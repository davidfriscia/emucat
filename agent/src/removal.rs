//! Removes a local VM directory, once it has been safely registered. This is the only code in the
//! agent that deletes anything from a base path, and it fails closed: any doubt leaves the files alone.
//!
//! Callers must already have the server's confirmation that the master is committed. What this module
//! adds is everything only the local disk can answer: that the directory is the same one that was
//! archived, that it still holds exactly what the manifest says, and that nothing would be lost.
//!
//! The directory is first renamed to a name only this operation uses, inside the same base path. On
//! Windows that rename fails if any file inside is open, and after it no emulator can find the VM, so
//! nothing can change between the last check and the deletion.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::emulators::{EmulatorType, VmName};
use crate::packaging::{
    DirectoryIdentity, Manifest, ManifestEntryType, TreeEntry, directory_identity, hex,
    open_for_reading, resolve_vm_root, scan_tree,
};
use crate::repository::{CancelFlag, ProgressFn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovalRefusal {
    /// Screenshots would be lost, because nothing uploads them yet.
    UnarchivedMedia,
    /// The directory is not the one that was archived.
    IdentityMismatch,
    /// A file differs from the archive, or a file exists that is not in it.
    ContentChanged,
    /// A link, junction or other reparse point appeared.
    Unsafe,
    /// A file is open in another program.
    InUse,
    /// Deleting started and could not finish.
    Incomplete,
    /// The directory cannot be examined.
    Unreadable,
}

impl RemovalRefusal {
    /// Stable code, shared with `REGISTRATION_ERROR_CODES` in the contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnarchivedMedia => "transfer_blocked_media",
            Self::IdentityMismatch => "cleanup_identity_mismatch",
            Self::ContentChanged => "cleanup_content_changed",
            Self::Unsafe => "cleanup_unsafe",
            Self::InUse => "cleanup_in_use",
            Self::Incomplete => "cleanup_incomplete",
            Self::Unreadable => "cleanup_unreadable",
        }
    }
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct RemovalError {
    pub refusal: RemovalRefusal,
    pub message: String,
}

fn refuse(refusal: RemovalRefusal, message: impl Into<String>) -> RemovalError {
    RemovalError {
        refusal,
        message: message.into(),
    }
}

#[derive(Debug)]
pub struct RemovalRequest<'a> {
    pub base_path: &'a Path,
    pub emulator: EmulatorType,
    pub vm_name: &'a VmName,
    pub operation_id: Uuid,
    pub identity: DirectoryIdentity,
    pub manifest: &'a Manifest,
}

/// The name a directory has while it is being removed. A leading dot is not a valid VM name, so
/// discovery reports it as skipped and it can never be registered.
pub fn quarantine_path(base_path: &Path, operation_id: Uuid) -> PathBuf {
    base_path.join(format!(".emucat-removing-{operation_id}"))
}

/// Whether a transfer can even start. Screenshots are excluded from archives and are not uploaded yet,
/// so deleting the directory would destroy them.
pub fn blocking_media(root: &Path, emulator: EmulatorType) -> Result<Vec<String>, RemovalError> {
    let tree = scan_tree(root, emulator)
        .map_err(|error| refuse(RemovalRefusal::Unreadable, error.message))?;
    Ok(tree.excluded_files)
}

