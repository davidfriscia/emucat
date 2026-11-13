//! Local state the agent tracks for each VM. Registration records which version a local copy came
//! from; the other operations are not implemented yet.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::archives::VersionId;
use crate::emulators::{EmulatorType, VmName};
use crate::packaging::DirectoryIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationType {
    DiscoverVms,
    RegisterVm,
    DownloadVersion,
    VerifyContent,
    LaunchVm,
    StopVm,
    CreateSnapshot,
    UploadSnapshot,
    UploadMedia,
    RemoveLocalCopy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

/// What the agent is currently doing with its local copy of a VM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Unknown,
    Absent,
    Idle,
    Downloading,
    Extracting,
    Verifying,
    Starting,
    Running,
    Stopping,
    Archiving,
    Uploading,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentStatus {
    Unverified,
    Verified,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub operation_type: OperationType,
    pub state: OperationState,
    #[serde(with = "time::serde::rfc3339")]
    pub requested_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVmState {
    pub agent_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub local_source_version_id: Option<VersionId>,
    pub execution_state: ExecutionState,
    pub content_status: ContentStatus,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_verified_at: Option<OffsetDateTime>,
    pub last_verified_sha256: Option<String>,
    pub pending_operations: Vec<PendingOperation>,
    /// The directory this lineage was established for: the volume and file ID of the very directory a
    /// restore published, a registration or snapshot read, or a verification found identical to its
    /// version. A directory with the VM's name but another identity has no proven lineage, whatever this
    /// record says. Records written by agents older than Milestone 7 have none. See decision 0037.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_identity: Option<DirectoryIdentity>,
}

const LOCAL_STATE_FILE: &str = "vm-state.json";

/// Records that a local VM is the source of a version. The VM was verified as part of creating that
/// version, and it counts as unverified again from the next connection, as [`AgentVmState`] requires.
pub fn record_local_source(
    state_dir: &Path,
    agent_id: Uuid,
    emulator_type: EmulatorType,
    vm_name: &VmName,
    version_id: Uuid,
    manifest_sha256: Option<&str>,
    directory: Option<DirectoryIdentity>,
) -> std::io::Result<()> {
    let path = state_dir.join(LOCAL_STATE_FILE);
    let mut states: BTreeMap<String, AgentVmState> = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error),
    };
    states.insert(
        format!("{emulator_type}/{}", vm_name.key()),
        AgentVmState {
            agent_id,
            emulator_type,
            vm_name: vm_name.clone(),
            local_source_version_id: Some(VersionId(version_id)),
            execution_state: ExecutionState::Idle,
            content_status: ContentStatus::Verified,
            last_verified_at: Some(OffsetDateTime::now_utc()),
            last_verified_sha256: manifest_sha256.map(str::to_owned),
            pending_operations: Vec::new(),
            directory_identity: directory,
        },
    );
    let temporary = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(&states)?)?;
        // Lineage decides what a snapshot is a child of, so it is made durable before it is relied on.
        file.sync_all()?;
    }
    fs::rename(&temporary, &path)
}

/// Forgets what [`record_local_source`] recorded for one VM, once its persistent copy has been removed
/// (decision 0041). Atomic and durable, like recording it; forgetting what is not there succeeds.
pub fn forget_local_source(
    state_dir: &Path,
    emulator_type: EmulatorType,
    vm_name: &VmName,
) -> std::io::Result<()> {
    let path = state_dir.join(LOCAL_STATE_FILE);
    let mut states: BTreeMap<String, AgentVmState> = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if states
        .remove(&format!("{emulator_type}/{}", vm_name.key()))
        .is_none()
    {
        return Ok(());
    }
    let temporary = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(&states)?)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &path)
}

/// Why a local copy's lineage cannot be relied on for a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineageProblem {
    /// Nothing records where this copy came from.
    Unrecorded,
    /// A record exists, from an agent that did not record which directory it was for.
    NoDirectoryRecorded,
    /// The directory with this name is not the one the record was made for.
    DirectoryReplaced,
    /// The record names another version.
    OtherVersion(Uuid),
}

/// The version a local copy provably came from: a record naming it, made for this very directory.
pub fn proven_lineage(
    state_dir: &Path,
    emulator_type: EmulatorType,
    vm_name: &VmName,
    directory: DirectoryIdentity,
    expected_version: Uuid,
) -> Result<(), LineageProblem> {
    let state =
        read_local_state(state_dir, emulator_type, vm_name).ok_or(LineageProblem::Unrecorded)?;
    let Some(VersionId(source)) = state.local_source_version_id else {
        return Err(LineageProblem::Unrecorded);
    };
    match state.directory_identity {
        None => Err(LineageProblem::NoDirectoryRecorded),
        Some(recorded) if recorded != directory => Err(LineageProblem::DirectoryReplaced),
        Some(_) if source != expected_version => Err(LineageProblem::OtherVersion(source)),
        Some(_) => Ok(()),
    }
}

/// Every local copy [`record_local_source`] recorded.
pub fn local_source_entries(state_dir: &Path) -> Vec<AgentVmState> {
    let Ok(bytes) = fs::read(state_dir.join(LOCAL_STATE_FILE)) else {
        return Vec::new();
    };
    let states: BTreeMap<String, AgentVmState> = serde_json::from_slice(&bytes).unwrap_or_default();
    states.into_values().collect()
}

/// What [`record_local_source`] recorded, for one VM.
pub fn read_local_state(
    state_dir: &Path,
    emulator_type: EmulatorType,
    vm_name: &VmName,
) -> Option<AgentVmState> {
    let bytes = fs::read(state_dir.join(LOCAL_STATE_FILE)).ok()?;
    let mut states: BTreeMap<String, AgentVmState> = serde_json::from_slice(&bytes).ok()?;
    states.remove(&format!("{emulator_type}/{}", vm_name.key()))
}

impl AgentVmState {
    /// A local copy can change while the agent is offline, so a verification only counts if it
    /// happened after the agent's most recent connection.
    pub fn is_content_trusted(&self, last_connected_at: OffsetDateTime) -> bool {
        self.content_status == ContentStatus::Verified
            && self
                .last_verified_at
                .is_some_and(|verified_at| verified_at >= last_connected_at)
    }
}
