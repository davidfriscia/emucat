//! Keeps a VM's screenshots on the server, for as long as the agent runs, whether the VM is running or not.
//!
//! What it knows comes from three places. The server says which VMs this agent is responsible for, and
//! which hashes it already holds. The disk says which files exist. [`MediaQueue`] remembers the rest, so
//! that a restart does not read every screenshot again. Bytes go over authenticated HTTP(S) to the API:
//! never through the archive repository, and never in a WebSocket message.
//!
//! Filesystem notifications make this quick, and are not trusted: a periodic reconciliation repeats
//! everything, so a missed event only costs time. Notifications only ever mark a VM as worth scanning.
//! All the decisions, and every safety check, are in the scan.
//!
//! One recursive watch is held on each emulator's base path, rather than one on each VM. A handle inside
//! a VM directory would stop that directory from being renamed on Windows, which a transfer depends on.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::future::BoxFuture;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{Notify, mpsc};
use url::Url;
use uuid::Uuid;

use crate::config::{EmulatorConfig, MediaSettings};
use crate::credentials::Secret;
use crate::emulators::{EmulatorType, VmIdentity, VmName};
use crate::media::{
    MediaFileProblem, MediaScan, MediaScanLimits, MediaStamp, hash_media_file, open_media_file,
    scan_vm_media,
};
use crate::media_queue::{EntryError, EntryState, MediaQueue, QueueEntry, RetryPolicy, vm_key};
use crate::packaging::resolve_vm_root;
use crate::protocol::{
    AGENT_MAX_MESSAGE_BYTES, MEDIA_STATUS_MAX_VMS, MediaSyncStatus, MediaSyncVmStatus, Message,
    PROTOCOL_VERSION,
};
use crate::repository::CancelFlag;

/// How many hashes one question to the server can ask about. Mirrors `MEDIA_ACK_QUERY_MAX`.
pub const ACK_QUERY_MAX: usize = 256;
const EVENT_CAPACITY: usize = 256;
const DEBOUNCE: Duration = Duration::from_millis(250);
const API_RETRY_INITIAL: Duration = Duration::from_secs(1);
const API_RETRY_CEILING: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// What became of a request to the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiFailure {
    /// Trying again later may work: the network, the server, or a credential problem it may recover from.
    Transient { code: String, message: String },
    /// These bytes were refused for what they are. Sending them again cannot help.
    Permanent { code: String, message: String },
}

impl ApiFailure {
    pub fn entry_error(&self) -> EntryError {
        match self {
            Self::Transient { code, message } | Self::Permanent { code, message } => EntryError {
                code: code.clone(),
                message: message.clone(),
            },
        }
    }

    pub fn is_permanent(&self) -> bool {
        matches!(self, Self::Permanent { .. })
    }
}

/// Which answers mean that the bytes themselves are the problem. Everything else is treated as passing,
/// including 401 and 403: a credential problem is not the screenshot's fault, and connectivity is what
/// stops an agent whose credential was really revoked.
pub fn classify_response(status: u16, code: &str, message: &str) -> ApiFailure {
    let failure = |permanent: bool| {
        let code = code.to_owned();
        let message = message.to_owned();
        if permanent {
            ApiFailure::Permanent { code, message }
        } else {
            ApiFailure::Transient { code, message }
        }
    };
    match (status, code) {
        // Bytes changed on the way or on the disk. The next scan notices if it was the disk.
        (_, "hash_mismatch") => failure(false),
        (400 | 413 | 415 | 422, _) => failure(true),
        _ => failure(false),
    }
}

/// The server's side of synchronization. Tests use a stand-in whose failures can be chosen.
pub trait MediaApi: Send + Sync {
    /// The VMs this agent is responsible for, and the server's size limit.
    fn list_vms(&self) -> BoxFuture<'_, Result<AgentMediaVms, ApiFailure>>;

    /// Which of these hashes the server holds for this VM.
    fn acknowledged<'a>(
        &'a self,
        vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>>;

    fn upload<'a>(
        &'a self,
        vm: &'a VmIdentity,
        entry: &'a QueueEntry,
        file: std::fs::File,
    ) -> BoxFuture<'a, Result<(), ApiFailure>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMediaVms {
    pub vms: Vec<VmIdentity>,
    pub max_upload_bytes: u64,
}

/// The real server, over HTTP(S). Redirects are not followed, since one could carry the credential to
/// another host or from https down to http, and the address was checked when the agent started.
pub struct HttpMediaApi {
    client: reqwest::Client,
    base: Url,
    credential: Secret,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmListBody {
    vms: Vec<VmListEntry>,
    max_upload_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmListEntry {
    emulator_type: EmulatorType,
    vm_name: VmName,
}

#[derive(Deserialize)]
struct AckBody {
    acknowledged: Vec<String>,
}

fn network_failure(error: &reqwest::Error) -> ApiFailure {
    // Without the URL: it holds nothing secret, but a message should say what happened and no more.
    let message = if error.is_timeout() {
        "The server took too long to answer".to_owned()
    } else if error.is_connect() {
        "Cannot connect to the server".to_owned()
    } else {
        "The connection to the server failed".to_owned()
    };
    ApiFailure::Transient {
        code: "server_unreachable".to_owned(),
        message,
    }
}

async fn failure_from(response: reqwest::Response) -> ApiFailure {
    let status = response.status().as_u16();
    match response.json::<ErrorEnvelope>().await {
        Ok(body) => classify_response(status, &body.error.code, &body.error.message),
        Err(_) => classify_response(
            status,
            "server_error",
            &format!("The server answered {status}"),
        ),
    }
}

/// Keeps a path readable in a header: everything but the characters that need no escaping is encoded.
fn percent_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

impl HttpMediaApi {
    pub fn new(api_url: &Url, credential: Secret) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.without_url().to_string())?;
        Ok(Self {
            client,
            base: api_url.clone(),
            credential,
        })
    }

