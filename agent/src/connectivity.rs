//! The agent's connection to the server. It only ever connects out and never listens.
//!
//! [`run`] keeps one authenticated WebSocket open: it says hello, sends heartbeats, answers discovery
//! requests, passes registration messages to [`AgentOperations`], and reconnects with exponential backoff and jitter whenever the connection is lost. It
//! stops for good only when asked to, or when the server has said something that reconnecting cannot
//! fix: a revoked credential, a newer connection with this identity, or another protocol version.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{self, Message as Frame, client::IntoClientRequest};
use url::Url;
use uuid::Uuid;

use crate::config::EmulatorConfig;
use crate::credentials::Secret;
use crate::discovery::{self, ScanLimits};
use crate::emulators::EmulatorType;
use crate::media_sync::MediaSync;
use crate::platform::Platform;
use crate::protocol::{
    AGENT_MAX_MESSAGE_BYTES, AgentHello, Decoded, DiscoveryError, DiscoveryErrorCode,
    DiscoveryResult, Empty, Envelope, Message, close_codes, decode,
};
use crate::registration::AgentOperations;

pub const AGENT_WS_PATH: &str = "/api/v1/agent/ws";
/// How often a change in screenshot synchronization is reported. Far below the server's message limit.
const MEDIA_STATUS_INTERVAL: Duration = Duration::from_secs(5);

/// WebSocket address of the agent endpoint for a server's base URL. A base path is preserved, so
/// that a server behind a reverse proxy prefix works.
pub fn agent_ws_url(api_url: &Url) -> Url {
    let mut url = api_url.clone();
    // Cannot fail for http and https, the only schemes configuration accepts.
    let scheme = if api_url.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    let _ = url.set_scheme(scheme);
    let base = api_url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{AGENT_WS_PATH}"));
    url
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransportError {
    #[error(
        "refusing to send secrets to {0} over unencrypted http. Use https; http is only for a \
         server on this computer"
    )]
    InsecureRemote(String),
}

pub fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

/// Credentials and pairing secrets only travel over TLS, or to this computer for local development.
pub fn check_transport(api_url: &Url) -> Result<(), TransportError> {
    if api_url.scheme() == "https" || is_loopback_host(api_url) {
        Ok(())
    } else {
        Err(TransportError::InsecureRemote(
            api_url.host_str().unwrap_or_default().to_owned(),
        ))
    }
}

/// Exponential backoff with equal jitter: half of each delay is fixed, and half is random. A server
/// that restarts is not met by all of its agents at the same instant.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub initial: Duration,
    pub maximum: Duration,
    /// A connection that lasted this long was healthy, so the next delay starts over.
    pub stable_after: Duration,
    attempt: u32,
}

impl Backoff {
    pub const fn new(initial: Duration, maximum: Duration, stable_after: Duration) -> Self {
        Self {
            initial,
            maximum,
            stable_after,
            attempt: 0,
        }
    }

    /// The upper limit of the next delay, before jitter.
    pub fn ceiling(&self) -> Duration {
        let factor = 2u32.saturating_pow(self.attempt.min(16));
        self.initial.saturating_mul(factor).min(self.maximum)
    }

    pub fn next_delay(&mut self) -> Duration {
        let ceiling = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        let half = ceiling / 2;
        half + half.mul_f64(fastrand::f64())
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(
            Duration::from_secs(1),
            Duration::from_secs(60),
            Duration::from_secs(60),
        )
    }
}

/// Why the connection loop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ConnectionEnd {
    #[error("stopped")]
    Shutdown,
    #[error(
        "the server does not accept this agent's credential, which means it was revoked or is \
         unknown. Pair again explicitly with `emucat-agent pair --force`"
    )]
    CredentialRejected,
    #[error(
        "another connection with this agent's identity took over. Make sure only one instance runs"
    )]
    Superseded,
    #[error("the server speaks a different protocol version. Update the agent or the server")]
    UnsupportedProtocol,
}

#[derive(Clone)]
pub struct ConnectionSettings {
    pub ws_url: Url,
    pub credential: Secret,
    pub hello: AgentHello,
    pub host: Platform,
    pub emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
    pub scan_limits: ScanLimits,
    pub connect_timeout: Duration,
    pub welcome_timeout: Duration,
    pub backoff: Backoff,
    /// Registration and repository work. Without it, this agent only discovers.
    pub operations: Option<Arc<AgentOperations>>,
    /// Screenshot synchronization, which only needs to hear about the connection and to report.
    pub media: Option<Arc<MediaSync>>,
}

