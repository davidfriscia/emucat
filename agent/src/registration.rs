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
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::archives::VersionId;
use crate::config::EmulatorConfig;
use crate::emulators::{EmulatorType, VmIdentity};
use crate::execution::{ActivityProbe, ExecutionConfig, ExecutionManager, ExecutionSettings};
use crate::media_sync::{DetachReport, MediaPreservation, detach_without_synchronization};
use crate::packaging::{
    BuildRequest, DirectoryIdentity, MANIFEST_VERSION, Manifest, SourceError, build_archive,
    directory_identity, remove_staging_files, resolve_vm_root,
};
use crate::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCancel, RegistrationCleanup,
    RegistrationFailure, RegistrationMode, RegistrationPhase, RegistrationProgress,
    RegistrationRequest, RegistrationResult, RegistrationRetryCleanup, RegistrationStage,
    RegistrationSync, RegistrationSyncEntry, RepositoryConfigSummary, RepositoryHealthRequest,
    RepositoryHealthResult, WorkspaceDiscard, WorkspaceDiscardResult,
};
use crate::removal::{RemovalRequest, remove_vm_directory};
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
    RepositoryResult,
};
use crate::restore::{RestoreConfig, RestoreManager, RestoreSettings};
use crate::state::record_local_source;

const OUTBOUND_CAPACITY: usize = 64;
/// Progress is informational, so it is thinned out to well below the server's message limit.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
/// How long a health check may take in total, whatever the repository does.
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(90);
const REMOTE_CLEANUP_ATTEMPTS: u32 = 6;
/// The code a removal blocked by a screenshot reported before decision 0051. Nothing reports it now, but a
/// journal kept from before an upgrade can still be retried, and then simply succeeds.
const MEDIA_BLOCKED_CODE: &str = "transfer_blocked_media";
/// The code a removal refused because the VM is running reports. It is kept for a retry too.
const RUNNING_BLOCKED_CODE: &str = "transfer_blocked_running";

fn is_retryable_cleanup(code: Option<&str>) -> bool {
    matches!(code, Some(MEDIA_BLOCKED_CODE | RUNNING_BLOCKED_CODE))
}

/// Finds a configured repository. A request can only name one by UUID.
pub trait RepositoryProvider: Send + Sync {
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>>;
    fn summary(&self, repository_id: Uuid) -> Option<RepositoryConfigSummary>;
    /// How many times a transfer is tried before giving up.
    fn upload_attempts(&self, repository_id: Uuid) -> u32;
    /// The repositories this agent has local settings for. No secrets, only UUIDs.
    fn repository_ids(&self) -> Vec<Uuid>;
}

pub struct OperationsConfig {
    pub agent_id: Uuid,
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub emulators: Arc<std::collections::BTreeMap<EmulatorType, EmulatorConfig>>,
    pub repositories: Arc<dyn RepositoryProvider>,
    /// How long to wait before trying again, between upload attempts.
    pub retry_delay: Duration,
    /// Screenshot synchronization. Without it a transfer of a VM with screenshots is refused up front,
    /// since nothing could ever prove that they are preserved.
    pub media: Option<Arc<dyn MediaPreservation>>,
    /// Where restores keep things, and what they accept.
    pub restore: RestoreSettings,
    /// How emulators are started and stopped.
    pub execution: ExecutionSettings,
    /// VirtualBox, when it is configured: registered machines are exported, run and watched (decision 0045).
    pub virtualbox: Option<crate::virtualbox::VirtualBoxSettings>,
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
    /// Work in progress, restores included, and how to stop it.
    running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
    /// Set when the process is stopping. Work then ends without recording a failure: as far as the
    /// journal is concerned it was interrupted, and the next start handles that.
    stopping: CancelFlag,
    /// Whether an emulator is running a VM. Nothing reads a VM for an archive, or removes it, then.
    activity: OnceLock<ActivityProbe>,
    /// VMs whose working copy is being removed. Nothing may launch, archive or restore them meanwhile.
    discarding: Mutex<std::collections::HashSet<VmIdentity>>,
}

