//! The HTTPS relay client and the SFTP-first fallback (decision 0055), against an in-memory relay that
//! speaks the routes of `apps/api/src/routes/agent-repository-relay.ts`: chunked, resumable uploads,
//! verification on the server, no-overwrite publication, and downloads read with `Range`.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::credentials::Secret;
use emucat_agent::packaging::hex;
use emucat_agent::relay::{
    FallbackArchiveRepository, HttpRelayArchiveRepository, RelayEndpoint, RelayTimeouts,
};
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, RepositoryTransport,
    VerifiedObject, no_progress,
};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;
use uuid::Uuid;

const CHUNK: usize = 256 * 1024;
const TOKEN: &str = "agent-token-for-tests";

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn pseudo_random(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_u32;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect()
}

#[derive(Default)]
struct Upload {
    key: String,
    size: usize,
    sha256: String,
    chunks: BTreeMap<usize, Vec<u8>>,
    state: &'static str,
}

#[derive(Default)]
struct Relay {
    enabled: bool,
    objects: HashMap<String, Vec<u8>>,
    uploads: HashMap<Uuid, Upload>,
    downloads: HashMap<Uuid, String>,
    verifications: HashMap<String, usize>,
    /// Chunk indexes that fail once with a 503, as a busy proxy would.
    fail_chunks_once: Vec<usize>,
    /// The first read of a download stops halfway, as a dropped connection would.
    truncate_first_read: bool,
    requests: Vec<String>,
    unauthorized: usize,
    chunk_puts: usize,
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 65536];
    let end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_owned();
    let path = first.next()?.to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        })
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    while buffer.len() < end + 4 + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(Request {
        method,
        path,
        headers,
        body: buffer[end + 4..end + 4 + length].to_vec(),
    })
}

enum Reply {
    Json(u16, Value),
    Empty(u16),
    Bytes {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        /// Fewer bytes than declared, then the connection closes.
        cut_at: Option<usize>,
    },
}

fn error(status: u16, code: &str) -> Reply {
    Reply::Json(
        status,
        json!({ "error": { "code": code, "message": format!("refused: {code}"), "requestId": "r" } }),
    )
}

fn status_of(id: Uuid, upload: &Upload) -> Value {
    let count = upload.size.div_ceil(CHUNK);
    let missing: Vec<[usize; 2]> = (0..count)
        .filter(|index| !upload.chunks.contains_key(index))
        .map(|index| [index, index])
        .collect();
    json!({
        "transferId": id,
        "direction": "upload",
        "state": upload.state,
        "key": upload.key,
        "sizeBytes": upload.size,
        "sha256": upload.sha256,
        "chunkBytes": CHUNK,
        "chunkCount": count,
        "missingChunks": missing,
        "doneBytes": 0,
        "error": null,
        "updatedAt": "2026-11-22T00:00:00.000Z",
        "expiresAt": null,
    })
}

