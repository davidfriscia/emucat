//! Versioned WebSocket messages. Mirrors `packages/contracts/src/protocol.ts`; both are tested
//! against the same fixtures.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::discovery::DiscoveryReport;
use crate::platform::{Architecture, Platform};

pub const PROTOCOL_VERSION: u32 = 1;
pub const AGENT_MAX_MESSAGE_BYTES: usize = 64 * 1024;

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
    )
}