pub struct AgentOperations {
    inner: Arc<Inner>,
    virtualbox: Arc<crate::virtualbox_registration::VirtualBoxRegistrations>,
    /// Imports into VirtualBox and deletions from it (decision 0046).
    management: Arc<crate::virtualbox_management::VirtualBoxManagement>,
    /// Screenshots of running VirtualBox machines (decision 0046).
    virtualbox_captures: Arc<crate::virtualbox_capture::VirtualBoxCaptures>,
    monitor: Option<Arc<crate::virtualbox_monitor::VirtualBoxMonitor>>,
    restores: Arc<RestoreManager>,
    execution: Arc<ExecutionManager>,
    captures: Arc<crate::capture::CaptureManager>,
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

        let running: Arc<Mutex<HashMap<Uuid, CancelFlag>>> = Arc::default();
        let stopping = CancelFlag::new();
        let restores = RestoreManager::load(
            RestoreConfig {
                agent_id: config.agent_id,
                state_dir: config.state_dir.clone(),
                staging_dir: config.staging_dir.clone(),
                emulators: Arc::clone(&config.emulators),
                repositories: Arc::clone(&config.repositories),
                retry_delay: config.retry_delay,
                media: config.media.clone(),
                settings: config.restore.clone(),
            },
            outbound.clone(),
            Arc::clone(&running),
            stopping.clone(),
        )?;
        let execution = ExecutionManager::load(
            ExecutionConfig {
                state_dir: config.state_dir.clone(),
                emulators: Arc::clone(&config.emulators),
                settings: config.execution,
            },
            outbound.clone(),
            stopping.clone(),
        )?;
        let captures = crate::capture::CaptureManager::load(
            config.state_dir.clone(),
            execution.clone(),
            config.media.clone(),
        )?;
        captures.set_outbound(outbound.clone());
        let virtualbox = crate::virtualbox_registration::VirtualBoxRegistrations::load(
            crate::virtualbox_registration::VirtualBoxRegistrationsConfig {
                settings: config.virtualbox.clone(),
                state_dir: config.state_dir.clone(),
                staging_dir: config.staging_dir.clone(),
                repositories: Arc::clone(&config.repositories),
                retry_delay: config.retry_delay,
            },
            outbound.clone(),
            Arc::clone(&running),
            stopping.clone(),
        )?;
        let management = crate::virtualbox_management::VirtualBoxManagement::load(
            crate::virtualbox_management::VirtualBoxManagementConfig {
                settings: config.virtualbox.clone(),
                state_dir: config.state_dir.clone(),
                staging_dir: config.staging_dir.clone(),
                repositories: Arc::clone(&config.repositories),
            },
            outbound.clone(),
            Arc::clone(&running),
            stopping.clone(),
        )?;
        let virtualbox_captures = crate::virtualbox_capture::VirtualBoxCaptures::load(
            config.virtualbox.clone(),
            &config.state_dir,
            outbound.clone(),
            stopping.clone(),
        )?;
        let monitor = config.virtualbox.clone().map(|settings| {
            let monitor = crate::virtualbox_monitor::VirtualBoxMonitor::new(
                settings,
                outbound.clone(),
                stopping.clone(),
            );
            // Nothing starts a machine that is being exported or deleted.
            let (exports, deletions) = (Arc::downgrade(&virtualbox), Arc::downgrade(&management));
            monitor.set_busy_probe(Arc::new(move || {
                let mut busy = exports
                    .upgrade()
                    .map(|exports| exports.exporting())
                    .unwrap_or_default();
                busy.extend(
                    deletions
                        .upgrade()
                        .map(|deletions| deletions.deleting())
                        .unwrap_or_default(),
                );
                busy
            }));
            let watching = Arc::downgrade(&monitor);
            virtualbox_captures.set_watch_probe(Arc::new(move |machine| {
                watching
                    .upgrade()
                    .is_some_and(|monitor| monitor.watches(machine))
            }));
            if tokio::runtime::Handle::try_current().is_ok() {
                monitor.spawn();
            }
            monitor
        });
        let inner = Arc::new(Inner {
            config,
            outbound,
            journals: Mutex::new(journals),
            running,
            stopping,
            activity: OnceLock::new(),
            discarding: Mutex::default(),
        });

