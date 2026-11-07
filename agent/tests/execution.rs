//! VM sessions end to end on Windows, with a fake emulator in place of 86Box and QEMU: launching, the
//! command line that was built, graceful and forced stops, early exits, refusals, and recovery after a
//! restart, including a recorded PID that now belongs to another process. Every VM is a disposable
//! fixture in a temporary directory.
#![cfg(windows)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::execution::{ExecutionConfig, ExecutionManager, ExecutionSettings};
use emucat_agent::process::{self, Reattached};
use emucat_agent::protocol::{
    AgentExecutionState, ExecutionMode, Message, VmExecutionAck, VmExecutionStatus,
    VmLaunchRequest, VmStopRequest,
};
use emucat_agent::repository::CancelFlag;
use tempfile::TempDir;
use tokio::sync::mpsc;
use uuid::Uuid;

/// The fake emulator `cargo test` builds next to the test executables.
fn fake_emulator() -> PathBuf {
    let deps = std::env::current_exe().unwrap();
    let path = deps
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples")
        .join("fake_emulator.exe");
    assert!(
        path.is_file(),
        "build the example first: {}",
        path.display()
    );
    path
}

struct Machine {
    directory: TempDir,
    emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
}

impl Machine {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let bin = directory.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let box86 = bin.join("86Box.exe");
        let qemu = bin.join("qemu-system-i386.exe");
        fs::copy(fake_emulator(), &box86).unwrap();
        fs::copy(fake_emulator(), &qemu).unwrap();
        let mut emulators = BTreeMap::new();
        for (emulator, executable) in [(EmulatorType::Box86, box86), (EmulatorType::Qemu, qemu)] {
            let base_path = directory.path().join(emulator.to_string());
            fs::create_dir_all(&base_path).unwrap();
            emulators.insert(
                emulator,
                EmulatorConfig {
                    base_path,
                    executable,
                },
            );
        }
        Self {
            directory,
            emulators: Arc::new(emulators),
        }
    }

    fn base(&self, emulator: EmulatorType) -> &Path {
        &self.emulators[&emulator].base_path
    }

    fn state_dir(&self) -> PathBuf {
        self.directory.path().join("state")
    }

    fn box86_vm(&self, name: &str, behavior: &str) -> PathBuf {
        let root = self.base(EmulatorType::Box86).join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("86box.cfg"), "[General]\n").unwrap();
        fs::write(root.join("fake-behavior.txt"), behavior).unwrap();
        root
    }

    fn qemu_vm(&self, name: &str, launcher: &str, behavior: &str) -> PathBuf {
        let root = self.base(EmulatorType::Qemu).join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("run.bat"), launcher).unwrap();
        fs::write(root.join("disk.qcow2"), "not really a disk").unwrap();
        fs::write(root.join("fake-behavior.txt"), behavior).unwrap();
        root
    }

    fn launch_record(&self, emulator: EmulatorType, name: &str) -> serde_json::Value {
        let path = self.base(emulator).join(format!("{name}.launch.json"));
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap()
    }

    fn manager(&self, settings: ExecutionSettings) -> Agent {
        let (sender, receiver) = mpsc::channel(256);
        let manager = ExecutionManager::load(
            ExecutionConfig {
                state_dir: self.state_dir(),
                emulators: Arc::clone(&self.emulators),
                settings,
            },
            sender,
            CancelFlag::new(),
        )
        .unwrap();
        Agent { manager, receiver }
    }
}

struct Agent {
    manager: Arc<ExecutionManager>,
    receiver: mpsc::Receiver<Message>,
}

fn quick() -> ExecutionSettings {
    ExecutionSettings {
        stop_timeout: Duration::from_secs(5),
        start_grace: Duration::from_secs(1),
    }
}

fn launch(emulator: EmulatorType, name: &str) -> VmLaunchRequest {
    VmLaunchRequest {
        session_id: Uuid::new_v4(),
        emulator_type: emulator,
        vm_name: VmName::new(name).unwrap(),
        mode: ExecutionMode::Local,
        version_id: None,
    }
}