impl ConnectionSettings {
    pub fn new(
        api_url: &Url,
        credential: Secret,
        hello: AgentHello,
        host: Platform,
        emulators: BTreeMap<EmulatorType, EmulatorConfig>,
    ) -> Self {
        Self {
            ws_url: agent_ws_url(api_url),
            credential,
            hello,
            host,
            emulators: Arc::new(emulators),
            scan_limits: ScanLimits::default(),
            connect_timeout: Duration::from_secs(15),
            welcome_timeout: Duration::from_secs(15),
            backoff: Backoff::default(),
            operations: None,
            media: None,
        }
    }
}

/// Runs until asked to stop, or until reconnecting could not help.
pub async fn run(
    settings: ConnectionSettings,
    shutdown: impl Future<Output = ()>,
) -> ConnectionEnd {
    tokio::pin!(shutdown);
    let mut backoff = settings.backoff;
    let mut recent_operations = VecDeque::new();

    loop {
        let started = Instant::now();
        match run_session(&settings, &mut recent_operations, shutdown.as_mut()).await {
            SessionEnd::Final(end) => {
                // Whatever is running ends now, and the journals say how far it got. This also means
                // that a revoked agent stops touching anything at once.
                if let Some(operations) = &settings.operations {
                    operations.shutdown();
                }
                return end;
            }
            SessionEnd::Lost(reason) => {
                if started.elapsed() >= backoff.stable_after {
                    backoff.reset();
                }
                let delay = backoff.next_delay();
                tracing::warn!(%reason, delay_ms = delay.as_millis() as u64, "Connection lost; reconnecting");
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    () = shutdown.as_mut() => {
                        if let Some(operations) = &settings.operations {
                            operations.shutdown();
                        }
                        return ConnectionEnd::Shutdown;
                    }
                }
            }
        }
    }
}

enum SessionEnd {
    Final(ConnectionEnd),
    Lost(String),
}

/// How a close code from the server decides what happens next.
fn end_for_close_code(code: u16) -> Option<ConnectionEnd> {
    match code {
        close_codes::AGENT_REVOKED => Some(ConnectionEnd::CredentialRejected),
        close_codes::SUPERSEDED => Some(ConnectionEnd::Superseded),
        close_codes::UNSUPPORTED_PROTOCOL_VERSION => Some(ConnectionEnd::UnsupportedProtocol),
        _ => None,
    }
}

/// The server's `server.error` codes that mean the same as the close code that follows them.
fn end_for_error_code(code: &str) -> Option<ConnectionEnd> {
    match code {
        "agent_revoked" => Some(ConnectionEnd::CredentialRejected),
        "superseded" => Some(ConnectionEnd::Superseded),
        "unsupported_protocol_version" => Some(ConnectionEnd::UnsupportedProtocol),
        _ => None,
    }
}

const MAX_RECENT_OPERATIONS: usize = 32;

enum ScanOutcome {
    Done(Uuid, Uuid, discovery::DiscoveryReport),
    Failed(Uuid, Uuid),
}

fn text(envelope: &Envelope) -> Result<Frame, String> {
    serde_json::to_string(envelope)
        .map(Frame::text)
        .map_err(|error| error.to_string())
}

