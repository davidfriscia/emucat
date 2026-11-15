//! Imports OVAs into VirtualBox, and deletes machines from it (decision 0046). Both are irreversible, so both
//! keep a journal that is written before VBoxManage is asked to do anything that cannot be undone, and neither is
//! ever repeated: after a restart, what happened is found out by looking at VirtualBox, and reported as found.
//!
//! - An import downloads the version's OVA into a directory of its own in the staging directory, checks its size
//!   and SHA-256, runs `import --dry-run`, then `import --vsys=0 --vmname=<name>`. The new machine is the one
//!   `list vms` shows afterwards that it did not show before, with the requested name. Anything else is reported,
//!   never guessed at, and never removed. Nothing is linked to the catalog here: the server never does that by
//!   itself either.
//! - A deletion inspects the machine by UUID just before: it must still have the name the administrator typed and
//!   be powered off. Then `unregistervm <uuid> --delete`, which is VirtualBox's own removal of the machine and its
//!   files, and an inspection again to see whether the UUID is gone. This module never removes a machine's files
//!   itself, and never removes anything but the files it downloaded into its own staging directory.
//!
//! Both share the agent's single operation slot with registrations and restores.

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
    Message, VirtualBoxDelete, VirtualBoxImport, VirtualBoxMachine, VirtualBoxOperationAck,
    VirtualBoxOperationKind, VirtualBoxOperationOutcome, VirtualBoxOperationPhase,
    VirtualBoxOperationProgress, VirtualBoxOperationResult, VirtualBoxOperationStage,
    VirtualBoxOperationSyncEntry,
};
use crate::registration::RepositoryProvider;
use crate::repository::{CancelFlag, ProgressFn, RepositoryErrorKind, RepositoryKey};
use crate::virtualbox::{
    self, CommandRunner, Inspection, ListedVm, RunError, VirtualBoxSettings, VirtualBoxVmState,
};

const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
/// Longest name an imported machine may be given. Mirrors `VIRTUALBOX_TARGET_NAME_MAX_LENGTH`.
pub const TARGET_NAME_MAX_CHARS: usize = 128;
/// Most machines one result reports as unattributed.
const MAX_STRAY_MACHINES: usize = 16;

/// Whether a name can be given to an imported machine: the rules of `validateVirtualBoxTargetName`, checked
/// again here, since VirtualBox names a folder after the machine and an option must never be read from it.
pub fn valid_target_name(name: &str) -> bool {
    let count = name.chars().count();
    count > 0
        && count <= TARGET_NAME_MAX_CHARS
        && !name
            .chars()
            .any(|character| "\\/:*?\"<>|".contains(character) || character.is_control())
        && name.trim() == name
        && !name.ends_with('.')
        && !name.starts_with('-')
}

/// The directory an import downloads into. Named by the operation, so no two imports ever share one.
fn import_directory(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("virtualbox-import-{operation_id}"))
}

fn import_path(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    import_directory(staging_dir, operation_id).join(format!("{operation_id}.ova"))
}

/// Removes the OVA this module downloaded, and its directory if that is then empty. Nothing else: no wildcard,
/// and no recursive removal.
fn remove_download(staging_dir: &Path, operation_id: Uuid) {
    let file = import_path(staging_dir, operation_id);
    if fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_file()) {
        let _ = fs::remove_file(&file);
    }
    let _ = fs::remove_dir(import_directory(staging_dir, operation_id));
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "request", rename_all = "snake_case")]
enum Command {
    Import(VirtualBoxImport),
    Delete(VirtualBoxDelete),
}

impl Command {
    fn operation_id(&self) -> Uuid {
        match self {
            Self::Import(request) => request.operation_id,
            Self::Delete(request) => request.operation_id,
        }
    }

    fn kind(&self) -> VirtualBoxOperationKind {
        match self {
            Self::Import(_) => VirtualBoxOperationKind::Import,
            Self::Delete(_) => VirtualBoxOperationKind::Delete,
        }
    }
}

/// Everything needed after a restart. No secret, and no machine contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    command: Command,
    phase: VirtualBoxOperationPhase,
    /// For an import: every machine VirtualBox listed before the import began.
    #[serde(default)]
    before: Option<Vec<Uuid>>,
    result: Option<VirtualBoxOperationResult>,
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("virtualbox-operations")
}

