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
        workspace_id: None,
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
            "stdio",
            "-monitor",
            "vc"
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

    // A Remote Snapshot session runs a working copy, and never the persistent copy instead.
    let no_working_copy = VmLaunchRequest {
        mode: ExecutionMode::RemoteSnapshot,
        workspace_id: Some(Uuid::new_v4()),
        ..launch(EmulatorType::Box86, "dos")
    };
    agent
        .manager
        .handle(Message::ServerVmLaunch(no_working_copy.clone()));
    let refused = agent
        .wait_state(no_working_copy.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(refused.code.as_deref(), Some("workspace_unavailable"));

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

impl Machine {
    /// A working copy as a restore into it leaves one: its record, and the VM under its own directory.
    fn working_copy(
        &self,
        name: &str,
        purpose: Option<emucat_agent::protocol::WorkspacePurpose>,
    ) -> (Uuid, PathBuf) {
        let workspace = Uuid::new_v4();
        emucat_agent::workspaces::write_record(
            &self.state_dir(),
            &emucat_agent::workspaces::WorkspaceRecord {
                workspace_id: workspace,
                emulator_type: EmulatorType::Box86,
                vm_name: VmName::new(name).unwrap(),
                source_version_id: Uuid::new_v4(),
                manifest_sha256: None,
                purpose,
            },
        )
        .unwrap();
        let root =
            emucat_agent::workspaces::workspace_base(&self.state_dir(), workspace).join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("86box.cfg"), "[General]\n").unwrap();
        fs::write(root.join("fake-behavior.txt"), "").unwrap();
        (workspace, root)
    }
}

