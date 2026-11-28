//! VirtualBox masters and local execution (decision 0045): exporting a registered machine into an OVA and
//! publishing it, and watching, starting and stopping it.
//!
//! Everything runs against `fake_vboxmanage`, which `cargo test` builds next to the test executables, and
//! against a repository held in memory. Nothing here runs the real VBoxManage, or touches a real machine.

mod support;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::emulators::VmName;
use emucat_agent::packaging::hex;
use emucat_agent::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RepositoryConfigSummary,
    VirtualBoxControl, VirtualBoxControlAction, VirtualBoxControlResult,
    VirtualBoxRegistrationRequest, VirtualBoxStates, VirtualBoxWatch,
};
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use emucat_agent::virtualbox::{VirtualBoxConfig, VirtualBoxSettings, VirtualBoxVmState};
use emucat_agent::virtualbox_monitor::VirtualBoxMonitor;
use emucat_agent::virtualbox_registration::archive_key;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::sync::mpsc;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x7777);
const POWEROFF: &str = include_str!("fixtures/virtualbox/showvminfo-poweroff.txt");
const RUNNING: &str = include_str!("fixtures/virtualbox/showvminfo-running.txt");
/// The machine in the powered-off fixture.
const XENIX: &str = "2acda0fc-cea6-406b-8a55-746fac380687";
/// The machine in the running fixture.
const XP: &str = "97910566-2cc6-492b-9dc7-6cc6ee66ffd6";

fn uuid(text: &str) -> Uuid {
    Uuid::parse_str(text).unwrap()
}

// The fake VBoxManage.

fn fake_vboxmanage() -> PathBuf {
    support::example("fake_vboxmanage")
}

/// A private copy of the fake, with its own machines.
struct Installation {
    directory: TempDir,
    executable: PathBuf,
}

impl Installation {
    fn new(files: &[(&str, &str)]) -> Self {
        let directory = TempDir::new().unwrap();
        let executable = directory.path().join(if cfg!(windows) {
            "VBoxManage.exe"
        } else {
            "VBoxManage"
        });
        fs::copy(fake_vboxmanage(), &executable).unwrap();
        let installation = Self {
            directory,
            executable,
        };
        for (name, content) in files {
            installation.write(name, content);
        }
        installation
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.directory.path().join(name), content).unwrap();
    }

    fn calls(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.directory.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn calls_of(&self, command: &str) -> Vec<Vec<String>> {
        self.calls()
            .into_iter()
            .filter(|call| call.first().map(String::as_str) == Some(command))
            .collect()
    }

    fn settings(&self) -> VirtualBoxSettings {
        let mut settings = VirtualBoxSettings::new(VirtualBoxConfig {
            vboxmanage: self.executable.clone(),
        });
        settings.command_timeout = Duration::from_secs(20);
        settings.active_poll = Duration::from_millis(200);
        settings.inactive_poll = Duration::from_millis(400);
        settings.reconcile_poll = Duration::from_millis(50);
        settings.reconcile_window = Duration::from_secs(5);
        settings
    }
}

// A repository held in memory.

#[derive(Clone, Default)]
struct MemoryRepository {
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl MemoryRepository {
    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.objects.lock().unwrap().get(key).cloned()
    }

    fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.objects.lock().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }
}

