//! Verifying a local VM against the manifest of its immutable master.
//!
//! Every file the manifest lists is hashed with SHA-256, here on the agent, and nothing is uploaded. The
//! tree is listed with the archive's own rules, so screenshots, which are never in an archive, are neither
//! expected nor reported as unexpected, and anything that is a link or reparse point fails the check rather
//! than being followed. The tree is listed again at the end: a file that changed while it was being read
//! makes the result `verification_failed`, never `verified`. See decision 0032.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use crate::emulators::EmulatorType;
use crate::packaging::{
    Manifest, ManifestEntryType, SourceErrorKind, TreeEntry, TreeSnapshot, hash_file, scan_tree,
};
use crate::repository::CancelFlag;

/// How many paths of each kind a result names. The counts are always complete.
pub const LISTED_PATHS_MAX: usize = 20;
const LISTED_PATH_LENGTH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyStatus {
    Verified,
    Modified,
    Missing,
    VerificationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PathList {
    pub count: u64,
    pub paths: Vec<String>,
}

impl PathList {
    fn add(&mut self, path: &str) {
        self.count += 1;
        if self.paths.len() < LISTED_PATHS_MAX {
            self.paths
                .push(path.chars().take(LISTED_PATH_LENGTH).collect());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyOutcome {
    pub status: VerifyStatus,
    pub files_verified: u64,
    pub bytes_hashed: u64,
    pub duration_ms: u64,
    pub missing: PathList,
    pub modified: PathList,
    pub unexpected: PathList,
    pub message: Option<String>,
}

fn stamps(tree: &TreeSnapshot) -> BTreeMap<&str, &TreeEntry> {
    tree.archived
        .iter()
        .map(|(path, entry)| (path.as_str(), entry))
        .collect()
}

/// Compares the tree under `root` with `manifest`. It only reads.
pub fn verify_local_copy(
    root: &Path,
    emulator: EmulatorType,
    manifest: &Manifest,
    cancel: &CancelFlag,
) -> VerifyOutcome {
    let started = Instant::now();
    let mut outcome = VerifyOutcome {
        status: VerifyStatus::Verified,
        files_verified: 0,
        bytes_hashed: 0,
        duration_ms: 0,
        missing: PathList::default(),
        modified: PathList::default(),
        unexpected: PathList::default(),
        message: None,
    };
    let failed = |mut outcome: VerifyOutcome, message: String| {
        outcome.status = VerifyStatus::VerificationFailed;
        outcome.message = Some(message);
        outcome.duration_ms = started.elapsed().as_millis() as u64;
        outcome
    };

    let before = match scan_tree(root, emulator) {
        Ok(tree) => tree,
        Err(error) => {
            let message = match error.kind {
                SourceErrorKind::Unsafe => {
                    format!("The VM cannot be verified safely: {}", error.message)
                }
                _ => format!("The VM cannot be listed: {}", error.message),
            };
            return failed(outcome, message);
        }
    };

    let mut expected_paths = std::collections::BTreeSet::new();
    for entry in &manifest.entries {
        expected_paths.insert(entry.path.as_str());
        match (before.archived.get(&entry.path), entry.entry_type) {
            (None, _) => outcome.missing.add(&entry.path),
            (Some(TreeEntry::Directory), ManifestEntryType::Directory) => {}
            (Some(TreeEntry::File(stamp)), ManifestEntryType::File) => {
                if Some(stamp.size_bytes) != entry.size_bytes {
                    outcome.modified.add(&entry.path);
                    continue;
                }
                if cancel.is_cancelled() {
                    return failed(outcome, "Cancelled".to_owned());
                }
                match hash_file(&root.join(&entry.path), cancel) {
                    Ok((size, sha256)) => {
                        outcome.bytes_hashed += size;
                        if Some(&sha256) == entry.sha256.as_ref() && Some(size) == entry.size_bytes
                        {
                            outcome.files_verified += 1;
                        } else {
                            outcome.modified.add(&entry.path);
                        }
                    }
                    Err(error) => {
                        return failed(
                            outcome,
                            format!("{} cannot be read: {}", entry.path, error.message),
                        );
                    }
                }
            }
            (Some(_), _) => outcome.modified.add(&entry.path),
        }
    }
    for path in before.archived.keys() {
        if !expected_paths.contains(path.as_str()) {
            outcome.unexpected.add(path);
        }
    }

    // Nothing may have changed while the files were read, or the hashes describe no single moment.
    match scan_tree(root, emulator) {
        Ok(after) if stamps(&after) == stamps(&before) => {}
        Ok(_) => {
            return failed(
                outcome,
                "Files changed while they were being verified. Stop the VM and verify again"
                    .to_owned(),
            );
        }
        Err(error) => {
            return failed(
                outcome,
                format!("The VM cannot be listed: {}", error.message),
            );
        }
    }

    outcome.status = if outcome.missing.count > 0 {
        VerifyStatus::Missing
    } else if outcome.modified.count > 0 || outcome.unexpected.count > 0 {
        VerifyStatus::Modified
    } else {
        VerifyStatus::Verified
    };
    outcome.duration_ms = started.elapsed().as_millis() as u64;
    outcome
}
