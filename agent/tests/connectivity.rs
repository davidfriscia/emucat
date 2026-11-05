//! Runs the connection loop against a real WebSocket server on this computer. The TypeScript tests
//! exercise the real server's side of the same protocol, and `apps/api/e2e` runs both together.

// The closures that a WebSocket handshake takes have this error type by the library's design.
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use emucat_agent::config::EmulatorConfig;
use emucat_agent::connectivity::{
    Backoff, ConnectionEnd, ConnectionSettings, TransportError, check_transport, run,
};
use emucat_agent::credentials::Secret;
use emucat_agent::emulators::EmulatorType;
use emucat_agent::platform::{Architecture, Platform};
use emucat_agent::protocol::{AgentHello, Message, close_codes};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use url::Url;
use uuid::Uuid;

const TOKEN: &str = "emucat_agent_test_token_value";
const AGENT_ID: &str = "018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63";
const LONG: Duration = Duration::from_secs(20);

type Socket = WebSocketStream<TcpStream>;

async fn listener() -> (TcpListener, Url) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    (listener, url)
}

fn settings(api_url: &Url, base: Option<&Path>) -> ConnectionSettings {
    let emulators = base
        .map(|base| {
            BTreeMap::from([(
                EmulatorType::Box86,
                EmulatorConfig {
                    base_path: base.to_path_buf(),
                    executable: "unused".into(),
                },
            )])
        })
        .unwrap_or_default();
    let mut settings = ConnectionSettings::new(
        api_url,
        Secret::new(TOKEN),
        AgentHello {
            agent_version: "1.2.3".to_owned(),
            platform: Platform::Windows,
            architecture: Architecture::X86_64,
        },
        Platform::Windows,
        emulators,
    );
    settings.backoff = Backoff::new(
        Duration::from_millis(20),
        Duration::from_millis(100),
        Duration::from_secs(60),
    );
    settings
}

/// Accepts one connection and checks its credential, without which it answers 401.
async fn accept(listener: &TcpListener) -> Socket {
    let (stream, _) = listener.accept().await.unwrap();
    tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer {TOKEN}")
        );
        assert_eq!(request.uri().path(), "/api/v1/agent/ws");
        assert_eq!(
            request.uri().query(),
            None,
            "a token must not be in the URL"
        );
        Ok::<_, ErrorResponse>(response)
    })
    .await
    .unwrap()
}

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(LONG, socket.next())
            .await
            .expect("timed out waiting for the agent")
            .expect("the agent closed the connection")
            .unwrap()
        {
            Frame::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Frame::Close(_) => panic!("the agent closed the connection"),
            _ => {}
        }
    }
}

fn server_message(message_type: &str, correlation: Option<&Value>, payload: Value) -> Frame {
    let mut envelope = json!({
        "protocolVersion": 1,
        "id": Uuid::new_v4(),
        "sentAt": "2026-01-31T15:30:00Z",
        "type": message_type,
        "payload": payload,
    });
    if let Some(correlation) = correlation {
        envelope["correlationId"] = correlation.clone();
    }
    Frame::text(envelope.to_string())
}

/// Reads the agent's hello, checks it, and welcomes the agent.
async fn welcome(socket: &mut Socket, heartbeat_seconds: u32) {
    let hello = next_json(socket).await;
    assert_eq!(hello["type"], "agent.hello");
    assert_eq!(hello["payload"]["agentVersion"], "1.2.3");
    assert_eq!(hello["payload"]["platform"], "windows");
    socket
        .send(server_message(
            "server.welcome",
            Some(&hello["id"]),
            json!({ "agentId": AGENT_ID, "heartbeatIntervalSeconds": heartbeat_seconds }),
        ))
        .await
        .unwrap();
}

async fn close_with(socket: &mut Socket, code: u16) {
    socket
        .send(Frame::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: "test".into(),
        })))
        .await
        .unwrap();
}

/// A stop signal for the agent, and a way of waiting for the loop to end.
fn start(
    settings: ConnectionSettings,
) -> (oneshot::Sender<()>, tokio::task::JoinHandle<ConnectionEnd>) {
    let (stop, stopped) = oneshot::channel::<()>();
    let handle = tokio::spawn(run(settings, async move {
        let _ = stopped.await;
    }));
    (stop, handle)
}