impl ArchiveRepository for MemoryRepository {
    fn health_check<'a>(
        &'a self,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move { unreachable!("not used here") }.boxed()
    }

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        async move {
            Ok(self.object(key.as_str()).map(|object| ObjectMetadata {
                size_bytes: object.len() as u64,
            }))
        }
        .boxed()
    }

    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        async move { Ok(None) }.boxed()
    }

    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move {
            assert!(key.is_staging(), "uploads only ever go to staging");
            let bytes = fs::read(source).unwrap();
            let size = bytes.len() as u64;
            self.objects
                .lock()
                .unwrap()
                .insert(key.as_str().to_owned(), bytes);
            progress(size, size);
            Ok(ObjectMetadata { size_bytes: size })
        }
        .boxed()
    }

    fn download<'a>(
        &'a self,
        _key: &'a RepositoryKey,
        _destination: &'a Path,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { unreachable!("registration never downloads") }.boxed()
    }

    fn verify<'a>(
        &'a self,
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let object = self
                .object(key.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            let sha256 = hex(&Sha256::digest(&object));
            progress(object.len() as u64, object.len() as u64);
            if sha256 != expected_sha256 || object.len() as u64 != expected_size {
                return Err(RepositoryError::new(Kind::HashMismatch, "mismatch"));
            }
            Ok(VerifiedObject {
                size_bytes: object.len() as u64,
                sha256,
            })
        }
        .boxed()
    }

    fn publish<'a>(
        &'a self,
        staging: &'a RepositoryKey,
        final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            let mut objects = self.objects.lock().unwrap();
            if objects.contains_key(final_key.as_str()) {
                return Err(RepositoryError::new(Kind::AlreadyExists, "exists"));
            }
            let object = objects
                .remove(staging.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            objects.insert(final_key.as_str().to_owned(), object);
            Ok(())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            self.objects.lock().unwrap().remove(key.as_str());
            Ok(())
        }
        .boxed()
    }
}

struct Provider {
    repository: MemoryRepository,
}

impl RepositoryProvider for Provider {
    fn repository_ids(&self) -> Vec<Uuid> {
        vec![REPOSITORY]
    }

    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        if repository_id == REPOSITORY {
            Ok(Arc::new(self.repository.clone()))
        } else {
            Err(RepositoryError::new(Kind::NotConfigured, "not configured"))
        }
    }

    fn summary(&self, repository_id: Uuid) -> Option<RepositoryConfigSummary> {
        (repository_id == REPOSITORY).then(|| RepositoryConfigSummary {
            host: "nas.test".to_owned(),
            port: 22,
            username: "emucat".to_owned(),
            remote_root: "/repo".to_owned(),
        })
    }

    fn upload_attempts(&self, _repository_id: Uuid) -> u32 {
        2
    }
}

// An agent.

struct World {
    directory: TempDir,
    repository: MemoryRepository,
}

impl World {
    fn new() -> Self {
        Self {
            directory: TempDir::new().unwrap(),
            repository: MemoryRepository::default(),
        }
    }

    fn state(&self) -> PathBuf {
        self.directory.path().join("state")
    }

    fn staging(&self) -> PathBuf {
        self.directory.path().join("staging")
    }

    fn start(&self, virtualbox: Option<VirtualBoxSettings>) -> Arc<AgentOperations> {
        fs::create_dir_all(self.staging()).unwrap();
        AgentOperations::load(OperationsConfig {
            restore: emucat_agent::restore::RestoreSettings::under(&self.state()),
            agent_id: Uuid::from_u128(1),
            state_dir: self.state(),
            staging_dir: self.staging(),
            emulators: Arc::new(BTreeMap::new()),
            repositories: Arc::new(Provider {
                repository: self.repository.clone(),
            }),
            retry_delay: Duration::from_millis(1),
            execution: emucat_agent::execution::ExecutionSettings::default(),
            virtualbox,
            media: None,
        })
        .unwrap()
    }
}

fn request(machine: &str) -> VirtualBoxRegistrationRequest {
    let vm_name = VmName::new("xenix-386").unwrap();
    let version_id = Uuid::new_v4();
    VirtualBoxRegistrationRequest {
        operation_id: Uuid::new_v4(),
        archive_key: archive_key(&vm_name, version_id),
        vm_name,
        machine_uuid: uuid(machine),
        repository_id: REPOSITORY,
        version_id,
    }
}

async fn next_message(operations: &AgentOperations, wanted: impl Fn(&Message) -> bool) -> Message {
    let mut outbound = operations.outbound().await;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let message = outbound.recv().await.expect("the channel stays open");
            if wanted(&message) {
                return message;
            }
        }
    })
    .await
    .expect("timed out waiting for a message")
}

