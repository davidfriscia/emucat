//! VM execution on the agent: starting an emulator for a session, watching it, stopping it, and knowing it
//! again after a restart.
//!
//! Each session has a journal, replaced atomically before and after each step, as registration's are. The
//! emulator does not depend on the agent: it keeps running when the agent stops or loses its connection, and
//! the next start finds it again by its PID **and** creation time, so that a reused PID is never mistaken
//! for it. A session ends only when the process is seen to end. Reports of an end repeat until the server
//! acknowledges them. See decisions 0028 to 0031.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::config::EmulatorConfig;
use crate::emulators::{EmulatorType, VmIdentity};
use crate::launcher::{GracefulStop, LaunchError, check_executable, plan_launch};
use crate::process::{
    self, ProcessHandle, ProcessIdentity, QmpChannel, Reattached, WAIT_SLICE, WaitOutcome,
};
use crate::protocol::{
    AgentExecutionState, ExecutionCapabilities, ExecutionEmulator, ExecutionMode, ExecutionSync,
    Message, VmExecutionAck, VmExecutionStatus, VmLaunchRequest, VmStopRequest,
};
use crate::repository::CancelFlag;

/// How long a stopped emulator gets to exit, and how long a new one must keep running to count as started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionSettings {
    pub stop_timeout: Duration,
    pub start_grace: Duration,
}

impl Default for ExecutionSettings {
    fn default() -> Self {
        Self {
            stop_timeout: Duration::from_secs(120),
            start_grace: Duration::from_secs(3),
        }
    }
}

pub struct ExecutionConfig {
    pub state_dir: PathBuf,
    pub emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
    pub settings: ExecutionSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Graceful {
    CloseWindow,
    QmpPowerdown,
}

impl From<GracefulStop> for Graceful {
    fn from(stop: GracefulStop) -> Self {
        match stop {
            GracefulStop::CloseWindow => Self::CloseWindow,
            GracefulStop::QmpPowerdown => Self::QmpPowerdown,
        }
    }
}

/// Everything needed to know a session again after a restart. No secret and no VM contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request: VmLaunchRequest,
    state: AgentExecutionState,
    process: Option<ProcessIdentity>,
    graceful: Option<Graceful>,
    #[serde(with = "time::serde::rfc3339::option")]
    started_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    ended_at: Option<OffsetDateTime>,
    exit_code: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    stop_requested_at: Option<OffsetDateTime>,
    code: Option<String>,
    message: Option<String>,
}

impl Journal {
    fn identity(&self) -> VmIdentity {
        VmIdentity {
            emulator_type: self.request.emulator_type,
            vm_name: self.request.vm_name.clone(),
        }
    }

    fn is_active(&self) -> bool {
        !self.state.is_terminal()
    }
}

/// What only this run of the agent has: the process handle, and QEMU's monitor channel if it was started
/// by this run. Neither survives a restart.
struct Live {
    process: Arc<ProcessHandle>,
    qmp: Option<Arc<QmpChannel>>,
}

/// Says why a VM is in use, if it is. Shared between the workflows that must not overlap on one VM.
pub type ActivityProbe = Arc<dyn Fn(&VmIdentity) -> Option<String> + Send + Sync>;

pub struct ExecutionManager {
    config: ExecutionConfig,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    live: Mutex<HashMap<Uuid, Live>>,
    /// Says whether a registration, restore or verification is working on a VM.
    busy: OnceLock<ActivityProbe>,
    stopping: CancelFlag,
}

fn bounded(message: &str) -> String {
    message.chars().take(1000).collect()
}