/// How one operation ended. Messages never hold a path or VBoxManage's output, only its error token.
struct Ending {
    outcome: VirtualBoxOperationOutcome,
    code: Option<String>,
    message: Option<String>,
    machine: Option<VirtualBoxMachine>,
    strays: Vec<VirtualBoxMachine>,
    files_removed: Option<bool>,
}

impl Ending {
    fn failed(code: &str, message: impl Into<String>) -> Self {
        Self {
            outcome: VirtualBoxOperationOutcome::Failed,
            code: Some(code.to_owned()),
            message: Some(message.into()),
            machine: None,
            strays: Vec::new(),
            files_removed: None,
        }
    }

    fn uncertain(code: &str, message: impl Into<String>, strays: Vec<VirtualBoxMachine>) -> Self {
        Self {
            outcome: VirtualBoxOperationOutcome::Uncertain,
            code: Some(code.to_owned()),
            message: Some(message.into()),
            machine: None,
            strays,
            files_removed: None,
        }
    }
}

fn with_token(text: &str, stderr: &str) -> String {
    match virtualbox::error_token(stderr) {
        Some(token) => format!("{text} ({token})"),
        None => text.to_owned(),
    }
}

fn unavailable(error: &RunError) -> Ending {
    match error {
        RunError::NotFound => Ending::failed(
            "virtualbox_unavailable",
            "VBoxManage cannot be started on this agent",
        ),
        RunError::Timeout => {
            Ending::failed("virtualbox_timeout", "VBoxManage did not answer in time")
        }
        RunError::Spawn(_) | RunError::Cancelled => {
            Ending::failed("virtualbox_unavailable", "VBoxManage could not be run")
        }
    }
}

pub struct VirtualBoxManagementConfig {
    pub settings: Option<VirtualBoxSettings>,
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub repositories: Arc<dyn RepositoryProvider>,
}

pub struct VirtualBoxManagement {
    settings: Option<VirtualBoxSettings>,
    runner: Option<Arc<dyn CommandRunner + Send + Sync>>,
    state_dir: PathBuf,
    staging_dir: PathBuf,
    repositories: Arc<dyn RepositoryProvider>,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    /// Shared with every other operation: one at a time on this agent.
    running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
    stopping: CancelFlag,
}

