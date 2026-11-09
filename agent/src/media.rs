//! Media domain: which files are screenshots, finding them safely, and reading them without being fooled
//! by a file that is still being written. Media are independent of VM archives and versions.
//!
//! Nothing in this module follows a link, and nothing writes. The server never names a path: everything
//! here starts from a VM root that [`crate::packaging::resolve_vm_root`] has validated.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::archives::is_root_ppm;
use crate::discovery::is_link_like;
use crate::emulators::EmulatorType;
use crate::filesystem::parse_vm_relative_path;
use crate::packaging::{hex, is_in_use, open_for_reading};

/// File name endings treated as screenshots in an 86Box `screenshots` tree, ignoring case.
pub const SCREENSHOT_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".bmp", ".ppm"];

const SCREENSHOTS_DIRECTORY: &str = "screenshots";

fn has_screenshot_extension(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SCREENSHOT_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/// Whether a VM-relative file is a media file the agent should pick up: a supported image anywhere in an
/// 86Box `screenshots` tree, and `.ppm` files in a QEMU VM's root.
pub fn is_watched_media_path(emulator: EmulatorType, path: &str) -> bool {
    let Ok(segments) = parse_vm_relative_path(path) else {
        return false;
    };
    match emulator {
        EmulatorType::Box86 => {
            segments.len() >= 2
                && segments[0].eq_ignore_ascii_case(SCREENSHOTS_DIRECTORY)
                && segments
                    .last()
                    .is_some_and(|last| has_screenshot_extension(last))
        }
        EmulatorType::Qemu => is_root_ppm(&segments),
    }
}

/// What a file looked like at one moment. Different values prove that it changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStamp {
    pub size_bytes: u64,
    pub modified_ms: u64,
}

impl MediaStamp {
    pub fn of(metadata: &fs::Metadata) -> Self {
        Self {
            size_bytes: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_millis() as u64),
        }
    }

    /// The modification time, for showing to an administrator.
    pub fn modified(&self) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_millis(self.modified_ms)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFile {
    /// Relative to the VM root, with forward slashes.
    pub source_path: String,
    pub stamp: MediaStamp,
}

#[derive(Debug, Clone, Copy)]
pub struct MediaScanLimits {
    pub max_files: usize,
    pub max_depth: usize,
}

impl Default for MediaScanLimits {
    fn default() -> Self {
        Self {
            max_files: 20_000,
            max_depth: 16,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaScan {
    pub files: Vec<MediaFile>,
    /// Links, junctions and special files that were found and not followed, for the log.
    pub refused: Vec<String>,
    /// The limits were reached, so more files may exist than are listed here.
    pub truncated: bool,
}

/// Finds the screenshots of one VM. Only regular files count, and nothing is followed: a link in the
/// tree is reported and left out. Reading this opens no file.
pub fn scan_vm_media(
    root: &Path,
    emulator: EmulatorType,
    limits: &MediaScanLimits,
) -> io::Result<MediaScan> {
    let mut scan = MediaScan::default();
    match emulator {
        EmulatorType::Qemu => {
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                if is_watched_media_path(emulator, &name) {
                    record_file(&entry.path(), name, &mut scan, limits);
                }
            }
        }
        EmulatorType::Box86 => {
            // Listed, because the name is matched ignoring case but has to be used as it is spelled.
            let mut pending = Vec::new();
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                if !name.eq_ignore_ascii_case(SCREENSHOTS_DIRECTORY) {
                    continue;
                }
                let metadata = fs::symlink_metadata(entry.path())?;
                if is_link_like(&metadata) {
                    scan.refused.push(name);
                } else if metadata.is_dir() {
                    pending.push((entry.path(), name, 1usize));
                }
            }
            while let Some((directory, prefix, depth)) = pending.pop() {
                for entry in fs::read_dir(&directory)? {
                    let entry = entry?;
                    let Ok(name) = entry.file_name().into_string() else {
                        continue;
                    };
                    let relative = format!("{prefix}/{name}");
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path)?;
                    if is_link_like(&metadata) {
                        scan.refused.push(relative);
                    } else if metadata.is_dir() {
                        if depth >= limits.max_depth {
                            scan.truncated = true;
                        } else {
                            pending.push((path, relative, depth + 1));
                        }
                    } else if is_watched_media_path(emulator, &relative) {
                        record_file(&path, relative, &mut scan, limits);
                    }
                }
            }
        }
    }
    scan.files.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    Ok(scan)
}