/// A Windows creation time, in 100 ns intervals since 1601, as a timestamp.
fn creation_timestamp(filetime: u64) -> Option<OffsetDateTime> {
    let unix_100ns = i128::from(filetime) - 116_444_736_000_000_000;
    OffsetDateTime::from_unix_timestamp_nanos(unix_100ns * 100).ok()
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("executions")
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

impl ExecutionManager {
    /// Loads every session an earlier run left, and finds out what became of each process. Runs inside
    /// the runtime, since a process that still runs is watched again.
    pub fn load(
        config: ExecutionConfig,
        outbound: mpsc::Sender<Message>,
        stopping: CancelFlag,
    ) -> Result<Arc<Self>, String> {
        let directory = journal_directory(&config.state_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
        let mut journals = HashMap::new();
        for item in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
            .flatten()
        {
            let path = item.path();
            if path.extension().and_then(|text| text.to_str()) != Some("journal") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
            // Kept for inspection. The server treats the session as interrupted, which deletes nothing.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a session journal that cannot be read");
                continue;
            };
            journals.insert(journal.request.session_id, journal);
        }
        let manager = Arc::new(Self {
            config,
            outbound,
            journals: Mutex::new(journals),
            live: Mutex::new(HashMap::new()),
            busy: OnceLock::new(),
            stopping,
        });
        manager.reconcile();
        Ok(manager)
    }

    /// Lets launching refuse a VM that other work is using.
    pub fn set_busy_probe(&self, probe: ActivityProbe) {
        let _ = self.busy.set(probe);
    }

    fn journal_path(&self, session_id: Uuid) -> PathBuf {
        journal_directory(&self.config.state_dir).join(format!("{session_id}.journal"))
    }

    fn persist(&self, journal: &Journal) -> std::io::Result<()> {
        let path = self.journal_path(journal.request.session_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(journal).expect("a journal always serializes");
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
            .insert(journal.request.session_id, journal.clone());
        Ok(())
    }

    fn journal(&self, session_id: Uuid) -> Option<Journal> {
        self.journals
            .lock()
            .expect("poisoned")
            .get(&session_id)
            .cloned()
    }

    fn send(&self, message: Message) {
        // Nobody may be connected. What matters is in a journal, and is sent again after the welcome.
        let _ = self.outbound.try_send(message);
    }

    fn status(&self, journal: &Journal) -> VmExecutionStatus {
        let session_id = journal.request.session_id;
        let live = self.live.lock().expect("poisoned");
        let graceful_stop_available = journal.is_active()
            && live
                .get(&session_id)
                .is_some_and(|live| match journal.graceful {
                    Some(Graceful::QmpPowerdown) => live.qmp.is_some(),
                    Some(Graceful::CloseWindow) => true,
                    None => false,
                });
        VmExecutionStatus {
            session_id,
            emulator_type: journal.request.emulator_type,
            vm_name: journal.request.vm_name.clone(),
            state: journal.state,
            pid: journal.process.as_ref().map(|process| process.pid),
            process_started_at: journal
                .process
                .as_ref()
                .and_then(|process| creation_timestamp(process.creation_time)),
            started_at: journal.started_at,
            ended_at: journal.ended_at,
            exit_code: journal.exit_code,
            stop_requested: journal.stop_requested_at.is_some(),
            graceful_stop_available,
            code: journal.code.clone(),
            message: journal.message.clone(),
        }
    }

    /// Records a change and says so. If it cannot be recorded it is still said, and the journal on disk
    /// keeps the older state, which errs towards "still running".
    fn update(&self, session_id: Uuid, change: impl FnOnce(&mut Journal)) {
        let Some(mut journal) = self.journal(session_id) else {
            return;
        };
        change(&mut journal);
        if let Err(error) = self.persist(&journal) {
            tracing::error!(%error, %session_id, "Cannot record a session's state");
            self.journals
                .lock()
                .expect("poisoned")
                .insert(session_id, journal.clone());
        }
        self.send(Message::AgentVmExecutionStatus(self.status(&journal)));
    }

    /// What became of each process an earlier run started. A process is only ever recognized by its
    /// recorded identity, and an identity that cannot be checked leaves the session `unknown`.
    fn reconcile(self: &Arc<Self>) {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.is_active())
            .cloned()
            .collect();
        for journal in journals {
            let session_id = journal.request.session_id;
            if self
                .live
                .lock()
                .expect("poisoned")
                .contains_key(&session_id)
            {
                continue;
            }
            let Some(identity) = journal.process.clone() else {
                // Stopped between recording the session and recording its process. It may be running.
                self.update(session_id, |journal| {
                    journal.state = AgentExecutionState::Unknown;
                    journal.code = Some("agent_restarted".to_owned());
                    journal.message = Some(
                        "The agent stopped while it was starting this emulator, so it cannot tell whether \
                         it is running. Check the computer, then dismiss this session"
                            .to_owned(),
                    );
                });
                continue;
            };
            match process::reattach(&identity) {
                Reattached::Running(handle) => {
                    tracing::info!(%session_id, pid = identity.pid, "Found a running emulator again");
                    self.live.lock().expect("poisoned").insert(
                        session_id,
                        Live {
                            process: Arc::new(handle),
                            qmp: None,
                        },
                    );
                    self.update(session_id, |journal| {
                        if journal.state == AgentExecutionState::Unknown
                            || journal.state == AgentExecutionState::Starting
                        {
                            journal.state = AgentExecutionState::Running;
                        }
                        if journal.graceful == Some(Graceful::QmpPowerdown) {
                            journal.code = Some("graceful_stop_unavailable".to_owned());
                            journal.message = Some(
                                "The agent restarted, and QEMU's monitor belonged to the earlier run, so \
                                 only a forced stop is possible for this session"
                                    .to_owned(),
                            );
                        }
                    });
                    self.watch(session_id);
                }
                Reattached::Gone => {
                    tracing::info!(%session_id, pid = identity.pid, "An emulator ended while the agent was away");
                    self.update(session_id, |journal| {
                        journal.state = if journal.stop_requested_at.is_some() {
                            AgentExecutionState::Stopped
                        } else {
                            AgentExecutionState::Exited
                        };
                        journal.ended_at = Some(OffsetDateTime::now_utc());
                        journal.exit_code = None;
                        journal.code = Some("exited_while_agent_away".to_owned());
                        journal.message = Some(
                            "The emulator ended while the agent was not watching, so its exit code and \
                             exact end time are not known"
                                .to_owned(),
                        );
                    });
                }
                Reattached::Unknown(message) => {
                    tracing::warn!(%session_id, %message, "Cannot tell whether an emulator still runs");
                    self.update(session_id, |journal| {
                        journal.state = AgentExecutionState::Unknown;
                        journal.code = Some("process_state_unknown".to_owned());
                        journal.message = Some(bounded(&message));
                    });
                }
            }
        }
    }

    pub fn capabilities(&self) -> ExecutionCapabilities {
        ExecutionCapabilities {
            emulators: self
                .config
                .emulators
                .iter()
                .map(
                    |(emulator, config)| match check_executable(*emulator, &config.executable) {
                        Ok(_) => ExecutionEmulator {
                            emulator_type: *emulator,
                            launchable: true,
                            problem: None,
                        },
                        Err(error) => ExecutionEmulator {
                            emulator_type: *emulator,
                            launchable: false,
                            problem: Some(bounded(&error.message)),
                        },
                    },
                )
                .collect(),
            modes: vec![ExecutionMode::Local],
        }
    }

    /// What a new connection must say. Sessions in `unknown` are looked at again first.
    pub fn sync_message(self: &Arc<Self>, verifications: Vec<Uuid>) -> Message {
        self.reconcile();
        let sessions = {
            let journals = self.journals.lock().expect("poisoned");
            journals.values().cloned().collect::<Vec<_>>()
        };
        Message::AgentExecutionSync(ExecutionSync {
            sessions: sessions
                .iter()
                .take(64)
                .map(|journal| self.status(journal))
                .collect(),
            capabilities: self.capabilities(),
            verifications,
        })
    }

    /// Ends that have not been acknowledged. Sent again on each heartbeat.
    pub fn pending_reports(&self) -> Vec<Message> {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| !journal.is_active())
            .cloned()
            .collect();
        journals
            .iter()
            .map(|journal| Message::AgentVmExecutionStatus(self.status(journal)))
            .collect()
    }

    pub fn handle(self: &Arc<Self>, message: Message) {
        match message {
            Message::ServerVmLaunch(request) => self.launch(request),
            Message::ServerVmStop(request) => self.stop(request),
            Message::ServerVmExecutionAck(ack) => self.acknowledged(&ack),
            _ => {}
        }
    }

    /// Why a VM must not be touched by anything destructive now, if it must not. The process is asked
    /// directly, rather than trusting the last recorded state.
    pub fn activity(&self, vm: &VmIdentity) -> Option<String> {
        let sessions: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.is_active() && journal.identity() == *vm)
            .cloned()
            .collect();
        for journal in sessions {
            let live = self
                .live
                .lock()
                .expect("poisoned")
                .get(&journal.request.session_id)
                .map(|live| Arc::clone(&live.process));
            match live {
                Some(process) if matches!(process.poll(), Ok(WaitOutcome::Exited(_))) => continue,
                Some(_) => return Some(format!("{} is running", vm.vm_name)),
                None if journal.state == AgentExecutionState::Unknown => {
                    return Some(format!(
                        "Whether {} is running cannot be told, so it is treated as running",
                        vm.vm_name
                    ));
                }
                None => {
                    return Some(format!("{} has a session that has not ended", vm.vm_name));
                }
            }
        }
        None
    }

    /// Whether any session on this agent is active, for tests and diagnostics.
    pub fn active_sessions(&self) -> Vec<Uuid> {
        self.journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.is_active())
            .map(|journal| journal.request.session_id)
            .collect()
    }

    pub fn shutdown(&self) {
        // Emulators keep running. Their journals say so, and the next start finds them.
        self.stopping.cancel();
    }

    fn fail_new(&self, request: VmLaunchRequest, code: &str, message: String) {
        let session_id = request.session_id;
        tracing::warn!(%session_id, %code, %message, "Launch refused");
        let journal = Journal {
            request,
            state: AgentExecutionState::Failed,
            process: None,
            graceful: None,
            started_at: None,
            ended_at: Some(OffsetDateTime::now_utc()),
            exit_code: None,
            stop_requested_at: None,
            code: Some(code.to_owned()),
            message: Some(bounded(&message)),
        };
        if let Err(error) = self.persist(&journal) {
            tracing::error!(%error, %session_id, "Cannot record a refused launch");
        }
        self.send(Message::AgentVmExecutionStatus(self.status(&journal)));
    }

    fn launch(self: &Arc<Self>, request: VmLaunchRequest) {
        let session_id = request.session_id;
        if let Some(existing) = self.journal(session_id) {
            if existing.request == request {
                tracing::debug!(%session_id, "A repeated launch request; repeating the state");
                self.send(Message::AgentVmExecutionStatus(self.status(&existing)));
            } else {
                tracing::error!(%session_id, "Refused a repeated launch request with other identities");
            }
            return;
        }
        let vm = VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        };
        if request.mode != ExecutionMode::Local {
            return self.fail_new(
                request,
                "execution_mode_unavailable",
                "Only local execution is available in this version".to_owned(),
            );
        }
        if let Some(reason) = self.activity(&vm) {
            return self.fail_new(request, "vm_already_running", reason);
        }
        if let Some(reason) = self.busy.get().and_then(|probe| probe(&vm)) {
            return self.fail_new(request, "vm_busy", reason);
        }
        let Some(emulator) = self.config.emulators.get(&request.emulator_type).cloned() else {
            return self.fail_new(
                request,
                "emulator_not_configured",
                format!("{} is not configured on this agent", vm.emulator_type),
            );
        };
        let journal = Journal {
            request,
            state: AgentExecutionState::Starting,
            process: None,
            graceful: None,
            started_at: None,
            ended_at: None,
            exit_code: None,
            stop_requested_at: None,
            code: None,
            message: None,
        };
        if let Err(error) = self.persist(&journal) {
            tracing::error!(%error, %session_id, "Cannot create a session journal");
            self.send(Message::AgentVmExecutionStatus(VmExecutionStatus {
                state: AgentExecutionState::Failed,
                code: Some("state_unwritable".to_owned()),
                message: Some("The agent cannot write to its state directory".to_owned()),
                ..self.status(&journal)
            }));
            self.journals.lock().expect("poisoned").remove(&session_id);
            return;
        }
        self.send(Message::AgentVmExecutionStatus(self.status(&journal)));

        let this = Arc::clone(self);
        tokio::spawn(async move {
            let vm_name = vm.vm_name.clone();
            let planned = blocking(move || {
                let plan = plan_launch(
                    vm.emulator_type,
                    &emulator.executable,
                    &emulator.base_path,
                    &vm.vm_name,
                )?;
                tracing::info!(
                    %session_id,
                    program = %plan.spawn.program.display(),
                    args = ?plan.spawn.args,
                    directory = %plan.spawn.working_dir.display(),
                    source = %plan.source,
                    "Starting an emulator"
                );
                let (handle, qmp) = process::spawn(&plan.spawn).map_err(|error| LaunchError {
                    kind: crate::launcher::LaunchErrorKind::ExecutableInvalid,
                    message: error.to_string(),
                })?;
                Ok::<_, LaunchError>((plan.graceful, handle, qmp))
            })
            .await;
            let (graceful, handle, qmp) = match planned {
                Some(Ok(started)) => started,
                Some(Err(error)) => {
                    let code = if matches!(
                        error.kind,
                        crate::launcher::LaunchErrorKind::ExecutableInvalid
                    ) && error.message.starts_with("cannot start")
                    {
                        "launch_failed"
                    } else {
                        error.kind.code()
                    };
                    tracing::warn!(%session_id, %vm_name, code, message = %error.message, "Launch failed");
                    this.update(session_id, |journal| {
                        journal.state = AgentExecutionState::Failed;
                        journal.ended_at = Some(OffsetDateTime::now_utc());
                        journal.code = Some(code.to_owned());
                        journal.message = Some(bounded(&error.message));
                    });
                    return;
                }
                None => {
                    this.update(session_id, |journal| {
                        journal.state = AgentExecutionState::Failed;
                        journal.ended_at = Some(OffsetDateTime::now_utc());
                        journal.code = Some("internal_error".to_owned());
                    });
                    return;
                }
            };
            let identity = handle.identity().clone();
            let graceful_kind = Graceful::from(graceful);
            this.live.lock().expect("poisoned").insert(
                session_id,
                Live {
                    process: Arc::new(handle),
                    qmp: qmp.map(Arc::new),
                },
            );
            this.update(session_id, |journal| {
                journal.process = Some(identity.clone());
                journal.graceful = Some(graceful_kind);
                journal.started_at = Some(OffsetDateTime::now_utc());
                if graceful_kind == Graceful::QmpPowerdown && journal.message.is_none() {
                    let connected = this
                        .live
                        .lock()
                        .expect("poisoned")
                        .get(&session_id)
                        .is_some_and(|live| live.qmp.is_some());
                    if !connected {
                        journal.code = Some("graceful_stop_unavailable".to_owned());
                        journal.message = Some(
                            "QEMU's monitor did not answer, so only a forced stop is possible"
                                .to_owned(),
                        );
                    }
                }
            });
            tracing::info!(%session_id, pid = identity.pid, "Emulator started");

            // A process that ends at once failed to start, whatever its exit code says.
            let process = this.process(session_id);
            let grace = this.config.settings.start_grace;
            let early = match process {
                Some(process) => blocking(move || process.wait(grace)).await,
                None => None,
            };
            match early {
                Some(Ok(WaitOutcome::Exited(code))) => {
                    this.live.lock().expect("poisoned").remove(&session_id);
                    this.update(session_id, |journal| {
                        journal.state = AgentExecutionState::Failed;
                        journal.ended_at = Some(OffsetDateTime::now_utc());
                        journal.exit_code = Some(code);
                        journal.code = Some("launch_exited_early".to_owned());
                        journal.message = Some(format!(
                            "The emulator exited with code {code} within {} seconds of starting. Check \
                             its configuration by starting it by hand",
                            grace.as_secs()
                        ));
                    });
                }
                _ => {
                    this.update(session_id, |journal| {
                        if journal.state == AgentExecutionState::Starting {
                            journal.state = AgentExecutionState::Running;
                        }
                    });
                    this.watch(session_id);
                }
            }
        });
    }

    fn process(&self, session_id: Uuid) -> Option<Arc<ProcessHandle>> {
        self.live
            .lock()
            .expect("poisoned")
            .get(&session_id)
            .map(|live| Arc::clone(&live.process))
    }

    /// Waits for the process to end, a slice at a time, and records how it ended.
    fn watch(self: &Arc<Self>, session_id: Uuid) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if this.stopping.is_cancelled() {
                    return;
                }
                let Some(process) = this.process(session_id) else {
                    return;
                };
                match blocking(move || process.wait(WAIT_SLICE)).await {
                    Some(Ok(WaitOutcome::Running)) => continue,
                    Some(Ok(WaitOutcome::Exited(code))) => {
                        this.live.lock().expect("poisoned").remove(&session_id);
                        tracing::info!(%session_id, code, "Emulator ended");
                        this.update(session_id, |journal| {
                            let stopped = journal.stop_requested_at.is_some();
                            journal.state = if stopped {
                                AgentExecutionState::Stopped
                            } else {
                                AgentExecutionState::Exited
                            };
                            journal.ended_at = Some(OffsetDateTime::now_utc());
                            journal.exit_code = Some(code);
                            if journal.code.as_deref() != Some("forced") {
                                journal.code = None;
                                journal.message = None;
                            }
                        });
                        return;
                    }
                    Some(Err(error)) => {
                        tracing::warn!(%error, %session_id, "Cannot wait for an emulator");
                        tokio::time::sleep(WAIT_SLICE).await;
                    }
                    None => return,
                }
            }
        });
    }

    fn stop(self: &Arc<Self>, request: VmStopRequest) {
        let session_id = request.session_id;
        let Some(journal) = self.journal(session_id) else {
            tracing::warn!(%session_id, "A stop request for a session this agent does not know");
            return;
        };
        if journal.request.emulator_type != request.emulator_type
            || journal.request.vm_name != request.vm_name
        {
            tracing::error!(%session_id, "Refused a stop request that names another VM");
            return;
        }
        if !journal.is_active() {
            self.send(Message::AgentVmExecutionStatus(self.status(&journal)));
            return;
        }
        let live = {
            let live = self.live.lock().expect("poisoned");
            live.get(&session_id)
                .map(|live| (Arc::clone(&live.process), live.qmp.clone()))
        };
        let Some((process, qmp)) = live else {
            self.update(session_id, |journal| {
                journal.code = Some("stop_unavailable".to_owned());
                journal.message = Some(
                    "The agent has no verified handle on this emulator, so it will not stop anything"
                        .to_owned(),
                );
            });
            return;
        };
        let graceful = journal.graceful;
        let timeout = self.config.settings.stop_timeout;
        self.update(session_id, |journal| {
            journal
                .stop_requested_at
                .get_or_insert_with(OffsetDateTime::now_utc);
            journal.state = AgentExecutionState::Stopping;
            journal.code = request.force.then(|| "forced".to_owned());
            journal.message = None;
        });

        let this = Arc::clone(self);
        tokio::spawn(async move {
            if request.force {
                tracing::warn!(%session_id, pid = process.identity().pid, "Forced stop requested");
                let terminated = blocking(move || {
                    // QEMU can still be asked to quit at once, which closes its disk images properly.
                    if let Some(qmp) = qmp
                        && qmp.execute("quit", Duration::from_secs(2)).is_ok()
                        && matches!(
                            process.wait(Duration::from_secs(5)),
                            Ok(WaitOutcome::Exited(_))
                        )
                    {
                        return Ok(());
                    }
                    process.terminate(1)
                })
                .await;
                if let Some(Err(error)) = terminated {
                    this.update(session_id, |journal| {
                        journal.state = AgentExecutionState::Running;
                        journal.code = Some("stop_failed".to_owned());
                        journal.message = Some(bounded(&format!(
                            "The emulator could not be ended: {error}"
                        )));
                    });
                }
                return;
            }

            let asked = blocking(move || match graceful {
                Some(Graceful::CloseWindow) => {
                    if process::close_windows(&process) > 0 {
                        Ok(())
                    } else {
                        Err("The emulator has no window that can be asked to close".to_owned())
                    }
                }
                Some(Graceful::QmpPowerdown) => match qmp {
                    Some(qmp) => qmp.execute("system_powerdown", Duration::from_secs(5)),
                    None => {
                        Err("QEMU's monitor is not connected to this run of the agent".to_owned())
                    }
                },
                None => Err("This session has no way to be stopped gracefully".to_owned()),
            })
            .await
            .unwrap_or_else(|| Err("internal error".to_owned()));
            if let Err(message) = asked {
                this.update(session_id, |journal| {
                    if journal.state == AgentExecutionState::Stopping {
                        journal.state = AgentExecutionState::Running;
                    }
                    journal.code = Some("graceful_stop_unavailable".to_owned());
                    journal.message =
                        Some(bounded(&format!("{message}. A forced stop is possible")));
                });
                return;
            }
            tracing::info!(%session_id, "Graceful stop requested");
            tokio::time::sleep(timeout).await;
            if this
                .journal(session_id)
                .is_some_and(|journal| journal.state == AgentExecutionState::Stopping)
            {
                this.update(session_id, |journal| {
                    journal.state = AgentExecutionState::Running;
                    journal.code = Some("stop_timeout".to_owned());
                    journal.message = Some(format!(
                        "The emulator was asked to stop and is still running after {} seconds. The guest \
                         may be waiting for someone, or may not support it. A forced stop is possible",
                        timeout.as_secs()
                    ));
                });
            }
        });
    }

    /// The server has recorded the end. An `unknown` session can be dismissed too, by an administrator.
    fn acknowledged(&self, ack: &VmExecutionAck) {
        let session_id = ack.session_id;
        let Some(journal) = self.journal(session_id) else {
            return;
        };
        let dismissable = journal.state == AgentExecutionState::Unknown
            && !self
                .live
                .lock()
                .expect("poisoned")
                .contains_key(&session_id);
        if journal.is_active() && !dismissable {
            tracing::warn!(%session_id, "Ignored an acknowledgement for a session that is still running");
            return;
        }
        self.journals.lock().expect("poisoned").remove(&session_id);
        let _ = fs::remove_file(self.journal_path(session_id));
    }
}

#[cfg(test)]
mod tests {
    use super::creation_timestamp;

    #[test]
    fn windows_creation_times_become_timestamps() {
        // 2024-01-01T00:00:00Z
        let time = creation_timestamp(133_485_408_000_000_000).unwrap();
        assert_eq!(time.unix_timestamp(), 1_704_067_200);
    }
}
