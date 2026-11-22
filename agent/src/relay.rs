//! Repository transfers through the EmuCat server's HTTPS relay (decision 0055).
//!
//! An agent prefers its own SFTP connection. When it cannot reach a repository at all, it can send and
//! fetch the same objects through the server instead: the agent talks to the API over HTTPS with its own
//! bearer credential, the server stages the bytes on its own disk, and the server talks to the repository
//! over its own SFTP connection, with its own key and its own strict host-key checks. Keys, staging,
//! verification and no-overwrite publication are exactly those of [`crate::sftp`], so the registration
//! workflow cannot tell the two apart.
//!
//! [`FallbackArchiveRepository`] decides which one to use, once per opened repository: SFTP first, and
//! the relay only when SFTP could not reach the repository. An authentication failure, a host-key
//! problem, a permission or integrity failure is never a reason to go around SFTP: those are reported
//! as they are.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use url::Url;
use uuid::Uuid;

use crate::credentials::Secret;
use crate::packaging::hex;
use crate::protocol::PROTOCOL_VERSION;
use crate::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, RepositoryTransport,
    VerifiedObject,
};

/// The header that carries one chunk's SHA-256. Shared with `CHUNK_SHA256_HEADER` in the contracts.
pub const CHUNK_SHA256_HEADER: &str = "x-emucat-chunk-sha256";
/// What a server may configure as its chunk size, and so what this agent accepts.
pub const MIN_CHUNK_BYTES: u64 = 256 * 1024;
pub const MAX_CHUNK_BYTES: u64 = 64 * 1024 * 1024;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const CHUNK_ATTEMPTS: u32 = 4;
const READ_ATTEMPTS: u32 = 4;
const MESSAGE_LIMIT: usize = 512;

/// Where the relay is, and the credential that authenticates this agent to it. The credential is the
/// agent's own, only ever sent in the `Authorization` header to the server it was issued by.
#[derive(Clone)]
pub struct RelayEndpoint {
    pub api_url: Url,
    pub credential: Secret,
}

impl RelayEndpoint {
    pub fn new(api_url: &Url, credential: Secret) -> Self {
        Self {
            api_url: api_url.clone(),
            credential,
        }
    }
}

/// Timeouts for relay requests. Every request is bounded; a transfer is bounded per chunk or per read.
#[derive(Debug, Clone, Copy)]
pub struct RelayTimeouts {
    pub connect: Duration,
    /// For a small JSON request, and for silence while reading a download.
    pub request: Duration,
    /// For one chunk to be sent and acknowledged.
    pub chunk: Duration,
    /// How long the server may take to write or read an object in the repository, beyond the time the
    /// bytes themselves need.
    pub repository_work: Duration,
}

impl RelayTimeouts {
    pub fn from_transfer_timeout(connect: Duration, transfer: Duration) -> Self {
        Self {
            connect,
            request: transfer.max(Duration::from_secs(30)),
            chunk: (transfer * 5).max(Duration::from_secs(120)),
            repository_work: Duration::from_secs(30 * 60),
        }
    }
}

