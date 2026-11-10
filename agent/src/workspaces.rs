//! Remote Snapshot working copies (decision 0038).
//!
//! A working copy is `{state_dir}/workspaces/{workspace_id}/{vm_name}`, with a small record next to it
//! saying which VM it holds and which version it is a copy of. The state directory is refused inside every
//! emulator's base path, so discovery never sees a working copy and it can never collide with, or be taken
//! for, the persistent local copy. Nothing here touches anything outside the workspaces directory.
//!
//! A working copy is created by a restore into it, run by a `remote_snapshot` session, preserved by a
//! snapshot of it, and removed only when the server asks, after checking that nothing uses the VM.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::discovery::is_link_like;
use crate::emulators::{EmulatorType, VmName};

const RECORD_SUFFIX: &str = ".workspace.json";
const REMOVING_PREFIX: &str = ".removing-";

/// Where working copies live, for a state directory.
pub fn workspaces_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("workspaces")
}

/// The directory that plays the part of a base path for one working copy.
pub fn workspace_base(state_dir: &Path, workspace_id: Uuid) -> PathBuf {
    workspaces_dir(state_dir).join(workspace_id.to_string())
}

fn record_path(state_dir: &Path, workspace_id: Uuid) -> PathBuf {
    workspaces_dir(state_dir).join(format!("{workspace_id}{RECORD_SUFFIX}"))
}

/// What the agent knows about a working copy. No secret, no path the server chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub workspace_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    /// The version the directory is a copy of now: the restored one, then each snapshot of it.
    pub source_version_id: Uuid,
    /// The manifest that version was verified against, when it is known.
    pub manifest_sha256: Option<String>,
}

/// Writes the record atomically and durably. Written before a working copy's restore is published, so a
/// crash cannot leave a working copy nobody knows the identity of.
pub fn write_record(state_dir: &Path, record: &WorkspaceRecord) -> io::Result<()> {
    let directory = workspaces_dir(state_dir);
    fs::create_dir_all(&directory)?;
    let path = record_path(state_dir, record.workspace_id);
    let temporary = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(record).expect("a record always serializes"))?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &path)
}

pub fn read_record(state_dir: &Path, workspace_id: Uuid) -> Option<WorkspaceRecord> {
    let bytes = fs::read(record_path(state_dir, workspace_id)).ok()?;
    serde_json::from_slice::<WorkspaceRecord>(&bytes)
        .ok()
        .filter(|record| record.workspace_id == workspace_id)
}

/// The working copy's VM directory, if the working copy exists, holds that VM, and is not a link at any
/// level the agent controls.
pub fn existing_vm_root(
    state_dir: &Path,
    workspace_id: Uuid,
    emulator_type: EmulatorType,
    vm_name: &VmName,
) -> Option<PathBuf> {
    let record = read_record(state_dir, workspace_id)?;
    if record.emulator_type != emulator_type || record.vm_name.key() != vm_name.key() {
        return None;
    }
    let base = workspace_base(state_dir, workspace_id);
    let root = base.join(record.vm_name.as_str());
    let plain_directory = |path: &Path| {
        fs::symlink_metadata(path)
            .is_ok_and(|metadata| !is_link_like(&metadata) && metadata.is_dir())
    };
    (plain_directory(&workspaces_dir(state_dir))
        && plain_directory(&base)
        && plain_directory(&root))
    .then_some(root)
}

/// The working copies this agent holds: a record and a published VM directory, both present.
pub fn held(state_dir: &Path) -> Vec<Uuid> {
    let Ok(listing) = fs::read_dir(workspaces_dir(state_dir)) else {
        return Vec::new();
    };
    let mut ids: Vec<Uuid> = listing
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = Uuid::parse_str(name.strip_suffix(RECORD_SUFFIX)?).ok()?;
            let record = read_record(state_dir, id)?;
            existing_vm_root(state_dir, id, record.emulator_type, &record.vm_name).map(|_| id)
        })
        .collect();
    ids.sort();
    ids.truncate(256);
    ids
}

/// Records that a working copy is now a copy of a new version, after a snapshot of it committed.
pub fn record_source(
    state_dir: &Path,
    workspace_id: Uuid,
    version_id: Uuid,
    manifest_sha256: Option<&str>,
) -> io::Result<()> {
    let Some(mut record) = read_record(state_dir, workspace_id) else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no such working copy",
        ));
    };
    record.source_version_id = version_id;
    record.manifest_sha256 = manifest_sha256.map(str::to_owned);
    write_record(state_dir, &record)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscardError {
    pub code: &'static str,
    pub message: String,
}

/// Removes a working copy: renamed first, so that a crash midway leaves nothing that looks like one, then
/// deleted, then its record. Only an immediate child of the workspaces directory, named by its UUID, and
/// not a link, is ever touched. Removing one that is already gone succeeds.
pub fn discard(
    state_dir: &Path,
    workspace_id: Uuid,
    emulator_type: EmulatorType,
    vm_name: &VmName,
) -> Result<(), DiscardError> {
    let directory = workspaces_dir(state_dir);
    let base = workspace_base(state_dir, workspace_id);
    let removing = directory.join(format!("{REMOVING_PREFIX}{workspace_id}"));
    if let Some(record) = read_record(state_dir, workspace_id)
        && (record.emulator_type != emulator_type || record.vm_name.key() != vm_name.key())
    {
        return Err(DiscardError {
            code: "workspace_mismatch",
            message: "This working copy holds another VM".to_owned(),
        });
    }
    match fs::symlink_metadata(&base) {
        Ok(metadata) if is_link_like(&metadata) || !metadata.is_dir() => {
            return Err(DiscardError {
                code: "workspace_unsafe",
                message: "The working copy is a link or not a directory, so it was kept".to_owned(),
            });
        }
        Ok(_) => fs::rename(&base, &removing).map_err(|error| DiscardError {
            code: "workspace_in_use",
            message: format!("The working copy could not be moved aside, so it was kept: {error}"),
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(DiscardError {
                code: "workspace_unreadable",
                message: format!("Cannot examine the working copy: {error}"),
            });
        }
    }
    finish_removal(&removing).map_err(|error| DiscardError {
        code: "workspace_incomplete",
        message: format!("Removing the working copy stopped partway: {error}"),
    })?;
    match fs::remove_file(record_path(state_dir, workspace_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DiscardError {
            code: "workspace_incomplete",
            message: format!("Cannot remove the working copy's record: {error}"),
        }),
    }
}

fn finish_removal(removing: &Path) -> io::Result<()> {
    match fs::symlink_metadata(removing) {
        // `remove_dir_all` removes links themselves rather than following them.
        Ok(metadata) if !is_link_like(&metadata) && metadata.is_dir() => {
            fs::remove_dir_all(removing)
        }
        Ok(_) => fs::remove_file(removing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Finishes removals a crash interrupted. Only `.removing-{uuid}` entries are touched.
pub fn recover(state_dir: &Path) {
    let Ok(listing) = fs::read_dir(workspaces_dir(state_dir)) else {
        return;
    };
    for entry in listing.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(id) = name
            .strip_prefix(REMOVING_PREFIX)
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            continue;
        };
        if let Err(error) = finish_removal(&entry.path()) {
            tracing::warn!(%error, workspace_id = %id, "Cannot finish removing a working copy");
        } else {
            let _ = fs::remove_file(record_path(state_dir, id));
        }
    }
}
