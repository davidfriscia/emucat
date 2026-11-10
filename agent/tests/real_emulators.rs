//! Real 86Box and QEMU, launched, stopped and found again after a restart by the agent's own code. Every
//! VM is a disposable fixture in a temporary directory, with no disk image: nothing the user owns is
//! read or written, apart from the emulator installations themselves, which are only executed.
//!
//! Opt-in, since they need the emulators installed and open windows:
//!
//! ```text
//! set EMUCAT_REAL_86BOX=C:\path\to\86Box.exe
//! set EMUCAT_REAL_QEMU=C:\Program Files\qemu\qemu-system-x86_64.exe
//! cargo test --test real_emulators -- --ignored --nocapture --test-threads=1
//! ```
#![cfg(windows)]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmName};
use emucat_agent::execution::{ExecutionConfig, ExecutionManager, ExecutionSettings};
use emucat_agent::protocol::{
    AgentExecutionState, ExecutionMode, Message, VmExecutionStatus, VmLaunchRequest, VmStopRequest,
};
use emucat_agent::repository::CancelFlag;
use tempfile::TempDir;
use tokio::sync::mpsc;
use uuid::Uuid;

fn installed(variable: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(variable)?);
    assert!(
        path.is_file(),
        "{variable} names no file: {}",
        path.display()
    );
    Some(path)
}

struct Machine {
    directory: TempDir,
    emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
}

impl Machine {
    fn new(emulator: EmulatorType, executable: PathBuf) -> Self {
        let directory = TempDir::new().unwrap();
        let base_path = directory.path().join(emulator.to_string());
        fs::create_dir_all(&base_path).unwrap();
        let mut emulators = BTreeMap::new();
        emulators.insert(
            emulator,
            EmulatorConfig {
                base_path,
                executable,
            },
        );
        Self {
            directory,
            emulators: Arc::new(emulators),
        }
    }