fn record_file(path: &Path, relative: String, scan: &mut MediaScan, limits: &MediaScanLimits) {
    if scan.files.len() >= limits.max_files {
        scan.truncated = true;
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if is_link_like(&metadata) {
        scan.refused.push(relative);
    } else if metadata.is_file() {
        scan.files.push(MediaFile {
            source_path: relative,
            stamp: MediaStamp::of(&metadata),
        });
    } else {
        scan.refused.push(relative);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaFileProblem {
    /// Gone, replaced, or different from what was expected. A later scan will sort it out.
    Changed,
    /// Open for writing somewhere, so it is not finished.
    InUse,
    /// A link appeared on the way to it, or it is not a regular file.
    Unsafe(String),
    Unreadable(String),
}

/// Walks to a file one segment at a time, refusing anything that is not a plain directory on the way
/// and a regular file at the end. A VM-relative path can therefore never lead outside the VM, whatever
/// happened on the disk since it was found.
pub fn checked_media_path(root: &Path, source_path: &str) -> Result<PathBuf, MediaFileProblem> {
    let segments = parse_vm_relative_path(source_path)
        .map_err(|_| MediaFileProblem::Unsafe(format!("{source_path} is not a safe path")))?;
    let mut current = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                MediaFileProblem::Changed
            } else {
                MediaFileProblem::Unreadable(error.to_string())
            }
        })?;
        if is_link_like(&metadata) {
            return Err(MediaFileProblem::Unsafe(format!(
                "{source_path} goes through a link"
            )));
        }
        let last = index + 1 == segments.len();
        if (last && !metadata.is_file()) || (!last && !metadata.is_dir()) {
            return Err(MediaFileProblem::Unsafe(format!(
                "{source_path} is not a regular file"
            )));
        }
    }
    Ok(current)
}

/// Opens a file that must still look exactly as it did when it was hashed. On Windows the handle also
/// keeps writers out for as long as it is open, so the bytes sent are the bytes that were hashed.
pub fn open_media_file(
    root: &Path,
    source_path: &str,
    expected: MediaStamp,
) -> Result<File, MediaFileProblem> {
    let path = checked_media_path(root, source_path)?;
    let file = open_for_reading(&path).map_err(|error| problem_from(&error))?;
    let metadata = file
        .metadata()
        .map_err(|error| MediaFileProblem::Unreadable(error.to_string()))?;
    if MediaStamp::of(&metadata) != expected {
        return Err(MediaFileProblem::Changed);
    }
    Ok(file)
}

fn problem_from(error: &io::Error) -> MediaFileProblem {
    if is_in_use(error) {
        MediaFileProblem::InUse
    } else if error.kind() == io::ErrorKind::NotFound {
        MediaFileProblem::Changed
    } else {
        MediaFileProblem::Unreadable(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashedMedia {
    pub sha256: String,
    pub stamp: MediaStamp,
}

/// Reads a whole file and hashes it, and fails if it changed in the meantime: same size and modification
/// time before and after, through a handle that denies writers where the platform can.
pub fn hash_media_file(root: &Path, source_path: &str) -> Result<HashedMedia, MediaFileProblem> {
    let path = checked_media_path(root, source_path)?;
    let before = fs::symlink_metadata(&path).map_err(|error| problem_from(&error))?;
    let mut file = open_for_reading(&path).map_err(|error| problem_from(&error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| MediaFileProblem::Unreadable(error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let after = fs::symlink_metadata(&path).map_err(|error| problem_from(&error))?;
    let stamp = MediaStamp::of(&after);
    if MediaStamp::of(&before) != stamp || is_link_like(&after) || !after.is_file() {
        return Err(MediaFileProblem::Changed);
    }
    Ok(HashedMedia {
        sha256: hex(&hasher.finalize()),
        stamp,
    })
}