/// The archive store, reached through the server.
pub struct HttpRelayArchiveRepository {
    client: reqwest::Client,
    endpoint: RelayEndpoint,
    repository_id: Uuid,
    timeouts: RelayTimeouts,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayInfo {
    enabled: bool,
    reason: Option<String>,
    chunk_bytes: u64,
    max_object_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct TransferError {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferStatus {
    transfer_id: Uuid,
    state: String,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    chunk_bytes: u64,
    chunk_count: Option<u64>,
    missing_chunks: Vec<(u64, u64)>,
    error: Option<TransferError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyStatus {
    state: String,
    done_bytes: u64,
    total_bytes: u64,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    error: Option<TransferError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatResponse {
    exists: bool,
    size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreeSpaceResponse {
    free_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    host_key_fingerprint: Option<String>,
    root_readable: bool,
    root_writable: bool,
    no_overwrite_publication: bool,
    free_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: TransferError,
}

fn bounded(message: &str) -> String {
    let mut text: String = message.chars().take(MESSAGE_LIMIT).collect();
    if text.len() < message.len() {
        text.push('…');
    }
    text
}

/// What a server's error code means here. Codes are shared with the contracts, and anything unknown
/// is a generic repository error that is not retried.
pub fn kind_of_code(code: &str) -> Kind {
    match code {
        "archive_exists" => Kind::AlreadyExists,
        "remote_object_missing" | "transfer_not_found" => Kind::NotFound,
        "hash_mismatch" | "chunk_hash_mismatch" | "archive_size_mismatch" => Kind::HashMismatch,
        "insufficient_remote_space" | "transfer_staging_full" | "transfer_too_large" => {
            Kind::InsufficientSpace
        }
        "ssh_authentication_failed" => Kind::AuthenticationFailed,
        "host_key_unknown" => Kind::HostKeyUnknown,
        "host_key_changed" => Kind::HostKeyChanged,
        "repository_permission_denied" | "repository_not_authorized" => Kind::PermissionDenied,
        "publication_unsupported" => Kind::PublicationUnsupported,
        "repository_unreachable" => Kind::Unreachable,
        "upload_interrupted" | "transfer_busy" | "transfer_expired" | "rate_limited" => {
            Kind::Interrupted
        }
        // `not_found` is an unknown route: a server from before decision 0055, which has no relay.
        "relay_disabled"
        | "server_repository_unavailable"
        | "repository_disabled"
        | "not_found" => Kind::NotConfigured,
        _ => Kind::Protocol,
    }
}

fn relay_error(kind: Kind, message: &str) -> RepositoryError {
    RepositoryError::new(
        kind,
        format!("Through the server relay: {}", bounded(message)),
    )
}

fn from_transfer_error(error: Option<TransferError>, fallback: &str) -> RepositoryError {
    match error {
        Some(error) => relay_error(kind_of_code(&error.code), &error.message),
        None => relay_error(Kind::Protocol, fallback),
    }
}

fn request_failure(error: reqwest::Error) -> RepositoryError {
    // `without_url`: the address is the configured server's, but nothing about a request is logged.
    let kind = if error.is_connect() {
        Kind::Unreachable
    } else {
        Kind::Interrupted
    };
    relay_error(kind, &error.without_url().to_string())
}

/// Ranges of chunk indexes, inclusive, as the status lists them.
fn expand(ranges: &[(u64, u64)], chunk_count: u64) -> RepositoryResult<Vec<u64>> {
    let mut indexes = Vec::new();
    for &(start, end) in ranges {
        if start > end || end >= chunk_count {
            return Err(relay_error(
                Kind::Protocol,
                "the server listed a chunk that does not exist",
            ));
        }
        indexes.extend(start..=end);
    }
    Ok(indexes)
}

async fn wait_or_cancel(cancel: &CancelFlag, delay: Duration) -> RepositoryResult<()> {
    tokio::select! {
        () = cancel.cancelled() => Err(RepositoryError::cancelled()),
        () = tokio::time::sleep(delay) => Ok(()),
    }
}

/// The file's size and SHA-256, read once before anything is sent.
async fn hash_file(source: &Path, cancel: &CancelFlag) -> RepositoryResult<(u64, String)> {
    let mut file = tokio::fs::File::open(source).await.map_err(|error| {
        RepositoryError::new(Kind::Protocol, format!("Cannot read the file: {error}"))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled());
        }
        let read = file.read(&mut buffer).await.map_err(|error| {
            RepositoryError::new(Kind::Protocol, format!("Cannot read the file: {error}"))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((size, hex(&hasher.finalize())))
}

impl HttpRelayArchiveRepository {
    pub fn new(
        endpoint: RelayEndpoint,
        repository_id: Uuid,
        timeouts: RelayTimeouts,
    ) -> RepositoryResult<Self> {
        let client = reqwest::Client::builder()
            // A redirect could carry the credential somewhere else. The relay never redirects.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeouts.connect)
            .read_timeout(timeouts.request)
            .build()
            .map_err(|error| relay_error(Kind::NotConfigured, &error.without_url().to_string()))?;
        Ok(Self {
            client,
            endpoint,
            repository_id,
            timeouts,
        })
    }

    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.endpoint.api_url.clone();
        let id = self.repository_id.to_string();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty()
                .extend(["api", "v1", "agent", "repositories", id.as_str()])
                .extend(segments);
        }
        url
    }

    fn request(&self, method: reqwest::Method, segments: &[&str]) -> reqwest::RequestBuilder {
        // Built separately from the URL, and never printed: the header is the only place the token goes.
        let mut value = reqwest::header::HeaderValue::from_str(&format!(
            "Bearer {}",
            self.endpoint.credential.expose()
        ))
        .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("Bearer invalid"));
        value.set_sensitive(true);
        self.client
            .request(method, self.url(segments))
            .header(reqwest::header::AUTHORIZATION, value)
            .header("x-emucat-protocol-version", PROTOCOL_VERSION.to_string())
    }

    /// Sends a request, and turns any answer other than a success into a repository error.
    async fn send(&self, request: reqwest::RequestBuilder) -> RepositoryResult<reqwest::Response> {
        let response = request.send().await.map_err(request_failure)?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.bytes().await.unwrap_or_default();
        let parsed = serde_json::from_slice::<ErrorEnvelope>(&body).ok();
        let (kind, message) = match parsed {
            Some(ErrorEnvelope { error }) => {
                let mut kind = kind_of_code(&error.code);
                if kind == Kind::Protocol && (status.is_server_error() || status.as_u16() == 429) {
                    kind = Kind::Interrupted;
                }
                (kind, error.message)
            }
            None if status.as_u16() == 401 || status.as_u16() == 403 => (
                Kind::PermissionDenied,
                "the server did not accept this agent's credential".to_owned(),
            ),
            None if status.as_u16() == 404 => (
                Kind::NotConfigured,
                "this server has no repository relay".to_owned(),
            ),
            None if status.is_server_error() || status.as_u16() == 429 => {
                (Kind::Interrupted, format!("the server answered {status}"))
            }
            None => (Kind::Protocol, format!("the server answered {status}")),
        };
        let kind = match status.as_u16() {
            401 | 403 if kind == Kind::Protocol => Kind::PermissionDenied,
            _ => kind,
        };
        Err(relay_error(kind, &message))
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> RepositoryResult<T> {
        let response = self.send(request.timeout(self.timeouts.request)).await?;
        let bytes = response.bytes().await.map_err(request_failure)?;
        serde_json::from_slice(&bytes)
            .map_err(|_| relay_error(Kind::Protocol, "the server's answer could not be read"))
    }

    async fn empty(&self, request: reqwest::RequestBuilder) -> RepositoryResult<()> {
        self.send(request.timeout(self.timeouts.request)).await?;
        Ok(())
    }

    /// Whether this server relays for this repository, and with what chunk size.
    async fn info(&self) -> RepositoryResult<RelayInfo> {
        let info: RelayInfo = self
            .json(self.request(reqwest::Method::GET, &["relay"]))
            .await?;
        if !info.enabled {
            return Err(relay_error(
                Kind::NotConfigured,
                info.reason
                    .as_deref()
                    .unwrap_or("this server does not relay for this repository"),
            ));
        }
        if !(MIN_CHUNK_BYTES..=MAX_CHUNK_BYTES).contains(&info.chunk_bytes) {
            return Err(relay_error(
                Kind::Protocol,
                "the server's chunk size is outside what this agent accepts",
            ));
        }
        Ok(info)
    }

    fn upload_status(&self, id: Uuid) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, &["uploads", &id.to_string()])
    }

    /// Sends one chunk, trying again while the failure is one that can pass.
    async fn put_chunk(
        &self,
        file: &mut tokio::fs::File,
        transfer: Uuid,
        index: u64,
        chunk_bytes: u64,
        size: u64,
        cancel: &CancelFlag,
    ) -> RepositoryResult<u64> {
        let offset = index * chunk_bytes;
        let length = chunk_bytes.min(size - offset);
        let mut buffer = vec![0u8; usize::try_from(length).unwrap_or(usize::MAX)];
        let unreadable = |error: std::io::Error| {
            RepositoryError::new(Kind::Protocol, format!("Cannot read the file: {error}"))
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(unreadable)?;
        file.read_exact(&mut buffer).await.map_err(unreadable)?;
        let sha = hex(&Sha256::digest(&buffer));
        let body = buffer;
        let mut attempt = 0;
        loop {
            if cancel.is_cancelled() {
                return Err(RepositoryError::cancelled());
            }
            attempt += 1;
            let request = self
                .request(
                    reqwest::Method::PUT,
                    &[
                        "uploads",
                        &transfer.to_string(),
                        "chunks",
                        &index.to_string(),
                    ],
                )
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .header(CHUNK_SHA256_HEADER, sha.as_str())
                .timeout(self.timeouts.chunk)
                .body(body.clone());
            let sent = tokio::select! {
                () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                sent = self.send(request) => sent,
            };
            match sent {
                Ok(_) => return Ok(length),
                Err(error) if error.kind.is_retryable() && attempt < CHUNK_ATTEMPTS => {
                    tracing::warn!(
                        repository_id = %self.repository_id,
                        index,
                        attempt,
                        error = %error,
                        "A chunk did not reach the server; sending it again"
                    );
                    wait_or_cancel(cancel, Duration::from_secs(u64::from(attempt))).await?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Waits for the server's work on a transfer to finish, reporting what it says.
    async fn wait_for_upload(
        &self,
        id: Uuid,
        size: u64,
        cancel: &CancelFlag,
    ) -> RepositoryResult<TransferStatus> {
        let deadline = Instant::now() + self.repository_budget(size);
        loop {
            let status: TransferStatus = self.json(self.upload_status(id)).await?;
            match status.state.as_str() {
                "published" => return Ok(status),
                "receiving" | "received" | "publishing" => {}
                "cancelled" => return Err(RepositoryError::cancelled()),
                _ => {
                    return Err(from_transfer_error(
                        status.error,
                        "the server could not write the object",
                    ));
                }
            }
            if Instant::now() > deadline {
                return Err(relay_error(
                    Kind::Interrupted,
                    "the server took too long to write the object to the repository",
                ));
            }
            wait_or_cancel(cancel, POLL_INTERVAL).await?;
        }
    }

    /// Time for the server to hash and copy an object, on top of a fixed allowance: at least 4 MB/s.
    fn repository_budget(&self, size: u64) -> Duration {
        self.timeouts.repository_work + Duration::from_secs(size / (4 * 1024 * 1024))
    }

    async fn upload_inner(
        &self,
        key: &RepositoryKey,
        source: &Path,
        progress: &ProgressFn,
        cancel: &CancelFlag,
    ) -> RepositoryResult<ObjectMetadata> {
        let info = self.info().await?;
        let (size, sha256) = hash_file(source, cancel).await?;
        if size > info.max_object_bytes {
            return Err(relay_error(
                Kind::InsufficientSpace,
                "the archive is larger than the server can stage",
            ));
        }
        let status: TransferStatus = self
            .json(
                self.request(reqwest::Method::POST, &["uploads"])
                    .json(&serde_json::json!({
                        "key": key.as_str(),
                        "sizeBytes": size,
                        "sha256": sha256,
                    })),
            )
            .await?;
        let id = status.transfer_id;
        let result = async {
            if status.state == "receiving" {
                let chunk_bytes = status.chunk_bytes;
                if chunk_bytes == 0 || chunk_bytes > MAX_CHUNK_BYTES {
                    return Err(relay_error(
                        Kind::Protocol,
                        "the server's chunk size is invalid",
                    ));
                }
                let chunk_count = status.chunk_count.unwrap_or(size.div_ceil(chunk_bytes));
                let missing = expand(&status.missing_chunks, chunk_count)?;
                let missing_bytes: u64 = missing
                    .iter()
                    .map(|index| chunk_bytes.min(size - index * chunk_bytes))
                    .sum();
                let mut done = size - missing_bytes;
                progress(done, size);
                if !missing.is_empty() && missing.len() as u64 != chunk_count {
                    tracing::info!(
                        repository_id = %self.repository_id,
                        remaining = missing.len(),
                        chunk_count,
                        "Resuming an upload through the server relay"
                    );
                }
                let mut file = tokio::fs::File::open(source).await.map_err(|error| {
                    RepositoryError::new(Kind::Protocol, format!("Cannot read the file: {error}"))
                })?;
                for index in missing {
                    done += self
                        .put_chunk(&mut file, id, index, chunk_bytes, size, cancel)
                        .await?;
                    progress(done, size);
                }
                let completed: TransferStatus = self
                    .json(self.request(
                        reqwest::Method::POST,
                        &["uploads", &id.to_string(), "complete"],
                    ))
                    .await?;
                if completed.state == "failed" {
                    return Err(from_transfer_error(
                        completed.error,
                        "the server refused the upload",
                    ));
                }
            } else if status.state == "received" {
                // Every chunk arrived before; only the server's work is left.
                let _: TransferStatus = self
                    .json(self.request(
                        reqwest::Method::POST,
                        &["uploads", &id.to_string(), "complete"],
                    ))
                    .await?;
            }
            let finished = self.wait_for_upload(id, size, cancel).await?;
            if finished.size_bytes.is_some_and(|stored| stored != size)
                || finished
                    .sha256
                    .as_deref()
                    .is_some_and(|stored| stored != sha256)
            {
                return Err(relay_error(
                    Kind::HashMismatch,
                    "the server stored a different object than was sent",
                ));
            }
            progress(size, size);
            Ok(ObjectMetadata { size_bytes: size })
        }
        .await;
        if result
            .as_ref()
            .is_err_and(|error| error.kind == Kind::Cancelled)
        {
            // Best effort: the server also expires abandoned uploads on its own.
            let _ = self
                .empty(self.request(reqwest::Method::DELETE, &["uploads", &id.to_string()]))
                .await;
        }
        result
    }

    async fn download_inner(
        &self,
        key: &RepositoryKey,
        destination: &Path,
        progress: &ProgressFn,
        cancel: &CancelFlag,
    ) -> RepositoryResult<VerifiedObject> {
        let mut status: TransferStatus = self
            .json(
                self.request(reqwest::Method::POST, &["downloads"])
                    .json(&serde_json::json!({ "key": key.as_str() })),
            )
            .await?;
        let id = status.transfer_id;
        // The server fetches the object from the repository and checks it before anything is read.
        let started = Instant::now();
        while status.state == "staging" {
            if let Some(total) = status.size_bytes {
                progress(0, total);
            }
            wait_or_cancel(cancel, POLL_INTERVAL).await?;
            if started.elapsed() > self.repository_budget(status.size_bytes.unwrap_or(0)) {
                return Err(relay_error(
                    Kind::Interrupted,
                    "the server took too long to fetch the object from the repository",
                ));
            }
            status = self
                .json(self.request(reqwest::Method::GET, &["downloads", &id.to_string()]))
                .await?;
        }
        if status.state != "ready" {
            return Err(from_transfer_error(
                status.error,
                "the server could not fetch the object",
            ));
        }
        let (Some(size), Some(expected)) = (status.size_bytes, status.sha256.clone()) else {
            return Err(relay_error(
                Kind::Protocol,
                "the server did not say what it staged",
            ));
        };

        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .await
            .map_err(|error| {
                RepositoryError::new(Kind::Protocol, format!("Cannot create the file: {error}"))
            })?;
        let received = self
            .read_content(id, size, &mut file, progress, cancel)
            .await;
        let received = match received {
            Ok(hasher) => file
                .sync_all()
                .await
                .map(|()| hex(&hasher.finalize()))
                .map_err(|error| {
                    RepositoryError::new(Kind::Protocol, format!("Cannot write locally: {error}"))
                }),
            Err(error) => Err(error),
        };
        drop(file);
        match received {
            Ok(sha256) if sha256 == expected => Ok(VerifiedObject {
                size_bytes: size,
                sha256,
            }),
            Ok(_) => {
                let _ = tokio::fs::remove_file(destination).await;
                Err(relay_error(
                    Kind::HashMismatch,
                    "the downloaded bytes differ from what the server staged",
                ))
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(destination).await;
                Err(error)
            }
        }
    }

    /// Reads the staged object, resuming with a `Range` request after an interruption.
    async fn read_content(
        &self,
        id: Uuid,
        size: u64,
        file: &mut tokio::fs::File,
        progress: &ProgressFn,
        cancel: &CancelFlag,
    ) -> RepositoryResult<Sha256> {
        let mut hasher = Sha256::new();
        let mut offset = 0u64;
        let mut failures = 0;
        progress(0, size);
        if size == 0 {
            return Ok(hasher);
        }
        while offset < size {
            if cancel.is_cancelled() {
                return Err(RepositoryError::cancelled());
            }
            let mut request = self.request(
                reqwest::Method::GET,
                &["downloads", &id.to_string(), "content"],
            );
            if offset > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            }
            let attempt = async {
                let response = self.send(request).await?;
                if offset > 0 {
                    let expected = format!("bytes {offset}-");
                    let range = response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    if response.status().as_u16() != 206 || !range.starts_with(&expected) {
                        return Err(relay_error(
                            Kind::Protocol,
                            "the server did not resume the download where it stopped",
                        ));
                    }
                }
                let mut stream = response.bytes_stream();
                loop {
                    let next = tokio::select! {
                        () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                        next = stream.next() => next,
                    };
                    let Some(chunk) = next else { break };
                    let chunk = chunk.map_err(request_failure)?;
                    if offset + chunk.len() as u64 > size {
                        return Err(relay_error(
                            Kind::Protocol,
                            "the server sent more bytes than the object has",
                        ));
                    }
                    file.write_all(&chunk).await.map_err(|error| {
                        RepositoryError::new(
                            Kind::Protocol,
                            format!("Cannot write locally: {error}"),
                        )
                    })?;
                    hasher.update(&chunk);
                    offset += chunk.len() as u64;
                    progress(offset, size);
                }
                Ok(())
            }
            .await;
            match attempt {
                Ok(()) if offset == size => return Ok(hasher),
                Ok(()) => {
                    failures += 1;
                    if failures >= READ_ATTEMPTS {
                        return Err(relay_error(
                            Kind::Interrupted,
                            "the download kept ending early",
                        ));
                    }
                }
                Err(error) if error.kind.is_retryable() && failures + 1 < READ_ATTEMPTS => {
                    failures += 1;
                    tracing::warn!(
                        repository_id = %self.repository_id,
                        offset,
                        error = %error,
                        "The download through the server relay was interrupted; resuming"
                    );
                    wait_or_cancel(cancel, Duration::from_secs(u64::from(failures))).await?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(hasher)
    }

    async fn verify_inner(
        &self,
        key: &RepositoryKey,
        expected_size: u64,
        expected_sha256: &str,
        progress: &ProgressFn,
        cancel: &CancelFlag,
    ) -> RepositoryResult<VerifiedObject> {
        let body = serde_json::json!({
            "key": key.as_str(),
            "sizeBytes": expected_size,
            "sha256": expected_sha256,
        });
        let started = Instant::now();
        loop {
            // Repeating the same request asks how the server's check is going.
            let status: VerifyStatus = self
                .json(self.request(reqwest::Method::POST, &["verify"]).json(&body))
                .await?;
            progress(status.done_bytes, status.total_bytes);
            match status.state.as_str() {
                "verified" => {
                    let size_bytes = status.size_bytes.unwrap_or(expected_size);
                    let sha256 = status.sha256.unwrap_or_default();
                    if size_bytes != expected_size || sha256 != expected_sha256 {
                        return Err(relay_error(
                            Kind::HashMismatch,
                            &format!(
                                "the stored object does not match: {size_bytes} bytes with SHA-256 \
                                 {sha256}"
                            ),
                        ));
                    }
                    return Ok(VerifiedObject { size_bytes, sha256 });
                }
                "running" => {}
                _ => return Err(from_transfer_error(status.error, "the check failed")),
            }
            if started.elapsed() > self.repository_budget(expected_size) {
                return Err(relay_error(
                    Kind::Interrupted,
                    "the server took too long to read the object back",
                ));
            }
            wait_or_cancel(cancel, POLL_INTERVAL).await?;
        }
    }
}

impl ArchiveRepository for HttpRelayArchiveRepository {
    fn health_check<'a>(
        &'a self,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move {
            self.info().await?;
            let health: HealthResponse = self
                .send(
                    self.request(reqwest::Method::POST, &["health"])
                        .timeout(self.timeouts.request * 2),
                )
                .await?
                .json()
                .await
                .map_err(|_| {
                    relay_error(Kind::Protocol, "the server's answer could not be read")
                })?;
            Ok(HealthReport {
                host_key_fingerprint: health.host_key_fingerprint,
                root_readable: health.root_readable,
                root_writable: health.root_writable,
                no_overwrite_publication: health.no_overwrite_publication,
                free_bytes: health.free_bytes,
            })
        }
        .boxed()
    }

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        async move {
            let stat: StatResponse = self
                .json(
                    self.request(reqwest::Method::POST, &["stat"])
                        .json(&serde_json::json!({ "key": key.as_str() })),
                )
                .await?;
            Ok(stat.exists.then(|| ObjectMetadata {
                size_bytes: stat.size_bytes.unwrap_or(0),
            }))
        }
        .boxed()
    }

    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        async move {
            let free: FreeSpaceResponse = self
                .json(self.request(reqwest::Method::GET, &["free-space"]))
                .await?;
            Ok(free.free_bytes)
        }
        .boxed()
    }

    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move {
            if !key.is_staging() {
                return Err(RepositoryError::new(
                    Kind::Protocol,
                    "Uploads may only write to a staging key",
                ));
            }
            self.upload_inner(key, source, &progress, cancel).await
        }
        .boxed()
    }

    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            self.download_inner(key, destination, &progress, cancel)
                .await
        }
        .boxed()
    }

    fn verify<'a>(
        &'a self,
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            self.verify_inner(key, expected_size, expected_sha256, &progress, cancel)
                .await
        }
        .boxed()
    }

    fn publish<'a>(
        &'a self,
        staging: &'a RepositoryKey,
        final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            self.empty(
                self.request(reqwest::Method::POST, &["publish"])
                    .json(&serde_json::json!({
                        "stagingKey": staging.as_str(),
                        "finalKey": final_key.as_str(),
                    })),
            )
            .await
        }
        .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            self.empty(
                self.request(reqwest::Method::POST, &["delete"])
                    .json(&serde_json::json!({ "key": key.as_str() })),
            )
            .await
        }
        .boxed()
    }

    fn transport(&self) -> RepositoryTransport {
        RepositoryTransport::Relay
    }
}

