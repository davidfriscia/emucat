//! Runs the pairing client against a scripted HTTP server on this computer. The TypeScript tests
//! exercise the real server's side, and `apps/api/e2e` runs both together.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::credentials::{CredentialStore, MemoryCredentialStore};
use emucat_agent::pairing::{
    PairingError, PairingRequest, default_agent_name, pair, sanitize_agent_name,
};
use emucat_agent::platform::{Architecture, Platform};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    authorization: Option<String>,
    body: String,
}

/// Answers each request with the next scripted (status, headers, JSON) reply.
async fn scripted_server(replies: Vec<(u16, &'static str, Value)>) -> (Url, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for (status, headers, body) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let read = stream.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
                    break end;
                }
            };
            let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            while buffer.len() < header_end + 4 + length {
                let read = stream.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..read]);
            }
            log.lock().unwrap().push(Seen {
                path: head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned(),
                authorization: head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_owned())
                }),
                body: String::from_utf8_lossy(&buffer[header_end + 4..]).into_owned(),
            });
            let text = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{text}",
                text.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (url, seen)
}

fn request() -> PairingRequest {
    PairingRequest {
        name: "Test machine".to_owned(),
        platform: Platform::Windows,
        architecture: Architecture::X86_64,
        agent_version: "1.2.3".to_owned(),
        protocol_version: 1,
    }
}

const SECRET: &str = "emucat_pairing_secret_value_for_tests";
const CREDENTIAL: &str = "emucat_agent_credential_value_for_tests";
const AGENT_ID: &str = "018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63";

fn created(code: &str) -> (u16, &'static str, Value) {
    (
        201,
        "",
        json!({
            "pairingCode": code,
            "pollingSecret": SECRET,
            "expiresAt": "2099-01-01T00:00:00.000Z",
            "pollIntervalSeconds": 1,
        }),
    )
}

fn pending() -> (u16, &'static str, Value) {
    (
        200,
        "",
        json!({ "status": "pending", "expiresAt": "2099-01-01T00:00:00.000Z" }),
    )
}

fn never() -> impl std::future::Future<Output = ()> {
    std::future::pending()
}

#[tokio::test]
async fn pairs_stores_the_credential_and_tells_the_person_the_code() {
    let (url, seen) = scripted_server(vec![
        created("ABCD-2345"),
        pending(),
        (
            200,
            "",
            json!({ "status": "approved", "agentId": AGENT_ID, "credential": CREDENTIAL }),
        ),
    ])
    .await;
    let store = MemoryCredentialStore::default();
    let mut shown = None;
    let stored = pair(
        &url,
        &request(),
        &store,
        |code, _| shown = Some(code.to_owned()),
        never(),
    )
    .await
    .unwrap();

    assert_eq!(shown.as_deref(), Some("ABCD-2345"));
    assert_eq!(stored.agent_id.to_string(), AGENT_ID);
    assert_eq!(stored.credential.expose(), CREDENTIAL);
    assert!(stored.belongs_to(&url));
    assert_eq!(store.load().unwrap(), Some(stored));

    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].path, "/api/v1/agent/pairing/requests");
    let body: Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(
        body,
        json!({
            "name": "Test machine",
            "platform": "windows",
            "architecture": "x86_64",
            "agentVersion": "1.2.3",
            "protocolVersion": 1,
        })
    );
    assert_eq!(seen[1].path, "/api/v1/agent/pairing/poll");
    assert_eq!(
        seen[1].authorization.as_deref(),
        Some(format!("Bearer {SECRET}").as_str())
    );
    assert!(!seen[1].path.contains(SECRET));
}