async fn finished(handle: tokio::task::JoinHandle<ConnectionEnd>) -> ConnectionEnd {
    tokio::time::timeout(LONG, handle)
        .await
        .expect("the agent did not stop")
        .unwrap()
}

#[tokio::test]
async fn says_hello_and_sends_heartbeats_on_schedule() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 1).await;
    for _ in 0..2 {
        let beat = next_json(&mut socket).await;
        assert_eq!(beat["type"], "agent.heartbeat");
        assert_eq!(beat["protocolVersion"], 1);
        socket
            .send(server_message(
                "server.heartbeat_ack",
                Some(&beat["id"]),
                json!({}),
            ))
            .await
            .unwrap();
    }
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn closes_politely_when_asked_to_stop() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;
    let _ = stop.send(());
    let frame = tokio::time::timeout(LONG, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Frame::Close(Some(close)) = frame else {
        panic!("expected a close frame, got {frame:?}");
    };
    assert_eq!(u16::from(close.code), 1000);
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn reconnects_after_the_server_goes_away() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));

    let mut first = accept(&listener).await;
    welcome(&mut first, 60).await;
    close_with(&mut first, 1001).await;
    drop(first);

    let mut second = accept(&listener).await;
    welcome(&mut second, 60).await;
    second.send(Frame::Close(None)).await.unwrap();
    drop(second);

    let mut third = accept(&listener).await;
    welcome(&mut third, 60).await;

    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn keeps_trying_while_the_server_is_down() {
    let (listener, url) = listener().await;
    let address = listener.local_addr().unwrap();
    drop(listener);
    let (stop, agent) = start(settings(&url, None));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!agent.is_finished());

    let listener = TcpListener::bind(address).await.unwrap();
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn reconnects_when_heartbeats_go_unanswered() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));
    let mut silent = accept(&listener).await;
    welcome(&mut silent, 1).await;
    // Never acknowledges. The agent gives up on this socket after two intervals and an allowance.
    let again = tokio::time::timeout(Duration::from_secs(15), accept(&listener))
        .await
        .expect("the agent did not reconnect");
    drop(again);
    drop(silent);
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn reconnects_when_no_welcome_arrives() {
    let (listener, url) = listener().await;
    let mut agent_settings = settings(&url, None);
    agent_settings.welcome_timeout = Duration::from_millis(100);
    let (stop, agent) = start(agent_settings);
    let first = accept(&listener).await;
    let second = tokio::time::timeout(LONG, accept(&listener))
        .await
        .expect("the agent did not reconnect");
    drop((first, second));
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn stops_for_good_when_the_credential_is_refused() {
    let (listener, url) = listener().await;
    let (_stop, agent) = start(settings(&url, None));
    let (stream, _) = listener.accept().await.unwrap();
    let refused = tokio_tungstenite::accept_hdr_async(stream, |_: &Request, _: Response| {
        Err::<Response, ErrorResponse>(
            tokio_tungstenite::tungstenite::http::Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(None)
                .unwrap(),
        )
    })
    .await;
    assert!(refused.is_err());
    assert_eq!(finished(agent).await, ConnectionEnd::CredentialRejected);
}

#[tokio::test]
async fn keeps_retrying_when_the_server_fails_rather_than_refuses() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));
    let (stream, _) = listener.accept().await.unwrap();
    let _ = tokio_tungstenite::accept_hdr_async(stream, |_: &Request, _: Response| {
        Err::<Response, ErrorResponse>(
            tokio_tungstenite::tungstenite::http::Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(None)
                .unwrap(),
        )
    })
    .await;
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

async fn closed_by_server_ends_with(code: u16, expected: ConnectionEnd) {
    let (listener, url) = listener().await;
    let (_stop, agent) = start(settings(&url, None));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;
    close_with(&mut socket, code).await;
    assert_eq!(finished(agent).await, expected);
}

#[tokio::test]
async fn stops_when_revoked() {
    closed_by_server_ends_with(
        close_codes::AGENT_REVOKED,
        ConnectionEnd::CredentialRejected,
    )
    .await;
}

#[tokio::test]
async fn stops_when_superseded_rather_than_fighting_over_the_identity() {
    closed_by_server_ends_with(close_codes::SUPERSEDED, ConnectionEnd::Superseded).await;
}

#[tokio::test]
async fn stops_on_a_protocol_mismatch() {
    closed_by_server_ends_with(
        close_codes::UNSUPPORTED_PROTOCOL_VERSION,
        ConnectionEnd::UnsupportedProtocol,
    )
    .await;
}