fn stop(request: &VmLaunchRequest, force: bool) -> Message {
    Message::ServerVmStop(VmStopRequest {
        session_id: request.session_id,
        emulator_type: request.emulator_type,
        vm_name: request.vm_name.clone(),
        force,
    })
}

impl Agent {
    /// The first status for the session that satisfies `wanted`.
    async fn wait_for(
        &mut self,
        session_id: Uuid,
        wanted: impl Fn(&VmExecutionStatus) -> bool,
    ) -> VmExecutionStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut seen = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.receiver.recv()).await {
                Ok(Some(Message::AgentVmExecutionStatus(status)))
                    if status.session_id == session_id =>
                {
                    if wanted(&status) {
                        return status;
                    }
                    seen.push(format!("{:?} {:?}", status.state, status.code));
                }
                Ok(Some(_)) => {}
                _ => panic!("no matching status; saw {seen:?}"),
            }
        }
    }

    async fn wait_state(
        &mut self,
        session_id: Uuid,
        state: AgentExecutionState,
    ) -> VmExecutionStatus {
        self.wait_for(session_id, |status| status.state == state)
            .await
    }
}

fn args(record: &serde_json::Value) -> Vec<String> {
    record["arguments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn box86_starts_with_its_own_directory_and_stops_when_its_window_is_closed() {
    let machine = Machine::new();
    let root = machine.box86_vm("dos", "");
    let mut agent = machine.manager(quick());
    let request = launch(EmulatorType::Box86, "dos");
    let session = request.session_id;
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));

    let running = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    assert!(running.pid.is_some());
    assert!(running.process_started_at.is_some());
    assert!(running.graceful_stop_available);
    let vm = VmIdentity {
        emulator_type: EmulatorType::Box86,
        vm_name: VmName::new("dos").unwrap(),
    };
    assert!(agent.manager.activity(&vm).is_some());

    let record = machine.launch_record(EmulatorType::Box86, "dos");
    let root_text = root.to_string_lossy().into_owned();
    assert_eq!(
        args(&record),
        vec![
            "--vmpath".to_owned(),
            root_text.clone(),
            "--vmname".to_owned(),
            "dos".to_owned(),
            "--noconfirm".to_owned(),
            root.join("86box.cfg").to_string_lossy().into_owned(),
        ]
    );
    assert_eq!(record["workingDirectory"].as_str().unwrap(), root_text);
    assert_eq!(
        record["pid"].as_u64().unwrap(),
        u64::from(running.pid.unwrap())
    );

    agent.manager.handle(stop(&request, false));
    agent
        .wait_state(session, AgentExecutionState::Stopping)
        .await;
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    assert_eq!(stopped.exit_code, Some(0));
    assert!(stopped.stop_requested);
    assert!(stopped.ended_at.is_some());
    assert!(agent.manager.activity(&vm).is_none());

    // Repeated until the server says it has it, and then forgotten.
    assert_eq!(agent.manager.pending_reports().len(), 1);
    agent
        .manager
        .handle(Message::ServerVmExecutionAck(VmExecutionAck {
            session_id: session,
        }));
    assert!(agent.manager.pending_reports().is_empty());
    assert!(
        !machine
            .state_dir()
            .join("executions")
            .join(format!("{session}.journal"))
            .exists()
    );
    // The VM is as it was.
    assert!(root.join("86box.cfg").is_file());
}

#[tokio::test]
async fn qemu_runs_its_checked_launcher_and_powers_down_through_its_monitor() {
    let machine = Machine::new();
    machine.qemu_vm(
        "win98",
        "@echo off\r\ncd /d \"%~dp0\"\r\nqemu-system-i386 -m 64 ^\r\n  -hda disk.qcow2 -vga cirrus\r\n",
        "",
    );
    let mut agent = machine.manager(quick());
    let request = launch(EmulatorType::Qemu, "win98");
    let session = request.session_id;
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    let running = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    assert!(running.graceful_stop_available, "{running:?}");

    let record = machine.launch_record(EmulatorType::Qemu, "win98");
    assert_eq!(
        args(&record),
        [
            "-m",
            "64",
            "-hda",
            "disk.qcow2",
            "-vga",
            "cirrus",
            "-qmp",
            "stdio"
        ]
    );
    assert!(
        record["program"]
            .as_str()
            .unwrap()
            .ends_with("qemu-system-i386.exe")
    );

    agent.manager.handle(stop(&request, false));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    assert_eq!(stopped.exit_code, Some(0));
}