impl VirtualBoxManagement {
    /// Loads what an earlier run left behind, and settles it as a restart requires: work that had not reached
    /// VirtualBox failed, and work that had is looked up in VirtualBox, never repeated.
    pub fn load(
        config: VirtualBoxManagementConfig,
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
            // Kept for inspection: the server sees the operation as lost, which makes it uncertain, never retried.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a journal that cannot be read");
                continue;
            };
            journals.insert(journal.command.operation_id(), journal);
        }
        let runner = config.settings.as_ref().map(|settings| {
            let runner: Arc<dyn CommandRunner + Send + Sync> = Arc::new(settings.runner());
            runner
        });
        let management = Arc::new(Self {
            settings: config.settings,
            runner,
            state_dir: config.state_dir,
            staging_dir: config.staging_dir,
            repositories: config.repositories,
            outbound,
            journals: Mutex::new(journals),
            running,
            stopping,
        });
        management.recover_interrupted();
        Ok(management)
    }

    /// Whether this agent can import and delete at all: only with VirtualBox configured.
    pub fn available(&self) -> bool {
        self.settings.is_some()
    }

    /// Machines being deleted now. Nothing may start them meanwhile.
    pub fn deleting(&self) -> HashSet<Uuid> {
        self.journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.phase != VirtualBoxOperationPhase::Reported)
            .filter_map(|journal| match &journal.command {
                Command::Delete(request) => Some(request.machine_uuid),
                Command::Import(_) => None,
            })
            .collect()
    }

    pub fn sync_entries(&self) -> Vec<VirtualBoxOperationSyncEntry> {
        let mut entries: Vec<VirtualBoxOperationSyncEntry> = self
            .journals
            .lock()
            .expect("poisoned")
            .iter()
            .map(|(operation_id, journal)| VirtualBoxOperationSyncEntry {
                operation_id: *operation_id,
                phase: journal.phase,
            })
            .collect();
        entries.sort_by_key(|entry| entry.operation_id);
        entries
    }

    /// Results without an answer yet, sent again on every heartbeat.
    pub fn pending_reports(&self) -> Vec<Message> {
        self.journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.phase == VirtualBoxOperationPhase::Reported)
            .filter_map(|journal| journal.result.clone())
            .map(Message::AgentVirtualBoxOperationResult)
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

    /// Written to a temporary file, synced, then renamed over the journal: never half written.
    fn persist(&self, journal: Journal) -> std::io::Result<()> {
        let operation_id = journal.command.operation_id();
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

    fn send_progress(
        &self,
        operation_id: Uuid,
        stage: VirtualBoxOperationStage,
        done_bytes: Option<u64>,
        total_bytes: Option<u64>,
    ) {
        self.send(Message::AgentVirtualBoxOperationProgress(
            VirtualBoxOperationProgress {
                operation_id,
                stage,
                done_bytes,
                total_bytes,
            },
        ));
    }

    /// Answers a command that never started, with no journal: nothing was done.
    fn refuse(&self, operation_id: Uuid, kind: VirtualBoxOperationKind, ending: Ending) {
        self.send(Message::AgentVirtualBoxOperationResult(result_of(
            operation_id,
            kind,
            ending,
        )));
    }

    /// Records how an operation ended, and reports it until the server answers.
    fn finish(&self, mut journal: Journal, ending: Ending) {
        let operation_id = journal.command.operation_id();
        let result = result_of(operation_id, journal.command.kind(), ending);
        tracing::info!(
            %operation_id,
            kind = ?result.kind,
            outcome = ?result.outcome,
            code = result.code.as_deref().unwrap_or(""),
            "VirtualBox operation finished"
        );
        journal.phase = VirtualBoxOperationPhase::Reported;
        journal.result = Some(result.clone());
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a VirtualBox result");
        }
        self.send(Message::AgentVirtualBoxOperationResult(result));
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
            let operation_id = journal.command.operation_id();
            match journal.phase {
                VirtualBoxOperationPhase::Running => {
                    // Nothing was asked of VirtualBox yet. The download, if any, is only this module's.
                    remove_download(&self.staging_dir, operation_id);
                    self.finish(
                        journal,
                        Ending::failed(
                            "agent_restarted",
                            "The agent restarted before VirtualBox was asked to do anything. Nothing was \
                             changed in VirtualBox",
                        ),
                    );
                }
                VirtualBoxOperationPhase::Irreversible => {
                    remove_download(&self.staging_dir, operation_id);
                    if tokio::runtime::Handle::try_current().is_ok() {
                        let management = Arc::clone(self);
                        tokio::task::spawn_blocking(move || management.reconcile(journal));
                    } else {
                        self.reconcile(journal);
                    }
                }
                VirtualBoxOperationPhase::Reported => {}
            }
        }
    }

    /// After a restart in the middle of an import or a deletion: what VirtualBox shows now decides what is
    /// reported. The command is never run again.
    fn reconcile(&self, journal: Journal) {
        let Some(runner) = self.runner.clone() else {
            self.finish(
                journal,
                Ending::uncertain(
                    "agent_restarted",
                    "The agent restarted while VirtualBox was working, and VirtualBox is no longer \
                     configured, so what happened is unknown. Check VirtualBox on this agent",
                    Vec::new(),
                ),
            );
            return;
        };
        let timeout = self.command_timeout();
        let ending = match &journal.command {
            Command::Import(request) => {
                let before: HashSet<Uuid> = journal.before.iter().flatten().copied().collect();
                match virtualbox::list_vms(&*runner, timeout) {
                    Ok(after) => {
                        let found =
                            attribute(&*runner, timeout, &before, &after.vms, &request.target_name);
                        match found {
                            Attribution::One(machine) => Ending {
                                outcome: VirtualBoxOperationOutcome::Succeeded,
                                code: None,
                                message: Some(
                                    "The agent restarted during the import; VirtualBox lists the new machine"
                                        .to_owned(),
                                ),
                                machine: Some(machine),
                                strays: Vec::new(),
                                files_removed: None,
                            },
                            Attribution::Other(strays) => Ending::uncertain(
                                "agent_restarted",
                                "The agent restarted during the import. VirtualBox may still be importing, \
                                 or may have stopped; check VirtualBox on this agent before importing again",
                                strays,
                            ),
                        }
                    }
                    Err(_) => Ending::uncertain(
                        "agent_restarted",
                        "The agent restarted during the import, and VirtualBox cannot be asked what it did. \
                         Check VirtualBox on this agent before importing again",
                        Vec::new(),
                    ),
                }
            }
            Command::Delete(request) => {
                match virtualbox::inspect(&*runner, request.machine_uuid, timeout) {
                    Inspection::Missing => Ending {
                        outcome: VirtualBoxOperationOutcome::Succeeded,
                        code: None,
                        message: Some(
                            "The agent restarted during the deletion; VirtualBox no longer lists the machine"
                                .to_owned(),
                        ),
                        machine: None,
                        strays: Vec::new(),
                        files_removed: None,
                    },
                    Inspection::Found(_) | Inspection::Failed(_) => Ending::uncertain(
                        "agent_restarted",
                        "The agent restarted during the deletion, and VirtualBox may not have finished it. \
                         Check the machine in VirtualBox before doing anything else",
                        Vec::new(),
                    ),
                }
            }
        };
        self.finish(journal, ending);
    }

    fn command_timeout(&self) -> Duration {
        self.settings
            .as_ref()
            .map_or(Duration::from_secs(30), |settings| settings.command_timeout)
    }

    /// Claims the operation slot and writes the journal, or answers why not. Returns the cancel flag of the job.
    fn begin(&self, command: Command) -> Option<CancelFlag> {
        let operation_id = command.operation_id();
        let kind = command.kind();
        if self.journal(operation_id).is_some() {
            tracing::debug!(%operation_id, "Ignored a repeated VirtualBox command");
            return None;
        }
        if self.settings.is_none() {
            self.refuse(
                operation_id,
                kind,
                Ending::failed(
                    "virtualbox_unavailable",
                    "VirtualBox is not configured on this agent",
                ),
            );
            return None;
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                self.refuse(
                    operation_id,
                    kind,
                    Ending::failed("agent_busy", "This agent is already running an operation"),
                );
                return None;
            }
            running.insert(operation_id, cancel.clone());
        }
        let journal = Journal {
            command,
            phase: VirtualBoxOperationPhase::Running,
            before: None,
            result: None,
        };
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot create a journal");
            self.running.lock().expect("poisoned").remove(&operation_id);
            self.refuse(
                operation_id,
                kind,
                Ending::failed(
                    "staging_failed",
                    "The agent cannot write to its state directory",
                ),
            );
            return None;
        }
        Some(cancel)
    }

    fn end(&self, operation_id: Uuid) {
        self.running.lock().expect("poisoned").remove(&operation_id);
    }

    pub fn start_import(self: &Arc<Self>, request: VirtualBoxImport) {
        let operation_id = request.operation_id;
        let Some(cancel) = self.begin(Command::Import(request)) else {
            return;
        };
        let management = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, "VirtualBox import started");
            let ending = management.run_import(operation_id, &cancel).await;
            management.end(operation_id);
            let Some(journal) = management.journal(operation_id) else {
                return;
            };
            match ending {
                Some(ending) => management.finish(journal, ending),
                // Stopping: the next start settles it from the journal.
                None if management.stopping.is_cancelled() => {}
                None if journal.phase == VirtualBoxOperationPhase::Irreversible => {
                    tokio::task::spawn_blocking(move || management.reconcile(journal));
                }
                None => management.finish(
                    journal,
                    Ending::failed(
                        "internal_error",
                        "The import stopped before VirtualBox was asked to import",
                    ),
                ),
            }
        });
    }

    pub fn start_delete(self: &Arc<Self>, request: VirtualBoxDelete) {
        let operation_id = request.operation_id;
        let Some(_cancel) = self.begin(Command::Delete(request)) else {
            return;
        };
        let management = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            tracing::warn!(%operation_id, "VirtualBox deletion started");
            let ending = management.run_delete(operation_id);
            management.end(operation_id);
            if let Some(journal) = management.journal(operation_id) {
                management.finish(journal, ending);
            }
        });
    }

    /// The server recorded the result. Only a reported operation is forgotten: one still running reports first.
    pub fn acknowledged(&self, ack: VirtualBoxOperationAck) {
        let operation_id = ack.operation_id;
        if self
            .journal(operation_id)
            .is_some_and(|journal| journal.phase == VirtualBoxOperationPhase::Reported)
        {
            tracing::info!(%operation_id, "VirtualBox operation closed");
            self.forget(operation_id);
        }
    }

    pub fn owns(&self, operation_id: Uuid) -> bool {
        self.journals
            .lock()
            .expect("poisoned")
            .contains_key(&operation_id)
    }

    fn progress_reporter(
        self: &Arc<Self>,
        operation_id: Uuid,
        stage: VirtualBoxOperationStage,
    ) -> ProgressFn {
        let management = Arc::clone(self);
        let last = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
        self.send_progress(operation_id, stage, None, None);
        Arc::new(move |done: u64, total: u64| {
            let mut last = last.lock().expect("poisoned");
            if last.elapsed() >= PROGRESS_INTERVAL || done == total {
                *last = Instant::now();
                management.send_progress(operation_id, stage, Some(done), Some(total));
            }
        })
    }

    /// `None` only when the agent is stopping before anything irreversible: the restart reports it.
    async fn run_import(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Option<Ending> {
        let journal = self.journal(operation_id)?;
        let Command::Import(request) = journal.command.clone() else {
            return Some(Ending::failed(
                "internal_error",
                "The journal is not an import",
            ));
        };
        let runner = self.runner.clone()?;
        let settings = self.settings.clone()?;
        self.send_progress(operation_id, VirtualBoxOperationStage::Checking, None, None);

        if !valid_target_name(&request.target_name) {
            return Some(Ending::failed(
                "invalid_target_name",
                "The name asked for is not a valid VirtualBox machine name",
            ));
        }
        // The server names the key; this checks that it is this VM's, and an OVA.
        if crate::virtualbox_registration::archive_key(&request.vm_name, request.version_id)
            != request.archive_key
        {
            return Some(Ending::failed(
                "invalid_request",
                "The archive key does not belong to this VM and version",
            ));
        }
        let Ok(key) = RepositoryKey::new(request.archive_key.clone()) else {
            return Some(Ending::failed(
                "invalid_request",
                "The archive key is not valid",
            ));
        };

        // What VirtualBox has now. A machine already called this would make VirtualBox refuse the import.
        let listed = {
            let runner = Arc::clone(&runner);
            let timeout = settings.command_timeout;
            tokio::task::spawn_blocking(move || virtualbox::list_vms(&*runner, timeout))
                .await
                .ok()?
        };
        let before = match listed {
            Ok(list) => list,
            Err(error) => return Some(unavailable(&error)),
        };
        if before
            .vms
            .iter()
            .any(|vm| vm.name.to_lowercase() == request.target_name.to_lowercase())
        {
            return Some(Ending::failed(
                "target_name_in_use",
                "VirtualBox already has a machine with this name. Choose another name",
            ));
        }

        // Room for the download, in the agent's own staging directory.
        if let Some(free) = crate::packaging::available_disk_bytes(&self.staging_dir)
            && free < request.archive_size_bytes
        {
            return Some(Ending::failed(
                "insufficient_local_space",
                format!(
                    "The staging directory has {free} bytes free, and the OVA is {} bytes",
                    request.archive_size_bytes
                ),
            ));
        }
        let repository = match self.repositories.open(request.repository_id) {
            Ok(repository) => repository,
            Err(error) => return Some(Ending::failed(error.kind.code(), error.message)),
        };
        let directory = import_directory(&self.staging_dir, operation_id);
        let ova = import_path(&self.staging_dir, operation_id);
        remove_download(&self.staging_dir, operation_id);
        if let Err(error) = fs::create_dir_all(&directory) {
            return Some(Ending::failed(
                "staging_failed",
                format!("Cannot create the download directory: {error}"),
            ));
        }
        let downloading =
            self.progress_reporter(operation_id, VirtualBoxOperationStage::Downloading);
        if let Err(error) = repository.download(&key, &ova, downloading, cancel).await {
            remove_download(&self.staging_dir, operation_id);
            if error.kind == RepositoryErrorKind::Cancelled && self.stopping.is_cancelled() {
                return None;
            }
            return Some(Ending::failed(error.kind.code(), error.message));
        }

        // The bytes are the version's, whatever the repository said.
        self.send_progress(
            operation_id,
            VirtualBoxOperationStage::Verifying,
            None,
            None,
        );
        let hashed = {
            let (ova, cancel) = (ova.clone(), cancel.clone());
            tokio::task::spawn_blocking(move || hash_file(&ova, &cancel))
                .await
                .ok()?
        };
        match hashed {
            Ok((size, sha256))
                if size == request.archive_size_bytes && sha256 == request.archive_sha256 => {}
            Ok(_) => {
                remove_download(&self.staging_dir, operation_id);
                return Some(Ending::failed(
                    "hash_mismatch",
                    "The downloaded OVA does not have the size and SHA-256 of this version",
                ));
            }
            Err(error) => {
                remove_download(&self.staging_dir, operation_id);
                return Some(Ending::failed(error.kind.code(), error.message));
            }
        }

        // A dry run first: VirtualBox reads the OVA and changes nothing.
        self.send_progress(operation_id, VirtualBoxOperationStage::DryRun, None, None);
        let dry_run = {
            let (runner, ova, name) = (
                Arc::clone(&runner),
                ova.clone(),
                request.target_name.clone(),
            );
            let timeout = settings.import_timeout;
            tokio::task::spawn_blocking(move || {
                virtualbox::import(&*runner, &ova, &name, true, timeout, &|| false)
            })
            .await
            .ok()?
        };
        match dry_run {
            Ok(output) if output.success => {}
            Ok(output) => {
                remove_download(&self.staging_dir, operation_id);
                return Some(Ending::failed(
                    "dry_run_failed",
                    with_token("VirtualBox cannot import this OVA", &output.stderr),
                ));
            }
            Err(error) => {
                remove_download(&self.staging_dir, operation_id);
                return Some(unavailable(&error));
            }
        }
        if self.stopping.is_cancelled() {
            remove_download(&self.staging_dir, operation_id);
            return None;
        }

        // From here on, VirtualBox may create a machine. The journal says so first, with what was there before.
        let before_uuids: HashSet<Uuid> = before.vms.iter().map(|vm| vm.uuid).collect();
        let mut journal = self.journal(operation_id)?;
        journal.phase = VirtualBoxOperationPhase::Irreversible;
        let mut listed_before: Vec<Uuid> = before_uuids.iter().copied().collect();
        listed_before.sort();
        journal.before = Some(listed_before);
        if let Err(error) = self.persist(journal) {
            remove_download(&self.staging_dir, operation_id);
            return Some(Ending::failed(
                "staging_failed",
                format!("Cannot write the journal, so nothing was imported: {error}"),
            ));
        }
        self.send_progress(
            operation_id,
            VirtualBoxOperationStage::Importing,
            None,
            None,
        );
        // Not cancellable: stopping VBoxManage halfway could leave a partial machine nobody asked for.
        let imported = {
            let (runner, ova, name) = (
                Arc::clone(&runner),
                ova.clone(),
                request.target_name.clone(),
            );
            let timeout = settings.import_timeout;
            tokio::task::spawn_blocking(move || {
                virtualbox::import(&*runner, &ova, &name, false, timeout, &|| false)
            })
            .await
            .ok()?
        };
        remove_download(&self.staging_dir, operation_id);

        self.send_progress(
            operation_id,
            VirtualBoxOperationStage::Discovering,
            None,
            None,
        );
        let after = {
            let runner = Arc::clone(&runner);
            let timeout = settings.command_timeout;
            tokio::task::spawn_blocking(move || virtualbox::list_vms(&*runner, timeout))
                .await
                .ok()?
        };
        let Ok(after) = after else {
            return Some(Ending::uncertain(
                "import_unconfirmed",
                "VirtualBox could not be asked which machines it has after the import. Check VirtualBox on \
                 this agent before importing again",
                Vec::new(),
            ));
        };
        let attribution = {
            let (runner, name) = (Arc::clone(&runner), request.target_name.clone());
            let timeout = settings.command_timeout;
            tokio::task::spawn_blocking(move || {
                attribute(&*runner, timeout, &before_uuids, &after.vms, &name)
            })
            .await
            .ok()?
        };
        Some(match (imported, attribution) {
            (Ok(output), Attribution::One(machine)) if output.success => Ending {
                outcome: VirtualBoxOperationOutcome::Succeeded,
                code: None,
                message: None,
                machine: Some(machine),
                strays: Vec::new(),
                files_removed: None,
            },
            (Ok(output), Attribution::Other(strays)) if output.success => Ending::uncertain(
                "import_ambiguous",
                "VirtualBox accepted the import, but EmuCat cannot tell which machine it created. Check \
                 VirtualBox on this agent",
                strays,
            ),
            (Ok(output), Attribution::Other(strays)) if strays.is_empty() => Ending::failed(
                "import_failed",
                with_token(
                    "VirtualBox could not import the OVA. No machine was created",
                    &output.stderr,
                ),
            ),
            (Ok(output), attribution) => Ending::uncertain(
                "import_failed",
                with_token(
                    "VirtualBox reported a failed import, but new machines appeared. Check VirtualBox on \
                     this agent",
                    &output.stderr,
                ),
                attribution.into_machines(),
            ),
            (Err(RunError::Timeout), attribution) => Ending::uncertain(
                "import_timeout",
                "The import did not finish in time. VirtualBox may still be importing; check it on this agent",
                attribution.into_machines(),
            ),
            (Err(error), Attribution::Other(strays)) if strays.is_empty() => unavailable(&error),
            (Err(_), attribution) => Ending::uncertain(
                "import_unconfirmed",
                "VBoxManage stopped unexpectedly, and new machines appeared. Check VirtualBox on this agent",
                attribution.into_machines(),
            ),
        })
    }

    /// This blocks. The last check and the command are as close together as they can be.
    fn run_delete(self: &Arc<Self>, operation_id: Uuid) -> Ending {
        let Some(journal) = self.journal(operation_id) else {
            return Ending::failed("internal_error", "The journal disappeared");
        };
        let Command::Delete(request) = journal.command.clone() else {
            return Ending::failed("internal_error", "The journal is not a deletion");
        };
        let (Some(runner), Some(settings)) = (self.runner.clone(), self.settings.clone()) else {
            return Ending::failed("virtualbox_unavailable", "VirtualBox is not configured");
        };
        self.send_progress(operation_id, VirtualBoxOperationStage::Checking, None, None);
        let machine = request.machine_uuid;
        match virtualbox::inspect(&*runner, machine, settings.command_timeout) {
            Inspection::Missing => {
                return Ending::failed(
                    "machine_missing",
                    "VirtualBox does not list this machine. Nothing was deleted",
                );
            }
            Inspection::Failed(error) => return unavailable(&error),
            Inspection::Found(vm) => {
                // By UUID, and only the machine the administrator named: same name, powered off.
                if vm.name != request.machine_name {
                    return Ending::failed(
                        "machine_name_mismatch",
                        "VirtualBox calls this machine something else now. Nothing was deleted",
                    );
                }
                if vm.accessible == Some(false) {
                    return Ending::failed(
                        "machine_inaccessible",
                        "VirtualBox cannot read this machine's settings. Nothing was deleted",
                    );
                }
                if vm.state != VirtualBoxVmState::PoweredOff {
                    return Ending::failed(
                        "machine_not_powered_off",
                        "The machine is not powered off. Nothing was deleted",
                    );
                }
            }
        }

        let mut journal = journal;
        journal.phase = VirtualBoxOperationPhase::Irreversible;
        if let Err(error) = self.persist(journal) {
            return Ending::failed(
                "staging_failed",
                format!("Cannot write the journal, so nothing was deleted: {error}"),
            );
        }
        self.send_progress(operation_id, VirtualBoxOperationStage::Deleting, None, None);
        let deleted = virtualbox::unregister_delete(&*runner, machine, settings.import_timeout);
        // Whatever VBoxManage said, VirtualBox's list decides.
        let after = virtualbox::inspect(&*runner, machine, settings.command_timeout);
        match (deleted, after) {
            (Ok(output), Inspection::Missing) => Ending {
                outcome: VirtualBoxOperationOutcome::Succeeded,
                code: None,
                message: (!output.success).then(|| {
                    with_token(
                        "VirtualBox no longer lists the machine, but reported a problem removing its files",
                        &output.stderr,
                    )
                }),
                machine: None,
                strays: Vec::new(),
                files_removed: Some(output.success),
            },
            (Err(_), Inspection::Missing) => Ending {
                outcome: VirtualBoxOperationOutcome::Succeeded,
                code: None,
                message: Some(
                    "VirtualBox no longer lists the machine; whether its files were removed is unknown"
                        .to_owned(),
                ),
                machine: None,
                strays: Vec::new(),
                files_removed: None,
            },
            (Ok(output), Inspection::Found(_)) if !output.success => Ending::failed(
                "delete_failed",
                with_token("VirtualBox did not delete the machine", &output.stderr),
            ),
            (Ok(_), _) | (Err(_), _) => Ending::uncertain(
                "delete_unconfirmed",
                "VirtualBox may not have deleted the machine. Check it in VirtualBox before doing anything else",
                Vec::new(),
            ),
        }
    }
}