async fn outcome_of_poll(reply: (u16, &'static str, Value)) -> PairingError {
    let (url, _) = scripted_server(vec![created("ABCD-2345"), reply]).await;
    let store = MemoryCredentialStore::default();
    let error = pair(&url, &request(), &store, |_, _| {}, never())
        .await
        .unwrap_err();
    assert_eq!(store.load().unwrap(), None, "nothing is stored on failure");
    error
}

#[tokio::test]
async fn reports_rejection() {
    let error = outcome_of_poll((200, "", json!({ "status": "rejected" }))).await;
    assert!(matches!(error, PairingError::Rejected), "{error}");
}

#[tokio::test]
async fn reports_expiry() {
    let error = outcome_of_poll((200, "", json!({ "status": "expired" }))).await;
    assert!(matches!(error, PairingError::Expired), "{error}");
}

#[tokio::test]
async fn reports_a_credential_that_went_astray() {
    let error = outcome_of_poll((200, "", json!({ "status": "consumed" }))).await;
    assert!(matches!(error, PairingError::Consumed), "{error}");
}

#[tokio::test]
async fn reports_a_refused_secret() {
    let error = outcome_of_poll((
        401,
        "",
        json!({ "error": { "code": "invalid_pairing_secret", "message": "Unknown", "requestId": "r" } }),
    ))
    .await;
    assert!(
        matches!(error, PairingError::Refused { status: 401, .. }),
        "{error}"
    );
}

#[tokio::test]
async fn a_redirect_is_not_followed_with_a_secret() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let location: &'static str =
        Box::leak(format!("location: http://127.0.0.1:{port}/stolen\r\n").into_boxed_str());
    let error = outcome_of_poll((307, location, json!({}))).await;
    assert!(
        matches!(error, PairingError::Refused { status: 307, .. }),
        "{error}"
    );
    let reached = tokio::time::timeout(Duration::from_millis(200), target.accept()).await;
    assert!(reached.is_err(), "the redirect target was contacted");
}

#[tokio::test]
async fn retries_after_a_server_error_and_a_rate_limit() {
    let (url, _) = scripted_server(vec![
        created("ABCD-2345"),
        (
            500,
            "",
            json!({ "error": { "code": "internal_error", "message": "x", "requestId": "r" } }),
        ),
        (
            429,
            "retry-after: 1\r\n",
            json!({ "error": { "code": "rate_limited", "message": "x", "requestId": "r" } }),
        ),
        (
            200,
            "",
            json!({ "status": "approved", "agentId": AGENT_ID, "credential": CREDENTIAL }),
        ),
    ])
    .await;
    let store = MemoryCredentialStore::default();
    pair(&url, &request(), &store, |_, _| {}, never())
        .await
        .unwrap();
    assert!(store.load().unwrap().is_some());
}

#[tokio::test]
async fn refuses_to_print_anything_but_a_code() {
    let (url, _) = scripted_server(vec![created("\u{1b}[2Jnot a code")]).await;
    let mut shown = false;
    let error = pair(
        &url,
        &request(),
        &MemoryCredentialStore::default(),
        |_, _| shown = true,
        never(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, PairingError::InvalidResponse), "{error}");
    assert!(!shown);
}

#[tokio::test]
async fn can_be_cancelled_while_waiting() {
    let (url, _) = scripted_server(vec![created("ABCD-2345"), pending(), pending()]).await;
    let error = pair(
        &url,
        &request(),
        &MemoryCredentialStore::default(),
        |_, _| {},
        async {},
    )
    .await
    .unwrap_err();
    assert!(matches!(error, PairingError::Cancelled), "{error}");
}

#[tokio::test]
async fn refuses_a_remote_server_over_plain_http_before_sending_anything() {
    let url: Url = "http://emucat.invalid:4000".parse().unwrap();
    let error = pair(
        &url,
        &request(),
        &MemoryCredentialStore::default(),
        |_, _| {},
        never(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, PairingError::Transport(_)), "{error}");
}

#[test]
fn names_are_reduced_to_what_the_server_accepts() {
    assert_eq!(sanitize_agent_name("  Desk  ").as_deref(), Some("Desk"));
    assert_eq!(sanitize_agent_name("a\u{7}b\nc").as_deref(), Some("abc"));
    assert_eq!(sanitize_agent_name("   "), None);
    assert_eq!(sanitize_agent_name(&"x".repeat(300)).unwrap().len(), 128);
    let env = |name: &str| (name == "COMPUTERNAME").then(|| "DESK-1".to_owned());
    assert_eq!(default_agent_name(&env), "DESK-1");
    assert_eq!(default_agent_name(&|_| None), "emucat-agent");
}