async fn outcome(
    operations: &AgentOperations,
) -> Result<emucat_agent::protocol::VirtualBoxRegistrationResult, (String, String)> {
    match next_message(operations, |message| {
        matches!(
            message,
            Message::AgentVirtualBoxRegistrationResult(_) | Message::AgentRegistrationError(_)
        )
    })
    .await
    {
        Message::AgentVirtualBoxRegistrationResult(result) => Ok(result),
        Message::AgentRegistrationError(error) => Err((error.code, error.message)),
        _ => unreachable!(),
    }
}

fn ack(request: &VirtualBoxRegistrationRequest, outcome: AckOutcome) -> Message {
    Message::ServerRegistrationAck(RegistrationAck {
        operation_id: request.operation_id,
        outcome,
        version_id: Some(request.version_id),
        remove_local: true,
        delete_published: false,
    })
}

// Registration.

#[tokio::test]
async fn exports_a_powered_off_machine_and_publishes_the_ova_as_it_is() {
    let world = World::new();
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    let operations = world.start(Some(vbox.settings()));
    let request = request(XENIX);

    let sync = operations.sync_messages();
    assert!(sync.iter().any(|message| matches!(
        message,
        Message::AgentRegistrationSync(sync) if sync.virtualbox
    )));

    operations.handle(Message::ServerVirtualBoxRegistrationRequest(
        request.clone(),
    ));
    let result = outcome(&operations).await.expect("registered");

    let content = format!("fake ova of {XENIX}").into_bytes();
    assert_eq!(result.archive_key, request.archive_key);
    assert!(result.archive_key.ends_with(".ova"));
    assert_eq!(result.archive_size_bytes, content.len() as u64);
    assert_eq!(result.archive_sha256, hex(&Sha256::digest(&content)));
    // The OVA itself is the master: not wrapped in anything.
    assert_eq!(world.repository.object(&request.archive_key), Some(content));
    assert_eq!(world.repository.keys(), vec![request.archive_key.clone()]);

    // Named by UUID, written into the agent's own staging directory, which is then emptied.
    let exports = vbox.calls_of("export");
    assert_eq!(exports.len(), 1);
    let output = world
        .staging()
        .join(format!("virtualbox-{}", request.operation_id))
        .join(format!("{}.ova", request.operation_id));
    assert_eq!(
        exports[0],
        [
            "export".to_owned(),
            XENIX.to_owned(),
            format!("--output={}", output.display()),
            "--manifest".to_owned(),
        ]
    );
    assert!(!output.parent().unwrap().exists());
    // Read-only commands only, apart from the export: the machine is never started, changed or removed.
    for call in vbox.calls() {
        assert!(
            matches!(call[0].as_str(), "showvminfo" | "export" | "list"),
            "unexpected command {call:?}"
        );
    }

    // A copy: the commit is answered with the machine preserved, and the answer to that closes it.
    operations.handle(ack(&request, AckOutcome::Committed));
    let cleanup = match next_message(&operations, |message| {
        matches!(message, Message::AgentRegistrationCleanup(_))
    })
    .await
    {
        Message::AgentRegistrationCleanup(report) => report,
        _ => unreachable!(),
    };
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    assert!(operations.open_operations().contains(&request.operation_id));
    operations.handle(ack(&request, AckOutcome::Closed));
    assert!(operations.open_operations().is_empty());
    operations.shutdown();
}

#[tokio::test]
async fn a_machine_that_is_not_powered_off_is_refused_before_anything_is_exported() {
    let world = World::new();
    let vbox = Installation::new(&[(&format!("{XP}.txt"), RUNNING)]);
    let operations = world.start(Some(vbox.settings()));
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(request(XP)));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "source_in_use");
    assert!(vbox.calls_of("export").is_empty());
    assert!(world.repository.keys().is_empty());
    operations.shutdown();
}

#[tokio::test]
async fn an_unknown_machine_is_refused() {
    let world = World::new();
    let vbox = Installation::new(&[]);
    let operations = world.start(Some(vbox.settings()));
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(request(XENIX)));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "source_missing");
    operations.shutdown();
}