        // Each side asks the other, so neither can start on a VM the other is using. Weak references, so
        // that the managers can still be dropped.
        let vm_activity: ActivityProbe = {
            let execution = Arc::downgrade(&execution);
            Arc::new(move |vm: &VmIdentity| {
                execution
                    .upgrade()
                    .and_then(|execution| execution.activity(vm))
            })
        };
        let _ = inner.activity.set(Arc::clone(&vm_activity));
        restores.set_activity_probe(vm_activity);
        let disk_work: ActivityProbe = {
            let (inner, restores): (Weak<Inner>, Weak<RestoreManager>) =
                (Arc::downgrade(&inner), Arc::downgrade(&restores));
            Arc::new(move |vm: &VmIdentity| {
                inner
                    .upgrade()
                    .and_then(|inner| inner.working_on(vm))
                    .or_else(|| {
                        restores
                            .upgrade()
                            .and_then(|restores| restores.working_on(vm))
                    })
            })
        };
        execution.set_busy_probe(disk_work);

        inner.recover_interrupted();
        crate::workspaces::recover(&inner.config.state_dir);
        Ok(Arc::new(Self {
            inner,
            virtualbox,
            management,
            virtualbox_captures,
            monitor,
            restores,
            execution,
            captures,
            outbound: tokio::sync::Mutex::new(receiver),
        }))
    }

    pub fn execution(&self) -> &Arc<ExecutionManager> {
        &self.execution
    }

    /// Where VirtualBox screenshots are uploaded. Without one, none are taken.
    pub fn set_capture_uploader(
        &self,
        uploader: Arc<dyn crate::virtualbox_capture::CaptureUploader>,
    ) {
        self.virtualbox_captures.set_uploader(uploader);
    }

    /// What a new connection must tell the server: which operations exist here, and every report the
    /// server may not have received.
    pub fn sync_messages(&self) -> Vec<Message> {
        let mut operations: Vec<RegistrationSyncEntry> = {
            let journals = self.inner.journals.lock().expect("poisoned");
            journals
                .iter()
                .map(|(operation_id, journal)| RegistrationSyncEntry {
                    operation_id: *operation_id,
                    phase: journal.phase,
                })
                .collect()
        };
        operations.extend(self.virtualbox.sync_entries());
        let mut messages = vec![Message::AgentRegistrationSync(RegistrationSync {
            operations,
            snapshots: true,
            virtualbox: self.monitor.is_some(),
            virtualbox_management: self.monitor.is_some() && self.management.available(),
            virtualbox_operations: self.management.sync_entries(),
        })];
        messages.push(self.restores.sync_message());
        // Leftovers of a removed copy are deleted again on each connection, off the connection's task.
        if tokio::runtime::Handle::try_current().is_ok() {
            let restores = Arc::clone(&self.restores);
            tokio::task::spawn_blocking(move || restores.retry_removal_leftovers());
        }
        messages.push(
            self.execution
                .sync_message(self.restores.open_verifications()),
        );
        messages.extend(self.pending_reports());
        messages
    }

    /// Reports that have no answer yet. Sent again on each heartbeat, so a lost message or a failed
    /// database commit on the server is recovered without any further coordination.
    pub fn pending_reports(&self) -> Vec<Message> {
        let mut reports = self.pending_registration_reports();
        reports.extend(self.virtualbox.pending_reports());
        reports.extend(self.management.pending_reports());
        reports.extend(self.virtualbox_captures.reports());
        reports.extend(self.restores.pending_reports());
        reports.extend(self.execution.pending_reports());
        reports.extend(self.captures.reports());
        reports
    }

    fn pending_registration_reports(&self) -> Vec<Message> {
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
            Message::ServerQemuCapture(request) => self.captures.start(request),
            // VirtualBox captures share the QEMU answers, routed by operation.
            Message::ServerQemuCaptureAck(ack)
                if self.virtualbox_captures.owns(ack.operation_id) =>
            {
                let captures = self.virtualbox_captures.clone();
                tokio::task::spawn_blocking(move || captures.acknowledge(ack));
            }
            Message::ServerQemuCaptureRetry(retry)
                if self.virtualbox_captures.owns(retry.operation_id) =>
            {
                let captures = self.virtualbox_captures.clone();
                tokio::task::spawn_blocking(move || captures.retry(retry));
            }
            Message::ServerVirtualBoxCapture(request) => self.virtualbox_captures.start(request),
            Message::ServerVirtualBoxImport(request) => self.management.start_import(request),
            Message::ServerVirtualBoxDelete(request) => self.management.start_delete(request),
            Message::ServerVirtualBoxOperationAck(ack) => self.management.acknowledged(ack),
            Message::ServerQemuCaptureAck(ack) => {
                let captures = self.captures.clone();
                tokio::task::spawn_blocking(move || captures.acknowledge(ack));
            }
            Message::ServerQemuCaptureRetry(retry) => {
                let captures = self.captures.clone();
                tokio::task::spawn_blocking(move || captures.retry(retry));
            }
            Message::ServerRegistrationRequest(request) => self.inner.start(request),
            // VirtualBox registrations share the answers of all others, routed by operation.
            Message::ServerRegistrationCancel(cancel)
                if self.virtualbox.owns(cancel.operation_id) =>
            {
                self.virtualbox.cancel(cancel.operation_id);
            }
            Message::ServerRegistrationAck(ack) if self.virtualbox.owns(ack.operation_id) => {
                self.virtualbox.acknowledged(ack);
            }
            Message::ServerRegistrationCancel(cancel) => self.inner.cancel(&cancel),
            Message::ServerRegistrationAck(ack) => self.inner.acknowledged(ack),
            Message::ServerVirtualBoxRegistrationRequest(request) => self.virtualbox.start(request),
            Message::ServerVirtualBoxWatch(watch) => match &self.monitor {
                Some(monitor) => monitor.watch(watch),
                None => tracing::debug!("Ignored a VirtualBox watch: VirtualBox is not configured"),
            },
            Message::ServerVirtualBoxControl(control) => match &self.monitor {
                Some(monitor) => monitor.control(control),
                None => self.inner.send(Message::AgentVirtualBoxControlResult(
                    crate::protocol::VirtualBoxControlResult {
                        session_id: control.session_id,
                        machine_uuid: control.machine_uuid,
                        action: control.action,
                        accepted: false,
                        code: Some("virtualbox_unavailable".to_owned()),
                        message: Some("VirtualBox is not configured on this agent".to_owned()),
                    },
                )),
            },
            Message::ServerRepositoryHealthRequest(request) => self.inner.health_check(request),
            Message::ServerRegistrationRetryCleanup(retry) => self.inner.retry_cleanup(&retry),
            message @ (Message::ServerRestoreRequest(_)
            | Message::ServerRestoreCancel(_)
            | Message::ServerRestoreAck(_)
            | Message::ServerVmVerify(_)
            | Message::ServerVmVerifyAck(_)
            | Message::ServerLocalCopyRemove(_)
            | Message::ServerLocalCopyRemoveAck(_)) => self.restores.handle(message),
            Message::ServerArchiveDelete(request) => self.delete_archive(request),
            message @ (Message::ServerVmLaunch(_)
            | Message::ServerVmStop(_)
            | Message::ServerVmExecutionAck(_)) => self.execution.handle(message),
            Message::ServerWorkspaceDiscard(discard) => self.discard_workspace(discard),
            _ => {}
        }
    }

    /// Deletes one version's archive from a repository, when the server says the version is deleted
    /// (decision 0041). It reads nothing local and claims no operation slot: every step is idempotent, and
    /// the server asks again until it has an answer.
    fn delete_archive(&self, request: crate::protocol::ArchiveDelete) {
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let repositories = Arc::clone(&inner.config.repositories);
            let result = crate::archive_deletion::delete_archive(&repositories, &request).await;
            if let Some(code) = &result.code {
                tracing::warn!(version_id = %request.version_id, %code, "Archive not deleted");
            }
            inner.send(Message::AgentArchiveDeleteResult(result));
        });
    }

    /// A removal that failed validation is answered as a refused one, so that it does not hang.
    pub fn refuse_invalid_removal(&self, operation_id: Uuid) {
        self.restores.refuse_invalid_removal(operation_id);
    }

    /// Removes a working copy the server asked about, unless anything runs or works on its VM here. The
    /// check is per VM, as every other one is, so a session of the persistent copy also keeps it. The
    /// answer is sent once; the next `agent.restore_sync` lists what is still held, which recovers a lost
    /// request or answer.
    fn discard_workspace(&self, discard: WorkspaceDiscard) {
        let vm = VmIdentity {
            emulator_type: discard.emulator_type,
            vm_name: discard.vm_name.clone(),
        };
        let refusal = self
            .execution
            .activity(&vm)
            .map(|reason| ("vm_running", reason))
            .or_else(|| {
                self.inner
                    .working_on(&vm)
                    .or_else(|| self.restores.working_on(&vm))
                    .map(|reason| ("operation_in_progress", reason))
            });
        let workspace_id = discard.workspace_id;
        if let Some((code, reason)) = refusal {
            tracing::warn!(%workspace_id, code, "Refused to discard a working copy");
            self.inner.send(Message::AgentWorkspaceDiscardResult(
                WorkspaceDiscardResult {
                    workspace_id,
                    removed: false,
                    code: Some(code.to_owned()),
                    message: Some(bounded(&format!("{reason}. The working copy was kept"))),
                },
            ));
            return;
        }
        // Claimed before anything is removed: a registration, snapshot or restore now finds the agent busy,
        // and a launch of this VM finds it being worked on, until the removal has finished either way.
        {
            let mut running = self.inner.running.lock().expect("poisoned");
            if !running.is_empty() {
                drop(running);
                self.inner.send(Message::AgentWorkspaceDiscardResult(
                    WorkspaceDiscardResult {
                        workspace_id,
                        removed: false,
                        code: Some("agent_busy".to_owned()),
                        message: Some("The agent is busy with another operation".to_owned()),
                    },
                ));
                return;
            }
            running.insert(workspace_id, CancelFlag::new());
            self.inner
                .discarding
                .lock()
                .expect("poisoned")
                .insert(vm.clone());
        }
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let state_dir = inner.config.state_dir.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                crate::workspaces::discard(
                    &state_dir,
                    workspace_id,
                    discard.emulator_type,
                    &discard.vm_name,
                )
            })
            .await;
            let result = match outcome {
                Ok(Ok(())) => {
                    tracing::info!(%workspace_id, "Working copy discarded");
                    WorkspaceDiscardResult {
                        workspace_id,
                        removed: true,
                        code: None,
                        message: None,
                    }
                }
                Ok(Err(error)) => WorkspaceDiscardResult {
                    workspace_id,
                    removed: false,
                    code: Some(error.code.to_owned()),
                    message: Some(bounded(&error.message)),
                },
                Err(_) => WorkspaceDiscardResult {
                    workspace_id,
                    removed: false,
                    code: Some("internal_error".to_owned()),
                    message: None,
                },
            };
            inner.discarding.lock().expect("poisoned").remove(&vm);
            inner
                .running
                .lock()
                .expect("poisoned")
                .remove(&workspace_id);
            inner.send(Message::AgentWorkspaceDiscardResult(result));
        });
    }

    /// A verification that failed validation is answered as a failed one, so that it does not hang.
    pub fn refuse_invalid_verification(&self, operation_id: Uuid) {
        self.restores.refuse_invalid_verification(operation_id);
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

    pub fn refuse_invalid_restore(&self, operation_id: Uuid) {
        self.restores.refuse_invalid(operation_id);
    }

    /// Stops running work. Blocking work notices within one read.
    pub fn shutdown(&self) {
        self.execution.shutdown();
        self.inner.stopping.cancel();
        for flag in self.inner.running.lock().expect("poisoned").values() {
            flag.cancel();
        }
    }

    /// The local copy removals this agent has not closed yet, for tests and diagnostics.
    pub fn open_removals(&self) -> Vec<Uuid> {
        self.restores.open_removals()
    }

    /// The restores this agent has not closed yet, for tests and diagnostics.
    pub fn open_restores(&self) -> Vec<Uuid> {
        self.restores.open_operations()
    }

    /// Whether this agent has anything unresolved, for tests and diagnostics.
    pub fn open_operations(&self) -> Vec<Uuid> {
        let mut open: Vec<Uuid> = self
            .inner
            .journals
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect();
        open.extend(self.virtualbox.open_operations());
        open.extend(self.management.open_operations());
        open
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

    /// Why `vm` must not be launched now, if this module is working on it.
    fn working_on(&self, vm: &VmIdentity) -> Option<String> {
        if self.discarding.lock().expect("poisoned").contains(vm) {
            return Some(format!(
                "A working copy of {} is being discarded",
                vm.vm_name
            ));
        }
        let running = self.running.lock().expect("poisoned");
        let journals = self.journals.lock().expect("poisoned");
        running.keys().find_map(|operation_id| {
            journals.get(operation_id).and_then(|journal| {
                (journal.request.emulator_type == vm.emulator_type
                    && journal.request.vm_name == vm.vm_name)
                    .then(|| format!("A registration of {} is in progress", vm.vm_name))
            })
        })
    }

    fn vm_activity(&self, vm: &VmIdentity) -> Option<String> {
        self.activity.get().and_then(|probe| probe(vm))
    }

    fn start(self: &Arc<Self>, request: RegistrationRequest) {
        let operation_id = request.operation_id;
        if self.journal(operation_id).is_some() {
            tracing::debug!(%operation_id, "Ignored a repeated registration request");
            return;
        }
        // An archive of a disk that an emulator is writing describes no moment of it.
        if let Some(reason) = self.vm_activity(&VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        }) {
            self.send(Message::AgentRegistrationError(RegistrationFailure {
                operation_id,
                code: "vm_running".to_owned(),
                message: bounded(&format!("{reason}. Stop it before registering it")),
            }));
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
        let base_path = match request.workspace_id {
            Some(workspace_id) => self.snapshot_workspace_base(&request, workspace_id)?,
            None => base_path,
        };
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
        // A snapshot's parent is a claim about where these files came from. It is accepted only for the
        // very directory that lineage was recorded for.
        if request.mode == RegistrationMode::Snapshot && request.workspace_id.is_none() {
            self.check_snapshot_lineage(&request, directory)?;
        }
        // Screenshots play no part in whether a VM can be transferred (decision 0051): they are not in the
        // archive, and pending ones are handed to the media spool just before the directory is deleted.
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
        // The lineage was proven for one directory, so the archive must be of that one, still.
        if request.mode == RegistrationMode::Snapshot
            && directory_identity(&root).ok() != Some(directory)
        {
            return Err(failure(
                "source_changed",
                "The directory was replaced while it was archived",
            ));
        }
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

    /// A snapshot of a working copy reads it where this agent put it, and only if it is still the copy of
    /// the version named as the parent.
    fn snapshot_workspace_base(
        &self,
        request: &RegistrationRequest,
        workspace_id: Uuid,
    ) -> Result<PathBuf, JobFailure> {
        let state_dir = &self.config.state_dir;
        if crate::workspaces::existing_vm_root(
            state_dir,
            workspace_id,
            request.emulator_type,
            &request.vm_name,
        )
        .is_none()
        {
            return Err(failure(
                "workspace_unavailable",
                "This working copy is not on this agent",
            ));
        }
        let record = crate::workspaces::read_record(state_dir, workspace_id)
            .ok_or_else(|| failure("workspace_unavailable", "This working copy has no record"))?;
        // A Remote Volatile session's changes are thrown away, whatever the server asks.
        if !crate::workspaces::allows_snapshot(&record) {
            return Err(failure(
                "workspace_purpose_mismatch",
                "This working copy belongs to a Remote Volatile session, whose changes are never published",
            ));
        }
        if Some(record.source_version_id) != request.parent_version_id {
            return Err(failure(
                "snapshot_parent_mismatch",
                "The working copy is not a copy of the version named as the parent",
            ));
        }
        Ok(crate::workspaces::workspace_base(state_dir, workspace_id))
    }

    /// The parent the server names must be the version this agent recorded the local copy as coming from,
    /// and the record must have been made for this very directory: a restore that published it, a copy or
    /// snapshot that read it, or a verification that found it identical to that version. Nothing else is
    /// evidence. A copy with no such record, such as one recorded before Milestone 7 or one whose directory
    /// was replaced, is refused rather than attributed to whatever the server believes. Verifying it, if
    /// it is unchanged, records its lineage. See decision 0037.
    fn check_snapshot_lineage(
        &self,
        request: &RegistrationRequest,
        directory: DirectoryIdentity,
    ) -> Result<(), JobFailure> {
        use crate::state::LineageProblem;
        let Some(parent) = request.parent_version_id else {
            return Err(failure("invalid_request", "A snapshot names its parent"));
        };
        let unverified = |message: &str| {
            failure(
                "snapshot_lineage_unverified",
                format!(
                    "{message}. Verify the local copy, or restore the version you want to change"
                ),
            )
        };
        match crate::state::proven_lineage(
            &self.config.state_dir,
            request.emulator_type,
            &request.vm_name,
            directory,
            parent,
        ) {
            Ok(()) => Ok(()),
            Err(LineageProblem::OtherVersion(_)) => Err(failure(
                "snapshot_parent_mismatch",
                "This agent recorded its local copy as coming from another version",
            )),
            Err(LineageProblem::Unrecorded) => Err(unverified(
                "This agent has no record of which version its local copy came from",
            )),
            Err(LineageProblem::NoDirectoryRecorded) => Err(unverified(
                "This agent's record of where the local copy came from predates lineage checks",
            )),
            Err(LineageProblem::DirectoryReplaced) => Err(unverified(
                "The directory is not the one this agent's lineage record was made for: it was replaced",
            )),
        }
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
                let blocked = matches!(
                    &journal.report,
                    Some(Report::Cleanup(report)) if is_retryable_cleanup(report.code.as_deref())
                );
                if blocked {
                    // The identity and the manifest are what a later retry has to check against.
                    let mut journal = journal;
                    journal.phase = RegistrationPhase::MediaBlocked;
                    journal.report = None;
                    if let Err(error) = self.persist(journal) {
                        tracing::error!(%error, %operation_id, "Cannot keep a blocked transfer");
                    }
                } else {
                    self.forget(operation_id);
                }
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
            RegistrationPhase::Published
                | RegistrationPhase::Cleaning
                | RegistrationPhase::MediaBlocked
        ) {
            return;
        }
        // Registered now, so its screenshots can start on their way, whether this is a copy or not.
        if let Some(media) = &self.config.media {
            media.request_sync(&VmIdentity {
                emulator_type: journal.request.emulator_type,
                vm_name: journal.request.vm_name.clone(),
            });
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

    /// An administrator asks to try a blocked removal again. Everything is checked again, as the first
    /// time, which is why a VM someone has used since then is safely refused.
    fn retry_cleanup(self: &Arc<Self>, retry: &RegistrationRetryCleanup) {
        let operation_id = retry.operation_id;
        let journal = self
            .journal(operation_id)
            .filter(|journal| journal.request.version_id == retry.version_id);
        match journal {
            Some(journal) if journal.phase == RegistrationPhase::MediaBlocked => {
                tracing::info!(%operation_id, "Retrying the removal of a local VM");
                let ack = RegistrationAck {
                    operation_id,
                    outcome: AckOutcome::Committed,
                    version_id: Some(retry.version_id),
                    remove_local: true,
                    delete_published: false,
                };
                self.committed(journal, &ack);
            }
            // Already running, or finished and waiting for its answer. Nothing to do.
            Some(_) => {}
            None => self.send(Message::AgentRegistrationCleanup(RegistrationCleanup {
                operation_id,
                version_id: retry.version_id,
                local_copy: LocalCopyStatus::CleanupFailed,
                code: Some("cleanup_identity_mismatch".to_owned()),
                message: Some(
                    "This agent no longer has the record of what was archived, so nothing was removed"
                        .to_owned(),
                ),
            })),
        }
    }

    fn keep_local(&self, journal: &Journal) -> RegistrationCleanup {
        let request = &journal.request;
        // A working copy is now a copy of the new snapshot. The persistent copy is not this one's business.
        if let Some(workspace_id) = request.workspace_id {
            if let Err(error) = crate::workspaces::record_source(
                &self.config.state_dir,
                workspace_id,
                request.version_id,
                journal
                    .result
                    .as_ref()
                    .map(|result| result.manifest_sha256.as_str()),
            ) {
                tracing::warn!(%error, %workspace_id, "Cannot record the working copy's new source");
            }
            return RegistrationCleanup {
                operation_id: request.operation_id,
                version_id: request.version_id,
                local_copy: LocalCopyStatus::Preserved,
                code: None,
                message: None,
            };
        }
        // A snapshot means the same as a copy for the directory it read: it is a verified copy of the
        // version just published.
        let keeps = matches!(
            request.mode,
            RegistrationMode::Copy | RegistrationMode::Snapshot
        );
        if keeps
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
                // The directory that was archived, as recorded before reading it.
                journal.identity,
            )
        {
            // Registration succeeded. Local bookkeeping can be rebuilt by a later verification.
            tracing::warn!(%error, "Cannot record the local source version");
        }
        // The kept copy is now a copy of this version, so its manifest lets a verification run without
        // downloading anything. Only the manifest that was archived is kept.
        if keeps && let Some(result) = &journal.result {
            let manifest = fs::read(self.manifest_path(request.operation_id))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
                .filter(|manifest| manifest.sha256() == result.manifest_sha256);
            match manifest {
                Some(manifest) => {
                    if let Err(error) = crate::restore::keep_local_manifest(
                        &self.config.state_dir,
                        request.emulator_type,
                        &request.vm_name,
                        &manifest,
                    ) {
                        tracing::warn!(%error, "Cannot keep the manifest of the local copy");
                    }
                }
                None => {
                    tracing::warn!("The archived manifest cannot be kept for later verification")
                }
            }
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

        let held_vm = VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        };
        if let Some(media) = &self.config.media {
            media.hold(&held_vm, true);
        }

        let progress = self.progress_reporter(operation_id, RegistrationStage::CleaningLocal);
        let cancel = self.stopping.clone();
        let (emulator, vm_name, version_id) = (
            request.emulator_type,
            request.vm_name.clone(),
            request.version_id,
        );
        // Checked last, right before anything is removed. A launch is refused from here on, since this
        // operation is in progress for this VM.
        if let Some(reason) = self.vm_activity(&held_vm) {
            if let Some(media) = &self.config.media {
                media.hold(&held_vm, false);
            }
            tracing::warn!(%operation_id, %reason, "Local VM kept, since it is running");
            return refused(
                RUNNING_BLOCKED_CODE,
                format!("{reason}, so the local VM was kept. Stop it, then retry the removal"),
            );
        }
        // Screenshots are volatile media, not VM state (decision 0051). Whatever is still waiting for upload
        // is copied into the media spool at the last moment, and keeps going without the directory. Without
        // synchronization there is nowhere for them to go, and they are deleted with it, as said.
        let media = self.config.media.clone();
        let detached = Arc::new(std::sync::Mutex::new(None::<DetachReport>));
        let report_slot = Arc::clone(&detached);
        let detach_vm = held_vm.clone();
        let removed = blocking(move || {
            let before_delete = move |root: &Path| {
                let report = match &media {
                    Some(media) => media.detach_pending(&detach_vm, root),
                    None => detach_without_synchronization(root, detach_vm.emulator_type),
                };
                *report_slot.lock().expect("poisoned") = Some(report);
            };
            remove_vm_directory(
                &RemovalRequest {
                    base_path: &base_path,
                    emulator,
                    vm_name: &vm_name,
                    operation_id,
                    identity,
                    manifest: &manifest,
                    before_delete: &before_delete,
                },
                &progress,
                &cancel,
            )
        })
        .await;
        let media_note = detached
            .lock()
            .expect("poisoned")
            .as_ref()
            .and_then(DetachReport::summary);
        if let Some(media) = &self.config.media {
            media.hold(&held_vm, false);
        }
        match removed {
            Ok(Ok(())) => {
                tracing::info!(%operation_id, version = %version_id, "Local VM removed after a verified transfer");
                RegistrationCleanup {
                    operation_id,
                    version_id,
                    local_copy: LocalCopyStatus::Removed,
                    code: None,
                    message: media_note,
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