    fn endpoint(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty()
                .extend(["api", "v1", "agent", "media"])
                .extend(segments);
        }
        url
    }

    fn authorized(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        // Built separately from the URL, and never printed: the header is the only place the token goes.
        let mut value =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.credential.expose()))
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("Bearer invalid"));
        value.set_sensitive(true);
        request
            .header(reqwest::header::AUTHORIZATION, value)
            .header("x-emucat-protocol-version", PROTOCOL_VERSION.to_string())
    }
}

impl MediaApi for HttpMediaApi {
    fn list_vms(&self) -> BoxFuture<'_, Result<AgentMediaVms, ApiFailure>> {
        Box::pin(async move {
            let response = self
                .authorized(self.client.get(self.endpoint(&["vms"])))
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|error| network_failure(&error))?;
            if !response.status().is_success() {
                return Err(failure_from(response).await);
            }
            let body: VmListBody = response
                .json()
                .await
                .map_err(|error| network_failure(&error))?;
            Ok(AgentMediaVms {
                vms: body
                    .vms
                    .into_iter()
                    .map(|vm| VmIdentity {
                        emulator_type: vm.emulator_type,
                        vm_name: vm.vm_name,
                    })
                    .collect(),
                max_upload_bytes: body.max_upload_bytes,
            })
        })
    }

    fn acknowledged<'a>(
        &'a self,
        vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>> {
        Box::pin(async move {
            let mut held = BTreeSet::new();
            for chunk in hashes.chunks(ACK_QUERY_MAX) {
                let emulator = vm.emulator_type.to_string();
                let url =
                    self.endpoint(&["vms", &emulator, vm.vm_name.as_str(), "acknowledgements"]);
                let response = self
                    .authorized(self.client.post(url))
                    .json(&serde_json::json!({ "sha256": chunk }))
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|error| network_failure(&error))?;
                if !response.status().is_success() {
                    return Err(failure_from(response).await);
                }
                let body: AckBody = response
                    .json()
                    .await
                    .map_err(|error| network_failure(&error))?;
                held.extend(body.acknowledged);
            }
            Ok(held)
        })
    }

    fn upload<'a>(
        &'a self,
        vm: &'a VmIdentity,
        entry: &'a QueueEntry,
        file: std::fs::File,
    ) -> BoxFuture<'a, Result<(), ApiFailure>> {
        Box::pin(async move {
            let emulator = vm.emulator_type.to_string();
            let url = self.endpoint(&[
                "vms",
                &emulator,
                vm.vm_name.as_str(),
                "screenshots",
                &entry.sha256,
            ]);
            let captured_at = OffsetDateTime::from(entry.stamp.modified())
                .format(&Rfc3339)
                .unwrap_or_default();
            let mut request = self
                .authorized(self.client.put(url))
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .header(reqwest::header::CONTENT_LENGTH, entry.stamp.size_bytes)
                .header("x-emucat-source-path", percent_encode(&entry.source_path));
            if !captured_at.is_empty() {
                request = request.header("x-emucat-captured-at", captured_at);
            }
            let response = request
                .body(reqwest::Body::from(tokio::fs::File::from_std(file)))
                .timeout(Duration::from_secs(600))
                .send()
                .await
                .map_err(|error| network_failure(&error))?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(failure_from(response).await)
            }
        })
    }
}

/// What a transfer needs from synchronization, in order to prove that nothing would be lost. Implemented
/// here, and by a stand-in in tests of the registration workflow.
pub trait MediaPreservation: Send + Sync {
    /// The server's answer about these hashes. This is the only proof a transfer accepts.
    fn acknowledged<'a>(
        &'a self,
        vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>>;

    /// Looks at this VM now, rather than at the next reconciliation.
    fn request_sync(&self, vm: &VmIdentity);

    /// The server does not have these, whatever the local queue thinks, so they should be uploaded.
    fn requeue(&self, vm: &VmIdentity, hashes: &BTreeSet<String>);

    /// Why this content will not be uploaded, if that is already known.
    fn failure_of(&self, vm: &VmIdentity, sha256: &str) -> Option<EntryError>;

    /// Stops or resumes touching this VM's files, so that a transfer can move the directory.
    fn hold(&self, vm: &VmIdentity, held: bool);

    /// How long a transfer waits for the upload of its screenshots before keeping the local VM.
    fn transfer_wait(&self) -> Duration;
}

struct UploadDone {
    emulator: EmulatorType,
    vm_name: VmName,
    source_path: String,
    sha256: String,
    short_hash: String,
    attempt: u32,
    outcome: UploadOutcome,
}