#[tokio::test]
async fn a_machine_used_during_the_export_is_not_registered() {
    let world = World::new();
    let vbox = Installation::new(&[
        (&format!("{XENIX}.txt"), POWEROFF),
        // Someone started it and shut it down again while it was exported: a new state change time.
        (
            "export_then.txt",
            &POWEROFF.replace("2025-07-18T05:33:15", "2025-07-18T06:00:00"),
        ),
    ]);
    let operations = world.start(Some(vbox.settings()));
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(request(XENIX)));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "source_changed");
    assert!(world.repository.keys().is_empty());
    operations.shutdown();
}

#[tokio::test]
async fn a_failed_export_names_virtualbox_s_error_and_no_path() {
    let world = World::new();
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF), ("export_fail.txt", "")]);
    let operations = world.start(Some(vbox.settings()));
    let request = request(XENIX);
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(
        request.clone(),
    ));
    let (code, message) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "export_failed");
    assert!(message.contains("VBOX_E_FILE_ERROR"), "{message}");
    assert!(!message.contains("Users"), "{message}");
    assert!(
        !world
            .staging()
            .join(format!("virtualbox-{}", request.operation_id))
            .exists()
    );
    operations.shutdown();
}

#[tokio::test]
async fn a_key_that_is_not_this_version_s_ova_is_refused() {
    let world = World::new();
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    let operations = world.start(Some(vbox.settings()));
    let mut request = request(XENIX);
    request.archive_key = request.archive_key.replace(".ova", ".zip");
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(request));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "invalid_request");
    assert!(vbox.calls_of("export").is_empty());
    operations.shutdown();
}

#[tokio::test]
async fn without_virtualbox_nothing_is_offered_and_a_request_is_refused() {
    let world = World::new();
    let operations = world.start(None);
    assert!(operations.sync_messages().iter().any(|message| matches!(
        message,
        Message::AgentRegistrationSync(sync) if !sync.virtualbox
    )));
    operations.handle(Message::ServerVirtualBoxRegistrationRequest(request(XENIX)));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "virtualbox_unavailable");
    operations.shutdown();
}

#[tokio::test]
async fn an_export_interrupted_by_a_restart_is_reported_as_such_and_registers_nothing() {
    let world = World::new();
    let vbox = Installation::new(&[
        (&format!("{XENIX}.txt"), POWEROFF),
        ("export_sleep_ms.txt", "20000"),
    ]);
    let request = request(XENIX);
    {
        let operations = world.start(Some(vbox.settings()));
        operations.handle(Message::ServerVirtualBoxRegistrationRequest(
            request.clone(),
        ));
        // Wait for the export to have started.
        for _ in 0..200 {
            if !vbox.calls_of("export").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(!vbox.calls_of("export").is_empty());
        operations.shutdown();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let operations = world.start(Some(vbox.settings()));
    let reports = operations.pending_reports();
    assert!(
        reports.iter().any(|message| matches!(
            message,
            Message::AgentRegistrationError(error)
                if error.operation_id == request.operation_id && error.code == "agent_restarted"
        )),
        "{reports:?}"
    );
    assert!(world.repository.object(&request.archive_key).is_none());
    assert!(
        !world
            .staging()
            .join(format!("virtualbox-{}", request.operation_id))
            .exists()
    );
    operations.shutdown();
}

// Watching and control.

struct Watcher {
    monitor: Arc<VirtualBoxMonitor>,
    messages: mpsc::Receiver<Message>,
    stopping: CancelFlag,
}

impl Watcher {
    fn start(vbox: &Installation) -> Self {
        let (sender, messages) = mpsc::channel(256);
        let stopping = CancelFlag::new();
        let monitor = VirtualBoxMonitor::new(vbox.settings(), sender, stopping.clone());
        monitor.spawn();
        Self {
            monitor,
            messages,
            stopping,
        }
    }

    async fn next(&mut self, wanted: impl Fn(&Message) -> bool) -> Message {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let message = self.messages.recv().await.expect("open");
                if wanted(&message) {
                    return message;
                }
            }
        })
        .await
        .expect("timed out waiting for a message")
    }

    async fn states(&mut self, wanted: impl Fn(&VirtualBoxStates) -> bool) -> VirtualBoxStates {
        match self
            .next(|message| matches!(message, Message::AgentVirtualBoxStates(states) if wanted(states)))
            .await
        {
            Message::AgentVirtualBoxStates(states) => states,
            _ => unreachable!(),
        }
    }

    async fn control_result(&mut self) -> VirtualBoxControlResult {
        match self
            .next(|message| matches!(message, Message::AgentVirtualBoxControlResult(_)))
            .await
        {
            Message::AgentVirtualBoxControlResult(result) => result,
            _ => unreachable!(),
        }
    }

    fn watch(&self, machines: &[&str]) {
        self.monitor.watch(VirtualBoxWatch {
            machines: machines.iter().map(|machine| uuid(machine)).collect(),
        });
    }

    fn control(&self, machine: &str, action: VirtualBoxControlAction) -> Uuid {
        let session_id = Uuid::new_v4();
        self.monitor.control(VirtualBoxControl {
            session_id,
            machine_uuid: uuid(machine),
            action,
        });
        session_id
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stopping.cancel();
    }
}

