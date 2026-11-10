//! Versioned WebSocket messages. Mirrors `packages/contracts/src/protocol.ts`; both are tested
//! against the same fixtures.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::discovery::DiscoveryReport;
use crate::emulators::{EmulatorType, VmName};
use crate::platform::{Architecture, Platform};

pub const PROTOCOL_VERSION: u32 = 1;
pub const AGENT_MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// How many VMs one status message can describe. Mirrors `MEDIA_STATUS_MAX_VMS` in the contracts.
pub const MEDIA_STATUS_MAX_VMS: usize = 100;

/// Application-defined close codes. Mirrors `WS_CLOSE_CODES` in the contracts.
pub mod close_codes {
    pub const INVALID_MESSAGE: u16 = 4400;
    pub const AGENT_REVOKED: u16 = 4401;
    pub const UNSUPPORTED_PROTOCOL_VERSION: u16 = 4406;
    pub const TIMED_OUT: u16 = 4408;
    pub const SUPERSEDED: u16 = 4409;
    pub const TOO_MANY_MESSAGES: u16 = 4429;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub protocol_version: u32,
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub sent_at: OffsetDateTime,
    #[serde(flatten)]
    pub message: Message,
}

impl Envelope {
    /// A new message from this agent, answering nothing.
    pub fn new(message: Message) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: Uuid::new_v4(),
            correlation_id: None,
            sent_at: OffsetDateTime::now_utc(),
            message,
        }
    }

    pub fn answering(message: Message, correlation_id: Uuid) -> Self {
        Self {
            correlation_id: Some(correlation_id),
            ..Self::new(message)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Message {
    #[serde(rename = "agent.hello")]
    AgentHello(AgentHello),
    #[serde(rename = "agent.heartbeat")]
    AgentHeartbeat(Empty),
    #[serde(rename = "agent.discovery_result")]
    AgentDiscoveryResult(DiscoveryResult),
    #[serde(rename = "agent.discovery_error")]
    AgentDiscoveryError(DiscoveryError),
    #[serde(rename = "server.welcome")]
    ServerWelcome(ServerWelcome),
    #[serde(rename = "server.heartbeat_ack")]
    ServerHeartbeatAck(Empty),
    #[serde(rename = "server.error")]
    ServerError(ServerError),
    #[serde(rename = "server.discovery_request")]
    ServerDiscoveryRequest(DiscoveryRequest),
    #[serde(rename = "agent.registration_sync")]
    AgentRegistrationSync(RegistrationSync),
    #[serde(rename = "agent.registration_progress")]
    AgentRegistrationProgress(RegistrationProgress),
    #[serde(rename = "agent.registration_result")]
    AgentRegistrationResult(RegistrationResult),
    #[serde(rename = "agent.registration_error")]
    AgentRegistrationError(RegistrationFailure),
    #[serde(rename = "agent.registration_cleanup")]
    AgentRegistrationCleanup(RegistrationCleanup),
    #[serde(rename = "agent.repository_health_result")]
    AgentRepositoryHealthResult(RepositoryHealthResult),
    #[serde(rename = "server.registration_request")]
    ServerRegistrationRequest(RegistrationRequest),
    #[serde(rename = "server.registration_cancel")]
    ServerRegistrationCancel(RegistrationCancel),
    #[serde(rename = "server.registration_ack")]
    ServerRegistrationAck(RegistrationAck),
    #[serde(rename = "server.repository_health_request")]
    ServerRepositoryHealthRequest(RepositoryHealthRequest),
    #[serde(rename = "server.registration_retry_cleanup")]
    ServerRegistrationRetryCleanup(RegistrationRetryCleanup),
    #[serde(rename = "agent.media_sync_status")]
    AgentMediaSyncStatus(MediaSyncStatus),
    #[serde(rename = "agent.restore_sync")]
    AgentRestoreSync(RestoreSync),
    #[serde(rename = "agent.restore_progress")]
    AgentRestoreProgress(RestoreProgress),
    #[serde(rename = "agent.restore_result")]
    AgentRestoreResult(RestoreResult),
    #[serde(rename = "agent.restore_error")]
    AgentRestoreError(RestoreFailure),
    #[serde(rename = "server.restore_request")]
    ServerRestoreRequest(RestoreRequest),
    #[serde(rename = "server.restore_cancel")]
    ServerRestoreCancel(RestoreCancel),
    #[serde(rename = "server.restore_ack")]
    ServerRestoreAck(RestoreAck),
    #[serde(rename = "agent.execution_sync")]
    AgentExecutionSync(ExecutionSync),
    #[serde(rename = "agent.vm_execution_status")]
    AgentVmExecutionStatus(VmExecutionStatus),
    #[serde(rename = "agent.vm_verify_result")]
    AgentVmVerifyResult(VmVerifyResult),
    #[serde(rename = "server.vm_launch")]
    ServerVmLaunch(VmLaunchRequest),
    #[serde(rename = "server.vm_stop")]
    ServerVmStop(VmStopRequest),
    #[serde(rename = "server.vm_execution_ack")]
    ServerVmExecutionAck(VmExecutionAck),
    #[serde(rename = "server.vm_verify")]
    ServerVmVerify(VmVerifyRequest),
    #[serde(rename = "server.vm_verify_ack")]
    ServerVmVerifyAck(VmVerifyAck),
    #[serde(rename = "server.workspace_discard")]
    ServerWorkspaceDiscard(WorkspaceDiscard),
    #[serde(rename = "agent.workspace_discard_result")]
    AgentWorkspaceDiscardResult(WorkspaceDiscardResult),
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHello {
    pub agent_version: String,
    pub platform: Platform,
    pub architecture: Architecture,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWelcome {
    pub agent_id: Uuid,
    pub heartbeat_interval_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerError {
    pub code: String,
    pub message: String,
}

/// The only command in this protocol version. It carries nothing the agent has to interpret, and
/// unknown fields are refused, so a server cannot point a scan anywhere but the configured paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryRequest {
    pub operation_id: Uuid,
}

/// Says nothing about which agent this is: the server knows that from the connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub operation_id: Uuid,
    #[serde(flatten)]
    pub report: DiscoveryReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryError {
    pub operation_id: Uuid,
    pub code: DiscoveryErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryErrorCode {
    Busy,
    ScanFailed,
    InvalidRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistrationMode {
    Copy,
    Transfer,
    /// A further immutable version of a registered VM. Never removes anything. See decision 0037.
    Snapshot,
}

/// Which VM, in which repository, under which identities. It holds no path and no address: the agent
/// resolves a VM against its own base paths and a repository against its own configuration, and it
/// recomputes the archive key rather than believing it. Unknown fields are refused.
///
/// A snapshot names its parent, and only a snapshot does; only a snapshot can read a working copy. A
/// request that says otherwise fails to decode, and is answered as invalid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "RawRegistrationRequest")]
pub struct RegistrationRequest {
    pub operation_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub mode: RegistrationMode,
    pub repository_id: Uuid,
    pub version_id: Uuid,
    pub archive_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_version_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRegistrationRequest {
    operation_id: Uuid,
    emulator_type: EmulatorType,
    vm_name: VmName,
    mode: RegistrationMode,
    repository_id: Uuid,
    version_id: Uuid,
    archive_key: String,
    #[serde(default)]
    parent_version_id: Option<Uuid>,
    #[serde(default)]
    workspace_id: Option<Uuid>,
}

impl TryFrom<RawRegistrationRequest> for RegistrationRequest {
    type Error = &'static str;

    fn try_from(raw: RawRegistrationRequest) -> Result<Self, Self::Error> {
        let snapshot = raw.mode == RegistrationMode::Snapshot;
        if snapshot != raw.parent_version_id.is_some() {
            return Err("a snapshot names its parent, and nothing else does");
        }
        if raw.workspace_id.is_some() && !snapshot {
            return Err("only a snapshot reads a working copy");
        }
        if raw.parent_version_id == Some(raw.version_id) {
            return Err("a version cannot be its own parent");
        }
        Ok(Self {
            operation_id: raw.operation_id,
            emulator_type: raw.emulator_type,
            vm_name: raw.vm_name,
            mode: raw.mode,
            repository_id: raw.repository_id,
            version_id: raw.version_id,
            archive_key: raw.archive_key,
            parent_version_id: raw.parent_version_id,
            workspace_id: raw.workspace_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationCancel {
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckOutcome {
    /// The master is committed. `removeLocal` says whether the local copy may now be removed.
    Committed,
    /// There is no master for this operation, and there will not be one.
    Rejected,
    /// The server has everything. The agent can forget this operation.
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationAck {
    pub operation_id: Uuid,
    pub outcome: AckOutcome,
    #[serde(default)]
    pub version_id: Option<Uuid>,
    #[serde(default)]
    pub remove_local: bool,
    /// The published archive is referenced by nothing, and will never be.
    #[serde(default)]
    pub delete_published: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryHealthRequest {
    pub operation_id: Uuid,
    pub repository_id: Uuid,
}

/// How far along an operation is, as far as this agent knows. The server decides what follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationPhase {
    Running,
    Publishing,
    Published,
    Cleaning,
    Reported,
    /// The master exists, a screenshot blocked the removal, and this is kept so that it can be retried.
    MediaBlocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSyncEntry {
    pub operation_id: Uuid,
    pub phase: RegistrationPhase,
}

/// Sent after every welcome. It also tells the server that this agent can register VMs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSync {
    pub operations: Vec<RegistrationSyncEntry>,
    /// This agent can create snapshots. An older server ignores it.
    #[serde(default)]
    pub snapshots: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationStage {
    Validating,
    Archiving,
    Uploading,
    Verifying,
    CleaningLocal,
}

/// Only real measurements: without a known total there is no total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationProgress {
    pub operation_id: Uuid,
    pub stage: RegistrationStage,
    pub done_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

/// What this agent verified. It is a report, and authorizes nothing: the server only accepts it for an
/// operation it created, from the agent it created it for, with the identities it issued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResult {
    pub operation_id: Uuid,
    pub version_id: Uuid,
    pub archive_key: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
    pub manifest_version: u32,
    pub manifest_sha256: String,
    pub file_count: u64,
    pub total_uncompressed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationFailure {
    pub operation_id: Uuid,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCopyStatus {
    Preserved,
    Removed,
    CleanupFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationCleanup {
    pub operation_id: Uuid,
    pub version_id: Uuid,
    pub local_copy: LocalCopyStatus,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// The agent's local settings for a repository, minus anything secret. The server compares them with
/// its own record, since the two are configured separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfigSummary {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryHealthResult {
    pub operation_id: Uuid,
    pub repository_id: Uuid,
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub configuration: Option<RepositoryConfigSummary>,
    pub host_key_fingerprint: Option<String>,
    pub free_bytes: Option<u64>,
}

/// An administrator asks to try removing a local VM again, after a screenshot blocked it. It names
/// identities only, and the agent checks everything again before deleting anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationRetryCleanup {
    pub operation_id: Uuid,
    pub version_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSyncError {
    pub code: String,
    pub message: String,
    pub source_path: Option<String>,
}

/// One VM's screenshots, as this agent sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSyncVmStatus {
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub pending: u32,
    pub uploading: u32,
    pub synchronized: u32,
    pub failed: u32,
    pub last_error: Option<MediaSyncError>,
}

/// Informational, for the web interface. The server decides nothing on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSyncStatus {
    pub vms: Vec<MediaSyncVmStatus>,
    pub truncated: bool,
}

/// Which master, under which identities, from which repository. It holds no path and no address: the
/// agent derives the destination from its own base paths, reaches the repository through its own
/// configuration, and recomputes the archive key. Unknown fields are refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreRequest {
    pub operation_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub repository_id: Uuid,
    pub version_id: Uuid,
    pub archive_key: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
    /// What the registration verified, when that is known.
    pub manifest_sha256: Option<String>,
    /// For checking disk space before downloading. Never treated as a limit.
    pub expected_uncompressed_bytes: Option<u64>,
    /// Restore into this Remote Snapshot working copy, under the agent's own workspaces directory,
    /// rather than under the emulator's base path. See decision 0038.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreCancel {
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreAckOutcome {
    /// The server has recorded everything. The agent can forget this operation.
    Closed,
    /// The server does not recognize it. A directory that was published stays where it is.
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreAck {
    pub operation_id: Uuid,
    pub outcome: RestoreAckOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePhase {
    Running,
    Publishing,
    Published,
    Reported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSyncEntry {
    pub operation_id: Uuid,
    pub phase: RestorePhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEmulator {
    pub emulator_type: EmulatorType,
    pub base_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCapabilities {
    pub emulators: Vec<RestoreEmulator>,
    pub repository_ids: Vec<Uuid>,
    pub cache_max_bytes: u64,
    pub cache_used_bytes: u64,
}

/// What can honestly be said about a local copy without reading it. A difference proves a change, and no
/// difference proves nothing, which is why this has no way to say "verified".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalCopyCondition {
    Unverified,
    Modified,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCopyReport {
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub version_id: Uuid,
    pub status: LocalCopyCondition,
}

/// Sent after every welcome. It also tells the server that this agent can restore VMs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSync {
    pub operations: Vec<RestoreSyncEntry>,
    pub capabilities: RestoreCapabilities,
    pub local_copies: Vec<LocalCopyReport>,
    /// The Remote Snapshot working copies this agent holds. Saying so is also what tells a server that
    /// this agent keeps them.
    #[serde(default)]
    pub workspaces: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStage {
    Validating,
    Downloading,
    Verifying,
    Extracting,
    PublishingLocal,
}

/// Only real measurements: without a known total there is no total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProgress {
    pub operation_id: Uuid,
    pub stage: RestoreStage,
    pub done_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub cache_hit: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCache {
    pub hit: bool,
    pub downloaded_bytes: u64,
    pub archive_cached: bool,
    pub total_bytes: u64,
}

/// What this agent verified and where it put it. It is a report, and authorizes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub operation_id: Uuid,
    pub version_id: Uuid,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
    pub manifest_version: u32,
    pub manifest_sha256: String,
    pub file_count: u64,
    pub total_uncompressed_bytes: u64,
    pub local_directory: String,
    pub cache: RestoreCache,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub operation_id: Uuid,
    pub code: String,
    pub message: String,
}

/// What a text frame from the server turned out to be.
#[derive(Debug, PartialEq)]
pub enum Decoded {
    Message(Box<Envelope>),
    /// This agent speaks a different protocol version. Reconnecting will not help.
    UnsupportedVersion(u64),
    /// A valid envelope with a type this version does not know. Newer servers may add types, so this
    /// is ignored rather than treated as an error.
    UnknownType(String),
    /// A known type with a payload that fails validation, naming the operation if one can be read.
    InvalidPayload {
        message_type: String,
        operation_id: Option<Uuid>,
    },
    /// Not an envelope at all.
    Malformed,
}

/// Decodes in stages, so that a version mismatch or an unknown type gets a precise answer. Malformed
/// input of any kind ends in a value, never a panic.
pub fn decode(text: &str) -> Decoded {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Decoded::Malformed;
    };
    let Some(version) = value.get("protocolVersion").and_then(|v| v.as_u64()) else {
        return Decoded::Malformed;
    };
    if version != u64::from(PROTOCOL_VERSION) {
        return Decoded::UnsupportedVersion(version);
    }
    let Some(message_type) = value
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
    else {
        return Decoded::Malformed;
    };
    match serde_json::from_value::<Envelope>(value.clone()) {
        Ok(envelope) => Decoded::Message(Box::new(envelope)),
        Err(_) if !is_known_type(&message_type) => Decoded::UnknownType(message_type),
        Err(_) => Decoded::InvalidPayload {
            operation_id: value
                .pointer("/payload/operationId")
                .or_else(|| value.pointer("/payload/sessionId"))
                .and_then(|v| v.as_str())
                .and_then(|id| Uuid::parse_str(id).ok()),
            message_type,
        },
    }
}

fn is_known_type(message_type: &str) -> bool {
    matches!(
        message_type,
        "agent.hello"
            | "agent.heartbeat"
            | "agent.discovery_result"
            | "agent.discovery_error"
            | "server.welcome"
            | "server.heartbeat_ack"
            | "server.error"
            | "server.discovery_request"
            | "agent.registration_sync"
            | "agent.registration_progress"
            | "agent.registration_result"
            | "agent.registration_error"
            | "agent.registration_cleanup"
            | "agent.repository_health_result"
            | "server.registration_request"
            | "server.registration_cancel"
            | "server.registration_ack"
            | "server.repository_health_request"
            | "server.registration_retry_cleanup"
            | "agent.media_sync_status"
            | "agent.restore_sync"
            | "agent.restore_progress"
            | "agent.restore_result"
            | "agent.restore_error"
            | "server.restore_request"
            | "server.restore_cancel"
            | "server.restore_ack"
            | "agent.execution_sync"
            | "agent.vm_execution_status"
            | "agent.vm_verify_result"
            | "server.vm_launch"
            | "server.vm_stop"
            | "server.vm_execution_ack"
            | "server.vm_verify"
            | "server.vm_verify_ack"
            | "server.workspace_discard"
            | "agent.workspace_discard_result"
    )
}

/// Where a VM runs from. `local` runs the persistent copy, `remote_snapshot` a working copy (decision
/// 0038). `remote_volatile` is refused, never treated as another mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Local,
    RemoteVolatile,
    RemoteSnapshot,
}

/// Starts a VM that this agent holds. It names a session and a VM, and nothing about how: the executable,
/// the arguments and the directory all come from this agent's configuration and the VM's own files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmLaunchRequest {
    pub session_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub mode: ExecutionMode,
    /// The version the local copy is believed to come from, for the record. Never used to find files.
    pub version_id: Option<Uuid>,
    /// For `remote_snapshot` only: which working copy to run. The agent finds its directory itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
}

/// Asks a session's emulator to stop. `force` ends the process at once, and the server only sends it after
/// an administrator confirmed exactly that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmStopRequest {
    pub session_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub force: bool,
}

/// Removes a Remote Snapshot working copy. It names the copy and its VM, never a path: the agent finds
/// the directory under its own workspaces directory, and refuses while anything uses the VM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDiscard {
    pub workspace_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscardResult {
    pub workspace_id: Uuid,
    pub removed: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// The server has recorded a session's end. The agent can forget it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmExecutionAck {
    pub session_id: Uuid,
}

/// What the agent knows about a session's process. The server alone records `requested` and
/// `interrupted`, which an agent cannot know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentExecutionState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Exited,
    Failed,
    /// The agent cannot tell whether the process still runs. Nothing destructive may happen to the VM.
    Unknown,
}

impl AgentExecutionState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Stopped | Self::Exited | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmExecutionStatus {
    pub session_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub state: AgentExecutionState,
    pub pid: Option<u32>,
    /// When the operating system says the process was created. With the PID, it identifies the process.
    #[serde(with = "time::serde::rfc3339::option")]
    pub process_started_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub started_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub ended_at: Option<OffsetDateTime>,
    pub exit_code: Option<i64>,
    pub stop_requested: bool,
    /// Whether a graceful stop can be asked for at the moment.
    pub graceful_stop_available: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEmulator {
    pub emulator_type: EmulatorType,
    pub launchable: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionCapabilities {
    pub emulators: Vec<ExecutionEmulator>,
    pub modes: Vec<ExecutionMode>,
}

/// Sent after every welcome. It says what this agent can launch, every session it still knows of, and
/// which verifications it is running. Sending it is also what tells a server that this agent can launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSync {
    pub sessions: Vec<VmExecutionStatus>,
    pub capabilities: ExecutionCapabilities,
    pub verifications: Vec<Uuid>,
}

/// Verifies a local copy against a master. The identities let the agent find and check the manifest: its
/// SHA-256 must match, whichever copy of it the agent reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmVerifyRequest {
    pub operation_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub version_id: Uuid,
    pub repository_id: Uuid,
    pub archive_key: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
    pub manifest_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmVerifyAck {
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyResultStatus {
    Verified,
    Modified,
    Missing,
    Unavailable,
    VerificationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyPathList {
    pub count: u64,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmVerifyResult {
    pub operation_id: Uuid,
    pub version_id: Uuid,
    pub status: VerifyResultStatus,
    pub files_verified: u64,
    pub bytes_hashed: u64,
    pub duration_ms: u64,
    pub missing: VerifyPathList,
    pub modified: VerifyPathList,
    pub unexpected: VerifyPathList,
    /// The manifest the files were compared with, once it was found and checked.
    pub manifest_sha256: Option<String>,
    /// Where it came from: `local`, `cache` or `repository`.
    pub manifest_source: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
}