enum UploadOutcome {
    Uploaded,
    Failed(ApiFailure),
    /// The file is not what was hashed any more. A scan decides what it is now.
    FileChanged,
    Cancelled,
}

struct Candidate {
    stamp: MediaStamp,
    since: Instant,
}

struct State {
    queue: MediaQueue,
    /// The VMs the server says this agent is responsible for.
    registered: BTreeMap<String, VmIdentity>,
    /// VMs to scan, and when.
    dirty: BTreeMap<String, Instant>,
    /// Files seen but not yet known to be finished.
    candidates: HashMap<(String, String), Candidate>,
    /// Entries the server has been asked about since they were queued or since the last reconnection.
    asked: BTreeSet<(String, String)>,
    held: BTreeSet<String>,
    in_flight: usize,
    max_upload_bytes: u64,
    full_requested: bool,
    api_failures: u32,
    next_api_attempt: Option<Instant>,
    status_version: u64,
    status_sent: Option<u64>,
}

pub struct MediaSyncConfig {
    pub agent_id: Uuid,
    pub state_dir: std::path::PathBuf,
    pub emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
    pub settings: MediaSettings,
    pub api: Arc<dyn MediaApi>,
    pub scan_limits: MediaScanLimits,
}

pub struct MediaSync {
    config: MediaSyncConfig,
    state: Mutex<State>,
    wake: Notify,
    overflowed: AtomicBool,
    stopping: CancelFlag,
}

/// Keeps a status message well inside the protocol's limit, whatever is in it. VMs with something to
/// say go first, in case they do not all fit.
pub fn bounded_status(mut vms: Vec<MediaSyncVmStatus>) -> MediaSyncStatus {
    vms.sort_by_key(|vm| vm.pending == 0 && vm.uploading == 0 && vm.failed == 0);
    let mut truncated = vms.len() > MEDIA_STATUS_MAX_VMS;
    vms.truncate(MEDIA_STATUS_MAX_VMS);
    let limit = AGENT_MAX_MESSAGE_BYTES * 3 / 4;
    let size =
        |vm: &MediaSyncVmStatus| serde_json::to_string(vm).map_or(usize::MAX, |json| json.len());
    let mut total = 0usize;
    let mut fits = 0;
    for vm in &vms {
        total = total.saturating_add(size(vm) + 1);
        if total > limit {
            break;
        }
        fits += 1;
    }
    if fits < vms.len() {
        truncated = true;
        vms.truncate(fits);
    }
    MediaSyncStatus { vms, truncated }
}

enum FsEvent {
    Vm(EmulatorType, String),
    Everything,
}

/// Whether a changed path could mean something for a VM's screenshots, and which VM. This runs on the
/// watcher's thread for everything happening under a base path, including a running VM's disk writes, so
/// it decides from the path alone and touches no disk.
pub fn relevant_vm(emulator: EmulatorType, base: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(base).ok()?;
    let mut segments = relative.components().filter_map(|part| match part {
        std::path::Component::Normal(name) => name.to_str(),
        _ => None,
    });
    let vm = segments.next()?;
    let first = segments.next();
    let second = segments.next();
    let relevant = match emulator {
        EmulatorType::Box86 => first.is_none_or(|name| name.eq_ignore_ascii_case("screenshots")),
        EmulatorType::Qemu => {
            second.is_none() && first.is_none_or(|name| name.to_ascii_lowercase().ends_with(".ppm"))
        }
    };
    relevant.then(|| vm.to_owned())
}