/// SFTP first, and the relay only when SFTP cannot reach the repository at all. The choice is made by
/// the first operation and then kept, so that one job's upload, verification and publication all go
/// the same way.
pub struct FallbackArchiveRepository {
    repository_id: Uuid,
    sftp: Arc<dyn ArchiveRepository>,
    relay: Arc<dyn ArchiveRepository>,
    chosen: Mutex<Option<RepositoryTransport>>,
}

impl FallbackArchiveRepository {
    pub fn new(
        repository_id: Uuid,
        sftp: Arc<dyn ArchiveRepository>,
        relay: Arc<dyn ArchiveRepository>,
    ) -> Self {
        Self {
            repository_id,
            sftp,
            relay,
            chosen: Mutex::new(None),
        }
    }

    fn chosen(&self) -> Option<RepositoryTransport> {
        *self.chosen.lock().expect("poisoned")
    }

    fn choose(&self, transport: RepositoryTransport) {
        let mut chosen = self.chosen.lock().expect("poisoned");
        if chosen.is_none() {
            *chosen = Some(transport);
        }
    }

    /// Runs one operation on the chosen transport, or decides which one that is.
    async fn route<'a, T, F, Fut>(&'a self, operation: F) -> RepositoryResult<T>
    where
        F: Fn(Arc<dyn ArchiveRepository>) -> Fut,
        Fut: std::future::Future<Output = RepositoryResult<T>> + Send + 'a,
    {
        match self.chosen() {
            Some(RepositoryTransport::Sftp) => return operation(Arc::clone(&self.sftp)).await,
            Some(RepositoryTransport::Relay) => return operation(Arc::clone(&self.relay)).await,
            None => {}
        }
        let direct = operation(Arc::clone(&self.sftp)).await;
        let sftp_error = match direct {
            // Anything but "could not reach it" proves SFTP got there, and is reported as it is.
            Err(error) if error.kind == Kind::Unreachable => error,
            other => {
                self.choose(RepositoryTransport::Sftp);
                return other;
            }
        };
        tracing::warn!(
            repository_id = %self.repository_id,
            error = %sftp_error,
            "The repository cannot be reached over SFTP; trying the server relay"
        );
        match operation(Arc::clone(&self.relay)).await {
            Err(relay) if matches!(relay.kind, Kind::NotConfigured | Kind::Unreachable) => {
                // Neither way works. The SFTP problem is the one to fix, so it keeps its kind.
                Err(RepositoryError::new(
                    sftp_error.kind,
                    format!(
                        "{}. The server relay is not available either: {}",
                        sftp_error.message, relay.message
                    ),
                ))
            }
            relayed => {
                self.choose(RepositoryTransport::Relay);
                tracing::info!(
                    repository_id = %self.repository_id,
                    "Using the server relay for this repository"
                );
                relayed
            }
        }
    }
}

