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
}

/// Which VM, in which repository, under which identities. It holds no path and no address: the agent
/// resolves a VM against its own base paths and a repository against its own configuration, and it
/// recomputes the archive key rather than believing it. Unknown fields are refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationRequest {
    pub operation_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub mode: RegistrationMode,
    pub repository_id: Uuid,
    pub version_id: Uuid,
    pub archive_key: String,
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
    )
}
