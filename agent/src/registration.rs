//! The durable side of registering a VM on the agent.
//!
//! Each operation has a journal file, written before anything irreversible happens, so that a restart
//! cannot lose track of what was already done. A journal survives until the server says it has
//! everything. Running work is independent of the connection: an upload continues while the server is
//! away, and its outcome is delivered, repeatedly, once it is back. Repeated reports are safe because
//! the server treats each as idempotent.
//!
//! The order is what protects a VM. The source is only read until the server has acknowledged a commit
//! for this exact operation and version. Even then, only a transfer deletes anything, and only after
//! [`crate::removal`] has re-checked everything against the local disk and the repository.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::archives::VersionId;
use crate::config::EmulatorConfig;
use crate::emulators::{EmulatorType, VmIdentity};
use crate::packaging::{
    BuildRequest, DirectoryIdentity, MANIFEST_VERSION, Manifest, SourceError, build_archive,
    directory_identity, remove_staging_files, resolve_vm_root,
};
use crate::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCancel, RegistrationCleanup,
    RegistrationFailure, RegistrationMode, RegistrationPhase, RegistrationProgress,
    RegistrationRequest, RegistrationResult, RegistrationStage, RegistrationSync,
    RegistrationSyncEntry, RepositoryConfigSummary, RepositoryHealthRequest,
    RepositoryHealthResult,
};
use crate::removal::{RemovalRequest, blocking_media, remove_vm_directory};
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
    RepositoryResult,
};
use crate::state::record_local_source;

const OUTBOUND_CAPACITY: usize = 64;
/// Progress is informational, so it is thinned out to well below the server's message limit.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
/// How long a health check may take in total, whatever the repository does.
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(90);
const REMOTE_CLEANUP_ATTEMPTS: u32 = 6;

/// Finds a configured repository. A request can only name one by UUID.
pub trait RepositoryProvider: Send + Sync {
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>>;
    fn summary(&self, repository_id: Uuid) -> Option<RepositoryConfigSummary>;
    /// How many times an upload is tried before giving up.
    fn upload_attempts(&self, repository_id: Uuid) -> u32;
}

pub struct OperationsConfig {
    pub agent_id: Uuid,
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub emulators: Arc<std::collections::BTreeMap<EmulatorType, EmulatorConfig>>,
    pub repositories: Arc<dyn RepositoryProvider>,
    /// How long to wait before trying again, between upload attempts.
    pub retry_delay: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "report", rename_all = "snake_case")]
enum Report {
    Failure(RegistrationFailure),
    Cleanup(RegistrationCleanup),
}

/// Everything needed to carry on after a restart. It holds no secret and no VM contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request: RegistrationRequest,
    phase: RegistrationPhase,
    identity: Option<DirectoryIdentity>,
    result: Option<RegistrationResult>,
    report: Option<Report>,
}

#[derive(Debug)]
struct JobFailure {
    code: String,
    message: String,
}

impl From<SourceError> for JobFailure {
    fn from(error: SourceError) -> Self {
        Self {
            code: error.kind.code().to_owned(),
            message: error.message,
        }
    }
}

impl From<RepositoryError> for JobFailure {
    fn from(error: RepositoryError) -> Self {
        Self {
            code: error.kind.code().to_owned(),
            message: error.message,
        }
    }
}