impl MediaSync {
    pub fn new(config: MediaSyncConfig) -> Result<Arc<Self>, String> {
        let queue = MediaQueue::load(&config.state_dir, config.agent_id)
            .map_err(|error| format!("Cannot open the media queue: {error}"))?;
        let max_upload_bytes = config.settings.max_upload_bytes;
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                queue,
                registered: BTreeMap::new(),
                dirty: BTreeMap::new(),
                candidates: HashMap::new(),
                asked: BTreeSet::new(),
                held: BTreeSet::new(),
                in_flight: 0,
                max_upload_bytes,
                full_requested: true,
                api_failures: 0,
                next_api_attempt: None,
                status_version: 1,
                status_sent: None,
            }),
            config,
            wake: Notify::new(),
            overflowed: AtomicBool::new(false),
            stopping: CancelFlag::new(),
        }))
    }

    pub fn shutdown(&self) {
        self.stopping.cancel();
        self.wake.notify_one();
    }

    /// The connection to the server is back. What had been waiting for it goes now, the server is asked
    /// again what it holds, and the next status message goes out whatever it says.
    pub fn on_connected(&self) {
        {
            let mut state = self.lock();
            state.full_requested = true;
            state.next_api_attempt = None;
            state.api_failures = 0;
            state.status_sent = None;
            state.asked.clear();
            state.queue.retry_now();
        }
        self.wake.notify_one();
    }

    /// What to tell the server, if anything changed since it was last told.
    pub fn status_message(&self) -> Option<Message> {
        let mut state = self.lock();
        if state.status_sent == Some(state.status_version) {
            return None;
        }
        state.status_sent = Some(state.status_version);
        let registered: Vec<(EmulatorType, VmName)> = state
            .registered
            .values()
            .map(|vm| (vm.emulator_type, vm.vm_name.clone()))
            .collect();
        Some(Message::AgentMediaSyncStatus(bounded_status(
            state.queue.status(registered),
        )))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("poisoned")
    }

    fn base_path(&self, emulator: EmulatorType) -> Option<&Path> {
        self.config
            .emulators
            .get(&emulator)
            .map(|config| config.base_path.as_path())
    }

    /// Starts one watch for each base path that exists now. A base path that is missing is not an error:
    /// it is tried again at each reconciliation, and periodic scanning covers it in the meantime.
    fn ensure_watchers(
        self: &Arc<Self>,
        watchers: &mut BTreeMap<EmulatorType, RecommendedWatcher>,
        events: &mpsc::Sender<FsEvent>,
    ) {
        for (&emulator, config) in self.config.emulators.iter() {
            if watchers.contains_key(&emulator) {
                continue;
            }
            let base = config.base_path.clone();
            let sender = events.clone();
            let this = Arc::downgrade(self);
            let handler = move |result: notify::Result<notify::Event>| {
                let send = |event: FsEvent| {
                    if sender.try_send(event).is_err()
                        && let Some(sync) = this.upgrade()
                    {
                        // Nothing is lost by this: it only means looking everywhere next time.
                        sync.overflowed.store(true, Ordering::Relaxed);
                        sync.wake.notify_one();
                    }
                };
                match result {
                    Ok(event) if event.need_rescan() => send(FsEvent::Everything),
                    Ok(event) => {
                        for path in &event.paths {
                            if let Some(vm) = relevant_vm(emulator, &base, path) {
                                send(FsEvent::Vm(emulator, vm));
                            }
                        }
                    }
                    Err(_) => send(FsEvent::Everything),
                }
            };
            let started = notify::recommended_watcher(handler).and_then(|mut watcher| {
                watcher.watch(&config.base_path, RecursiveMode::Recursive)?;
                Ok(watcher)
            });
            match started {
                Ok(watcher) => {
                    tracing::info!(%emulator, path = %config.base_path.display(), "Watching for screenshots");
                    watchers.insert(emulator, watcher);
                }
                Err(error) => {
                    tracing::warn!(%emulator, %error, "Cannot watch the base path; relying on periodic scans");
                }
            }
        }
    }

    /// Runs until [`Self::shutdown`]. Every wait is on an event or a deadline, so an idle agent does
    /// nothing at all between reconciliations.
    pub async fn run(self: Arc<Self>) {
        let (event_sender, mut event_receiver) = mpsc::channel(EVENT_CAPACITY);
        let (done_sender, mut done_receiver) = mpsc::channel(EVENT_CAPACITY);
        let mut watchers = BTreeMap::new();
        self.ensure_watchers(&mut watchers, &event_sender);

        let mut reconcile = tokio::time::interval(self.config.settings.reconcile_interval);
        reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tracing::info!(
            interval_seconds = self.config.settings.reconcile_interval.as_secs(),
            max_concurrent_uploads = self.config.settings.max_concurrent_uploads,
            "Media synchronization started"
        );

        loop {
            self.step(&done_sender).await;
            let deadline = self.next_deadline();
            let timer = async {
                match deadline {
                    Some(when) => tokio::time::sleep_until(when.into()).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                () = self.stopping.cancelled() => break,
                _ = reconcile.tick() => {
                    self.lock().full_requested = true;
                    self.ensure_watchers(&mut watchers, &event_sender);
                }
                () = self.wake.notified() => {}
                () = timer => {}
                Some(event) = event_receiver.recv() => {
                    self.note_event(event);
                    while let Ok(event) = event_receiver.try_recv() {
                        self.note_event(event);
                    }
                }
                Some(done) = done_receiver.recv() => self.finish_upload(done),
            }
        }

        // Dropping the watchers ends the notifications. What was running is pending again when loaded.
        drop(watchers);
        let mut state = self.lock();
        if let Err(error) = state.queue.save() {
            tracing::warn!(%error, "Cannot save the media queue");
        }
        tracing::info!("Media synchronization stopped");
    }

    fn note_event(&self, event: FsEvent) {
        let mut state = self.lock();
        let when = Instant::now() + DEBOUNCE;
        match event {
            FsEvent::Vm(emulator, name) => {
                if let Ok(vm_name) = VmName::new(&name) {
                    let key = vm_key(emulator, &vm_name);
                    if state.registered.contains_key(&key) {
                        state.dirty.entry(key).or_insert(when);
                    }
                }
            }
            FsEvent::Everything => {
                let keys: Vec<String> = state.registered.keys().cloned().collect();
                for key in keys {
                    state.dirty.entry(key).or_insert(when);
                }
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        let state = self.lock();
        let mut soonest: Option<Instant> = state.next_api_attempt;
        let mut consider = |when: Instant| {
            soonest = Some(soonest.map_or(when, |current| current.min(when)));
        };
        for when in state.dirty.values() {
            consider(*when);
        }
        // Only what could actually be sent: a deadline for anything else would wake this for nothing,
        // again and again. A slot that frees up wakes this by itself, and so does the end of a hold.
        if state.in_flight < self.config.settings.max_concurrent_uploads
            && state.next_api_attempt.is_none()
        {
            let now = now_ms();
            let next = state
                .queue
                .entries()
                .filter(|entry| {
                    let key = vm_key(entry.emulator_type, &entry.vm_name);
                    entry.state == EntryState::RetryWait
                        && state.registered.contains_key(&key)
                        && !state.held.contains(&key)
                })
                .map(|entry| entry.next_attempt_ms)
                .min();
            if let Some(next) = next {
                consider(Instant::now() + Duration::from_millis(next.saturating_sub(now)));
            }
        }
        soonest
    }

    /// Does everything that can be done now, and saves. Nothing here waits for an upload to finish.
    async fn step(self: &Arc<Self>, done: &mpsc::Sender<UploadDone>) {
        if self.overflowed.swap(false, Ordering::Relaxed) {
            self.lock().full_requested = true;
        }
        {
            // A wait that is over is no longer a deadline.
            let mut state = self.lock();
            if state
                .next_api_attempt
                .is_some_and(|when| when <= Instant::now())
            {
                state.next_api_attempt = None;
            }
        }
        self.refresh_registered().await;
        self.scan_dirty().await;
        self.ask_server().await;
        self.dispatch(done);
        self.save().await;
    }

    fn api_available(&self) -> bool {
        self.lock()
            .next_api_attempt
            .is_none_or(|when| when <= Instant::now())
    }

    fn api_failed(&self, what: &str, failure: &ApiFailure) {
        let mut state = self.lock();
        state.api_failures = state.api_failures.saturating_add(1);
        let delay = crate::media_queue::retry_delay(
            state.api_failures,
            API_RETRY_INITIAL,
            API_RETRY_CEILING,
        );
        state.next_api_attempt = Some(Instant::now() + delay);
        let error = failure.entry_error();
        tracing::warn!(what, code = %error.code, message = %error.message, retry_in_ms = delay.as_millis() as u64, "Cannot reach the media API");
    }

    fn api_succeeded(&self) {
        let mut state = self.lock();
        state.api_failures = 0;
        state.next_api_attempt = None;
    }

    /// Asks which VMs count, which also makes each of them worth scanning. A VM nobody asked to register
    /// is never touched, whatever is on the disk, and neither is one the server stopped listing.
    async fn refresh_registered(&self) {
        if !self.lock().full_requested || !self.api_available() {
            return;
        }
        match self.config.api.list_vms().await {
            Ok(listed) => {
                self.api_succeeded();
                let mut state = self.lock();
                state.full_requested = false;
                state.max_upload_bytes = self
                    .config
                    .settings
                    .max_upload_bytes
                    .min(listed.max_upload_bytes);
                let registered: BTreeMap<String, VmIdentity> = listed
                    .vms
                    .into_iter()
                    .map(|vm| (vm_key(vm.emulator_type, &vm.vm_name), vm))
                    .collect();
                let keys: BTreeSet<String> = registered.keys().cloned().collect();
                state.queue.retain_vms(&keys);
                state.registered = registered;
                state.status_version += 1;
                let now = Instant::now();
                for key in keys {
                    state.dirty.entry(key).or_insert(now);
                }
            }
            Err(failure) => self.api_failed("listing VMs", &failure),
        }
    }

    /// Scans what is due, on the blocking pool, so that heartbeats and uploads carry on.
    async fn scan_dirty(&self) {
        let due: Vec<VmIdentity> = {
            let mut state = self.lock();
            let now = Instant::now();
            let keys: Vec<String> = state
                .dirty
                .iter()
                .filter(|(_, when)| **when <= now)
                .map(|(key, _)| key.clone())
                .collect();
            let mut vms = Vec::new();
            for key in keys {
                state.dirty.remove(&key);
                if state.held.contains(&key) {
                    continue;
                }
                if let Some(vm) = state.registered.get(&key) {
                    vms.push(vm.clone());
                }
            }
            vms
        };
        for vm in due {
            if self.stopping.is_cancelled() {
                return;
            }
            self.scan_vm(&vm).await;
        }
    }

    async fn scan_vm(&self, vm: &VmIdentity) {
        let Some(base) = self.base_path(vm.emulator_type).map(Path::to_path_buf) else {
            return;
        };
        let (vm_name, emulator, limits) = (
            vm.vm_name.clone(),
            vm.emulator_type,
            self.config.scan_limits,
        );
        let found = tokio::task::spawn_blocking(move || {
            let root = resolve_vm_root(&base, &vm_name, emulator).map_err(|error| error.message)?;
            let scan =
                scan_vm_media(&root, emulator, &limits).map_err(|error| error.to_string())?;
            Ok::<_, String>((root, scan))
        })
        .await;
        let (root, scan): (std::path::PathBuf, MediaScan) = match found {
            Ok(Ok(found)) => found,
            // A directory that is away says nothing about its screenshots. The entries stay.
            Ok(Err(reason)) => {
                tracing::debug!(vm = %vm.vm_name, %reason, "Nothing to scan");
                return;
            }
            Err(_) => return,
        };
        for refused in &scan.refused {
            tracing::warn!(vm = %vm.vm_name, source_path = %refused, "Ignored a link or special file among the screenshots");
        }
        if scan.truncated {
            tracing::warn!(vm = %vm.vm_name, "This VM has more screenshots than one scan covers");
        }

        let key = vm_key(vm.emulator_type, &vm.vm_name);
        let window = self.config.settings.stability_window;
        let mut to_hash = Vec::new();
        {
            let mut state = self.lock();
            let present: BTreeSet<String> = scan
                .files
                .iter()
                .map(|file| file.source_path.clone())
                .collect();
            if !scan.truncated {
                let removed = state
                    .queue
                    .forget_missing(vm.emulator_type, &vm.vm_name, &present);
                for entry in &removed {
                    tracing::info!(
                        vm = %vm.vm_name,
                        source_path = %entry.source_path,
                        sha256 = %entry.short_hash(),
                        "A local screenshot is gone. The server keeps its copy"
                    );
                }
                if !removed.is_empty() {
                    state.status_version += 1;
                }
            }
            state
                .candidates
                .retain(|(vm_key, path), _| vm_key != &key || present.contains(path));

            let now = Instant::now();
            let mut wait: Option<Duration> = None;
            for file in &scan.files {
                if state.queue.is_unchanged(
                    vm.emulator_type,
                    &vm.vm_name,
                    &file.source_path,
                    file.stamp,
                ) {
                    state
                        .candidates
                        .remove(&(key.clone(), file.source_path.clone()));
                    continue;
                }
                let candidate = state
                    .candidates
                    .entry((key.clone(), file.source_path.clone()))
                    .or_insert(Candidate {
                        stamp: file.stamp,
                        since: now,
                    });
                if candidate.stamp != file.stamp {
                    candidate.stamp = file.stamp;
                    candidate.since = now;
                }
                let waited = now.duration_since(candidate.since);
                if waited >= window {
                    to_hash.push(file.clone());
                } else {
                    let left = window - waited;
                    wait = Some(wait.map_or(left, |current| current.min(left)));
                }
            }
            if let Some(left) = wait {
                let when = now + left;
                let entry = state.dirty.entry(key.clone()).or_insert(when);
                *entry = (*entry).min(when);
            }
        }

        for file in to_hash {
            let (hash_root, source_path) = (root.clone(), file.source_path.clone());
            let hashed =
                tokio::task::spawn_blocking(move || hash_media_file(&hash_root, &source_path))
                    .await;
            let mut state = self.lock();
            let candidate_key = (key.clone(), file.source_path.clone());
            match hashed {
                Ok(Ok(hashed)) => {
                    state.candidates.remove(&candidate_key);
                    if hashed.stamp.size_bytes > state.max_upload_bytes {
                        let limit = state.max_upload_bytes;
                        state.queue.record_failed(
                            vm.emulator_type,
                            &vm.vm_name,
                            &file.source_path,
                            &hashed.sha256,
                            hashed.stamp,
                            EntryError {
                                code: "upload_too_large".to_owned(),
                                message: format!("This file is over the limit of {limit} bytes"),
                            },
                        );
                        state.status_version += 1;
                        tracing::warn!(vm = %vm.vm_name, source_path = %file.source_path, "A screenshot is too large to upload");
                    } else if state.queue.record(
                        vm.emulator_type,
                        &vm.vm_name,
                        &file.source_path,
                        &hashed.sha256,
                        hashed.stamp,
                    ) {
                        state.status_version += 1;
                        state.asked.remove(&(key.clone(), file.source_path.clone()));
                        tracing::info!(
                            vm = %vm.vm_name,
                            source_path = %file.source_path,
                            sha256 = hashed.sha256.get(..12).unwrap_or_default(),
                            size_bytes = hashed.stamp.size_bytes,
                            "Screenshot queued"
                        );
                    }
                }
                // Still being written, or changed while it was read. It gets another full wait.
                Ok(Err(MediaFileProblem::InUse | MediaFileProblem::Changed)) => {
                    state.candidates.remove(&candidate_key);
                    let when = Instant::now() + window.max(DEBOUNCE);
                    state.dirty.entry(key.clone()).or_insert(when);
                }
                Ok(Err(MediaFileProblem::Unsafe(reason))) => {
                    state.candidates.remove(&candidate_key);
                    tracing::warn!(vm = %vm.vm_name, source_path = %file.source_path, %reason, "Refused a screenshot");
                }
                Ok(Err(MediaFileProblem::Unreadable(reason))) => {
                    state.candidates.remove(&candidate_key);
                    tracing::warn!(vm = %vm.vm_name, source_path = %file.source_path, %reason, "Cannot read a screenshot");
                }
                Err(_) => {}
            }
        }
    }

    /// Asks about queued content before sending it. After a lost state directory, or for a copy of
    /// something already uploaded under another name, this saves sending anything at all.
    async fn ask_server(&self) {
        if !self.api_available() {
            return;
        }
        let mut questions: BTreeMap<String, (VmIdentity, BTreeSet<String>)> = BTreeMap::new();
        {
            let state = self.lock();
            for entry in state.queue.due(u64::MAX) {
                let key = vm_key(entry.emulator_type, &entry.vm_name);
                if state
                    .asked
                    .contains(&(key.clone(), entry.source_path.clone()))
                    || state.held.contains(&key)
                {
                    continue;
                }
                let Some(vm) = state.registered.get(&key) else {
                    continue;
                };
                questions
                    .entry(key)
                    .or_insert_with(|| (vm.clone(), BTreeSet::new()))
                    .1
                    .insert(entry.sha256);
            }
        }
        for (key, (vm, hashes)) in questions {
            let list: Vec<String> = hashes.iter().cloned().collect();
            match self.config.api.acknowledged(&vm, &list).await {
                Ok(held) => {
                    self.api_succeeded();
                    let mut state = self.lock();
                    let entries: Vec<QueueEntry> = state
                        .queue
                        .entries()
                        .filter(|entry| {
                            vm_key(entry.emulator_type, &entry.vm_name) == key
                                && hashes.contains(&entry.sha256)
                        })
                        .cloned()
                        .collect();
                    for entry in entries {
                        if !matches!(entry.state, EntryState::Pending | EntryState::RetryWait) {
                            continue;
                        }
                        state.asked.insert((key.clone(), entry.source_path.clone()));
                        if held.contains(&entry.sha256) {
                            tracing::info!(
                                vm = %vm.vm_name,
                                source_path = %entry.source_path,
                                sha256 = %entry.short_hash(),
                                "The server already has this screenshot"
                            );
                            state.queue.set_state(
                                entry.emulator_type,
                                &entry.vm_name,
                                &entry.source_path,
                                EntryState::Completed,
                            );
                            state.status_version += 1;
                        }
                    }
                }
                Err(failure) => {
                    self.api_failed("asking about screenshots", &failure);
                    return;
                }
            }
        }
    }

    fn dispatch(self: &Arc<Self>, done: &mpsc::Sender<UploadDone>) {
        let now = now_ms();
        let mut state = self.lock();
        if state
            .next_api_attempt
            .is_some_and(|when| when > Instant::now())
        {
            return;
        }
        let slots = self
            .config
            .settings
            .max_concurrent_uploads
            .saturating_sub(state.in_flight);
        if slots == 0 {
            return;
        }
        let ready: Vec<QueueEntry> = state
            .queue
            .due(now)
            .into_iter()
            .filter(|entry| {
                let key = vm_key(entry.emulator_type, &entry.vm_name);
                state
                    .asked
                    .contains(&(key.clone(), entry.source_path.clone()))
                    && !state.held.contains(&key)
                    && state.registered.contains_key(&key)
            })
            .take(slots)
            .collect();
        for entry in ready {
            state.in_flight += 1;
            state.queue.set_state(
                entry.emulator_type,
                &entry.vm_name,
                &entry.source_path,
                EntryState::Uploading,
            );
            state.status_version += 1;
            let this = Arc::clone(self);
            let done = done.clone();
            tokio::spawn(async move {
                let outcome = tokio::select! {
                    outcome = this.upload_one(&entry) => outcome,
                    () = this.stopping.cancelled() => UploadOutcome::Cancelled,
                };
                let _ = done
                    .send(UploadDone {
                        emulator: entry.emulator_type,
                        vm_name: entry.vm_name.clone(),
                        source_path: entry.source_path.clone(),
                        sha256: entry.sha256.clone(),
                        short_hash: entry.short_hash().to_owned(),
                        attempt: entry.attempts + 1,
                        outcome,
                    })
                    .await;
            });
        }
    }

    async fn upload_one(&self, entry: &QueueEntry) -> UploadOutcome {
        let Some(base) = self.base_path(entry.emulator_type).map(Path::to_path_buf) else {
            return UploadOutcome::FileChanged;
        };
        let (vm_name, emulator, source_path, stamp) = (
            entry.vm_name.clone(),
            entry.emulator_type,
            entry.source_path.clone(),
            entry.stamp,
        );
        // Everything is checked again here, since time has passed since the scan.
        let opened = tokio::task::spawn_blocking(move || {
            let root = resolve_vm_root(&base, &vm_name, emulator)
                .map_err(|_| MediaFileProblem::Changed)?;
            open_media_file(&root, &source_path, stamp)
        })
        .await;
        let file = match opened {
            Ok(Ok(file)) => file,
            Ok(Err(MediaFileProblem::InUse)) => {
                return UploadOutcome::Failed(ApiFailure::Transient {
                    code: "file_in_use".to_owned(),
                    message: "The file is in use by another program".to_owned(),
                });
            }
            Ok(Err(MediaFileProblem::Unsafe(reason))) => {
                return UploadOutcome::Failed(ApiFailure::Permanent {
                    code: "source_unsafe".to_owned(),
                    message: reason,
                });
            }
            Ok(Err(MediaFileProblem::Unreadable(reason))) => {
                return UploadOutcome::Failed(ApiFailure::Transient {
                    code: "source_unreadable".to_owned(),
                    message: reason,
                });
            }
            Ok(Err(MediaFileProblem::Changed)) | Err(_) => return UploadOutcome::FileChanged,
        };
        let vm = VmIdentity {
            emulator_type: entry.emulator_type,
            vm_name: entry.vm_name.clone(),
        };
        match self.config.api.upload(&vm, entry, file).await {
            Ok(()) => UploadOutcome::Uploaded,
            Err(failure) => UploadOutcome::Failed(failure),
        }
    }

    fn finish_upload(&self, done: UploadDone) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
        state.status_version += 1;
        let UploadDone {
            emulator,
            vm_name,
            source_path,
            sha256,
            short_hash,
            attempt,
            outcome,
        } = done;
        // The entry may have been replaced by newer content while this was running.
        let current = state
            .queue
            .get(emulator, &vm_name, &source_path)
            .is_some_and(|entry| entry.sha256 == sha256);
        if !current {
            return;
        }
        match outcome {
            UploadOutcome::Uploaded => {
                tracing::info!(
                    vm = %vm_name, source_path = %source_path, sha256 = %short_hash, attempt,
                    status = "completed", "Screenshot uploaded"
                );
                state
                    .queue
                    .set_state(emulator, &vm_name, &source_path, EntryState::Completed);
            }
            UploadOutcome::Failed(failure) if failure.is_permanent() => {
                let error = failure.entry_error();
                tracing::warn!(
                    vm = %vm_name, source_path = %source_path, sha256 = %short_hash, attempt,
                    classification = "permanent", code = %error.code, message = %error.message,
                    "The server refused a screenshot; it will not be sent again unless it changes"
                );
                state
                    .queue
                    .mark_failed(emulator, &vm_name, &source_path, error);
            }
            UploadOutcome::Failed(failure) => {
                let error = failure.entry_error();
                let settings = &self.config.settings;
                let delay = state.queue.mark_retry(
                    emulator,
                    &vm_name,
                    &source_path,
                    error.clone(),
                    now_ms(),
                    RetryPolicy {
                        initial: settings.retry_initial,
                        ceiling: settings.retry_ceiling,
                    },
                );
                tracing::warn!(
                    vm = %vm_name, source_path = %source_path, sha256 = %short_hash, attempt,
                    classification = "transient", code = %error.code, message = %error.message,
                    retry_in_ms = delay.unwrap_or_default().as_millis() as u64,
                    "Upload failed; it will be tried again"
                );
            }
            UploadOutcome::FileChanged => {
                tracing::info!(
                    vm = %vm_name, source_path = %source_path, sha256 = %short_hash,
                    "A screenshot changed before it could be uploaded"
                );
                state.queue.remove(emulator, &vm_name, &source_path);
                let key = vm_key(emulator, &vm_name);
                state.dirty.entry(key).or_insert_with(Instant::now);
            }
            UploadOutcome::Cancelled => {
                state
                    .queue
                    .set_state(emulator, &vm_name, &source_path, EntryState::Pending);
            }
        }
    }

    async fn save(&self) {
        // Quick, and only one task ever does this, so it does not need the blocking pool's overhead of
        // moving the queue out and back. The write is small next to what a scan or an upload costs.
        let mut state = self.lock();
        if let Err(error) = state.queue.save() {
            tracing::warn!(%error, "Cannot save the media queue. It is tried again after the next change");
        }
    }

    /// Whether anything is still on its way, for tests and diagnostics.
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let state = self.lock();
        let mut counts = (0, 0, 0, 0);
        for entry in state.queue.entries() {
            match entry.state {
                EntryState::Pending | EntryState::RetryWait => counts.0 += 1,
                EntryState::Uploading => counts.1 += 1,
                EntryState::Completed => counts.2 += 1,
                EntryState::Failed => counts.3 += 1,
            }
        }
        counts
    }
}