/// Everything short of deleting: the checks a transfer must pass. Hashes every file, so this takes
/// about as long as reading the VM.
fn verify_matches_manifest(
    root: &Path,
    request: &RemovalRequest<'_>,
    progress: &ProgressFn,
    cancel: &CancelFlag,
) -> Result<(), RemovalError> {
    let tree = scan_tree(root, request.emulator).map_err(|error| {
        use crate::packaging::SourceErrorKind as Kind;
        let refusal = match error.kind {
            Kind::Unsafe => RemovalRefusal::Unsafe,
            Kind::InUse => RemovalRefusal::InUse,
            _ => RemovalRefusal::Unreadable,
        };
        refuse(refusal, error.message)
    })?;
    if let Some(first) = tree.excluded_files.first() {
        return Err(refuse(
            RemovalRefusal::UnarchivedMedia,
            format!(
                "{first} is a screenshot that is not in the archive, and would be lost. Move the \
                 screenshots away, then remove the directory by hand"
            ),
        ));
    }

    let expected: BTreeMap<&str, ManifestEntryType> = request
        .manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.entry_type))
        .collect();
    let same_shape = tree.archived.len() == expected.len()
        && tree.archived.iter().all(|(path, entry)| {
            matches!(
                (entry, expected.get(path.as_str())),
                (TreeEntry::File(_), Some(ManifestEntryType::File))
                    | (TreeEntry::Directory, Some(ManifestEntryType::Directory))
            )
        });
    if !same_shape {
        return Err(refuse(
            RemovalRefusal::ContentChanged,
            "The directory no longer has the same files as the archive",
        ));
    }

    let total = request.manifest.total_uncompressed_bytes;
    let mut done = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    for entry in &request.manifest.entries {
        if entry.entry_type != ManifestEntryType::File {
            continue;
        }
        let path = root.join(&entry.path);
        let mut file = open_for_reading(&path).map_err(|error| {
            if crate::packaging::is_in_use(&error) {
                refuse(
                    RemovalRefusal::InUse,
                    format!("{} is in use by another program", entry.path),
                )
            } else {
                refuse(
                    RemovalRefusal::Unreadable,
                    format!("Cannot read {}: {error}", entry.path),
                )
            }
        })?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        loop {
            if cancel.is_cancelled() {
                return Err(refuse(
                    RemovalRefusal::Incomplete,
                    "Stopped before deleting",
                ));
            }
            let count = file.read(&mut buffer).map_err(|error| {
                refuse(
                    RemovalRefusal::Unreadable,
                    format!("Cannot read {}: {error}", entry.path),
                )
            })?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            size += count as u64;
            done += count as u64;
            progress(done, total);
        }
        if Some(size) != entry.size_bytes || Some(hex(&hasher.finalize())) != entry.sha256 {
            return Err(refuse(
                RemovalRefusal::ContentChanged,
                format!("{} differs from the archive", entry.path),
            ));
        }
    }
    Ok(())
}

/// Removes the VM's directory if, and only if, it still is what was archived. Calling this again after
/// a crash continues a removal that had already begun.
pub fn remove_vm_directory(
    request: &RemovalRequest<'_>,
    progress: &ProgressFn,
    cancel: &CancelFlag,
) -> Result<(), RemovalError> {
    let quarantine = quarantine_path(request.base_path, request.operation_id);

    if !quarantine.exists() {
        let root = resolve_vm_root(request.base_path, request.vm_name, request.emulator).map_err(
            |error| {
                use crate::packaging::SourceErrorKind as Kind;
                let refusal = match error.kind {
                    Kind::Unsafe => RemovalRefusal::Unsafe,
                    Kind::Missing | Kind::Invalid => RemovalRefusal::IdentityMismatch,
                    _ => RemovalRefusal::Unreadable,
                };
                refuse(refusal, error.message)
            },
        )?;
        let identity = directory_identity(&root).map_err(|error| {
            refuse(
                RemovalRefusal::Unreadable,
                format!("Cannot identify the directory: {error}"),
            )
        })?;
        if identity != request.identity {
            return Err(refuse(
                RemovalRefusal::IdentityMismatch,
                "This is not the directory that was archived: it has been replaced",
            ));
        }
        verify_matches_manifest(&root, request, progress, cancel)?;
        fs::rename(&root, &quarantine).map_err(|error| {
            let refusal = if crate::packaging::is_in_use(&error)
                || error.kind() == std::io::ErrorKind::PermissionDenied
            {
                RemovalRefusal::InUse
            } else {
                RemovalRefusal::Unreadable
            };
            refuse(
                refusal,
                format!("Cannot move the directory aside, so a file may be in use: {error}"),
            )
        })?;
    }

    // Whether this is the first pass or a resumed one, what is about to be deleted must be the right
    // directory, and must not be a link to somewhere else.
    let metadata = fs::symlink_metadata(&quarantine).map_err(|error| {
        refuse(
            RemovalRefusal::Unreadable,
            format!("Cannot examine the directory: {error}"),
        )
    })?;
    if crate::discovery::is_link_like(&metadata) || !metadata.is_dir() {
        return Err(refuse(
            RemovalRefusal::Unsafe,
            "What is about to be deleted is not a plain directory",
        ));
    }
    let identity = directory_identity(&quarantine).map_err(|error| {
        refuse(
            RemovalRefusal::Unreadable,
            format!("Cannot identify the directory: {error}"),
        )
    })?;
    if identity != request.identity {
        return Err(refuse(
            RemovalRefusal::IdentityMismatch,
            "The directory that was set aside is not the one that was archived",
        ));
    }

    // Links are removed rather than followed, and none should exist at this point anyway.
    fs::remove_dir_all(&quarantine).map_err(|error| {
        refuse(
            RemovalRefusal::Incomplete,
            format!(
                "Deleting stopped partway: {error}. What remains is in {}, can be deleted by hand, \
                 and is safe to lose: the verified archive is in the repository",
                quarantine.display()
            ),
        )
    })
}
