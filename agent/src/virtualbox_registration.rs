//! Registers a VirtualBox machine as a catalog VM (decision 0045): `VBoxManage export <uuid>` into an OVA in
//! the agent's own staging directory, and that OVA, as it is, becomes the master. It is uploaded, verified and
//! published exactly like a ZIP archive is, and the same journal phases make it survive a restart.
//!
//! The machine itself is never changed. It must be powered off when the export starts and still be powered
//! off, with the same state change time, when it ends: otherwise someone used it meanwhile, and the OVA
//! describes no single moment of it. A registration is always a copy, so there is no local cleanup to do.
//!
//! This shares the agent's single operation slot with registrations and restores, so an export never runs
//! alongside other disk work.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::packaging::hash_file;
use crate::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCleanup,
    RegistrationFailure, RegistrationPhase, RegistrationProgress, RegistrationStage,
    RegistrationSyncEntry, VirtualBoxRegistrationRequest, VirtualBoxRegistrationResult,
};
use crate::registration::RepositoryProvider;
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
};
use crate::virtualbox::{self, Inspection, RunError, VirtualBoxSettings, VirtualBoxVmState};

const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const REMOTE_CLEANUP_ATTEMPTS: u32 = 6;

/// The key of a VirtualBox master: the OVA is the archive. Mirrors `archiveObjectKey` in the contracts.
pub fn archive_key(vm_name: &crate::emulators::VmName, version_id: Uuid) -> String {
    format!("archives/virtualbox/{}/{version_id}.ova", vm_name.key())
}

/// Where an export is written: a directory of its own, named by the operation, inside the staging directory.
fn export_directory(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("virtualbox-{operation_id}"))
}

fn export_path(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    export_directory(staging_dir, operation_id).join(format!("{operation_id}.ova"))
}

/// Removes what an export left. Only the directory this module created for the operation.
fn remove_export(staging_dir: &Path, operation_id: Uuid) {
    let directory = export_directory(staging_dir, operation_id);
    if directory.exists() {
        let _ = fs::remove_dir_all(directory);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "report", rename_all = "snake_case")]
enum Report {
    Failure(RegistrationFailure),
    Cleanup(RegistrationCleanup),
}

/// Everything needed to carry on after a restart. It holds no secret and no machine contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request: VirtualBoxRegistrationRequest,
    phase: RegistrationPhase,
    result: Option<VirtualBoxRegistrationResult>,
    report: Option<Report>,
}

#[derive(Debug)]
struct JobFailure {
    code: String,
    message: String,
}