fn state_of(states: &VirtualBoxStates, machine: &str) -> Option<VirtualBoxVmState> {
    states
        .machines
        .iter()
        .find(|observation| observation.machine_uuid == uuid(machine))
        .map(|observation| observation.state)
}

#[tokio::test]
async fn a_watch_is_answered_with_every_machine_and_a_missing_one_is_not_present() {
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    let mut watcher = Watcher::start(&vbox);
    let gone = "0f0f0f0f-0000-4000-8000-000000000001";
    watcher.watch(&[XENIX, gone]);
    let states = watcher.states(|states| states.complete).await;
    assert!(states.available);
    assert_eq!(states.machines.len(), 2);
    assert_eq!(
        state_of(&states, XENIX),
        Some(VirtualBoxVmState::PoweredOff)
    );
    let missing = states
        .machines
        .iter()
        .find(|observation| observation.machine_uuid == uuid(gone))
        .unwrap();
    assert!(!missing.present);
    // Only reads: list runningvms and showvminfo.
    for call in vbox.calls() {
        assert!(
            matches!(call[0].as_str(), "list" | "showvminfo"),
            "{call:?}"
        );
    }
}

#[tokio::test]
async fn start_and_acpi_shutdown_are_seen_by_observation() {
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XENIX]);
    watcher.states(|states| states.complete).await;

    let session = watcher.control(XENIX, VirtualBoxControlAction::Start);
    let result = watcher.control_result().await;
    assert!(result.accepted, "{result:?}");
    assert_eq!(result.session_id, session);
    assert_eq!(
        vbox.calls_of("startvm"),
        vec![vec![
            "startvm".to_owned(),
            XENIX.to_owned(),
            "--type".to_owned(),
            "gui".to_owned()
        ]]
    );
    watcher
        .states(|states| state_of(states, XENIX) == Some(VirtualBoxVmState::Running))
        .await;

    watcher.control(XENIX, VirtualBoxControlAction::AcpiShutdown);
    assert!(watcher.control_result().await.accepted);
    assert_eq!(
        vbox.calls_of("controlvm"),
        vec![vec![
            "controlvm".to_owned(),
            XENIX.to_owned(),
            "acpipowerbutton".to_owned()
        ]]
    );
    watcher
        .states(|states| state_of(states, XENIX) == Some(VirtualBoxVmState::PoweredOff))
        .await;
}

#[tokio::test]
async fn an_ignored_acpi_request_changes_nothing_and_a_poweroff_ends_the_machine() {
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF), ("ignore_acpi.txt", "")]);
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XENIX]);
    watcher.states(|states| states.complete).await;
    watcher.control(XENIX, VirtualBoxControlAction::Start);
    watcher.control_result().await;
    watcher
        .states(|states| state_of(states, XENIX) == Some(VirtualBoxVmState::Running))
        .await;

    // Accepted by VirtualBox, and still running: acceptance is not an observation.
    watcher.control(XENIX, VirtualBoxControlAction::AcpiShutdown);
    assert!(watcher.control_result().await.accepted);
    tokio::time::sleep(Duration::from_millis(600)).await;
    while let Ok(message) = watcher.messages.try_recv() {
        if let Message::AgentVirtualBoxStates(states) = message {
            assert_ne!(
                state_of(&states, XENIX),
                Some(VirtualBoxVmState::PoweredOff)
            );
        }
    }

    watcher.control(XENIX, VirtualBoxControlAction::Poweroff);
    assert!(watcher.control_result().await.accepted);
    assert!(
        vbox.calls_of("controlvm")
            .iter()
            .any(|call| call[2] == "poweroff")
    );
    watcher
        .states(|states| state_of(states, XENIX) == Some(VirtualBoxVmState::PoweredOff))
        .await;
}