fn handle(relay: &Mutex<Relay>, request: Request) -> Reply {
    let mut relay = relay.lock().unwrap();
    relay
        .requests
        .push(format!("{} {}", request.method, request.path));
    if request.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {TOKEN}"))
        || !request.headers.contains_key("x-emucat-protocol-version")
    {
        relay.unauthorized += 1;
        return error(401, "unauthorized");
    }
    let Some(rest) = request.path.strip_prefix("/api/v1/agent/repositories/") else {
        return error(404, "not_found");
    };
    let segments: Vec<&str> = rest.split('/').skip(1).collect();
    let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
    let key = |name: &str| body[name].as_str().unwrap_or_default().to_owned();
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["relay"]) => Reply::Json(
            200,
            json!({
                "enabled": relay.enabled,
                "reason": if relay.enabled { Value::Null } else { json!("relay is off") },
                "chunkBytes": CHUNK,
                "maxObjectBytes": 1u64 << 40,
            }),
        ),
        _ if !relay.enabled => error(503, "relay_disabled"),
        ("POST", ["stat"]) => {
            let size = relay.objects.get(&key("key")).map(Vec::len);
            Reply::Json(200, json!({ "exists": size.is_some(), "sizeBytes": size }))
        }
        ("GET", ["free-space"]) => Reply::Json(200, json!({ "freeBytes": 123_456_789 })),
        ("POST", ["health"]) => Reply::Json(
            200,
            json!({
                "hostKeyFingerprint": "SHA256:server",
                "rootReadable": true,
                "rootWritable": true,
                "noOverwritePublication": true,
                "freeBytes": 42,
            }),
        ),
        ("POST", ["verify"]) => {
            let object = key("key");
            let polls = {
                let count = relay.verifications.entry(object.clone()).or_default();
                *count += 1;
                *count
            };
            let Some(stored) = relay.objects.get(&object) else {
                return error(404, "remote_object_missing");
            };
            let total = body["sizeBytes"].as_u64().unwrap_or(0);
            if polls == 1 {
                return Reply::Json(
                    200,
                    json!({ "state": "running", "doneBytes": 0, "totalBytes": total,
                            "sizeBytes": null, "sha256": null, "error": null }),
                );
            }
            let matches = stored.len() as u64 == total && sha(stored) == key("sha256");
            Reply::Json(
                200,
                json!({
                    "state": if matches { "verified" } else { "failed" },
                    "doneBytes": stored.len(),
                    "totalBytes": total,
                    "sizeBytes": stored.len(),
                    "sha256": sha(stored),
                    "error": if matches { Value::Null } else {
                        json!({ "code": "hash_mismatch", "message": "different bytes" })
                    },
                }),
            )
        }
        ("POST", ["publish"]) => {
            let (staging, target) = (key("stagingKey"), key("finalKey"));
            if relay.objects.contains_key(&target) {
                return error(409, "archive_exists");
            }
            let Some(bytes) = relay.objects.get(&staging).cloned() else {
                return error(404, "remote_object_missing");
            };
            relay.objects.insert(target, bytes);
            Reply::Empty(204)
        }
        ("POST", ["delete"]) => {
            relay.objects.remove(&key("key"));
            Reply::Empty(204)
        }
        ("POST", ["uploads"]) => {
            let (object, size, digest) = (
                key("key"),
                body["sizeBytes"].as_u64().unwrap_or(0) as usize,
                key("sha256"),
            );
            let resumed = relay.uploads.iter().find_map(|(id, upload)| {
                (upload.key == object
                    && upload.size == size
                    && upload.sha256 == digest
                    && upload.state == "receiving")
                    .then_some(*id)
            });
            let id = resumed.unwrap_or_else(|| {
                let id = Uuid::new_v4();
                relay.uploads.insert(
                    id,
                    Upload {
                        key: object,
                        size,
                        sha256: digest,
                        chunks: BTreeMap::new(),
                        state: "receiving",
                    },
                );
                id
            });
            Reply::Json(200, status_of(id, &relay.uploads[&id]))
        }
        ("GET", ["uploads", id]) => {
            let id: Uuid = id.parse().unwrap();
            match relay.uploads.get_mut(&id) {
                Some(upload) => {
                    // The server's work finishes between two polls.
                    if upload.state == "publishing" {
                        upload.state = "published";
                    }
                    Reply::Json(200, status_of(id, upload))
                }
                None => error(404, "transfer_not_found"),
            }
        }
        ("PUT", ["uploads", id, "chunks", index]) => {
            let (id, index): (Uuid, usize) = (id.parse().unwrap(), index.parse().unwrap());
            relay.chunk_puts += 1;
            if let Some(position) = relay.fail_chunks_once.iter().position(|&i| i == index) {
                relay.fail_chunks_once.remove(position);
                return error(503, "internal_error");
            }
            let header = request.headers.get("x-emucat-chunk-sha256").cloned();
            let Some(upload) = relay.uploads.get_mut(&id) else {
                return error(404, "transfer_not_found");
            };
            if header.as_deref() != Some(sha(&request.body).as_str()) {
                return error(422, "chunk_hash_mismatch");
            }
            let expected = CHUNK.min(upload.size - index * CHUNK);
            if request.body.len() != expected {
                return error(422, "chunk_size_mismatch");
            }
            upload.chunks.insert(index, request.body);
            let count = upload.size.div_ceil(CHUNK);
            Reply::Json(
                200,
                json!({ "transferId": id, "index": index,
                        "receivedChunks": upload.chunks.len(), "chunkCount": count }),
            )
        }
        ("POST", ["uploads", id, "complete"]) => {
            let id: Uuid = id.parse().unwrap();
            let Some(upload) = relay.uploads.get_mut(&id) else {
                return error(404, "transfer_not_found");
            };
            let joined: Vec<u8> = upload.chunks.values().flatten().copied().collect();
            if joined.len() != upload.size {
                return error(409, "transfer_incomplete");
            }
            if sha(&joined) != upload.sha256 {
                upload.state = "failed";
                return Reply::Json(200, status_of(id, upload));
            }
            upload.state = "publishing";
            let reply = status_of(id, upload);
            let key = upload.key.clone();
            relay.objects.insert(key, joined);
            Reply::Json(200, reply)
        }
        ("DELETE", ["uploads", id]) => {
            let id: Uuid = id.parse().unwrap();
            if let Some(upload) = relay.uploads.get_mut(&id) {
                upload.state = "cancelled";
            }
            Reply::Json(200, json!({}))
        }
        ("POST", ["downloads"]) => {
            let object = key("key");
            let Some(bytes) = relay.objects.get(&object) else {
                return error(404, "remote_object_missing");
            };
            let size = bytes.len();
            let id = Uuid::new_v4();
            relay.downloads.insert(id, object);
            Reply::Json(
                200,
                json!({ "transferId": id, "direction": "download", "state": "staging",
                        "key": key("key"), "sizeBytes": size, "sha256": null, "chunkBytes": CHUNK,
                        "chunkCount": null, "missingChunks": [], "doneBytes": 0, "error": null,
                        "updatedAt": "2026-11-22T00:00:00.000Z", "expiresAt": null }),
            )
        }
        ("GET", ["downloads", id]) => {
            let id: Uuid = id.parse().unwrap();
            let object = relay.downloads[&id].clone();
            let bytes = &relay.objects[&object];
            Reply::Json(
                200,
                json!({ "transferId": id, "direction": "download", "state": "ready",
                        "key": object, "sizeBytes": bytes.len(), "sha256": sha(bytes),
                        "chunkBytes": CHUNK, "chunkCount": null, "missingChunks": [],
                        "doneBytes": bytes.len(), "error": null,
                        "updatedAt": "2026-11-22T00:00:00.000Z", "expiresAt": null }),
            )
        }
        ("GET", ["downloads", id, "content"]) => {
            let id: Uuid = id.parse().unwrap();
            let bytes = relay.objects[&relay.downloads[&id]].clone();
            let start: usize = request
                .headers
                .get("range")
                .and_then(|range| range.strip_prefix("bytes="))
                .and_then(|range| range.strip_suffix('-'))
                .map_or(0, |start| start.parse().unwrap());
            let cut_at = std::mem::take(&mut relay.truncate_first_read).then_some(bytes.len() / 2);
            let mut headers = vec![("x-emucat-sha256".to_owned(), sha(&bytes))];
            let status = if start > 0 {
                headers.push((
                    "content-range".to_owned(),
                    format!("bytes {start}-{}/{}", bytes.len() - 1, bytes.len()),
                ));
                206
            } else {
                200
            };
            Reply::Bytes {
                status,
                headers,
                body: bytes[start..].to_vec(),
                cut_at,
            }
        }
        _ => error(404, "not_found"),
    }
}

