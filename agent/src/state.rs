//! Local state the agent will track for each VM. Persistence and the operations themselves are not
//! implemented yet.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::archives::VersionId;
use crate::emulators::{EmulatorType, VmName};

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