#[tokio::test]
async fn a_start_outside_emucat_is_detected() {
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XENIX]);
    watcher.states(|states| states.complete).await;
    // Someone starts it in the VirtualBox Manager.
    vbox.write(
        &format!("{XENIX}.txt"),
        &POWEROFF.replace("VMState=\"poweroff\"", "VMState=\"running\""),
    );
    vbox.write("running.txt", &format!("\"Xenix 386\" {{{XENIX}}}\n"));
    let states = watcher
        .states(|states| state_of(states, XENIX) == Some(VirtualBoxVmState::Running))
        .await;
    assert!(!states.complete);
    assert!(vbox.calls_of("startvm").is_empty());
}

#[tokio::test]
async fn absence_from_runningvms_is_never_taken_for_powered_off() {
    // showvminfo says running, and runningvms lists nothing.
    let vbox = Installation::new(&[(&format!("{XP}.txt"), RUNNING)]);
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XP]);
    let states = watcher.states(|states| states.complete).await;
    assert_eq!(state_of(&states, XP), Some(VirtualBoxVmState::Running));
    tokio::time::sleep(Duration::from_millis(700)).await;
    while let Ok(message) = watcher.messages.try_recv() {
        if let Message::AgentVirtualBoxStates(states) = message {
            assert_eq!(
                state_of(&states, XP).unwrap_or(VirtualBoxVmState::Running),
                VirtualBoxVmState::Running
            );
        }
    }
}

#[tokio::test]
async fn only_a_watched_machine_can_be_controlled() {
    let vbox = Installation::new(&[
        (&format!("{XENIX}.txt"), POWEROFF),
        (&format!("{XP}.txt"), RUNNING),
    ]);
    let mut watcher = Watcher::start(&vbox);
    // Before any watch, nothing at all.
    watcher.control(XENIX, VirtualBoxControlAction::Start);
    let refused = watcher.control_result().await;
    assert!(!refused.accepted);
    assert_eq!(refused.code.as_deref(), Some("source_unavailable"));

    watcher.watch(&[XENIX]);
    watcher.states(|states| states.complete).await;
    watcher.control(XP, VirtualBoxControlAction::Poweroff);
    let refused = watcher.control_result().await;
    assert!(!refused.accepted);
    assert_eq!(refused.code.as_deref(), Some("source_unavailable"));
    assert!(vbox.calls_of("controlvm").is_empty());
    assert!(vbox.calls_of("startvm").is_empty());
}

#[tokio::test]
async fn a_refused_command_names_virtualbox_s_error_and_no_path() {
    let vbox = Installation::new(&[
        (&format!("{XENIX}.txt"), POWEROFF),
        ("refuse_control.txt", ""),
    ]);
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XENIX]);
    watcher.states(|states| states.complete).await;
    watcher.control(XENIX, VirtualBoxControlAction::Start);
    let refused = watcher.control_result().await;
    assert!(!refused.accepted);
    assert_eq!(refused.code.as_deref(), Some("control_refused"));
    let message = refused.message.unwrap();
    assert!(message.contains("VBOX_E_INVALID_VM_STATE"), "{message}");
    assert!(!message.contains("Users"), "{message}");
}

#[tokio::test]
async fn without_vboxmanage_nothing_is_known_and_nothing_is_listed() {
    let vbox = Installation::new(&[(&format!("{XENIX}.txt"), POWEROFF)]);
    fs::remove_file(&vbox.executable).unwrap();
    let mut watcher = Watcher::start(&vbox);
    watcher.watch(&[XENIX]);
    let states = watcher.states(|states| states.complete).await;
    assert!(!states.available);
    assert!(states.machines.is_empty());
}