/// What running work has to say, or nothing at all for an agent without operations.
async fn next_outbound(
    outbound: &mut Option<tokio::sync::MutexGuard<'_, mpsc::Receiver<Message>>>,
) -> Option<Message> {
    match outbound {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

async fn send_all<S>(sink: &mut S, messages: Vec<Message>) -> Result<(), String>
where
    S: futures_util::Sink<Frame, Error = tungstenite::Error> + Unpin,
{
    for message in messages {
        let frame = text(&Envelope::new(message))?;
        sink.send(frame).await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn run_session<F: Future<Output = ()>>(
    settings: &ConnectionSettings,
    recent_operations: &mut VecDeque<Uuid>,
    mut shutdown: Pin<&mut F>,
) -> SessionEnd {
    let mut request = match settings.ws_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => return SessionEnd::Lost(error.to_string()),
    };
    // Built separately from the URL, and never printed: the header is the only place the token goes.
    let bearer = format!("Bearer {}", settings.credential.expose());
    match bearer.parse() {
        Ok(value) => {
            request.headers_mut().insert(AUTHORIZATION, value);
        }
        Err(_) => return SessionEnd::Final(ConnectionEnd::CredentialRejected),
    }

    let config = WebSocketConfig::default()
        .max_message_size(Some(AGENT_MAX_MESSAGE_BYTES))
        .max_frame_size(Some(AGENT_MAX_MESSAGE_BYTES));
    let connect = tokio_tungstenite::connect_async_with_config(request, Some(config), false);
    let connected = tokio::select! {
        connected = tokio::time::timeout(settings.connect_timeout, connect) => connected,
        () = shutdown.as_mut() => return SessionEnd::Final(ConnectionEnd::Shutdown),
    };
    let stream = match connected {
        Err(_) => return SessionEnd::Lost("connection timed out".to_owned()),
        Ok(Err(tungstenite::Error::Http(response))) => {
            let status = response.status().as_u16();
            if status == 401 || status == 403 {
                return SessionEnd::Final(ConnectionEnd::CredentialRejected);
            }
            return SessionEnd::Lost(format!("server answered {status}"));
        }
        Ok(Err(error)) => return SessionEnd::Lost(error.to_string()),
        Ok(Ok((stream, _response))) => stream,
    };
    let (mut sink, mut source) = stream.split();

    let hello = Envelope::new(Message::AgentHello(settings.hello.clone()));
    let hello_id = hello.id;
    match text(&hello) {
        Ok(frame) => {
            if let Err(error) = sink.send(frame).await {
                return SessionEnd::Lost(error.to_string());
            }
        }
        Err(error) => return SessionEnd::Lost(error),
    }

    // Results come back here from the blocking pool. The scan itself is bounded by its limits.
    let (scan_sender, mut scan_receiver) = mpsc::channel::<ScanOutcome>(1);
    let mut scanning = false;

    // Progress queued while nobody was listening is out of date. Everything that matters is in a
    // journal, and is sent again after the welcome.
    let mut outbound = match &settings.operations {
        Some(operations) => Some(operations.outbound().await),
        None => None,
    };
    if let Some(receiver) = &mut outbound {
        while receiver.try_recv().is_ok() {}
    }

    let welcome_deadline = Instant::now() + settings.welcome_timeout;
    let mut welcomed = false;
    let mut interval = Duration::from_secs(3600);
    let mut heartbeat = tokio::time::interval(interval);
    let mut last_ack = Instant::now();
    let mut unanswered_since: Option<Instant> = None;
    let mut media_status = tokio::time::interval(MEDIA_STATUS_INTERVAL);

    loop {
        let welcome_wait = tokio::time::sleep_until(welcome_deadline.into());
        tokio::select! {
            () = shutdown.as_mut() => {
                // Says goodbye, so that the server marks this agent offline at once.
                let _ = sink.send(normal_close()).await;
                let drain = async {
                    while let Some(Ok(frame)) = source.next().await {
                        if frame.is_close() {
                            break;
                        }
                    }
                };
                let _ = tokio::time::timeout(Duration::from_secs(2), drain).await;
                return SessionEnd::Final(ConnectionEnd::Shutdown);
            }
            () = welcome_wait, if !welcomed => {
                return SessionEnd::Lost("no welcome from the server".to_owned());
            }
            Some(message) = next_outbound(&mut outbound), if welcomed => {
                if let Err(error) = send_all(&mut sink, vec![message]).await {
                    return SessionEnd::Lost(error);
                }
            }
            _ = heartbeat.tick(), if welcomed => {
                // Two intervals and an allowance without an answer means this connection is dead,
                // even if the operating system has not noticed yet.
                let patience = interval * 2 + Duration::from_secs(5);
                if unanswered_since.is_some_and(|since| since.elapsed() >= patience) {
                    return SessionEnd::Lost(format!(
                        "no heartbeat answer for {} seconds",
                        last_ack.elapsed().as_secs()
                    ));
                }
                let beat = Envelope::new(Message::AgentHeartbeat(Empty {}));
                match text(&beat) {
                    Ok(frame) => {
                        if let Err(error) = sink.send(frame).await {
                            return SessionEnd::Lost(error.to_string());
                        }
                    }
                    Err(error) => return SessionEnd::Lost(error),
                }
                unanswered_since.get_or_insert_with(Instant::now);
                if let Some(operations) = &settings.operations {
                    if let Err(error) = send_all(&mut sink, operations.pending_reports()).await {
                        return SessionEnd::Lost(error);
                    }
                }
            }
            _ = media_status.tick(), if welcomed && settings.media.is_some() => {
                let message = settings.media.as_ref().and_then(|media| media.status_message());
                if let Some(message) = message {
                    if let Err(error) = send_all(&mut sink, vec![message]).await {
                        return SessionEnd::Lost(error);
                    }
                }
            }
            Some(outcome) = scan_receiver.recv() => {
                scanning = false;
                let envelope = match outcome {
                    ScanOutcome::Done(operation_id, request_id, report) => {
                        tracing::info!(
                            %operation_id,
                            vms = report.vms.len(),
                            skipped = report.skipped.len(),
                            "Discovery finished"
                        );
                        Envelope::answering(
                            Message::AgentDiscoveryResult(DiscoveryResult { operation_id, report }),
                            request_id,
                        )
                    }
                    ScanOutcome::Failed(operation_id, request_id) => Envelope::answering(
                        Message::AgentDiscoveryError(DiscoveryError {
                            operation_id,
                            code: DiscoveryErrorCode::ScanFailed,
                            message: "The scan could not be completed".to_owned(),
                        }),
                        request_id,
                    ),
                };
                match text(&envelope) {
                    Ok(frame) => {
                        if let Err(error) = sink.send(frame).await {
                            return SessionEnd::Lost(error.to_string());
                        }
                    }
                    Err(error) => return SessionEnd::Lost(error),
                }
            }
            frame = source.next() => {
                let frame = match frame {
                    None => return SessionEnd::Lost("the server closed the connection".to_owned()),
                    Some(Err(error)) => return SessionEnd::Lost(error.to_string()),
                    Some(Ok(frame)) => frame,
                };
                let body = match frame {
                    Frame::Text(body) => body,
                    Frame::Close(close) => {
                        let code = close.as_ref().map(|close| u16::from(close.code));
                        if let Some(end) = code.and_then(end_for_close_code) {
                            return SessionEnd::Final(end);
                        }
                        return SessionEnd::Lost(format!("the server closed the connection ({code:?})"));
                    }
                    // Pings are answered by the library. Nothing else is part of the protocol.
                    _ => continue,
                };
                match decode(body.as_str()) {
                    Decoded::Malformed => tracing::warn!("Ignored a malformed message from the server"),
                    Decoded::UnknownType(message_type) => {
                        tracing::debug!(%message_type, "Ignored a message type this version does not know");
                    }
                    Decoded::UnsupportedVersion(version) => {
                        tracing::error!(version, "The server sent another protocol version");
                        return SessionEnd::Final(ConnectionEnd::UnsupportedProtocol);
                    }
                    Decoded::InvalidPayload { message_type, operation_id } => {
                        tracing::warn!(%message_type, "Refused an invalid message from the server");
                        if let (true, Some(operation_id), Some(operations)) = (
                            message_type == "server.registration_request",
                            operation_id,
                            &settings.operations,
                        ) {
                            operations.refuse_invalid(operation_id);
                        }
                        if let (true, Some(operation_id), Some(operations)) = (
                            message_type == "server.restore_request",
                            operation_id,
                            &settings.operations,
                        ) {
                            operations.refuse_invalid_restore(operation_id);
                        }
                        if let (true, Some(operation_id), Some(operations)) = (
                            message_type == "server.vm_verify",
                            operation_id,
                            &settings.operations,
                        ) {
                            operations.refuse_invalid_verification(operation_id);
                        }
                        // An invalid launch starts nothing. The server's session expires unanswered,
                        // since a failed session cannot be described without the identities it lacks.
                        if let (true, Some(operation_id)) =
                            (message_type == "server.discovery_request", operation_id)
                        {
                            let refusal = Envelope::new(Message::AgentDiscoveryError(DiscoveryError {
                                operation_id,
                                code: DiscoveryErrorCode::InvalidRequest,
                                message: "The request failed validation".to_owned(),
                            }));
                            if let Ok(frame) = text(&refusal) {
                                if let Err(error) = sink.send(frame).await {
                                    return SessionEnd::Lost(error.to_string());
                                }
                            }
                        }
                    }
                    Decoded::Message(envelope) => match envelope.message {
                        Message::ServerWelcome(welcome) => {
                            if envelope.correlation_id != Some(hello_id) {
                                tracing::warn!("Ignored a welcome that answers something else");
                                continue;
                            }
                            welcomed = true;
                            interval = Duration::from_secs(
                                u64::from(welcome.heartbeat_interval_seconds).clamp(1, 300),
                            );
                            heartbeat = tokio::time::interval_at(
                                tokio::time::Instant::now() + interval,
                                interval,
                            );
                            last_ack = Instant::now();
                            tracing::info!(agent_id = %welcome.agent_id, "Connected to the server");
                            if let Some(operations) = &settings.operations {
                                if let Err(error) = send_all(&mut sink, operations.sync_messages()).await {
                                    return SessionEnd::Lost(error);
                                }
                            }
                            if let Some(media) = &settings.media {
                                media.on_connected();
                            }
                        }
                        Message::ServerHeartbeatAck(_) => {
                            last_ack = Instant::now();
                            unanswered_since = None;
                        }
                        Message::ServerError(error) => {
                            tracing::warn!(code = %error.code, message = %error.message, "Server reported an error");
                            if let Some(end) = end_for_error_code(&error.code) {
                                return SessionEnd::Final(end);
                            }
                        }
                        Message::ServerDiscoveryRequest(request) => {
                            let operation_id = request.operation_id;
                            if !welcomed {
                                tracing::warn!("Ignored a discovery request before the welcome");
                            } else if recent_operations.contains(&operation_id) {
                                tracing::warn!(%operation_id, "Ignored a repeated discovery request");
                            } else if scanning {
                                let busy = Envelope::answering(
                                    Message::AgentDiscoveryError(DiscoveryError {
                                        operation_id,
                                        code: DiscoveryErrorCode::Busy,
                                        message: "A scan is already running".to_owned(),
                                    }),
                                    envelope.id,
                                );
                                if let Ok(frame) = text(&busy) {
                                    if let Err(error) = sink.send(frame).await {
                                        return SessionEnd::Lost(error.to_string());
                                    }
                                }
                            } else {
                                if recent_operations.len() >= MAX_RECENT_OPERATIONS {
                                    recent_operations.pop_front();
                                }
                                recent_operations.push_back(operation_id);
                                tracing::info!(%operation_id, "Discovery requested");
                                scanning = true;
                                start_scan(settings, operation_id, envelope.id, scan_sender.clone());
                            }
                        }
                        message @ (Message::ServerRegistrationRequest(_)
                        | Message::ServerRegistrationCancel(_)
                        | Message::ServerRegistrationAck(_)
                        | Message::ServerRepositoryHealthRequest(_)
                        | Message::ServerRegistrationRetryCleanup(_)
                        | Message::ServerRestoreRequest(_)
                        | Message::ServerRestoreCancel(_)
                        | Message::ServerRestoreAck(_)
                        | Message::ServerVmLaunch(_)
                        | Message::ServerVmStop(_)
                        | Message::ServerVmExecutionAck(_)
                        | Message::ServerVmVerify(_)
                        | Message::ServerVmVerifyAck(_)) => {
                            match &settings.operations {
                                Some(operations) if welcomed => operations.handle(message),
                                _ => tracing::warn!("Ignored a repository command"),
                            }
                        }
                        other => {
                            // Well-formed, but not something a server can say.
                            tracing::warn!(?other, "Ignored a message that only an agent can send");
                        }
                    },
                }
            }
        }
    }
}

/// Filesystem work belongs on the blocking pool, so that heartbeats continue during a slow scan.
fn start_scan(
    settings: &ConnectionSettings,
    operation_id: Uuid,
    request_id: Uuid,
    results: mpsc::Sender<ScanOutcome>,
) {
    let emulators = Arc::clone(&settings.emulators);
    let host = settings.host;
    let limits = settings.scan_limits;
    tokio::spawn(async move {
        let scan =
            tokio::task::spawn_blocking(move || discovery::scan(&emulators, host, &limits)).await;
        let outcome = match scan {
            Ok(report) => ScanOutcome::Done(operation_id, request_id, report),
            Err(error) => {
                tracing::error!(%error, "Discovery failed");
                ScanOutcome::Failed(operation_id, request_id)
            }
        };
        // If the session has ended, there is nobody to tell. The server has already given up on it.
        let _ = results.send(outcome).await;
    });
}

/// A close frame for a stream this agent is ending on purpose.
fn normal_close() -> Frame {
    Frame::Close(Some(CloseFrame {
        code: CloseCode::Normal,
        reason: "agent stopping".into(),
    }))
}