async fn respond(stream: &mut TcpStream, reply: Reply) {
    let (status, mut headers, body, cut_at) = match reply {
        Reply::Json(status, value) => (
            status,
            vec![("content-type".to_owned(), "application/json".to_owned())],
            serde_json::to_vec(&value).unwrap(),
            None,
        ),
        Reply::Empty(status) => (status, Vec::new(), Vec::new(), None),
        Reply::Bytes {
            status,
            headers,
            body,
            cut_at,
        } => (status, headers, body, cut_at),
    };
    headers.push(("content-length".to_owned(), body.len().to_string()));
    headers.push(("connection".to_owned(), "close".to_owned()));
    let mut head = format!("HTTP/1.1 {status} X\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let sent = cut_at.unwrap_or(body.len());
    let _ = stream.write_all(&body[..sent]).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

async fn start_relay(configure: impl FnOnce(&mut Relay)) -> (Url, Arc<Mutex<Relay>>) {
    let mut relay = Relay {
        enabled: true,
        ..Relay::default()
    };
    configure(&mut relay);
    let relay = Arc::new(Mutex::new(relay));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let state = Arc::clone(&relay);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                if let Some(request) = read_request(&mut stream).await {
                    let reply = handle(&state, request);
                    respond(&mut stream, reply).await;
                }
            });
        }
    });
    (url, relay)
}

