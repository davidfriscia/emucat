//! Watches the registered VirtualBox machines, and runs the commands that start and stop them (decision
//! 0045). One task does all of it, so VBoxManage is never run twice at once from here, however many
//! machines or commands there are.
//!
//! - `list runningvms` runs every active interval (15 s). A change in who is listed makes the machines
//!   concerned be inspected at once.
//! - `showvminfo <uuid>` runs for an active machine every 15 s, for any other every 60 s, and every 2 s for
//!   two minutes after a command named it.
//! - Absence from `runningvms` is never taken to mean powered off: only what `showvminfo` says is reported.
//!   A machine that cannot be inspected is not reported at all, so its last observation stands.
//!
//! Only machines the server asked to watch, which are the registered ones, can be started or stopped.
//! Nothing here ever imports, unregisters, modifies or deletes a machine.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use time::OffsetDateTime;
use tokio::sync::{Notify, mpsc};
use uuid::Uuid;

use crate::protocol::{
    Message, VIRTUALBOX_WATCH_MAX, VirtualBoxControl, VirtualBoxControlAction,
    VirtualBoxControlResult, VirtualBoxObservation, VirtualBoxStates, VirtualBoxWatch,
};
use crate::repository::CancelFlag;
use crate::virtualbox::{
    self, CommandRunner, Inspection, ProcessRunner, RunError, VirtualBoxSettings, VirtualBoxVmState,
};

/// Which machines may not be started now, because an export is reading them.
pub type BusyMachines = Arc<dyn Fn() -> HashSet<Uuid> + Send + Sync>;

fn is_active(state: VirtualBoxVmState) -> bool {
    matches!(
        state,
        VirtualBoxVmState::Running
            | VirtualBoxVmState::Paused
            | VirtualBoxVmState::Starting
            | VirtualBoxVmState::Stopping
            | VirtualBoxVmState::Stuck
    )
}

/// An observation without the time it was made, which is what decides whether it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    present: bool,
    name: Option<String>,
    state: VirtualBoxVmState,
    raw_state: Option<String>,
    state_changed_at: Option<String>,
    accessible: Option<bool>,
}

impl Seen {
    fn observation(
        &self,
        machine_uuid: Uuid,
        observed_at: OffsetDateTime,
    ) -> VirtualBoxObservation {
        VirtualBoxObservation {
            machine_uuid,
            present: self.present,
            name: self.name.clone(),
            state: self.state,
            raw_state: self.raw_state.clone(),
            state_changed_at: self.state_changed_at.clone(),
            accessible: self.accessible,
            observed_at,
        }
    }
}

fn seen(inspection: Inspection) -> Option<Seen> {
    match inspection {
        Inspection::Found(vm) => Some(Seen {
            present: true,
            name: Some(vm.name),
            state: vm.state,
            raw_state: vm.raw_state,
            state_changed_at: vm.state_changed_at,
            accessible: vm.accessible,
        }),
        Inspection::Missing => Some(Seen {
            present: false,
            name: None,
            state: VirtualBoxVmState::Unknown,
            raw_state: None,
            state_changed_at: None,
            accessible: None,
        }),
        Inspection::Failed(_) => None,
    }
}

#[derive(Default)]
struct State {
    /// `None` until the server says what to watch. Nothing is inspected, or controlled, before that.
    watched: Option<Vec<Uuid>>,
    /// The next round answers a watch: every machine is inspected, and every one is reported.
    complete_due: bool,
    last: HashMap<Uuid, Seen>,
    inspected_at: HashMap<Uuid, Instant>,
    running: Option<HashSet<Uuid>>,
    listed_at: Option<Instant>,
    /// Until when a machine is inspected at the short interval, after a command.
    reconcile_until: HashMap<Uuid, Instant>,
    controls: VecDeque<VirtualBoxControl>,
}

pub struct VirtualBoxMonitor {
    settings: VirtualBoxSettings,
    runner: Arc<dyn CommandRunner + Send + Sync>,
    outbound: mpsc::Sender<Message>,
    state: Mutex<State>,
    wake: Notify,
    stopping: CancelFlag,
    busy: Mutex<Option<BusyMachines>>,
}