#[tokio::test]
async fn a_guest_that_ignores_a_stop_keeps_running_until_a_forced_stop() {
    let machine = Machine::new();
    machine.box86_vm("stubborn", "ignore_close=true\n");
    let mut agent = machine.manager(quick());
    let request = launch(EmulatorType::Box86, "stubborn");
    let session = request.session_id;
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    agent
        .wait_state(session, AgentExecutionState::Running)
        .await;

    agent.manager.handle(stop(&request, false));
    agent
        .wait_state(session, AgentExecutionState::Stopping)
        .await;
    let timed_out = agent
        .wait_for(session, |status| {
            status.code.as_deref() == Some("stop_timeout")
        })
        .await;
    assert_eq!(timed_out.state, AgentExecutionState::Running);

    agent.manager.handle(stop(&request, true));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    assert_eq!(stopped.exit_code, Some(1));
    assert_eq!(stopped.code.as_deref(), Some("forced"));
}

#[tokio::test]
async fn an_emulator_that_exits_at_once_is_a_failed_launch_and_one_that_exits_later_is_recorded() {
    let machine = Machine::new();
    machine.box86_vm("broken", "exit_after_ms=0\nexit_code=3\n");
    machine.box86_vm("short", "exit_after_ms=2500\nexit_code=7\n");
    let mut agent = machine.manager(quick());

    let broken = launch(EmulatorType::Box86, "broken");
    agent
        .manager
        .handle(Message::ServerVmLaunch(broken.clone()));
    let failed = agent
        .wait_state(broken.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(failed.code.as_deref(), Some("launch_exited_early"));
    assert_eq!(failed.exit_code, Some(3));

    let short = launch(EmulatorType::Box86, "short");
    agent.manager.handle(Message::ServerVmLaunch(short.clone()));
    agent
        .wait_state(short.session_id, AgentExecutionState::Running)
        .await;
    let exited = agent
        .wait_state(short.session_id, AgentExecutionState::Exited)
        .await;
    assert_eq!(exited.exit_code, Some(7));
    assert!(!exited.stop_requested);
}

#[tokio::test]
async fn refuses_duplicates_unsafe_launchers_and_remote_modes() {
    let machine = Machine::new();
    machine.box86_vm("dos", "");
    machine.qemu_vm(
        "evil",
        "qemu-system-i386 -hda disk.qcow2 & del /q C:\\x\r\n",
        "",
    );
    machine.qemu_vm(
        "monitor",
        "qemu-system-i386 -hda disk.qcow2 -monitor stdio\r\n",
        "",
    );
    let mut agent = machine.manager(quick());

    let first = launch(EmulatorType::Box86, "dos");
    agent.manager.handle(Message::ServerVmLaunch(first.clone()));
    agent
        .wait_state(first.session_id, AgentExecutionState::Running)
        .await;

    // The same request again starts nothing new: it is answered with the session's state.
    agent.manager.handle(Message::ServerVmLaunch(first.clone()));
    agent
        .wait_state(first.session_id, AgentExecutionState::Running)
        .await;
    assert_eq!(agent.manager.active_sessions(), vec![first.session_id]);

    let second = launch(EmulatorType::Box86, "dos");
    agent
        .manager
        .handle(Message::ServerVmLaunch(second.clone()));
    let refused = agent
        .wait_state(second.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(refused.code.as_deref(), Some("vm_already_running"));
    assert!(refused.pid.is_none());

    for name in ["evil", "monitor"] {
        let request = launch(EmulatorType::Qemu, name);
        agent
            .manager
            .handle(Message::ServerVmLaunch(request.clone()));
        let refused = agent
            .wait_state(request.session_id, AgentExecutionState::Failed)
            .await;
        assert_eq!(
            refused.code.as_deref(),
            Some("launch_configuration_required"),
            "{name}"
        );
        assert!(refused.pid.is_none());
    }
    assert!(
        !machine
            .base(EmulatorType::Qemu)
            .join("evil.launch.json")
            .exists()
    );

    for mode in [ExecutionMode::RemoteVolatile, ExecutionMode::RemoteSnapshot] {
        let request = VmLaunchRequest {
            mode,
            ..launch(EmulatorType::Box86, "dos")
        };
        agent
            .manager
            .handle(Message::ServerVmLaunch(request.clone()));
        let refused = agent
            .wait_state(request.session_id, AgentExecutionState::Failed)
            .await;
        assert_eq!(refused.code.as_deref(), Some("execution_mode_unavailable"));
    }

    let missing = launch(EmulatorType::Box86, "nothing-here");
    agent
        .manager
        .handle(Message::ServerVmLaunch(missing.clone()));
    let refused = agent
        .wait_state(missing.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(refused.code.as_deref(), Some("vm_not_available"));

    agent.manager.handle(stop(&first, true));
    agent
        .wait_state(first.session_id, AgentExecutionState::Stopped)
        .await;
}

#[tokio::test]
async fn a_restarted_agent_finds_its_emulator_again_and_can_still_stop_it() {
    let machine = Machine::new();
    machine.qemu_vm("long", "qemu-system-i386 -hda disk.qcow2\r\n", "");
    let request = launch(EmulatorType::Qemu, "long");
    let session = request.session_id;
    let pid = {
        let mut agent = machine.manager(quick());
        agent
            .manager
            .handle(Message::ServerVmLaunch(request.clone()));
        let running = agent
            .wait_state(session, AgentExecutionState::Running)
            .await;
        agent.manager.shutdown();
        running.pid.unwrap()
    };
    // The emulator does not depend on the agent.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut agent = machine.manager(quick());
    let found = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    assert_eq!(found.pid, Some(pid));
    // The monitor belonged to the earlier run.
    assert!(!found.graceful_stop_available);
    assert_eq!(found.code.as_deref(), Some("graceful_stop_unavailable"));

    agent.manager.handle(stop(&request, false));
    let refused = agent
        .wait_for(session, |status| {
            status.state == AgentExecutionState::Running && status.message.is_some()
        })
        .await;
    assert_eq!(refused.code.as_deref(), Some("graceful_stop_unavailable"));

    agent.manager.handle(stop(&request, true));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    assert_eq!(stopped.code.as_deref(), Some("forced"));
}

#[tokio::test]
async fn a_recorded_pid_that_another_process_now_has_is_never_touched() {
    let machine = Machine::new();
    machine.box86_vm("dos", "");
    let request = launch(EmulatorType::Box86, "dos");
    let session = request.session_id;
    {
        let mut agent = machine.manager(quick());
        agent
            .manager
            .handle(Message::ServerVmLaunch(request.clone()));
        agent
            .wait_state(session, AgentExecutionState::Running)
            .await;
        agent.manager.shutdown();
    }

    // As if the emulator had ended and its PID been given to another process: same PID, other creation
    // time. The journal is the only thing changed.
    let path = machine
        .state_dir()
        .join("executions")
        .join(format!("{session}.journal"));
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let identity: process::ProcessIdentity =
        serde_json::from_value(journal["process"].clone()).unwrap();
    journal["process"]["creationTime"] = serde_json::json!(identity.creation_time - 10_000_000);
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();

    let mut agent = machine.manager(quick());
    let ended = agent.wait_state(session, AgentExecutionState::Exited).await;
    assert_eq!(ended.code.as_deref(), Some("exited_while_agent_away"));
    assert_eq!(ended.exit_code, None);
    // Stopping an ended session does nothing at all.
    agent.manager.handle(stop(&request, true));

    // The real process was left alone, and still runs. The test ends it through its own identity.
    match process::reattach(&identity) {
        Reattached::Running(handle) => handle.terminate(1).unwrap(),
        other => panic!("the emulator should still run: {other:?}"),
    }
}