#[tokio::test]
async fn stops_when_the_server_reports_revocation_before_closing() {
    let (listener, url) = listener().await;
    let (_stop, agent) = start(settings(&url, None));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;
    socket
        .send(server_message(
            "server.error",
            None,
            json!({ "code": "agent_revoked", "message": "revoked" }),
        ))
        .await
        .unwrap();
    assert_eq!(finished(agent).await, ConnectionEnd::CredentialRejected);
}

#[tokio::test]
async fn survives_garbage_and_unknown_messages() {
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, None));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 1).await;
    for frame in [
        Frame::text("not json"),
        Frame::text("{}"),
        Frame::text("[1,2,3]"),
        Frame::binary(vec![1u8, 2, 3]),
        server_message("server.something_new", None, json!({ "x": 1 })),
        server_message("server.welcome", None, json!({ "wrong": true })),
        server_message("agent.heartbeat", None, json!({})),
    ] {
        socket.send(frame).await.unwrap();
    }
    assert_eq!(next_json(&mut socket).await["type"], "agent.heartbeat");
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

fn discovery_request(operation_id: Uuid) -> Frame {
    server_message(
        "server.discovery_request",
        None,
        json!({ "operationId": operation_id }),
    )
}

/// The next message that is not a heartbeat.
async fn next_report(socket: &mut Socket) -> Value {
    loop {
        let message = next_json(socket).await;
        if message["type"] != "agent.heartbeat" {
            return message;
        }
    }
}

#[tokio::test]
async fn answers_a_discovery_request_with_a_correlated_report() {
    let base = TempDir::new().unwrap();
    std::fs::create_dir(base.path().join("Win98")).unwrap();
    std::fs::write(base.path().join("Win98").join("86box.cfg"), b"x").unwrap();

    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, Some(base.path())));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;

    let operation_id = Uuid::new_v4();
    let request = discovery_request(operation_id);
    let request_id =
        serde_json::from_str::<Value>(request.to_text().unwrap()).unwrap()["id"].clone();
    socket.send(request).await.unwrap();

    let report = next_report(&mut socket).await;
    assert_eq!(report["type"], "agent.discovery_result");
    assert_eq!(report["correlationId"], request_id);
    assert_eq!(report["payload"]["operationId"], operation_id.to_string());
    assert_eq!(report["payload"]["hostPlatform"], "windows");
    assert_eq!(report["payload"]["vms"][0]["vmName"], "Win98");
    assert_eq!(report["payload"]["vms"][0]["emulatorType"], "86box");
    assert_eq!(report["payload"].get("agentId"), None);
    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn ignores_a_repeated_operation_and_refuses_an_invalid_request() {
    let base = TempDir::new().unwrap();
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, Some(base.path())));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 60).await;

    let operation_id = Uuid::new_v4();
    socket.send(discovery_request(operation_id)).await.unwrap();
    assert_eq!(
        next_report(&mut socket).await["type"],
        "agent.discovery_result"
    );
    socket.send(discovery_request(operation_id)).await.unwrap();

    // Extra instructions make a request invalid: a server cannot point a scan anywhere.
    let unknown_field = Uuid::new_v4();
    socket
        .send(server_message(
            "server.discovery_request",
            None,
            json!({ "operationId": unknown_field, "path": "C:\\Windows" }),
        ))
        .await
        .unwrap();
    let refusal = next_report(&mut socket).await;
    assert_eq!(refusal["type"], "agent.discovery_error");
    assert_eq!(refusal["payload"]["code"], "invalid_request");
    assert_eq!(refusal["payload"]["operationId"], unknown_field.to_string());

    socket
        .send(server_message(
            "server.discovery_request",
            None,
            json!({ "operationId": "not-a-uuid" }),
        ))
        .await
        .unwrap();

    // The connection is still healthy, and nothing was answered for the repeat or the bad ID.
    let fresh = Uuid::new_v4();
    socket.send(discovery_request(fresh)).await.unwrap();
    let report = next_report(&mut socket).await;
    assert_eq!(report["type"], "agent.discovery_result");
    assert_eq!(report["payload"]["operationId"], fresh.to_string());

    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[tokio::test]