impl VirtualBoxMonitor {
    pub fn new(
        settings: VirtualBoxSettings,
        outbound: mpsc::Sender<Message>,
        stopping: CancelFlag,
    ) -> Arc<Self> {
        let runner: ProcessRunner = settings.runner();
        Arc::new(Self {
            settings,
            runner: Arc::new(runner),
            outbound,
            state: Mutex::default(),
            wake: Notify::new(),
            stopping,
            busy: Mutex::new(None),
        })
    }

    pub fn set_busy_probe(&self, probe: BusyMachines) {
        *self.busy.lock().expect("poisoned") = Some(probe);
    }

    /// Starts the one task that polls and runs commands. It ends when the agent stops.
    pub fn spawn(self: &Arc<Self>) {
        let monitor = Arc::clone(self);
        tokio::spawn(async move { monitor.run().await });
    }

    /// The machines to watch, which replace the previous ones. A complete report follows.
    pub fn watch(&self, watch: VirtualBoxWatch) {
        let mut machines = watch.machines;
        machines.sort();
        machines.dedup();
        if machines.len() > VIRTUALBOX_WATCH_MAX {
            tracing::warn!(
                count = machines.len(),
                "Watching only the first {VIRTUALBOX_WATCH_MAX} VirtualBox machines"
            );
            machines.truncate(VIRTUALBOX_WATCH_MAX);
        }
        {
            let mut state = self.state.lock().expect("poisoned");
            let kept: HashSet<Uuid> = machines.iter().copied().collect();
            state.last.retain(|uuid, _| kept.contains(uuid));
            state.inspected_at.retain(|uuid, _| kept.contains(uuid));
            state.reconcile_until.retain(|uuid, _| kept.contains(uuid));
            state.watched = Some(machines);
            state.complete_due = true;
        }
        self.wake.notify_one();
    }

    /// Queues a command. It runs on the monitor's task, between two inspections.
    pub fn control(&self, control: VirtualBoxControl) {
        self.state
            .lock()
            .expect("poisoned")
            .controls
            .push_back(control);
        self.wake.notify_one();
    }

    fn send(&self, message: Message) {
        let _ = self.outbound.try_send(message);
    }

    async fn run(self: Arc<Self>) {
        loop {
            let tick = {
                let state = self.state.lock().expect("poisoned");
                let now = Instant::now();
                if state.reconcile_until.values().any(|until| *until > now) {
                    self.settings.reconcile_poll
                } else {
                    self.settings.active_poll
                }
            };
            tokio::select! {
                () = tokio::time::sleep(tick) => {}
                () = self.wake.notified() => {}
                () = self.stopping.cancelled() => return,
            }
            if self.stopping.is_cancelled() {
                return;
            }
            let monitor = Arc::clone(&self);
            let finished = tokio::task::spawn_blocking(move || monitor.round()).await;
            if let Err(error) = finished {
                tracing::error!(%error, "A VirtualBox poll stopped");
            }
        }
    }

    /// Commands first, then whatever inspections are due, and one report. This blocks.
    fn round(&self) {
        loop {
            let next = self.state.lock().expect("poisoned").controls.pop_front();
            let Some(control) = next else { break };
            let result = self.run_control(&control);
            self.send(Message::AgentVirtualBoxControlResult(result));
            let mut state = self.state.lock().expect("poisoned");
            // Whatever VirtualBox said, look at the machine now and then often for a while.
            state.inspected_at.remove(&control.machine_uuid);
            state.reconcile_until.insert(
                control.machine_uuid,
                Instant::now() + self.settings.reconcile_window,
            );
        }
        self.poll();
    }