#[tokio::test]
async fn a_working_copy_runs_only_in_the_mode_it_was_prepared_for() {
    use emucat_agent::protocol::WorkspacePurpose;
    let machine = Machine::new();
    // The persistent copy has the same name, and must never be the one that runs.
    let persistent = machine.box86_vm("dos", "");
    let (volatile, volatile_root) =
        machine.working_copy("dos", Some(WorkspacePurpose::RemoteVolatile));
    let mut agent = machine.manager(quick());
    assert!(
        agent
            .manager
            .capabilities()
            .modes
            .contains(&ExecutionMode::RemoteVolatile)
    );

    // Run as Remote Snapshot, a volatile working copy is refused: its changes would be published.
    let wrong = VmLaunchRequest {
        mode: ExecutionMode::RemoteSnapshot,
        workspace_id: Some(volatile),
        ..launch(EmulatorType::Box86, "dos")
    };
    agent.manager.handle(Message::ServerVmLaunch(wrong.clone()));
    let refused = agent
        .wait_state(wrong.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(refused.code.as_deref(), Some("workspace_purpose_mismatch"));
    assert!(refused.pid.is_none());

    // In its own mode it runs, from its own directory.
    let request = VmLaunchRequest {
        mode: ExecutionMode::RemoteVolatile,
        workspace_id: Some(volatile),
        ..launch(EmulatorType::Box86, "dos")
    };
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    agent
        .wait_state(request.session_id, AgentExecutionState::Running)
        .await;
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(
            emucat_agent::workspaces::workspace_base(&machine.state_dir(), volatile)
                .join("dos.launch.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        record["workingDirectory"].as_str().unwrap(),
        volatile_root.to_string_lossy()
    );
    assert!(
        !machine
            .base(EmulatorType::Box86)
            .join("dos.launch.json")
            .exists()
    );
    // While it runs, the VM is running on this agent for every purpose.
    let vm = VmIdentity {
        emulator_type: EmulatorType::Box86,
        vm_name: VmName::new("dos").unwrap(),
    };
    assert!(agent.manager.activity(&vm).is_some());
    agent.manager.handle(stop(&request, false));
    agent
        .wait_state(request.session_id, AgentExecutionState::Stopped)
        .await;
    assert!(persistent.join("86box.cfg").is_file());

    // A Milestone 7 working copy runs as it always did, and never as a volatile one.
    let (manual, _) = machine.working_copy("dos", None);
    let wrong = VmLaunchRequest {
        mode: ExecutionMode::RemoteVolatile,
        workspace_id: Some(manual),
        ..launch(EmulatorType::Box86, "dos")
    };
    agent.manager.handle(Message::ServerVmLaunch(wrong.clone()));
    let refused = agent
        .wait_state(wrong.session_id, AgentExecutionState::Failed)
        .await;
    assert_eq!(refused.code.as_deref(), Some("workspace_purpose_mismatch"));
    let request = VmLaunchRequest {
        mode: ExecutionMode::RemoteSnapshot,
        workspace_id: Some(manual),
        ..launch(EmulatorType::Box86, "dos")
    };
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    agent
        .wait_state(request.session_id, AgentExecutionState::Running)
        .await;
    agent.manager.handle(stop(&request, true));
    agent
        .wait_state(request.session_id, AgentExecutionState::Stopped)
        .await;
}

impl Machine {
    /// A QEMU working copy as a restore into it leaves one, with its own run script.
    fn qemu_working_copy(
        &self,
        name: &str,
        purpose: emucat_agent::protocol::WorkspacePurpose,
        launcher: &str,
    ) -> (Uuid, PathBuf) {
        let workspace = Uuid::new_v4();
        emucat_agent::workspaces::write_record(
            &self.state_dir(),
            &emucat_agent::workspaces::WorkspaceRecord {
                workspace_id: workspace,
                emulator_type: EmulatorType::Qemu,
                vm_name: VmName::new(name).unwrap(),
                source_version_id: Uuid::new_v4(),
                manifest_sha256: None,
                purpose: Some(purpose),
            },
        )
        .unwrap();
        let root =
            emucat_agent::workspaces::workspace_base(&self.state_dir(), workspace).join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("run.bat"), launcher).unwrap();
        fs::write(root.join("disk.qcow2"), "not really a disk").unwrap();
        fs::write(root.join("fake-behavior.txt"), "").unwrap();
        (workspace, root)
    }
}

/// Runs one QEMU session to its end, gracefully, and returns the command line it was started with.
async fn qemu_session(
    agent: &mut Agent,
    request: VmLaunchRequest,
    record: PathBuf,
) -> (Vec<String>, String) {
    let session = request.session_id;
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    let running = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    assert!(running.graceful_stop_available, "QMP answered: {running:?}");
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    agent.manager.handle(stop(&request, false));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    assert_eq!(stopped.exit_code, Some(0), "powered down over QMP");
    assert!(agent.manager.active_sessions().is_empty());
    (
        args(&record),
        record["workingDirectory"].as_str().unwrap().to_owned(),
    )
}

/// QEMU's human monitor on Ctrl+Alt+2 is kept in every mode, beside the agent's own QMP channel, and the
/// VM's arguments, directory and run script are left as they were.
#[tokio::test]
async fn every_mode_keeps_qemus_human_monitor_beside_qmp() {
    use emucat_agent::protocol::WorkspacePurpose;
    let launcher =
        "@echo off\r\nqemu-system-i386 -machine pc -m 128 -vga cirrus -hda disk.qcow2\r\n";
    let expected = [
        "-machine",
        "pc",
        "-m",
        "128",
        "-vga",
        "cirrus",
        "-hda",
        "disk.qcow2",
        "-qmp",
        "stdio",
        "-monitor",
        "vc",
    ];
    let machine = Machine::new();
    let local_root = machine.qemu_vm("nt40", launcher, "");
    let mut agent = machine.manager(quick());

    let local = launch(EmulatorType::Qemu, "nt40");
    let record = machine.base(EmulatorType::Qemu).join("nt40.launch.json");
    let (arguments, directory) = qemu_session(&mut agent, local, record).await;
    assert_eq!(arguments, expected, "Local");
    assert_eq!(directory, local_root.to_string_lossy(), "Local");
    assert_eq!(
        fs::read_to_string(local_root.join("run.bat")).unwrap(),
        launcher
    );

    for (mode, purpose) in [
        (
            ExecutionMode::RemoteVolatile,
            WorkspacePurpose::RemoteVolatile,
        ),
        (
            ExecutionMode::RemoteSnapshot,
            WorkspacePurpose::RemoteSnapshot,
        ),
    ] {
        let (workspace, root) = machine.qemu_working_copy("nt40", purpose, launcher);
        let request = VmLaunchRequest {
            mode,
            workspace_id: Some(workspace),
            ..launch(EmulatorType::Qemu, "nt40")
        };
        let record = emucat_agent::workspaces::workspace_base(&machine.state_dir(), workspace)
            .join("nt40.launch.json");
        let (arguments, directory) = qemu_session(&mut agent, request, record).await;
        assert_eq!(arguments, expected, "{mode:?}");
        assert_eq!(directory, root.to_string_lossy(), "{mode:?}");
        assert_eq!(fs::read_to_string(root.join("run.bat")).unwrap(), launcher);
    }
}

/// A monitor the VM configures, or turns off, is left alone, as is a VM without a display.
#[tokio::test]
async fn a_monitor_the_vm_chooses_is_respected_in_every_mode() {
    use emucat_agent::protocol::WorkspacePurpose;
    let cases = [
        (
            "explicit",
            "qemu-system-i386 -hda disk.qcow2 -monitor vc:800x600\r\n",
            &[
                "-hda",
                "disk.qcow2",
                "-monitor",
                "vc:800x600",
                "-qmp",
                "stdio",
            ][..],
        ),
        (
            "chardev",
            "qemu-system-i386 -hda disk.qcow2 -chardev vc,id=hmp -mon chardev=hmp,mode=readline\r\n",
            &[
                "-hda",
                "disk.qcow2",
                "-chardev",
                "vc,id=hmp",
                "-mon",
                "chardev=hmp,mode=readline",
                "-qmp",
                "stdio",
            ],
        ),
        (
            "disabled",
            "qemu-system-i386 -hda disk.qcow2 -monitor none\r\n",
            &["-hda", "disk.qcow2", "-monitor", "none", "-qmp", "stdio"],
        ),
        (
            "headless",
            "qemu-system-i386 -hda disk.qcow2 -display none\r\n",
            &["-hda", "disk.qcow2", "-display", "none", "-qmp", "stdio"],
        ),
    ];
    let machine = Machine::new();
    let mut agent = machine.manager(quick());
    for (name, launcher, expected) in cases {
        machine.qemu_vm(name, launcher, "");
        let record = machine
            .base(EmulatorType::Qemu)
            .join(format!("{name}.launch.json"));
        let (arguments, _) =
            qemu_session(&mut agent, launch(EmulatorType::Qemu, name), record).await;
        assert_eq!(arguments, expected, "Local {name}");

        for (mode, purpose) in [
            (
                ExecutionMode::RemoteVolatile,
                WorkspacePurpose::RemoteVolatile,
            ),
            (
                ExecutionMode::RemoteSnapshot,
                WorkspacePurpose::RemoteSnapshot,
            ),
        ] {
            let (workspace, _) = machine.qemu_working_copy(name, purpose, launcher);
            let request = VmLaunchRequest {
                mode,
                workspace_id: Some(workspace),
                ..launch(EmulatorType::Qemu, name)
            };
            let record = emucat_agent::workspaces::workspace_base(&machine.state_dir(), workspace)
                .join(format!("{name}.launch.json"));
            let (arguments, _) = qemu_session(&mut agent, request, record).await;
            assert_eq!(arguments, expected, "{mode:?} {name}");
        }
    }
}

/// Capture output is agent-owned in all modes, and remains after the working copy is removed.
#[tokio::test]
async fn captures_in_all_modes_without_changing_vm_files() {
    use emucat_agent::capture::{CaptureCommand, validate_ppm};
    use emucat_agent::protocol::WorkspacePurpose;
    let machine = Machine::new();
    let launcher = "qemu-system-i386 -m 16 -vga std\r\n";
    let local = machine.qemu_vm("capture-vm", launcher, "");
    let mut agent = machine.manager(quick());
    for mode in [ExecutionMode::Local, ExecutionMode::RemoteVolatile, ExecutionMode::RemoteSnapshot] {
        let workspace = match mode {
            ExecutionMode::Local => None,
            ExecutionMode::RemoteVolatile => Some(machine.qemu_working_copy("capture-vm", WorkspacePurpose::RemoteVolatile, launcher)),
            ExecutionMode::RemoteSnapshot => Some(machine.qemu_working_copy("capture-vm", WorkspacePurpose::RemoteSnapshot, launcher)),
        };
        let request = VmLaunchRequest {mode, workspace_id: workspace.as_ref().map(|(id, _)| *id), ..launch(EmulatorType::Qemu, "capture-vm")};
        agent.manager.handle(Message::ServerVmLaunch(request.clone()));
        let running = agent.wait_for(request.session_id, |status| status.state == AgentExecutionState::Running).await;
        assert_eq!(running.screenshot_available, Some(true));
        let output = machine.state_dir().join(format!("{}.ppm", Uuid::new_v4()));
        let capture = CaptureCommand {operation_id: Uuid::new_v4(), session_id: request.session_id, emulator_type: EmulatorType::Qemu, vm_name: request.vm_name.clone()};
        let manager = agent.manager.clone(); let destination = output.clone(); let command = capture.clone();
        tokio::task::spawn_blocking(move || manager.capture_screen(&command, destination)).await.unwrap().unwrap();
        validate_ppm(&output).unwrap();
        let invalid = CaptureCommand {session_id: Uuid::new_v4(), ..capture};
        assert!(agent.manager.capture_screen(&invalid, output.with_extension("other")).is_err());
        agent.manager.handle(stop(&request, true));
        agent.wait_for(request.session_id, |status| status.state == AgentExecutionState::Stopped).await;
        if let Some((id, _)) = workspace { emucat_agent::workspaces::discard(&machine.state_dir(), id, EmulatorType::Qemu, &request.vm_name).unwrap(); }
        validate_ppm(&output).unwrap();
        assert_eq!(fs::read_to_string(local.join("run.bat")).unwrap(), launcher);
    }
}
