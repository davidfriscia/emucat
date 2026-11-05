//! Device-style pairing, from the agent's side. See "Pairing" in the protocol documentation.
//!
//! The agent asks the server for a code, shows it to a person, and polls with a secret that only it
//! knows until that person has decided. The credential it finally receives goes straight to the
//! credential store.

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::OffsetDateTime;
use url::Url;
use uuid::Uuid;

use crate::connectivity::{TransportError, check_transport};
use crate::credentials::{
    CredentialError, CredentialStore, Secret, StoredCredential, server_origin,
};
use crate::platform::{Architecture, Platform};

pub const PAIRING_CODE_LENGTH: usize = 8;
const PAIRING_CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const AGENT_NAME_MAX_LENGTH: usize = 128;

/// The canonical form of a code, or `None` if it cannot be one. Mirrors `normalizePairingCode` in the
/// contracts. The agent uses it to refuse to print anything but a code from what the server sent.
pub fn normalize_pairing_code(input: &str) -> Option<String> {
    let code: String = input
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .map(|character| match character.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    let valid = code.len() == PAIRING_CODE_LENGTH
        && code
            .chars()
            .all(|character| PAIRING_CODE_ALPHABET.contains(character));
    valid.then_some(code)
}

pub fn format_pairing_code(canonical: &str) -> String {
    let (first, second) = canonical.split_at(PAIRING_CODE_LENGTH / 2);
    format!("{first}-{second}")
}

/// A name for the agent's identity, cut down to what the server accepts.
pub fn sanitize_agent_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(AGENT_NAME_MAX_LENGTH)
        .collect();
    let cleaned = cleaned.trim().to_owned();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// The computer's name, as the default label for this agent.
pub fn default_agent_name(env: &dyn Fn(&str) -> Option<String>) -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .find_map(env)
        .and_then(|name| sanitize_agent_name(&name))
        .unwrap_or_else(|| "emucat-agent".to_owned())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub name: String,
    pub platform: Platform,
    pub architecture: Architecture,
    pub agent_version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedRequest {
    pairing_code: String,
    polling_secret: Secret,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    poll_interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PollResponse {
    Pending,
    #[serde(rename_all = "camelCase")]
    Approved {
        agent_id: Uuid,
        credential: Secret,
    },
    Rejected,
    Expired,
    Consumed,
}

#[derive(Debug, Error)]
pub enum PairingError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("cannot reach the server: {0}")]
    Unreachable(String),
    #[error("the server refused the request ({status}): {message}")]
    Refused { status: u16, message: String },
    #[error("the server sent an invalid response")]
    InvalidResponse,
    #[error("an administrator rejected this pairing request")]
    Rejected,
    #[error("the pairing request expired. Run `emucat-agent pair` again")]
    Expired,
    #[error(
        "this pairing request was already completed, but the credential did not reach this agent. \
         Revoke the unused agent in the web app and run `emucat-agent pair` again"
    )]
    Consumed,
    #[error("pairing was cancelled")]
    Cancelled,
    #[error(transparent)]
    Credential(#[from] CredentialError),
}

fn http_client() -> Result<reqwest::Client, PairingError> {
    reqwest::Client::builder()
        // A redirect could carry a bearer secret to another server, or from https down to http.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| PairingError::Unreachable(error.without_url().to_string()))
}

fn endpoint(api_url: &Url, path: &str) -> Url {
    let mut url = api_url.clone();
    let base = api_url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{path}"));
    url
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ErrorDetail {
    message: String,
}

async fn refusal(response: reqwest::Response) -> PairingError {
    let status = response.status().as_u16();
    let message = response
        .json::<ErrorBody>()
        .await
        .map_or_else(|_| "no details".to_owned(), |body| body.error.message);
    PairingError::Refused { status, message }
}

/// How long to wait after a failed poll. The request stays valid, so a network problem is only delay.
const POLL_RETRY_DELAY: Duration = Duration::from_secs(5);

/// Runs one pairing to the end, and saves the credential. `announce` receives the code to show.
pub async fn pair(
    api_url: &Url,
    request: &PairingRequest,
    store: &dyn CredentialStore,
    announce: impl FnOnce(&str, OffsetDateTime),
    cancelled: impl Future<Output = ()>,
) -> Result<StoredCredential, PairingError> {
    check_transport(api_url)?;
    let client = http_client()?;

    let response = client
        .post(endpoint(api_url, "/api/v1/agent/pairing/requests"))
        .json(request)
        .send()
        .await
        .map_err(|error| PairingError::Unreachable(error.without_url().to_string()))?;
    if !response.status().is_success() {
        return Err(refusal(response).await);
    }
    let created: CreatedRequest = response
        .json()
        .await
        .map_err(|_| PairingError::InvalidResponse)?;
    let code =
        normalize_pairing_code(&created.pairing_code).ok_or(PairingError::InvalidResponse)?;
    announce(&format_pairing_code(&code), created.expires_at);

    let poll = poll_until_decided(
        &client,
        api_url,
        &created.polling_secret,
        created.poll_interval_seconds.clamp(1, 60),
        created.expires_at,
    );
    tokio::pin!(poll, cancelled);
    let (agent_id, credential) = tokio::select! {
        outcome = &mut poll => outcome?,
        () = &mut cancelled => return Err(PairingError::Cancelled),
    };

    let stored = StoredCredential {
        server_origin: server_origin(api_url),
        agent_id,
        credential,
    };
    store.save(&stored)?;
    Ok(stored)
}

async fn poll_until_decided(
    client: &reqwest::Client,
    api_url: &Url,
    secret: &Secret,
    interval_seconds: u64,
    expires_at: OffsetDateTime,
) -> Result<(Uuid, Secret), PairingError> {
    let url = endpoint(api_url, "/api/v1/agent/pairing/poll");
    let mut delay = Duration::from_secs(interval_seconds);
    loop {
        tokio::time::sleep(delay).await;
        delay = Duration::from_secs(interval_seconds);

        let response = match client
            .post(url.clone())
            .bearer_auth(secret.expose())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // Give up only when the request could no longer succeed anyway.
                if OffsetDateTime::now_utc() > expires_at + Duration::from_secs(300) {
                    return Err(PairingError::Unreachable(error.without_url().to_string()));
                }
                tracing::warn!(error = %error.without_url(), "Pairing poll failed; retrying");
                delay = POLL_RETRY_DELAY.max(delay);
                continue;
            }
        };
        let status = response.status();
        if status.as_u16() == 429 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok())
                .unwrap_or(POLL_RETRY_DELAY.as_secs());
            delay = Duration::from_secs(retry_after.clamp(1, 900));
            continue;
        }
        if status.is_server_error() {
            tracing::warn!(status = status.as_u16(), "Pairing poll failed; retrying");
            delay = POLL_RETRY_DELAY.max(delay);
            continue;
        }
        if !status.is_success() {
            return Err(refusal(response).await);
        }
        match response
            .json::<PollResponse>()
            .await
            .map_err(|_| PairingError::InvalidResponse)?
        {
            PollResponse::Pending => {}
            PollResponse::Approved {
                agent_id,
                credential,
            } => return Ok((agent_id, credential)),
            PollResponse::Rejected => return Err(PairingError::Rejected),
            PollResponse::Expired => return Err(PairingError::Expired),
            PollResponse::Consumed => return Err(PairingError::Consumed),
        }
    }
}