fn client(url: &Url, token: &str) -> HttpRelayArchiveRepository {
    HttpRelayArchiveRepository::new(
        RelayEndpoint::new(url, Secret::new(token)),
        Uuid::new_v4(),
        RelayTimeouts::from_transfer_timeout(Duration::from_secs(5), Duration::from_secs(10)),
    )
    .unwrap()
}

fn staging() -> RepositoryKey {
    RepositoryKey::staging(Uuid::new_v4())
}

fn final_key(name: &str) -> RepositoryKey {
    RepositoryKey::new(format!("archives/qemu/{name}.zip")).unwrap()
}

type ProgressLog = Arc<Mutex<Vec<(u64, u64)>>>;

fn recorded() -> (ProgressFn, ProgressLog) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    (
        Arc::new(move |done, total| sink.lock().unwrap().push((done, total))),
        log,
    )
}

fn write_file(directory: &TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = directory.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[tokio::test]
async fn upload_verify_publish_and_download_round_trip_in_chunks() {
    let (url, relay) = start_relay(|_| {}).await;
    let repository = client(&url, TOKEN);
    let directory = TempDir::new().unwrap();
    let bytes = pseudo_random(CHUNK * 2 + 1234);
    let source = write_file(&directory, "vm.zip", &bytes);
    let cancel = CancelFlag::new();

    let key = staging();
    let (progress, log) = recorded();
    let stored = repository
        .upload(&key, &source, progress, &cancel)
        .await
        .unwrap();
    assert_eq!(stored.size_bytes, bytes.len() as u64);
    assert_eq!(relay.lock().unwrap().chunk_puts, 3);
    assert_eq!(
        log.lock().unwrap().last(),
        Some(&(bytes.len() as u64, bytes.len() as u64))
    );

    let verified = repository
        .verify(
            &key,
            bytes.len() as u64,
            &sha(&bytes),
            no_progress(),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(verified.sha256, sha(&bytes));

    let target = final_key("one");
    repository.publish(&key, &target).await.unwrap();
    let again = repository.publish(&key, &target).await.unwrap_err();
    assert_eq!(again.kind, Kind::AlreadyExists, "{again}");
    assert_eq!(
        repository.stat(&target).await.unwrap(),
        Some(ObjectMetadata {
            size_bytes: bytes.len() as u64
        })
    );
    repository.delete(&key).await.unwrap();
    assert_eq!(repository.stat(&key).await.unwrap(), None);

    let destination = directory.path().join("back.zip");
    let downloaded = repository
        .download(&target, &destination, no_progress(), &cancel)
        .await
        .unwrap();
    assert_eq!(downloaded.sha256, sha(&bytes));
    assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    assert_eq!(repository.transport(), RepositoryTransport::Relay);
    assert_eq!(repository.free_space().await.unwrap(), Some(123_456_789));
    assert_eq!(relay.lock().unwrap().unauthorized, 0);
}

#[tokio::test]
async fn a_failed_chunk_is_sent_again_and_an_upload_resumes_with_what_is_missing() {
    let (url, relay) = start_relay(|relay| relay.fail_chunks_once = vec![1]).await;
    let repository = client(&url, TOKEN);
    let directory = TempDir::new().unwrap();
    let bytes = pseudo_random(CHUNK * 3);
    let source = write_file(&directory, "vm.zip", &bytes);
    let key = staging();

    // An earlier attempt already sent chunk 0 and 2.
    {
        let mut state = relay.lock().unwrap();
        let mut chunks = BTreeMap::new();
        chunks.insert(0, bytes[..CHUNK].to_vec());
        chunks.insert(2, bytes[CHUNK * 2..].to_vec());
        state.uploads.insert(
            Uuid::new_v4(),
            Upload {
                key: key.as_str().to_owned(),
                size: bytes.len(),
                sha256: sha(&bytes),
                chunks,
                state: "receiving",
            },
        );
    }
    let (progress, log) = recorded();
    repository
        .upload(&key, &source, progress, &CancelFlag::new())
        .await
        .unwrap();
    let state = relay.lock().unwrap();
    // Chunk 1 only: refused once, then accepted.
    assert_eq!(state.chunk_puts, 2);
    assert_eq!(state.objects[key.as_str()], bytes);
    assert_eq!(
        log.lock().unwrap().first(),
        Some(&((CHUNK * 2) as u64, bytes.len() as u64))
    );
}

#[tokio::test]
async fn a_download_that_stops_early_resumes_with_a_range_request() {
    let (url, relay) = start_relay(|relay| relay.truncate_first_read = true).await;
    let bytes = pseudo_random(CHUNK + 999);
    let target = final_key("resume");
    relay
        .lock()
        .unwrap()
        .objects
        .insert(target.as_str().to_owned(), bytes.clone());
    let repository = client(&url, TOKEN);
    let directory = TempDir::new().unwrap();
    let destination = directory.path().join("resumed.zip");
    let downloaded = repository
        .download(&target, &destination, no_progress(), &CancelFlag::new())
        .await
        .unwrap();
    assert_eq!(downloaded.sha256, sha(&bytes));
    assert_eq!(std::fs::read(&destination).unwrap(), bytes);
    let requests = relay.lock().unwrap().requests.clone();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.ends_with("/content"))
            .count(),
        2,
        "{requests:?}"
    );
}