impl ArchiveRepository for FallbackArchiveRepository {
    fn health_check<'a>(
        &'a self,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        self.route(move |repository| async move { repository.health_check(cancel).await })
            .boxed()
    }

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        self.route(move |repository| async move { repository.stat(key).await })
            .boxed()
    }

    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        self.route(|repository| async move { repository.free_space().await })
            .boxed()
    }

    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        self.route(move |repository| {
            let progress = Arc::clone(&progress);
            async move { repository.upload(key, source, progress, cancel).await }
        })
        .boxed()
    }

    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        self.route(move |repository| {
            let progress = Arc::clone(&progress);
            async move {
                repository
                    .download(key, destination, progress, cancel)
                    .await
            }
        })
        .boxed()
    }

    fn verify<'a>(
        &'a self,
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        self.route(move |repository| {
            let progress = Arc::clone(&progress);
            async move {
                repository
                    .verify(key, expected_size, expected_sha256, progress, cancel)
                    .await
            }
        })
        .boxed()
    }

    fn publish<'a>(
        &'a self,
        staging: &'a RepositoryKey,
        final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        self.route(move |repository| async move { repository.publish(staging, final_key).await })
            .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        self.route(move |repository| async move { repository.delete(key).await })
            .boxed()
    }

    fn transport(&self) -> RepositoryTransport {
        self.chosen().unwrap_or(RepositoryTransport::Sftp)
    }
}