fn failure(code: &str, message: impl Into<String>) -> JobFailure {
    JobFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

impl From<RepositoryError> for JobFailure {
    fn from(error: RepositoryError) -> Self {
        failure(error.kind.code(), error.message)
    }
}

/// What a machine must be for an export, and what it was when the export started.
fn require_powered_off(inspection: Inspection) -> Result<Option<String>, JobFailure> {
    match inspection {
        Inspection::Missing => Err(failure(
            "source_missing",
            "VirtualBox does not know this machine on this agent any more",
        )),
        Inspection::Failed(RunError::NotFound) => Err(failure(
            "virtualbox_unavailable",
            "VBoxManage cannot be started on this agent",
        )),
        Inspection::Failed(_) => Err(failure(
            "virtualbox_unavailable",
            "VBoxManage could not inspect this machine",
        )),
        Inspection::Found(vm) if vm.accessible == Some(false) => Err(failure(
            "source_invalid",
            "VirtualBox cannot read this machine's settings",
        )),
        Inspection::Found(vm) => match vm.state {
            VirtualBoxVmState::PoweredOff => Ok(vm.state_changed_at),
            VirtualBoxVmState::Running
            | VirtualBoxVmState::Paused
            | VirtualBoxVmState::Saved
            | VirtualBoxVmState::Starting
            | VirtualBoxVmState::Stopping
            | VirtualBoxVmState::Stuck
            | VirtualBoxVmState::Busy => Err(failure(
                "source_in_use",
                "The machine is not powered off. Shut it down (a saved state must be discarded or \
                 resumed and shut down), then register it",
            )),
            VirtualBoxVmState::Aborted
            | VirtualBoxVmState::Inaccessible
            | VirtualBoxVmState::Unknown => Err(failure(
                "source_invalid",
                format!(
                    "The machine is in a state that cannot be exported: {}",
                    vm.raw_state.as_deref().unwrap_or("unknown")
                ),
            )),
        },
    }
}

pub struct VirtualBoxRegistrations {
    settings: Option<VirtualBoxSettings>,
    state_dir: PathBuf,
    staging_dir: PathBuf,
    repositories: Arc<dyn RepositoryProvider>,
    retry_delay: Duration,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    /// Shared with every other operation: one at a time on this agent.
    running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
    stopping: CancelFlag,
}

pub struct VirtualBoxRegistrationsConfig {
    pub settings: Option<VirtualBoxSettings>,
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub repositories: Arc<dyn RepositoryProvider>,
    pub retry_delay: Duration,
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("virtualbox-registrations")
}

impl VirtualBoxRegistrations {
    /// Loads what an earlier run left behind, and resumes or fails it as a restart requires.
    pub fn load(
        config: VirtualBoxRegistrationsConfig,
        outbound: mpsc::Sender<Message>,
        running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
        stopping: CancelFlag,
    ) -> Result<Arc<Self>, String> {
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
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
            // As for any journal: a damaged one is kept for inspection, and the server sees the operation
            // as lost, which deletes nothing.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a journal that cannot be read");
                continue;
            };
            journals.insert(journal.request.operation_id, journal);
        }
        let registrations = Arc::new(Self {
            settings: config.settings,
            state_dir: config.state_dir,
            staging_dir: config.staging_dir,
            repositories: config.repositories,
            retry_delay: config.retry_delay,
            outbound,
            journals: Mutex::new(journals),
            running,
            stopping,
        });
        registrations.recover_interrupted();
        Ok(registrations)
    }

    /// Whether this module has an operation of this identity. Cancels and answers are routed by it.
    pub fn owns(&self, operation_id: Uuid) -> bool {
        self.journals
            .lock()
            .expect("poisoned")
            .contains_key(&operation_id)
    }

    /// The machines being exported now. Nothing may start them meanwhile.
    pub fn exporting(&self) -> HashSet<Uuid> {
        let running = self.running.lock().expect("poisoned");
        let journals = self.journals.lock().expect("poisoned");
        journals
            .values()
            .filter(|journal| {
                running.contains_key(&journal.request.operation_id)
                    && journal.phase == RegistrationPhase::Running
            })
            .map(|journal| journal.request.machine_uuid)
            .collect()
    }

    pub fn sync_entries(&self) -> Vec<RegistrationSyncEntry> {
        self.journals
            .lock()
            .expect("poisoned")
            .iter()
            .map(|(operation_id, journal)| RegistrationSyncEntry {
                operation_id: *operation_id,
                phase: journal.phase,
            })
            .collect()
    }

    /// Reports without an answer yet, sent again on every heartbeat.
    pub fn pending_reports(&self) -> Vec<Message> {
        let journals = self.journals.lock().expect("poisoned");
        let running = self.running.lock().expect("poisoned");
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
                        journal
                            .result
                            .clone()
                            .map(Message::AgentVirtualBoxRegistrationResult)
                    }
                    _ => None,
                },
            )
            .collect()
    }

    pub fn open_operations(&self) -> Vec<Uuid> {
        self.journals
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect()
    }

    fn journal_path(&self, operation_id: Uuid) -> PathBuf {
        journal_directory(&self.state_dir).join(format!("{operation_id}.journal"))
    }

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
    }

    fn send(&self, message: Message) {
        let _ = self.outbound.try_send(message);
    }

    fn refuse(&self, operation_id: Uuid, code: &str, message: &str) {
        self.send(Message::AgentRegistrationError(RegistrationFailure {
            operation_id,
            code: code.to_owned(),
            message: message.to_owned(),
        }));
    }

    fn record_failure(&self, mut journal: Journal, failed: JobFailure) {
        let operation_id = journal.request.operation_id;
        let report = RegistrationFailure {
            operation_id,
            code: failed.code,
            message: failed.message.chars().take(1000).collect(),
        };
        journal.phase = RegistrationPhase::Reported;
        journal.report = Some(Report::Failure(report.clone()));
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a failure");
        }
        self.send(Message::AgentRegistrationError(report));
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
            remove_export(&self.staging_dir, operation_id);
            match journal.phase {
                RegistrationPhase::Running => {
                    let repository_id = journal.request.repository_id;
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the OVA was published. Nothing was \
                             registered, and the VirtualBox machine was not changed. It is safe to \
                             try again",
                        ),
                    );
                    self.spawn_remote_cleanup(operation_id, repository_id);
                }
                RegistrationPhase::Publishing if tokio::runtime::Handle::try_current().is_ok() => {
                    let registrations = Arc::clone(self);
                    tokio::spawn(async move { registrations.resolve_publishing(journal).await });
                }
                _ => {}
            }
        }
    }

    /// As for a ZIP: the final object, if it is there and is what was built, is this operation's.
    async fn resolve_publishing(self: Arc<Self>, mut journal: Journal) {
        let Some(result) = journal.result.clone() else {
            return;
        };
        let operation_id = journal.request.operation_id;
        let repository = match self.repositories.open(journal.request.repository_id) {
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
                        self.send(Message::AgentVirtualBoxRegistrationResult(result));
                    }
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::NotFound => {
                    let _ = repository.delete(&staging).await;
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the OVA was published",
                        ),
                    );
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::Cancelled => return,
                Err(error) => {
                    tracing::warn!(%error, %operation_id, "Cannot check a publication yet");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        }
    }

    fn spawn_remote_cleanup(self: &Arc<Self>, operation_id: Uuid, repository_id: Uuid) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let registrations = Arc::clone(self);
        tokio::spawn(async move {
            let Ok(repository) = registrations.repositories.open(repository_id) else {
                return;
            };
            let staging = RepositoryKey::staging(operation_id);
            for attempt in 0..REMOTE_CLEANUP_ATTEMPTS {
                match repository.delete(&staging).await {
                    Ok(()) => return,
                    Err(error) if attempt + 1 == REMOTE_CLEANUP_ATTEMPTS => {
                        tracing::warn!(%error, %operation_id, "Cannot remove a staging object");
                    }
                    Err(_) => tokio::time::sleep(registrations.retry_delay).await,
                }
            }
        });
    }

    pub fn start(self: &Arc<Self>, request: VirtualBoxRegistrationRequest) {
        let operation_id = request.operation_id;
        if self.journal(operation_id).is_some() {
            tracing::debug!(%operation_id, "Ignored a repeated VirtualBox registration request");
            return;
        }
        if self.settings.is_none() {
            self.refuse(
                operation_id,
                "virtualbox_unavailable",
                "VirtualBox is not configured on this agent",
            );
            return;
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                self.refuse(
                    operation_id,
                    "agent_busy",
                    "This agent is already running an operation",
                );
                return;
            }
            running.insert(operation_id, cancel.clone());
        }
        let journal = Journal {
            request,
            phase: RegistrationPhase::Running,
            result: None,
            report: None,
        };
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot create a journal");
            self.running.lock().expect("poisoned").remove(&operation_id);
            self.refuse(
                operation_id,
                "staging_failed",
                "The agent cannot write to its state directory",
            );
            return;
        }
        let registrations = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, "VirtualBox registration started");
            let outcome = registrations.run_job(operation_id, &cancel).await;
            registrations
                .running
                .lock()
                .expect("poisoned")
                .remove(&operation_id);
            if registrations.stopping.is_cancelled() {
                return;
            }
            if let Err(failed) = outcome {
                tracing::warn!(%operation_id, code = %failed.code, message = %failed.message, "VirtualBox registration failed");
                remove_export(&registrations.staging_dir, operation_id);
                if let Some(journal) = registrations.journal(operation_id) {
                    let repository_id = journal.request.repository_id;
                    registrations.record_failure(journal, failed);
                    registrations.spawn_remote_cleanup(operation_id, repository_id);
                }
            }
        });
    }

    pub fn cancel(&self, operation_id: Uuid) {
        if let Some(flag) = self.running.lock().expect("poisoned").get(&operation_id) {
            let phase = self.journal(operation_id).map(|journal| journal.phase);
            if matches!(phase, Some(RegistrationPhase::Running)) {
                tracing::info!(%operation_id, "VirtualBox registration cancelled");
                flag.cancel();
            }
        }
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

    fn progress_reporter(
        self: &Arc<Self>,
        operation_id: Uuid,
        stage: RegistrationStage,
    ) -> ProgressFn {
        let registrations = Arc::clone(self);
        let last = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
        self.send_progress(operation_id, stage, None, None);
        Arc::new(move |done: u64, total: u64| {
            let mut last = last.lock().expect("poisoned");
            if last.elapsed() >= PROGRESS_INTERVAL || done == total {
                *last = Instant::now();
                registrations.send_progress(operation_id, stage, Some(done), Some(total));
            }
        })
    }

    async fn run_job(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Result<(), JobFailure> {
        let mut journal = self
            .journal(operation_id)
            .ok_or_else(|| failure("internal_error", "The journal disappeared"))?;
        let request = journal.request.clone();
        let settings = self
            .settings
            .clone()
            .ok_or_else(|| failure("virtualbox_unavailable", "VirtualBox is not configured"))?;
        self.send_progress(operation_id, RegistrationStage::Validating, None, None);

        // The server names the key, and this checks that it means what it must.
        if archive_key(&request.vm_name, request.version_id) != request.archive_key {
            return Err(failure(
                "invalid_request",
                "The archive key does not belong to this VM and version",
            ));
        }
        let final_key = RepositoryKey::new(request.archive_key.clone())
            .map_err(|_| failure("invalid_request", "The archive key is not valid"))?;
        let repository = self.repositories.open(request.repository_id)?;
        if repository.stat(&final_key).await?.is_some() {
            return Err(failure(
                "archive_exists",
                "An archive already exists at this version's key",
            ));
        }

        let machine = request.machine_uuid;
        let before = {
            let settings = settings.clone();
            blocking(move || {
                virtualbox::inspect(&settings.runner(), machine, settings.command_timeout)
            })
            .await?
        };
        let changed_at = require_powered_off(before)?;

        // The export. VirtualBox only reads the machine for it.
        self.send_progress(operation_id, RegistrationStage::Archiving, None, None);
        let output = export_path(&self.staging_dir, operation_id);
        remove_export(&self.staging_dir, operation_id);
        fs::create_dir_all(export_directory(&self.staging_dir, operation_id)).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot create the export directory: {error}"),
            )
        })?;
        let exported = {
            let (settings, output, cancel) = (settings.clone(), output.clone(), cancel.clone());
            blocking(move || {
                let runner = settings.runner();
                virtualbox::export(&runner, machine, &output, settings.export_timeout, &|| {
                    cancel.is_cancelled()
                })
            })
            .await?
        };
        match exported {
            Ok(result) if result.success => {}
            Ok(result) => {
                let token = virtualbox::error_token(&result.stderr);
                return Err(failure(
                    "export_failed",
                    match token {
                        Some(token) => format!("VBoxManage could not export the machine ({token})"),
                        None => "VBoxManage could not export the machine".to_owned(),
                    },
                ));
            }
            Err(RunError::Cancelled) => return Err(RepositoryError::cancelled().into()),
            Err(RunError::Timeout) => {
                return Err(failure(
                    "export_timeout",
                    "The export did not finish in time, and was stopped",
                ));
            }
            Err(RunError::NotFound) => {
                return Err(failure(
                    "virtualbox_unavailable",
                    "VBoxManage cannot be started on this agent",
                ));
            }
            Err(RunError::Spawn(_)) => {
                return Err(failure("export_failed", "VBoxManage could not be run"));
            }
        }

        // Still the moment the export began? A start and a stop meanwhile change the state change time.
        let after = {
            let settings = settings.clone();
            blocking(move || {
                virtualbox::inspect(&settings.runner(), machine, settings.command_timeout)
            })
            .await?
        };
        match require_powered_off(after) {
            Ok(time) if time == changed_at => {}
            Ok(_) | Err(_) => {
                return Err(failure(
                    "source_changed",
                    "The machine was used while it was exported. Nothing was registered",
                ));
            }
        }
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }

        let (size_bytes, sha256) = {
            let (output, cancel) = (output.clone(), cancel.clone());
            blocking(move || hash_file(&output, &cancel))
                .await?
                .map_err(|error| failure(error.kind.code(), error.message))?
        };
        if size_bytes == 0 {
            return Err(failure("export_failed", "VBoxManage wrote an empty OVA"));
        }
        if let Some(free) = repository.free_space().await?
            && free < size_bytes
        {
            return Err(failure(
                "insufficient_remote_space",
                format!("The repository has {free} bytes free, and the OVA is {size_bytes} bytes"),
            ));
        }

        let staging = RepositoryKey::staging(operation_id);
        let attempts = self
            .repositories
            .upload_attempts(request.repository_id)
            .max(1);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = self
                .upload_and_verify(
                    &*repository,
                    &staging,
                    &output,
                    size_bytes,
                    &sha256,
                    operation_id,
                    cancel,
                )
                .await;
            match outcome {
                Ok(()) => break,
                Err(error) if error.kind.is_retryable() && attempt < attempts => {
                    tracing::warn!(%error, %operation_id, attempt, "Upload failed; trying again");
                    let _ = repository.delete(&staging).await;
                    tokio::select! {
                        () = tokio::time::sleep(self.retry_delay) => {}
                        () = cancel.cancelled() => return Err(RepositoryError::cancelled().into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }

        let result = VirtualBoxRegistrationResult {
            operation_id,
            version_id: request.version_id,
            archive_key: request.archive_key.clone(),
            archive_size_bytes: size_bytes,
            archive_sha256: sha256.clone(),
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
                    Err(error) if error.kind == RepositoryErrorKind::AlreadyExists => {
                        return repository
                            .verify(
                                &final_key,
                                size_bytes,
                                &sha256,
                                crate::repository::no_progress(),
                                &CancelFlag::new(),
                            )
                            .await
                            .map(|_| ())
                            .map_err(|_| error);
                    }
                    Err(error) if error.kind.is_retryable() && attempt < attempts => {
                        tracing::warn!(%error, %operation_id, "Publication failed; trying again");
                        tokio::time::sleep(self.retry_delay).await;
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
        if stored.map(|object| object.size_bytes) != Some(size_bytes) {
            journal.phase = RegistrationPhase::Running;
            journal.result = None;
            let _ = self.persist(journal);
            return Err(failure(
                "hash_mismatch",
                "The published OVA does not have the expected size",
            ));
        }

        journal.phase = RegistrationPhase::Published;
        self.persist(journal).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;
        remove_export(&self.staging_dir, operation_id);
        tracing::info!(%operation_id, size = size_bytes, sha256 = %sha256, "OVA published");
        self.send(Message::AgentVirtualBoxRegistrationResult(result));
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_and_verify(
        self: &Arc<Self>,
        repository: &dyn ArchiveRepository,
        staging: &RepositoryKey,
        path: &Path,
        size_bytes: u64,
        sha256: &str,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> crate::repository::RepositoryResult<()> {
        let uploading = self.progress_reporter(operation_id, RegistrationStage::Uploading);
        repository.upload(staging, path, uploading, cancel).await?;
        let verifying = self.progress_reporter(operation_id, RegistrationStage::Verifying);
        repository
            .verify(staging, size_bytes, sha256, verifying, cancel)
            .await?;
        Ok(())
    }

    /// The server's answer. A commit is answered with the cleanup report a copy always makes: the machine
    /// is preserved, since nothing here ever changes it.
    pub fn acknowledged(self: &Arc<Self>, ack: RegistrationAck) {
        let operation_id = ack.operation_id;
        let Some(mut journal) = self.journal(operation_id) else {
            return;
        };
        match ack.outcome {
            AckOutcome::Closed => {
                tracing::info!(%operation_id, "VirtualBox registration closed");
                self.forget(operation_id);
            }
            AckOutcome::Rejected => {
                tracing::warn!(%operation_id, "The server rejected this VirtualBox registration");
                remove_export(&self.staging_dir, operation_id);
                let registrations = Arc::clone(self);
                tokio::spawn(async move {
                    if let Ok(repository) = registrations
                        .repositories
                        .open(journal.request.repository_id)
                    {
                        let _ = repository
                            .delete(&RepositoryKey::staging(operation_id))
                            .await;
                        if ack.delete_published
                            && let Some(result) = &journal.result
                            && let Ok(key) = RepositoryKey::new(result.archive_key.clone())
                        {
                            let _ = repository.delete(&key).await;
                        }
                    }
                    registrations.forget(operation_id);
                });
            }
            AckOutcome::Committed => {
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
                let report = RegistrationCleanup {
                    operation_id,
                    version_id: journal.request.version_id,
                    local_copy: LocalCopyStatus::Preserved,
                    code: None,
                    message: None,
                };
                journal.phase = RegistrationPhase::Reported;
                journal.report = Some(Report::Cleanup(report.clone()));
                if let Err(error) = self.persist(journal) {
                    tracing::error!(%error, %operation_id, "Cannot record the commit");
                }
                self.send(Message::AgentRegistrationCleanup(report));
            }
        }
    }
}

async fn blocking<T, F>(work: F) -> Result<T, JobFailure>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| failure("internal_error", format!("The work stopped: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_an_ova_under_the_virtualbox_type() {
        let name = crate::emulators::VmName::new("Win2k-Server").unwrap();
        let version = Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        assert_eq!(
            archive_key(&name, version),
            "archives/virtualbox/win2k-server/11111111-2222-4333-8444-555555555555.ova"
        );
    }

    #[test]
    fn only_a_powered_off_machine_can_be_exported() {
        let vm = |state| {
            Inspection::Found(crate::virtualbox::VirtualBoxVm {
                uuid: Uuid::nil(),
                name: "x".into(),
                os_type: None,
                state,
                raw_state: None,
                state_changed_at: Some("2025-01-01T00:00:00Z".into()),
                accessible: Some(true),
                memory_mb: None,
                cpus: None,
                error: None,
            })
        };
        assert_eq!(
            require_powered_off(vm(VirtualBoxVmState::PoweredOff)).unwrap(),
            Some("2025-01-01T00:00:00Z".into())
        );
        for state in [
            VirtualBoxVmState::Running,
            VirtualBoxVmState::Paused,
            VirtualBoxVmState::Saved,
            VirtualBoxVmState::Starting,
            VirtualBoxVmState::Stopping,
            VirtualBoxVmState::Stuck,
            VirtualBoxVmState::Busy,
        ] {
            assert_eq!(
                require_powered_off(vm(state)).unwrap_err().code,
                "source_in_use"
            );
        }
        for state in [VirtualBoxVmState::Aborted, VirtualBoxVmState::Unknown] {
            assert_eq!(
                require_powered_off(vm(state)).unwrap_err().code,
                "source_invalid"
            );
        }
        assert_eq!(
            require_powered_off(Inspection::Missing).unwrap_err().code,
            "source_missing"
        );
    }
}