    fn run_control(&self, control: &VirtualBoxControl) -> VirtualBoxControlResult {
        let refused = |code: &str, message: &str| VirtualBoxControlResult {
            session_id: control.session_id,
            machine_uuid: control.machine_uuid,
            action: control.action,
            accepted: false,
            code: Some(code.to_owned()),
            message: Some(message.to_owned()),
        };
        let watched = self
            .state
            .lock()
            .expect("poisoned")
            .watched
            .as_ref()
            .is_some_and(|machines| machines.contains(&control.machine_uuid));
        if !watched {
            // Only a registered machine can be controlled, and the server's watch is what says which.
            return refused(
                "source_unavailable",
                "This machine is not registered for this agent",
            );
        }
        if control.action == VirtualBoxControlAction::Start {
            let busy = self.busy.lock().expect("poisoned").clone();
            if busy.is_some_and(|busy| busy().contains(&control.machine_uuid)) {
                return refused(
                    "operation_in_progress",
                    "This machine is being exported. Wait for the registration to finish",
                );
            }
        }
        let arguments = virtualbox::control_arguments(control.machine_uuid, control.action);
        let arguments: Vec<&std::ffi::OsStr> = arguments.iter().map(std::ffi::OsStr::new).collect();
        tracing::info!(machine = %control.machine_uuid, action = ?control.action, "Running a VirtualBox command");
        match self.runner.run(&arguments, self.settings.command_timeout) {
            Ok(output) if output.success => VirtualBoxControlResult {
                session_id: control.session_id,
                machine_uuid: control.machine_uuid,
                action: control.action,
                accepted: true,
                code: None,
                message: None,
            },
            Ok(output) => {
                let message = match virtualbox::error_token(&output.stderr) {
                    Some(token) => format!("VirtualBox refused the command ({token})"),
                    None => "VirtualBox refused the command".to_owned(),
                };
                refused("control_refused", &message)
            }
            Err(RunError::Timeout) => refused(
                "control_refused",
                "VBoxManage did not answer in time. The machine's state is checked again",
            ),
            Err(_) => refused(
                "virtualbox_unavailable",
                "VBoxManage cannot be started on this agent",
            ),
        }
    }

    fn poll(&self) {
        let now = Instant::now();
        let (watched, complete, list_due) = {
            let state = self.state.lock().expect("poisoned");
            let Some(watched) = state.watched.clone() else {
                return;
            };
            let list_due = state.complete_due
                || state
                    .listed_at
                    .is_none_or(|at| now.duration_since(at) >= self.settings.active_poll);
            (watched, state.complete_due, list_due)
        };
        if watched.is_empty() && !complete {
            return;
        }

        let mut available = true;
        let mut membership_changed = HashSet::new();
        if list_due {
            match virtualbox::running_vms(&*self.runner, self.settings.command_timeout) {
                Ok(running) => {
                    let mut state = self.state.lock().expect("poisoned");
                    if let Some(previous) = &state.running {
                        membership_changed =
                            previous.symmetric_difference(&running).copied().collect();
                    }
                    state.running = Some(running);
                    state.listed_at = Some(now);
                }
                Err(RunError::NotFound) => available = false,
                Err(error) => tracing::warn!(?error, "VBoxManage list runningvms failed"),
            }
        }

        let due: Vec<Uuid> = {
            let state = self.state.lock().expect("poisoned");
            watched
                .iter()
                .copied()
                .filter(|uuid| {
                    if complete || membership_changed.contains(uuid) {
                        return true;
                    }
                    let Some(at) = state.inspected_at.get(uuid) else {
                        return true;
                    };
                    let elapsed = now.duration_since(*at);
                    let reconciling = state
                        .reconcile_until
                        .get(uuid)
                        .is_some_and(|until| *until > now);
                    let active = state
                        .last
                        .get(uuid)
                        .is_some_and(|seen| is_active(seen.state))
                        || state
                            .running
                            .as_ref()
                            .is_some_and(|running| running.contains(uuid));
                    let interval = if reconciling {
                        self.settings.reconcile_poll
                    } else if active {
                        self.settings.active_poll
                    } else {
                        self.settings.inactive_poll
                    };
                    elapsed >= interval
                })
                .collect()
        };

        let mut report = Vec::new();
        if available {
            for uuid in due {
                if self.stopping.is_cancelled() {
                    return;
                }
                let inspection =
                    virtualbox::inspect(&*self.runner, uuid, self.settings.command_timeout);
                if matches!(inspection, Inspection::Failed(RunError::NotFound)) {
                    available = false;
                    break;
                }
                let Some(observed) = seen(inspection) else {
                    continue;
                };
                let mut state = self.state.lock().expect("poisoned");
                state.inspected_at.insert(uuid, Instant::now());
                let changed = state.last.get(&uuid) != Some(&observed);
                if changed || complete {
                    report.push(observed.observation(uuid, OffsetDateTime::now_utc()));
                }
                state.last.insert(uuid, observed);
            }
        }
        if !available {
            report.clear();
        }
        {
            let mut state = self.state.lock().expect("poisoned");
            state.complete_due = false;
            let now = Instant::now();
            state.reconcile_until.retain(|_, until| *until > now);
        }
        if complete || !report.is_empty() {
            self.send(Message::AgentVirtualBoxStates(VirtualBoxStates {
                complete,
                available,
                machines: report,
            }));
        }
    }
}