#[tokio::test]
async fn server_refusals_keep_their_meaning() {
    let (url, _) = start_relay(|_| {}).await;
    let repository = client(&url, TOKEN);
    let directory = TempDir::new().unwrap();
    let missing = repository
        .download(
            &final_key("absent"),
            &directory.path().join("x"),
            no_progress(),
            &CancelFlag::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.kind, Kind::NotFound, "{missing}");
    assert!(
        !directory.path().join("x").exists(),
        "nothing is left behind"
    );

    let wrong = client(&url, "not-the-token")
        .stat(&final_key("absent"))
        .await
        .unwrap_err();
    assert_eq!(wrong.kind, Kind::PermissionDenied, "{wrong}");
    assert!(!wrong.message.contains("not-the-token"));

    // Uploads only ever go to a staging key, as over SFTP.
    let source = write_file(&directory, "f", b"x");
    let refused = repository
        .upload(
            &final_key("direct"),
            &source,
            no_progress(),
            &CancelFlag::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.kind, Kind::Protocol);

    let (off, _) = start_relay(|relay| relay.enabled = false).await;
    let disabled = client(&off, TOKEN)
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(disabled.kind, Kind::NotConfigured, "{disabled}");
}

#[tokio::test]
async fn a_redirect_is_never_followed_with_the_credential() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url: Url = format!("http://{}/", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_request(&mut stream).await;
        let reply = format!(
            "HTTP/1.1 307 X\r\nlocation: http://127.0.0.1:{port}/stolen\r\ncontent-length: 0\r\n\r\n"
        );
        let _ = stream.write_all(reply.as_bytes()).await;
    });
    let error = client(&url, TOKEN).stat(&final_key("x")).await.unwrap_err();
    assert_ne!(error.kind, Kind::NotFound);
    let reached = tokio::time::timeout(Duration::from_millis(200), target.accept()).await;
    assert!(reached.is_err(), "the redirect target was contacted");
}

/// An SFTP store that fails every call the same way, and counts them.
struct Failing {
    kind: Kind,
    calls: AtomicUsize,
}