impl MediaPreservation for MediaSync {
    fn acknowledged<'a>(
        &'a self,
        vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>> {
        self.config.api.acknowledged(vm, hashes)
    }

    fn request_sync(&self, vm: &VmIdentity) {
        {
            let mut state = self.lock();
            let key = vm_key(vm.emulator_type, &vm.vm_name);
            // Just registered, perhaps. Asking the server is what makes it count, not this call.
            if !state.registered.contains_key(&key) {
                state.full_requested = true;
                state.next_api_attempt = None;
            }
            state.dirty.entry(key).or_insert_with(Instant::now);
        }
        self.wake.notify_one();
    }

    fn requeue(&self, vm: &VmIdentity, hashes: &BTreeSet<String>) {
        {
            let mut state = self.lock();
            state
                .queue
                .requeue_hashes(vm.emulator_type, &vm.vm_name, hashes);
            let key = vm_key(vm.emulator_type, &vm.vm_name);
            state.asked.retain(|(entry_vm, _)| entry_vm != &key);
        }
        self.wake.notify_one();
    }

    fn failure_of(&self, vm: &VmIdentity, sha256: &str) -> Option<EntryError> {
        self.lock()
            .queue
            .failure_of(vm.emulator_type, &vm.vm_name, sha256)
            .cloned()
    }

    fn hold(&self, vm: &VmIdentity, held: bool) {
        {
            let mut state = self.lock();
            let key = vm_key(vm.emulator_type, &vm.vm_name);
            if held {
                state.held.insert(key);
            } else {
                state.held.remove(&key);
                state.dirty.entry(key).or_insert_with(Instant::now);
            }
        }
        self.wake.notify_one();
    }

    fn transfer_wait(&self) -> Duration {
        self.config.settings.transfer_wait
    }
}