fn result_of(
    operation_id: Uuid,
    kind: VirtualBoxOperationKind,
    ending: Ending,
) -> VirtualBoxOperationResult {
    VirtualBoxOperationResult {
        operation_id,
        kind,
        outcome: ending.outcome,
        code: ending.code,
        message: ending
            .message
            .map(|message| message.chars().take(1000).collect()),
        machine: ending.machine,
        stray_machines: ending.strays.into_iter().take(MAX_STRAY_MACHINES).collect(),
        files_removed: ending.files_removed,
    }
}

/// Which new machine an import created, if that can be said for certain.
enum Attribution {
    /// Exactly one machine appeared, with the requested name.
    One(VirtualBoxMachine),
    /// None, or several, or one with another name: all of them, for an administrator to look at.
    Other(Vec<VirtualBoxMachine>),
}

impl Attribution {
    fn into_machines(self) -> Vec<VirtualBoxMachine> {
        match self {
            Self::One(machine) => vec![machine],
            Self::Other(machines) => machines,
        }
    }
}

fn attribute(
    runner: &dyn CommandRunner,
    timeout: Duration,
    before: &HashSet<Uuid>,
    after: &[ListedVm],
    target_name: &str,
) -> Attribution {
    let appeared: Vec<&ListedVm> = after
        .iter()
        .filter(|vm| !before.contains(&vm.uuid))
        .collect();
    let described: Vec<VirtualBoxMachine> = appeared
        .iter()
        .map(|vm| {
            let state = match virtualbox::inspect(runner, vm.uuid, timeout) {
                Inspection::Found(found) => found.state,
                Inspection::Missing | Inspection::Failed(_) => VirtualBoxVmState::Unknown,
            };
            VirtualBoxMachine {
                uuid: vm.uuid,
                name: virtualbox::clean_text(&vm.name, 256),
                state,
            }
        })
        .collect();
    match described.as_slice() {
        [only] if appeared[0].name == target_name => Attribution::One(only.clone()),
        _ => Attribution::Other(described),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_names_follow_the_contract_rules() {
        assert!(valid_target_name("Xenix 386 (copy)"));
        assert!(valid_target_name(&"x".repeat(TARGET_NAME_MAX_CHARS)));
        for invalid in [
            "",
            "a/b",
            "a\\b",
            "C:",
            "what?",
            "a*b",
            "\"quoted\"",
            "<tag>",
            "pipe|",
            " padded",
            "padded ",
            "dot.",
            "-option",
            "line\nbreak",
        ] {
            assert!(!valid_target_name(invalid), "{invalid:?}");
        }
        assert!(!valid_target_name(&"x".repeat(TARGET_NAME_MAX_CHARS + 1)));
    }

    #[test]
    fn a_download_lives_in_a_directory_named_by_its_operation() {
        let operation = Uuid::from_u128(7);
        let path = import_path(Path::new("staging"), operation);
        assert_eq!(
            path,
            Path::new("staging")
                .join(format!("virtualbox-import-{operation}"))
                .join(format!("{operation}.ova"))
        );
    }
}