fn failure(code: &str, message: impl Into<String>) -> JobFailure {
    JobFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

struct Inner {
    config: OperationsConfig,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    /// Work in progress, and how to stop it.
    running: Mutex<HashMap<Uuid, CancelFlag>>,
    /// Set when the process is stopping. Work then ends without recording a failure: as far as the
    /// journal is concerned it was interrupted, and the next start handles that.
    stopping: CancelFlag,
}

pub struct AgentOperations {
    inner: Arc<Inner>,
    /// One session reads this at a time.
    outbound: tokio::sync::Mutex<mpsc::Receiver<Message>>,
}

impl AgentOperations {
    /// Loads what an earlier run left behind. Work that was interrupted before publication is marked
    /// as failed, and no source directory is touched by this.
    pub fn load(config: OperationsConfig) -> Result<Arc<Self>, String> {
        let (outbound, receiver) = mpsc::channel(OUTBOUND_CAPACITY);
        let directory = journal_directory(&config.state_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;

        let mut journals = HashMap::new();
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|text| text.to_str()) != Some("journal") {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) => {
                    return Err(format!("Cannot read {}: {error}", path.display()));
                }
            };
            // A damaged journal must not make the agent guess. Without it, the server treats the
            // operation as lost, which deletes nothing, and the file is kept for inspection.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a journal that cannot be read");
                continue;
            };
            journals.insert(journal.request.operation_id, journal);
        }

        let inner = Arc::new(Inner {
            config,
            outbound,
            journals: Mutex::new(journals),
            running: Mutex::new(HashMap::new()),
            stopping: CancelFlag::new(),
        });
        inner.recover_interrupted();
        Ok(Arc::new(Self {
            inner,
            outbound: tokio::sync::Mutex::new(receiver),
        }))
    }

    /// What a new connection must tell the server: which operations exist here, and every report the
    /// server may not have received.
    pub fn sync_messages(&self) -> Vec<Message> {
        let operations = {
            let journals = self.inner.journals.lock().expect("poisoned");
            journals
                .iter()
                .map(|(operation_id, journal)| RegistrationSyncEntry {
                    operation_id: *operation_id,
                    phase: journal.phase,
                })
                .collect()
        };
        let mut messages = vec![Message::AgentRegistrationSync(RegistrationSync {
            operations,
        })];
        messages.extend(self.pending_reports());
        messages
    }

    /// Reports that have no answer yet. Sent again on each heartbeat, so a lost message or a failed
    /// database commit on the server is recovered without any further coordination.
    pub fn pending_reports(&self) -> Vec<Message> {
        let journals = self.inner.journals.lock().expect("poisoned");
        let running = self.inner.running.lock().expect("poisoned");
        journals
            .iter()
            .filter_map(
                |(operation_id, journal)| match (&journal.report, journal.phase) {
                    (Some(Report::Failure(report)), _) => {
                        Some(Message::AgentRegistrationError(report.clone()))
                    }
                    (Some(Report::Cleanup(report)), _) => {
                        Some(Message::AgentRegistrationCleanup(report.clone()))
                    }
                    (None, RegistrationPhase::Published | RegistrationPhase::Cleaning)
                        if !running.contains_key(operation_id) =>
                    {
                        journal.result.clone().map(Message::AgentRegistrationResult)
                    }
                    _ => None,
                },
            )
            .collect()
    }

    /// The channel running work reports through.
    pub async fn outbound(&self) -> tokio::sync::MutexGuard<'_, mpsc::Receiver<Message>> {
        self.outbound.lock().await
    }

    /// Acts on a message for this module. Anything else is ignored.
    pub fn handle(&self, message: Message) {
        match message {
            Message::ServerRegistrationRequest(request) => self.inner.start(request),
            Message::ServerRegistrationCancel(cancel) => self.inner.cancel(&cancel),
            Message::ServerRegistrationAck(ack) => self.inner.acknowledged(ack),
            Message::ServerRepositoryHealthRequest(request) => self.inner.health_check(request),
            _ => {}
        }
    }

    /// A request that failed validation still deserves an answer, if it can be identified.
    pub fn refuse_invalid(&self, operation_id: Uuid) {
        self.inner
            .send(Message::AgentRegistrationError(RegistrationFailure {
                operation_id,
                code: "invalid_request".to_owned(),
                message: "The request failed validation".to_owned(),
            }));
    }

    /// Stops running work. Blocking work notices within one read.
    pub fn shutdown(&self) {
        self.inner.stopping.cancel();
        for flag in self.inner.running.lock().expect("poisoned").values() {
            flag.cancel();
        }
    }

    /// Whether this agent has anything unresolved, for tests and diagnostics.
    pub fn open_operations(&self) -> Vec<Uuid> {
        self.inner
            .journals
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect()
    }
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("registrations")
}

impl Inner {
    fn journal_path(&self, operation_id: Uuid) -> PathBuf {
        journal_directory(&self.config.state_dir).join(format!("{operation_id}.journal"))
    }

