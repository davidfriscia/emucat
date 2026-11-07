//! A local cache of downloaded master ZIPs, so that restoring again does not transfer them again.
//!
//! A file's name is its identity: version UUID and archive SHA-256, never a VM's name. There is no index
//! to fall out of step, and a file's modification time doubles as when it was last used. Nothing here is
//! proof of anything: the restore hashes whatever it reads from the cache before using it. A name that
//! does not end in `.zip` is unfinished, never used, and removed on the next start. See decision 0024.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use uuid::Uuid;

use crate::extraction::rename_no_replace;

/// Cache files in use right now, which eviction leaves alone.
#[derive(Debug, Default)]
struct Pins {
    counts: HashMap<String, u32>,
}

/// Keeps a cache file from being evicted for as long as it lives.
#[derive(Debug)]
pub struct CachePin {
    pins: Arc<Mutex<Pins>>,
    name: String,
}

impl Drop for CachePin {
    fn drop(&mut self) {
        let mut pins = self.pins.lock().expect("poisoned");
        if let Some(count) = pins.counts.get_mut(&self.name) {
            *count -= 1;
            if *count == 0 {
                pins.counts.remove(&self.name);
            }
        }
    }
}

/// What is in the cache, for reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheUsage {
    pub entries: u64,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub struct ArchiveCache {
    directory: PathBuf,
    max_bytes: u64,
    pins: Arc<Mutex<Pins>>,
}

fn is_entry_name(name: &str) -> bool {
    name.strip_suffix(".zip").is_some_and(|stem| {
        stem.len() == 36 + 1 + 64
            && stem
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    })
}

impl ArchiveCache {
    /// Opens the cache, and removes whatever an interrupted write left in it. A size of zero turns the
    /// cache off. Nothing fails because of this: a cache that cannot be used only costs a download.
    pub fn open(directory: PathBuf, max_bytes: u64) -> Self {
        let cache = Self {
            directory,
            max_bytes,
            pins: Arc::default(),
        };
        if max_bytes > 0 {
            if let Err(error) = fs::create_dir_all(&cache.directory) {
                tracing::warn!(%error, "Cannot create the archive cache");
            }
            cache.remove_unfinished();
        }
        cache
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    fn remove_unfinished(&self) {
        let Ok(listing) = fs::read_dir(&self.directory) else {
            return;
        };
        for item in listing.flatten() {
            let name = item.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".part") {
                if let Err(error) = fs::remove_file(item.path()) {
                    tracing::warn!(%error, %name, "Cannot remove an unfinished cache file");
                }
            }
        }
    }

    pub fn entry_name(version_id: Uuid, sha256: &str) -> String {
        format!("{version_id}-{sha256}.zip")
    }

    pub fn entry_path(&self, version_id: Uuid, sha256: &str) -> PathBuf {
        self.directory.join(Self::entry_name(version_id, sha256))
    }

    /// Keeps this entry out of eviction's reach. Whether or not it exists yet.
    pub fn pin(&self, version_id: Uuid, sha256: &str) -> CachePin {
        let name = Self::entry_name(version_id, sha256);
        *self
            .pins
            .lock()
            .expect("poisoned")
            .counts
            .entry(name.clone())
            .or_default() += 1;
        CachePin {
            pins: Arc::clone(&self.pins),
            name,
        }
    }

    /// Whether an entry exists, and if so marks it as just used. The file still has to be hashed.
    pub fn find(&self, version_id: Uuid, sha256: &str) -> Option<PathBuf> {
        if self.max_bytes == 0 {
            return None;
        }
        let path = self.entry_path(version_id, sha256);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || crate::discovery::is_link_like(&metadata) {
            return None;
        }
        if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(path)
    }

    /// Removes an entry that failed its check. Never trusted again, and never kept around.
    pub fn remove(&self, version_id: Uuid, sha256: &str) {
        let path = self.entry_path(version_id, sha256);
        if let Err(error) = fs::remove_file(&path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %path.display(), "Cannot remove a cache entry");
        }
    }

    fn entries(&self) -> Vec<(String, u64, SystemTime)> {
        let Ok(listing) = fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        listing
            .flatten()
            .filter_map(|item| {
                let name = item.file_name().to_string_lossy().into_owned();
                let metadata = item.metadata().ok()?;
                (is_entry_name(&name) && metadata.is_file()).then(|| {
                    (
                        name,
                        metadata.len(),
                        metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    )
                })
            })
            .collect()
    }

    pub fn usage(&self) -> CacheUsage {
        let entries = self.entries();
        CacheUsage {
            entries: entries.len() as u64,
            total_bytes: entries.iter().map(|(_, size, _)| size).sum(),
        }
    }

    /// Makes room, least recently used first, and only if that frees enough: there is no point in losing
    /// entries for an archive that will not fit anyway. Entries in use are never touched.
    fn make_room(&self, wanted: u64) -> bool {
        if wanted > self.max_bytes {
            return false;
        }
        let mut entries = self.entries();
        let mut total: u64 = entries.iter().map(|(_, size, _)| size).sum();
        if total.saturating_add(wanted) <= self.max_bytes {
            return true;
        }
        let pinned: Vec<String> = self
            .pins
            .lock()
            .expect("poisoned")
            .counts
            .keys()
            .cloned()
            .collect();
        entries.retain(|(name, _, _)| !pinned.contains(name));
        entries.sort_by_key(|(_, _, used)| *used);
        let evictable: u64 = entries.iter().map(|(_, size, _)| size).sum();
        if total - evictable + wanted > self.max_bytes {
            return false;
        }
        for (name, size, _) in entries {
            if total + wanted <= self.max_bytes {
                break;
            }
            let path = self.directory.join(&name);
            match fs::remove_file(&path) {
                Ok(()) => {
                    tracing::info!(entry = %name, size, "Evicted from the archive cache");
                    total -= size;
                }
                Err(error) => {
                    tracing::warn!(%error, entry = %name, "Cannot evict a cache entry");
                }
            }
        }
        total + wanted <= self.max_bytes
    }

    /// Moves a verified download into the cache. Returns where it now is, or the original path if it
    /// could not be cached, which is never a reason for a restore to fail. An unfinished copy has a name
    /// that cannot be mistaken for an entry, so what is visible as an entry is always complete.
    pub fn insert(
        &self,
        version_id: Uuid,
        sha256: &str,
        size: u64,
        source: &Path,
        operation_id: Uuid,
    ) -> PathBuf {
        if self.max_bytes == 0 || !self.make_room(size) {
            return source.to_path_buf();
        }
        let destination = self.entry_path(version_id, sha256);
        match rename_no_replace(source, &destination) {
            Ok(()) => return destination,
            // Another restore of this version got here first, and the entry is hashed before any use.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return source.to_path_buf();
            }
            // Most likely on another volume, which needs a copy.
            Err(_) => {}
        }
        let partial = self.directory.join(format!(
            "{}.{operation_id}.part",
            Self::entry_name(version_id, sha256)
        ));
        let copied = fs::copy(source, &partial).and_then(|_| {
            fs::OpenOptions::new()
                .write(true)
                .open(&partial)?
                .sync_all()?;
            rename_no_replace(&partial, &destination)
        });
        match copied {
            Ok(()) => {
                let _ = fs::remove_file(source);
                destination
            }
            Err(error) => {
                tracing::warn!(%error, "Cannot add a download to the archive cache");
                let _ = fs::remove_file(&partial);
                source.to_path_buf()
            }
        }
    }
}