    fn vm(&self, emulator: EmulatorType, name: &str) -> PathBuf {
        let root = self.emulators[&emulator].base_path.join(name);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn manager(&self, settings: ExecutionSettings) -> Agent {
        let (sender, receiver) = mpsc::channel(256);
        let manager = ExecutionManager::load(
            ExecutionConfig {
                state_dir: self.directory.path().join("state"),
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

impl Agent {
    async fn wait_for(
        &mut self,
        session_id: Uuid,
        wanted: impl Fn(&VmExecutionStatus) -> bool,
    ) -> VmExecutionStatus {
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut seen = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.receiver.recv()).await {
                Ok(Some(Message::AgentVmExecutionStatus(status)))
                    if status.session_id == session_id =>
                {
                    println!(
                        "  status: {:?} pid={:?} exit={:?} code={:?} graceful={}",
                        status.state,
                        status.pid,
                        status.exit_code,
                        status.code,
                        status.graceful_stop_available
                    );
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

fn settings() -> ExecutionSettings {
    ExecutionSettings {
        stop_timeout: Duration::from_secs(10),
        start_grace: Duration::from_secs(3),
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

/// A 486 with no disks, which stops at the BIOS. The machine and its ROMs are 86Box's own.
const BOX86_CONFIG: &str = "[General]\r\nvid_renderer = qt_software\r\nconfirm_exit = 0\r\n\r\n\
[Machine]\r\nmachine = 486sp3c\r\ncpu_family = i486sx\r\ncpu_speed = 33333333\r\n\
cpu_multi = 1\r\nmem_size = 4096\r\n\r\n[Video]\r\ngfxcard = et4000w32\r\n";

#[tokio::test]
#[ignore = "needs 86Box: set EMUCAT_REAL_86BOX"]
async fn real_86box_is_launched_tracked_and_closed_gracefully() {
    let Some(executable) = installed("EMUCAT_REAL_86BOX") else {
        println!("EMUCAT_REAL_86BOX is not set; skipped");
        return;
    };
    let machine = Machine::new(EmulatorType::Box86, executable);
    let root = machine.vm(EmulatorType::Box86, "disposable-486");
    fs::write(root.join("86box.cfg"), BOX86_CONFIG).unwrap();
    let mut agent = machine.manager(settings());

    let request = launch(EmulatorType::Box86, "disposable-486");
    let session = request.session_id;
    let started = Instant::now();
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    let running = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    println!(
        "86Box running after {:?}: pid {:?}",
        started.elapsed(),
        running.pid
    );
    assert!(running.pid.is_some());
    assert!(running.process_started_at.is_some());
    assert!(running.graceful_stop_available);

    // A second launch of the same VM is refused while it runs.
    let duplicate = launch(EmulatorType::Box86, "disposable-486");
    agent
        .manager
        .handle(Message::ServerVmLaunch(duplicate.clone()));
    let refused = agent
        .wait_for(duplicate.session_id, |status| {
            status.state == AgentExecutionState::Failed
        })
        .await;
    assert_eq!(refused.code.as_deref(), Some("vm_already_running"));

    tokio::time::sleep(Duration::from_secs(3)).await;
    agent.manager.handle(stop(&request, false));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    println!("86Box closed gracefully: exit code {:?}", stopped.exit_code);
    assert_eq!(stopped.code, None, "a graceful stop is not a forced one");
    assert!(root.join("86box.cfg").is_file(), "the VM's files are kept");
}

/// A QEMU machine with no disks and no display. SeaBIOS finds nothing to boot and waits. A QEMU VM is
/// recognized by its run script, as the user's are; the agent parses it, and never executes it.
fn qemu_batch(root: &std::path::Path) {
    fs::write(
        root.join("run.bat"),
        "@echo off
qemu-system-i386 -m 16 -nodefaults -display none
",
    )
    .unwrap();
}

/// The same machine, described by a launch profile, which takes precedence over the run script.
fn qemu_profile(root: &std::path::Path) {
    qemu_batch(root);
    fs::write(
        root.join("emucat-launch.json"),
        r#"{"profileVersion":1,"system":"i386","args":["-m","16","-nodefaults","-display","none"]}"#,
    )
    .unwrap();
}

#[tokio::test]
#[ignore = "needs QEMU: set EMUCAT_REAL_QEMU"]
async fn real_qemu_is_launched_found_again_after_a_restart_and_stopped() {
    let Some(executable) = installed("EMUCAT_REAL_QEMU") else {
        println!("EMUCAT_REAL_QEMU is not set; skipped");
        return;
    };
    let machine = Machine::new(EmulatorType::Qemu, executable);
    let root = machine.vm(EmulatorType::Qemu, "disposable-pc");
    qemu_batch(&root);

    let request = launch(EmulatorType::Qemu, "disposable-pc");
    let session = request.session_id;
    let (pid, created) = {
        let mut agent = machine.manager(settings());
        agent
            .manager
            .handle(Message::ServerVmLaunch(request.clone()));
        let running = agent
            .wait_state(session, AgentExecutionState::Running)
            .await;
        assert!(running.graceful_stop_available, "QMP answered on stdio");

        // There is no guest to act on the ACPI power button, so a graceful stop is asked for and times out.
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

        agent.manager.shutdown();
        (running.pid.unwrap(), running.process_started_at.unwrap())
    };
    println!("agent stopped; QEMU pid {pid} keeps running");
    tokio::time::sleep(Duration::from_secs(1)).await;

    let mut agent = machine.manager(settings());
    let found = agent
        .wait_state(session, AgentExecutionState::Running)
        .await;
    assert_eq!(
        found.pid,
        Some(pid),
        "the same process, found by its identity"
    );
    assert_eq!(found.process_started_at, Some(created));
    assert_eq!(found.code.as_deref(), Some("graceful_stop_unavailable"));

    agent.manager.handle(stop(&request, true));
    let stopped = agent
        .wait_state(session, AgentExecutionState::Stopped)
        .await;
    println!("QEMU forced to stop: exit code {:?}", stopped.exit_code);
    assert_eq!(stopped.code.as_deref(), Some("forced"));
    assert!(root.join("run.bat").is_file(), "the VM's files are kept");
}

#[tokio::test]
#[ignore = "needs QEMU: set EMUCAT_REAL_QEMU"]
async fn real_qemu_quits_through_its_monitor_when_forced() {
    let Some(executable) = installed("EMUCAT_REAL_QEMU") else {
        println!("EMUCAT_REAL_QEMU is not set; skipped");
        return;
    };
    let machine = Machine::new(EmulatorType::Qemu, executable);
    let root = machine.vm(EmulatorType::Qemu, "disposable-quit");
    qemu_profile(&root);
    let mut agent = machine.manager(settings());
    let request = launch(EmulatorType::Qemu, "disposable-quit");
    agent
        .manager
        .handle(Message::ServerVmLaunch(request.clone()));
    agent
        .wait_state(request.session_id, AgentExecutionState::Running)
        .await;
    agent.manager.handle(stop(&request, true));
    let stopped = agent
        .wait_state(request.session_id, AgentExecutionState::Stopped)
        .await;
    println!("QEMU quit through QMP: exit code {:?}", stopped.exit_code);
    assert_eq!(stopped.exit_code, Some(0), "QMP quit is a clean exit");
    assert_eq!(stopped.code.as_deref(), Some("forced"));
}