async fn a_scan_does_not_stop_the_connection_from_working() {
    let base = TempDir::new().unwrap();
    for index in 0..200 {
        std::fs::create_dir(base.path().join(format!("Vm{index}"))).unwrap();
    }
    let (listener, url) = listener().await;
    let (stop, agent) = start(settings(&url, Some(base.path())));
    let mut socket = accept(&listener).await;
    welcome(&mut socket, 1).await;

    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    socket.send(discovery_request(first)).await.unwrap();
    socket.send(discovery_request(second)).await.unwrap();

    let mut kinds = Vec::new();
    for _ in 0..2 {
        let message = next_report(&mut socket).await;
        kinds.push((
            message["payload"]["operationId"]
                .as_str()
                .unwrap()
                .to_owned(),
            message["type"].as_str().unwrap().to_owned(),
        ));
    }
    // The second arrives while the first runs, unless the first was very quick.
    let first_answer = kinds
        .iter()
        .find(|(id, _)| *id == first.to_string())
        .unwrap();
    assert_eq!(first_answer.1, "agent.discovery_result");
    assert!(kinds.iter().any(|(id, _)| *id == second.to_string()));

    let _ = stop.send(());
    assert_eq!(finished(agent).await, ConnectionEnd::Shutdown);
}

#[test]
fn backoff_grows_to_its_limit_with_jitter_and_resets() {
    let mut backoff = Backoff::new(
        Duration::from_secs(1),
        Duration::from_secs(60),
        Duration::from_secs(60),
    );
    let mut ceiling = 1;
    for _ in 0..10 {
        assert_eq!(backoff.ceiling(), Duration::from_secs(ceiling));
        let delay = backoff.next_delay();
        assert!(delay >= Duration::from_secs(ceiling) / 2, "{delay:?}");
        assert!(delay <= Duration::from_secs(ceiling), "{delay:?}");
        ceiling = (ceiling * 2).min(60);
    }
    assert_eq!(backoff.ceiling(), Duration::from_secs(60));
    for _ in 0..1000 {
        backoff.next_delay();
    }
    assert_eq!(
        backoff.ceiling(),
        Duration::from_secs(60),
        "it must not overflow"
    );
    backoff.reset();
    assert_eq!(backoff.ceiling(), Duration::from_secs(1));
}

#[test]
fn backoff_varies_between_agents() {
    let delays: std::collections::HashSet<_> = (0..20)
        .map(|_| {
            Backoff::new(
                Duration::from_secs(60),
                Duration::from_secs(60),
                Duration::from_secs(60),
            )
            .next_delay()
        })
        .collect();
    assert!(delays.len() > 1, "every delay was the same");
}

#[test]
fn secrets_only_travel_over_tls_or_to_this_computer() {
    let allowed = [
        "https://emucat.example",
        "http://localhost:4000",
        "http://127.0.0.1:4000",
        "http://127.8.8.8:4000",
        "http://[::1]:4000",
    ];
    for url in allowed {
        assert_eq!(check_transport(&url.parse().unwrap()), Ok(()), "{url}");
    }
    let refused = [
        "http://emucat.example",
        "http://192.168.1.10:4000",
        "http://localhost.evil.example",
        "http://127.0.0.1.evil.example",
    ];
    for url in refused {
        assert!(
            matches!(
                check_transport(&url.parse().unwrap()),
                Err(TransportError::InsecureRemote(_))
            ),
            "{url}"
        );
    }
}

#[test]
fn messages_are_known_to_the_decoder() {
    use emucat_agent::protocol::{Decoded, decode};
    assert_eq!(decode("nonsense"), Decoded::Malformed);
    assert_eq!(decode("{}"), Decoded::Malformed);
    assert_eq!(
        decode(r#"{"protocolVersion":2,"type":"x"}"#),
        Decoded::UnsupportedVersion(2)
    );
    let unknown = decode(
        r#"{"protocolVersion":1,"id":"018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65",
            "sentAt":"2026-01-31T15:30:00Z","type":"server.new","payload":{}}"#,
    );
    assert_eq!(unknown, Decoded::UnknownType("server.new".to_owned()));
    let ok = decode(
        r#"{"protocolVersion":1,"id":"018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65",
            "sentAt":"2026-01-31T15:30:00Z","type":"server.heartbeat_ack","payload":{}}"#,
    );
    let Decoded::Message(envelope) = ok else {
        panic!("{ok:?}");
    };
    assert!(matches!(envelope.message, Message::ServerHeartbeatAck(_)));
}