impl Failing {
    fn new(kind: Kind) -> Arc<Self> {
        Arc::new(Self {
            kind,
            calls: AtomicUsize::new(0),
        })
    }

    fn fail<T>(&self) -> RepositoryResult<T> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(RepositoryError::new(
            self.kind,
            format!("sftp: {:?}", self.kind),
        ))
    }
}

impl ArchiveRepository for Failing {
    fn health_check<'a>(
        &'a self,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move { self.fail() }.boxed()
    }
    fn stat<'a>(
        &'a self,
        _: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        async move { self.fail() }.boxed()
    }
    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        async move { self.fail() }.boxed()
    }
    fn upload<'a>(
        &'a self,
        _: &'a RepositoryKey,
        _: &'a Path,
        _: ProgressFn,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move { self.fail() }.boxed()
    }
    fn download<'a>(
        &'a self,
        _: &'a RepositoryKey,
        _: &'a Path,
        _: ProgressFn,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { self.fail() }.boxed()
    }
    fn verify<'a>(
        &'a self,
        _: &'a RepositoryKey,
        _: u64,
        _: &'a str,
        _: ProgressFn,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { self.fail() }.boxed()
    }
    fn publish<'a>(
        &'a self,
        _: &'a RepositoryKey,
        _: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { self.fail() }.boxed()
    }
    fn delete<'a>(&'a self, _: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { self.fail() }.boxed()
    }
}

fn fallback(sftp: Arc<Failing>, url: &Url) -> FallbackArchiveRepository {
    FallbackArchiveRepository::new(Uuid::new_v4(), sftp, Arc::new(client(url, TOKEN)))
}

#[tokio::test]
async fn an_unreachable_repository_falls_back_to_the_relay_and_stays_there() {
    let (url, relay) = start_relay(|_| {}).await;
    let sftp = Failing::new(Kind::Unreachable);
    let repository = fallback(Arc::clone(&sftp), &url);
    let report = repository.health_check(&CancelFlag::new()).await.unwrap();
    assert_eq!(
        report.host_key_fingerprint.as_deref(),
        Some("SHA256:server")
    );
    assert_eq!(repository.transport(), RepositoryTransport::Relay);
    // Decided once: SFTP is not tried again for this job.
    repository.free_space().await.unwrap();
    repository.stat(&final_key("x")).await.unwrap();
    assert_eq!(sftp.calls.load(Ordering::SeqCst), 1);
    assert!(relay.lock().unwrap().requests.len() >= 3);
}

#[tokio::test]
async fn authentication_host_key_and_integrity_failures_never_fall_back() {
    let (url, relay) = start_relay(|_| {}).await;
    for kind in [
        Kind::AuthenticationFailed,
        Kind::HostKeyUnknown,
        Kind::HostKeyChanged,
        Kind::PermissionDenied,
        Kind::HashMismatch,
        Kind::NotConfigured,
        Kind::Interrupted,
    ] {
        let repository = fallback(Failing::new(kind), &url);
        let error = repository
            .health_check(&CancelFlag::new())
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(repository.transport(), RepositoryTransport::Sftp);
    }
    assert!(relay.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn without_a_relay_the_sftp_problem_is_the_one_reported() {
    let (url, _) = start_relay(|relay| relay.enabled = false).await;
    let repository = fallback(Failing::new(Kind::Unreachable), &url);
    let error = repository
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::Unreachable);
    assert!(error.message.starts_with("sftp:"), "{error}");
    assert!(error.message.contains("relay is off"), "{error}");
    // Nothing was decided, so the next operation tries SFTP again.
    assert_eq!(repository.transport(), RepositoryTransport::Sftp);
}

#[test]
fn a_server_without_relay_routes_counts_as_no_relay() {
    // An older server answers every relay route with its generic 404.
    assert_eq!(
        emucat_agent::relay::kind_of_code("not_found"),
        Kind::NotConfigured
    );
    assert_eq!(
        emucat_agent::relay::kind_of_code("transfer_not_found"),
        Kind::NotFound
    );
    assert_eq!(
        emucat_agent::relay::kind_of_code("something_new"),
        Kind::Protocol
    );
}