    fn manifest_path(&self, operation_id: Uuid) -> PathBuf {
        journal_directory(&self.config.state_dir).join(format!("{operation_id}.manifest.json"))
    }

    /// Replaces the journal atomically and durably, and then updates the copy in memory.
    fn persist(&self, journal: Journal) -> std::io::Result<()> {
        let operation_id = journal.request.operation_id;
        let path = self.journal_path(operation_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&journal).expect("a journal always serializes");
        {
            use std::io::Write;
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &path)?;
        self.journals
            .lock()
            .expect("poisoned")
            .insert(operation_id, journal);
        Ok(())
    }

    fn journal(&self, operation_id: Uuid) -> Option<Journal> {
        self.journals
            .lock()
            .expect("poisoned")
            .get(&operation_id)
            .cloned()
    }

    fn forget(&self, operation_id: Uuid) {
        self.journals
            .lock()
            .expect("poisoned")
            .remove(&operation_id);
        let _ = fs::remove_file(self.journal_path(operation_id));
        let _ = fs::remove_file(self.manifest_path(operation_id));
    }

    fn send(&self, message: Message) {
        // Nobody may be connected. Anything that matters is in a journal, and is sent again.
        let _ = self.outbound.try_send(message);
    }

    fn recover_interrupted(self: &Arc<Self>) {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .cloned()
            .collect();
        for journal in journals {
            let operation_id = journal.request.operation_id;
            match journal.phase {
                RegistrationPhase::Running => {
                    let repository_id = journal.request.repository_id;
                    remove_staging_files(&self.config.staging_dir, operation_id);
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the archive was published. Nothing was \
                             registered, and the local VM was not changed. It is safe to try again",
                        ),
                    );
                    self.spawn_remote_cleanup(operation_id, repository_id);
                }
                // The link may or may not have been made. Only the repository can say.
                RegistrationPhase::Publishing => {
                    remove_staging_files(&self.config.staging_dir, operation_id);
                    let inner = Arc::clone(self);
                    tokio::spawn(async move { inner.resolve_publishing(journal).await });
                }
                _ => remove_staging_files(&self.config.staging_dir, operation_id),
            }
        }
    }

    /// A crash happened while publishing. If the final object is there and is what was built, then it
    /// is this operation's, because its key holds this operation's version UUID.
    async fn resolve_publishing(self: Arc<Self>, mut journal: Journal) {
        let operation_id = journal.request.operation_id;
        let Some(result) = journal.result.clone() else {
            return;
        };
        let repository = match self.config.repositories.open(journal.request.repository_id) {
            Ok(repository) => repository,
            Err(error) => {
                self.record_failure(journal, error.into());
                return;
            }
        };
        let Ok(final_key) = RepositoryKey::new(result.archive_key.clone()) else {
            return;
        };
        let staging = RepositoryKey::staging(operation_id);
        loop {
            if self.stopping.is_cancelled() {
                return;
            }
            let verified = repository
                .verify(
                    &final_key,
                    result.archive_size_bytes,
                    &result.archive_sha256,
                    crate::repository::no_progress(),
                    &self.stopping,
                )
                .await;
            match verified {
                Ok(_) => {
                    let _ = repository.delete(&staging).await;
                    journal.phase = RegistrationPhase::Published;
                    if self.persist(journal.clone()).is_ok() {
                        self.send(Message::AgentRegistrationResult(result));
                    }
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::NotFound => {
                    let _ = repository.delete(&staging).await;
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the archive was published",
                        ),
                    );
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::Cancelled => return,
                // The repository cannot be reached yet. Nothing here is urgent.
                Err(error) => {
                    tracing::warn!(%error, %operation_id, "Cannot check a publication yet");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        }
    }

    /// Removes what an attempt left under its staging key. Nothing refers to it and nothing can take
    /// it for an archive, so this is only tidying. It is still tried a few times, because the failure
    /// that got us here may well be the repository going away for a moment.
    fn spawn_remote_cleanup(self: &Arc<Self>, operation_id: Uuid, repository_id: Uuid) {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let Ok(repository) = inner.config.repositories.open(repository_id) else {
                return;
            };
            let staging = RepositoryKey::staging(operation_id);
            for attempt in 0..REMOTE_CLEANUP_ATTEMPTS {
                match repository.delete(&staging).await {
                    Ok(()) => return,
                    Err(error) if attempt + 1 == REMOTE_CLEANUP_ATTEMPTS => {
                        tracing::warn!(%error, %operation_id, "Cannot remove a staging object");
                    }
                    Err(_) => tokio::time::sleep(inner.config.retry_delay).await,
                }
            }
        });
    }

    fn record_failure(&self, mut journal: Journal, failed: JobFailure) {
        let operation_id = journal.request.operation_id;
        let report = RegistrationFailure {
            operation_id,
            code: failed.code,
            message: bounded(&failed.message),
        };
        journal.phase = RegistrationPhase::Reported;
        journal.report = Some(Report::Failure(report.clone()));
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a failure");
        }
        self.send(Message::AgentRegistrationError(report));
    }

    fn start(self: &Arc<Self>, request: RegistrationRequest) {
        let operation_id = request.operation_id;
        if self.journal(operation_id).is_some() {
            tracing::debug!(%operation_id, "Ignored a repeated registration request");
            return;
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                // Registering two VMs at once on one disk helps nobody, and the server prevents it.
                self.send(Message::AgentRegistrationError(RegistrationFailure {
                    operation_id,
                    code: "agent_busy".to_owned(),
                    message: "This agent is already running a registration".to_owned(),
                }));
                return;
            }
            running.insert(operation_id, cancel.clone());
        }

        let journal = Journal {
            request,
            phase: RegistrationPhase::Running,
            identity: None,
            result: None,
            report: None,
        };
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot create a journal");
            self.running.lock().expect("poisoned").remove(&operation_id);
            self.send(Message::AgentRegistrationError(RegistrationFailure {
                operation_id,
                code: "staging_failed".to_owned(),
                message: "The agent cannot write to its state directory".to_owned(),
            }));
            return;
        }

        let inner = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, "Registration started");
            let outcome = inner.run_job(operation_id, &cancel).await;
            inner
                .running
                .lock()
                .expect("poisoned")
                .remove(&operation_id);
            if inner.stopping.is_cancelled() {
                // Left exactly as a crash would leave it. The next start deals with it.
                return;
            }
            if let Err(failed) = outcome {
                tracing::warn!(%operation_id, code = %failed.code, message = %failed.message, "Registration failed");
                remove_staging_files(&inner.config.staging_dir, operation_id);
                if let Some(journal) = inner.journal(operation_id) {
                    let repository_id = journal.request.repository_id;
                    inner.record_failure(journal, failed);
                    inner.spawn_remote_cleanup(operation_id, repository_id);
                }
            }
        });
    }

    fn cancel(&self, cancel: &RegistrationCancel) {
        let operation_id = cancel.operation_id;
        if let Some(flag) = self.running.lock().expect("poisoned").get(&operation_id) {
            let phase = self.journal(operation_id).map(|journal| journal.phase);
            // Past this point only the server's answer to the result decides what happens.
            if matches!(phase, Some(RegistrationPhase::Running)) {
                tracing::info!(%operation_id, "Registration cancelled");
                flag.cancel();
            }
        }
    }

    fn progress_reporter(
        self: &Arc<Self>,
        operation_id: Uuid,
        stage: RegistrationStage,
    ) -> ProgressFn {
        let inner = Arc::clone(self);
        let last = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
        self.send_progress(operation_id, stage, None, None);
        Arc::new(move |done: u64, total: u64| {
            let mut last = last.lock().expect("poisoned");
            if last.elapsed() >= PROGRESS_INTERVAL || done == total {
                *last = Instant::now();
                inner.send_progress(operation_id, stage, Some(done), Some(total));
            }
        })
    }

    fn send_progress(
        &self,
        operation_id: Uuid,
        stage: RegistrationStage,
        done_bytes: Option<u64>,
        total_bytes: Option<u64>,
    ) {
        self.send(Message::AgentRegistrationProgress(RegistrationProgress {
            operation_id,
            stage,
            done_bytes,
            total_bytes,
        }));
    }

    /// Everything up to and including publication. On success, the result has been recorded and sent.
    async fn run_job(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Result<(), JobFailure> {
        let mut journal = self
            .journal(operation_id)
            .ok_or_else(|| failure("internal_error", "The journal disappeared"))?;
        let request = journal.request.clone();
        self.send_progress(operation_id, RegistrationStage::Validating, None, None);

        let identity = VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        };
        // The server names the key, and this checks that it means what it must.
        let final_key = RepositoryKey::for_version(&identity, VersionId(request.version_id));
        if final_key.as_str() != request.archive_key {
            return Err(failure(
                "invalid_request",
                "The archive key does not belong to this VM and version",
            ));
        }
        let base_path = self
            .config
            .emulators
            .get(&request.emulator_type)
            .map(|emulator| emulator.base_path.clone())
            .ok_or_else(|| {
                failure(
                    "source_missing",
                    format!("{} is not configured on this agent", request.emulator_type),
                )
            })?;
        let repository = self.config.repositories.open(request.repository_id)?;

        let root = {
            let (base_path, vm_name, emulator) = (
                base_path.clone(),
                request.vm_name.clone(),
                request.emulator_type,
            );
            blocking(move || resolve_vm_root(&base_path, &vm_name, emulator)).await??
        };
        let directory = directory_identity(&root).map_err(|error| {
            failure(
                "source_unreadable",
                format!("Cannot identify the directory: {error}"),
            )
        })?;
        if request.mode == RegistrationMode::Transfer {
            let (scan_root, emulator) = (root.clone(), request.emulator_type);
            let media = blocking(move || blocking_media(&scan_root, emulator))
                .await?
                .map_err(|error| failure(error.refusal.code(), error.message))?;
            if let Some(first) = media.first() {
                return Err(failure(
                    "transfer_blocked_media",
                    format!(
                        "This VM has {} screenshot(s), such as {first}. Screenshots are not in the \
                         archive and cannot be uploaded yet, so a transfer would lose them. Move \
                         them elsewhere, or use Copy",
                        media.len()
                    ),
                ));
            }
        }
        if repository.stat(&final_key).await?.is_some() {
            return Err(failure(
                "archive_exists",
                "An archive already exists at this version's key",
            ));
        }

        journal.identity = Some(directory);
        self.persist(journal.clone()).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;

        let archiving_progress = self.progress_reporter(operation_id, RegistrationStage::Archiving);
        let built = {
            let (staging_dir, emulator, vm_name, root, cancel) = (
                self.config.staging_dir.clone(),
                request.emulator_type,
                request.vm_name.clone(),
                root.clone(),
                cancel.clone(),
            );
            blocking(move || {
                build_archive(
                    &BuildRequest {
                        emulator,
                        vm_name: &vm_name,
                        root: &root,
                        staging_dir: &staging_dir,
                        operation_id,
                    },
                    &mut |progress| {
                        archiving_progress(progress.done_bytes, progress.total_bytes);
                    },
                    &cancel,
                )
            })
            .await??
        };
        write_manifest(&self.manifest_path(operation_id), &built.manifest).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot keep the manifest: {error}"),
            )
        })?;

        if let Some(free) = repository.free_space().await?
            && free < built.size_bytes
        {
            return Err(failure(
                "insufficient_remote_space",
                format!(
                    "The repository has {free} bytes free, and the archive is {} bytes",
                    built.size_bytes
                ),
            ));
        }

        let staging = RepositoryKey::staging(operation_id);
        let attempts = self
            .config
            .repositories
            .upload_attempts(request.repository_id)
            .max(1);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = self
                .upload_and_verify(&*repository, &staging, &built, operation_id, cancel)
                .await;
            match outcome {
                Ok(()) => break,
                Err(error) if error.kind.is_retryable() && attempt < attempts => {
                    tracing::warn!(%error, %operation_id, attempt, "Upload failed; trying again");
                    let _ = repository.delete(&staging).await;
                    tokio::select! {
                        () = tokio::time::sleep(self.config.retry_delay) => {}
                        () = cancel.cancelled() => return Err(RepositoryError::cancelled().into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }

        // The last moment a cancellation can take effect here. After it, the server decides.
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }
        let result = RegistrationResult {
            operation_id,
            version_id: request.version_id,
            archive_key: request.archive_key.clone(),
            archive_size_bytes: built.size_bytes,
            archive_sha256: built.sha256.clone(),
            manifest_version: MANIFEST_VERSION,
            manifest_sha256: built.manifest_sha256.clone(),
            file_count: built.manifest.file_count,
            total_uncompressed_bytes: built.manifest.total_uncompressed_bytes,
        };
        journal.phase = RegistrationPhase::Publishing;
        journal.result = Some(result.clone());
        self.persist(journal.clone()).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;

        let published = async {
            let mut attempt = 0;
            loop {
                attempt += 1;
                match repository.publish(&staging, &final_key).await {
                    Ok(()) => return Ok(()),
                    // A retry after a lost answer finds its own object. Its key holds this
                    // operation's version UUID, and its bytes are checked before believing that.
                    Err(error) if error.kind == RepositoryErrorKind::AlreadyExists => {
                        return repository
                            .verify(
                                &final_key,
                                built.size_bytes,
                                &built.sha256,
                                crate::repository::no_progress(),
                                &CancelFlag::new(),
                            )
                            .await
                            .map(|_| ())
                            .map_err(|_| error);
                    }
                    // The link may have been made and only the answer lost.
                    Err(error) if error.kind.is_retryable() && attempt < attempts => {
                        tracing::warn!(%error, %operation_id, "Publication failed; trying again");
                        tokio::time::sleep(self.config.retry_delay).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        .await;
        if let Err(error) = published {
            journal.phase = RegistrationPhase::Running;
            journal.result = None;
            let _ = self.persist(journal);
            return Err(error.into());
        }

        let stored = repository.stat(&final_key).await?;
        if stored.map(|object| object.size_bytes) != Some(built.size_bytes) {
            // The archive may exist with the wrong size. It is not referenced by anything, and the
            // journal must not say that it was published.
            journal.phase = RegistrationPhase::Running;
            journal.result = None;
            let _ = self.persist(journal);
            return Err(failure(
                "hash_mismatch",
                "The published archive does not have the expected size",
            ));
        }

        journal.phase = RegistrationPhase::Published;
        self.persist(journal).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;
        remove_staging_files(&self.config.staging_dir, operation_id);
        tracing::info!(%operation_id, size = built.size_bytes, sha256 = %built.sha256, "Archive published");
        self.send(Message::AgentRegistrationResult(result));
        Ok(())
    }

    async fn upload_and_verify(
        self: &Arc<Self>,
        repository: &dyn ArchiveRepository,
        staging: &RepositoryKey,
        built: &crate::packaging::BuiltArchive,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> RepositoryResult<()> {
        let uploading = self.progress_reporter(operation_id, RegistrationStage::Uploading);
        repository
            .upload(staging, &built.path, uploading, cancel)
            .await?;
        let verifying = self.progress_reporter(operation_id, RegistrationStage::Verifying);
        repository
            .verify(staging, built.size_bytes, &built.sha256, verifying, cancel)
            .await?;
        Ok(())
    }

    /// The server has answered about this operation.
    fn acknowledged(self: &Arc<Self>, ack: RegistrationAck) {
        let operation_id = ack.operation_id;
        let Some(journal) = self.journal(operation_id) else {
            tracing::debug!(%operation_id, "An answer about an operation that is already closed");
            return;
        };
        match ack.outcome {
            AckOutcome::Closed => {
                tracing::info!(%operation_id, "Registration closed");
                self.forget(operation_id);
            }
            AckOutcome::Rejected => {
                tracing::warn!(%operation_id, "The server rejected this registration");
                let inner = Arc::clone(self);
                tokio::spawn(async move {
                    if let Ok(repository) = inner
                        .config
                        .repositories
                        .open(journal.request.repository_id)
                    {
                        let staging = RepositoryKey::staging(operation_id);
                        let _ = repository.delete(&staging).await;
                        // Only what this operation published, and only because the server said that
                        // nothing refers to it.
                        if ack.delete_published
                            && let Some(result) = &journal.result
                            && let Ok(key) = RepositoryKey::new(result.archive_key.clone())
                        {
                            let _ = repository.delete(&key).await;
                        }
                    }
                    inner.forget(operation_id);
                });
            }
            AckOutcome::Committed => self.committed(journal, &ack),
        }
    }

    fn committed(self: &Arc<Self>, mut journal: Journal, ack: &RegistrationAck) {
        let operation_id = ack.operation_id;
        if ack.version_id != Some(journal.request.version_id) {
            tracing::error!(%operation_id, "An acknowledgement for a different version was ignored");
            return;
        }
        if !matches!(
            journal.phase,
            RegistrationPhase::Published | RegistrationPhase::Cleaning
        ) {
            return;
        }
        {
            let mut running = self.running.lock().expect("poisoned");
            if running.contains_key(&operation_id) {
                return;
            }
            running.insert(operation_id, CancelFlag::new());
        }
        journal.phase = RegistrationPhase::Cleaning;
        if let Err(error) = self.persist(journal.clone()) {
            tracing::error!(%error, %operation_id, "Cannot record the commit");
            self.running.lock().expect("poisoned").remove(&operation_id);
            return;
        }

        // Both have to agree. Neither a repeated message nor a confused server can turn a copy into a
        // deletion, since the mode the agent was given is in its own journal.
        let remove = ack.remove_local && journal.request.mode == RegistrationMode::Transfer;
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let report = if remove {
                inner.remove_local(&journal).await
            } else {
                inner.keep_local(&journal)
            };
            inner
                .running
                .lock()
                .expect("poisoned")
                .remove(&operation_id);
            if inner.stopping.is_cancelled() {
                return;
            }
            journal.phase = RegistrationPhase::Reported;
            journal.report = Some(Report::Cleanup(report.clone()));
            if let Err(error) = inner.persist(journal) {
                tracing::error!(%error, %operation_id, "Cannot record the cleanup");
            }
            inner.send(Message::AgentRegistrationCleanup(report));
        });
    }

    fn keep_local(&self, journal: &Journal) -> RegistrationCleanup {
        let request = &journal.request;
        if request.mode == RegistrationMode::Copy
            && let Err(error) = record_local_source(
                &self.config.state_dir,
                self.config.agent_id,
                request.emulator_type,
                &request.vm_name,
                request.version_id,
                journal
                    .result
                    .as_ref()
                    .map(|result| result.manifest_sha256.as_str()),
            )
        {
            // Registration succeeded. Local bookkeeping can be rebuilt by a later verification.
            tracing::warn!(%error, "Cannot record the local source version");
        }
        RegistrationCleanup {
            operation_id: request.operation_id,
            version_id: request.version_id,
            local_copy: LocalCopyStatus::Preserved,
            code: None,
            message: None,
        }
    }

    async fn remove_local(self: &Arc<Self>, journal: &Journal) -> RegistrationCleanup {
        let request = &journal.request;
        let operation_id = request.operation_id;
        let refused = |code: &str, message: String| RegistrationCleanup {
            operation_id,
            version_id: request.version_id,
            local_copy: LocalCopyStatus::CleanupFailed,
            code: Some(code.to_owned()),
            message: Some(bounded(&message)),
        };
        let (Some(identity), Some(result)) = (journal.identity, journal.result.clone()) else {
            return refused(
                "cleanup_identity_mismatch",
                "The journal does not say which directory was archived".to_owned(),
            );
        };
        let Some(base_path) = self
            .config
            .emulators
            .get(&request.emulator_type)
            .map(|emulator| emulator.base_path.clone())
        else {
            return refused(
                "cleanup_identity_mismatch",
                "This emulator is no longer configured".to_owned(),
            );
        };
        let manifest: Manifest = match fs::read(self.manifest_path(operation_id))
            .map_err(|error| error.to_string())
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
        {
            Ok(manifest) => manifest,
            Err(error) => {
                return refused(
                    "cleanup_unreadable",
                    format!("Cannot read the manifest: {error}"),
                );
            }
        };
        if manifest.sha256() != result.manifest_sha256 {
            return refused(
                "cleanup_unreadable",
                "The saved manifest is not the one that was archived".to_owned(),
            );
        }

        // The archive is the only other copy, so it is read back once more before deleting anything.
        let verify_key = RepositoryKey::new(result.archive_key.clone());
        let verified = match (
            self.config.repositories.open(request.repository_id),
            verify_key,
        ) {
            (Ok(repository), Ok(key)) => {
                let cancel = self.stopping.clone();
                repository
                    .verify(
                        &key,
                        result.archive_size_bytes,
                        &result.archive_sha256,
                        self.progress_reporter(operation_id, RegistrationStage::CleaningLocal),
                        &cancel,
                    )
                    .await
                    .map(|_| ())
            }
            (Err(error), _) => Err(error),
            (_, Err(_)) => Err(RepositoryError::new(
                RepositoryErrorKind::Protocol,
                "The archive key is not valid",
            )),
        };
        if let Err(error) = verified {
            return refused(
                error.kind.code(),
                format!(
                    "The archive could not be re-verified, so the local VM was kept: {}",
                    error.message
                ),
            );
        }

        let progress = self.progress_reporter(operation_id, RegistrationStage::CleaningLocal);
        let cancel = self.stopping.clone();
        let (emulator, vm_name, version_id) = (
            request.emulator_type,
            request.vm_name.clone(),
            request.version_id,
        );
        let removed = blocking(move || {
            remove_vm_directory(
                &RemovalRequest {
                    base_path: &base_path,
                    emulator,
                    vm_name: &vm_name,
                    operation_id,
                    identity,
                    manifest: &manifest,
                },
                &progress,
                &cancel,
            )
        })
        .await;
        match removed {
            Ok(Ok(())) => {
                tracing::info!(%operation_id, version = %version_id, "Local VM removed after a verified transfer");
                RegistrationCleanup {
                    operation_id,
                    version_id,
                    local_copy: LocalCopyStatus::Removed,
                    code: None,
                    message: None,
                }
            }
            Ok(Err(error)) => {
                tracing::warn!(%operation_id, code = error.refusal.code(), message = %error.message, "Local VM kept");
                refused(error.refusal.code(), error.message)
            }
            Err(error) => refused(&error.code, error.message),
        }
    }

    fn health_check(self: &Arc<Self>, request: RepositoryHealthRequest) {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let configuration = inner.config.repositories.summary(request.repository_id);
            let checked = async {
                let repository = inner.config.repositories.open(request.repository_id)?;
                repository.health_check(&inner.stopping).await
            };
            let outcome = tokio::time::timeout(HEALTH_CHECK_TIMEOUT, checked)
                .await
                .unwrap_or_else(|_| {
                    Err(RepositoryError::new(
                        RepositoryErrorKind::Unreachable,
                        "The health check took too long",
                    ))
                });
            let result = match outcome {
                Ok(report) => RepositoryHealthResult {
                    operation_id: request.operation_id,
                    repository_id: request.repository_id,
                    ok: true,
                    code: None,
                    message: None,
                    configuration,
                    host_key_fingerprint: report.host_key_fingerprint,
                    free_bytes: report.free_bytes,
                },
                Err(error) => RepositoryHealthResult {
                    operation_id: request.operation_id,
                    repository_id: request.repository_id,
                    ok: false,
                    code: Some(error.kind.code().to_owned()),
                    message: Some(bounded(&error.message)),
                    configuration,
                    host_key_fingerprint: None,
                    free_bytes: None,
                },
            };
            inner.send(Message::AgentRepositoryHealthResult(result));
        });
    }
}

/// Runs filesystem work on the blocking pool, so that heartbeats continue.
async fn blocking<T, F>(work: F) -> Result<T, JobFailure>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| failure("internal_error", format!("The work stopped: {error}")))
}

fn write_manifest(path: &Path, manifest: &Manifest) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::File::create(path)?;
    file.write_all(&manifest.canonical_bytes())?;
    file.sync_all()
}

/// Messages travel in a size-limited protocol, and end up in the web interface.
fn bounded(message: &str) -> String {
    message.chars().take(1000).collect()
}
