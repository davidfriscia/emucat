//! VirtualBox imports, deletions and screenshots (decision 0046), against `fake_vboxmanage` and a repository held in
//! memory. Nothing here runs the real VBoxManage, imports into or deletes from a real VirtualBox, or touches a real
//! machine.

mod support;

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::capture::CaptureAck;
use emucat_agent::emulators::VmName;
use emucat_agent::media_sync::ApiFailure;
use emucat_agent::packaging::hex;
use emucat_agent::protocol::{
    Message, RepositoryConfigSummary, VirtualBoxCaptureCommand, VirtualBoxDelete, VirtualBoxImport,
    VirtualBoxOperationAck, VirtualBoxOperationOutcome, VirtualBoxOperationPhase,
    VirtualBoxOperationResult, VirtualBoxWatch,
};
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use emucat_agent::virtualbox::{VirtualBoxConfig, VirtualBoxSettings, VirtualBoxVmState};
use emucat_agent::virtualbox_capture::CaptureUploader;
use emucat_agent::virtualbox_registration::archive_key;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x7777);
const POWEROFF: &str = include_str!("fixtures/virtualbox/showvminfo-poweroff.txt");
const RUNNING: &str = include_str!("fixtures/virtualbox/showvminfo-running.txt");
const XENIX: &str = "2acda0fc-cea6-406b-8a55-746fac380687";
const XP: &str = "97910566-2cc6-492b-9dc7-6cc6ee66ffd6";
/// What the fake gives an imported machine by default.
const IMPORTED: &str = "5b0a7f0e-91c4-4d8e-b0c2-0f5f8d0a1e11";
const OVA: &[u8] = b"an ova of xenix, as exported";

fn uuid(text: &str) -> Uuid {
    Uuid::parse_str(text).unwrap()
}

fn fake_vboxmanage() -> PathBuf {
    support::example("fake_vboxmanage")
}

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

    /// A VirtualBox with Xenix (powered off) and XP (running).
    fn standard() -> Self {
        Self::new(&[
            (
                "list.txt",
                &format!("\"Xenix 386\" {{{XENIX}}}\n\"Windows XP ITA SP3 (x86)\" {{{XP}}}\n"),
            ),
            (&format!("{XENIX}.txt"), POWEROFF),
            (&format!("{XP}.txt"), RUNNING),
            (
                "running.txt",
                &format!("\"Windows XP ITA SP3 (x86)\" {{{XP}}}\n"),
            ),
        ])
    }

    fn write(&self, name: &str, content: &str) {
        fs::write(self.directory.path().join(name), content).unwrap();
    }

    fn read(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.directory.path().join(name)).ok()
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
        settings.import_timeout = Duration::from_secs(20);
        settings.active_poll = Duration::from_millis(200);
        settings.inactive_poll = Duration::from_millis(400);
        settings.reconcile_poll = Duration::from_millis(50);
        settings.reconcile_window = Duration::from_secs(5);
        settings
    }
}

#[derive(Clone, Default)]
struct MemoryRepository {
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl MemoryRepository {
    fn put(&self, key: &str, bytes: &[u8]) {
        self.objects
            .lock()
            .unwrap()
            .insert(key.to_owned(), bytes.to_vec());
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.objects.lock().unwrap().get(key).cloned()
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
        _key: &'a RepositoryKey,
        _source: &'a Path,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move { unreachable!("an import never uploads") }.boxed()
    }

    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let object = self
                .object(key.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            assert!(!destination.exists(), "a download never overwrites");
            fs::write(destination, &object).unwrap();
            progress(object.len() as u64, object.len() as u64);
            Ok(VerifiedObject {
                size_bytes: object.len() as u64,
                sha256: hex(&Sha256::digest(&object)),
            })
        }
        .boxed()
    }

    fn verify<'a>(
        &'a self,
        _key: &'a RepositoryKey,
        _expected_size: u64,
        _expected_sha256: &'a str,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { unreachable!("an import never verifies a remote object") }.boxed()
    }

    fn publish<'a>(
        &'a self,
        _staging: &'a RepositoryKey,
        _final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { unreachable!("an import never publishes") }.boxed()
    }

    fn delete<'a>(&'a self, _key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { unreachable!("nothing here deletes an archive") }.boxed()
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
        1
    }
}

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
        fs::create_dir_all(self.state()).unwrap();
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

    /// An import of an OVA the repository holds, with the size and SHA-256 it really has.
    fn import(&self, target_name: &str) -> VirtualBoxImport {
        let vm_name = VmName::new("xenix-386").unwrap();
        let version_id = Uuid::new_v4();
        let key = archive_key(&vm_name, version_id);
        self.repository.put(&key, OVA);
        VirtualBoxImport {
            operation_id: Uuid::new_v4(),
            vm_name,
            version_id,
            repository_id: REPOSITORY,
            archive_key: key,
            archive_size_bytes: OVA.len() as u64,
            archive_sha256: hex(&Sha256::digest(OVA)),
            target_name: target_name.to_owned(),
        }
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

async fn result_of(operations: &AgentOperations, operation_id: Uuid) -> VirtualBoxOperationResult {
    match next_message(operations, |message| {
        matches!(message, Message::AgentVirtualBoxOperationResult(result) if result.operation_id == operation_id)
    })
    .await
    {
        Message::AgentVirtualBoxOperationResult(result) => result,
        _ => unreachable!(),
    }
}

fn imports(vbox: &Installation) -> (usize, usize) {
    let calls = vbox.calls_of("import");
    let dry = calls
        .iter()
        .filter(|call| call.iter().any(|argument| argument == "--dry-run"))
        .count();
    (dry, calls.len() - dry)
}

// Imports.

#[tokio::test]
async fn imports_a_verified_ova_and_finds_the_new_machine_by_comparing_lists() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));
    let sync = operations.sync_messages();
    assert!(sync.iter().any(|message| matches!(
        message,
        Message::AgentRegistrationSync(sync) if sync.virtualbox && sync.virtualbox_management
    )));

    let request = world.import("Xenix 386 (copy)");
    operations.handle(Message::ServerVirtualBoxImport(request.clone()));
    let result = result_of(&operations, request.operation_id).await;
    assert_eq!(
        result.outcome,
        VirtualBoxOperationOutcome::Succeeded,
        "{result:?}"
    );
    let machine = result.machine.expect("the new machine");
    assert_eq!(machine.uuid, uuid(IMPORTED));
    assert_eq!(machine.name, "Xenix 386 (copy)");
    assert_eq!(machine.state, VirtualBoxVmState::PoweredOff);
    assert!(result.stray_machines.is_empty());

    // A dry run, then the import, of the downloaded file, with the requested name and nothing else.
    let ova = world
        .staging()
        .join(format!("virtualbox-import-{}", request.operation_id))
        .join(format!("{}.ova", request.operation_id));
    let calls = vbox.calls_of("import");
    assert_eq!(
        calls,
        vec![
            vec![
                "import".to_owned(),
                ova.display().to_string(),
                "--dry-run".to_owned(),
                "--vsys=0".to_owned(),
                "--vmname=Xenix 386 (copy)".to_owned(),
            ],
            vec![
                "import".to_owned(),
                ova.display().to_string(),
                "--vsys=0".to_owned(),
                "--vmname=Xenix 386 (copy)".to_owned(),
            ],
        ]
    );
    // Nothing else was touched, and the download is gone.
    assert!(vbox.calls_of("unregistervm").is_empty());
    assert!(vbox.read(&format!("{XENIX}.txt")).is_some());
    assert!(!ova.exists());
    assert!(!ova.parent().unwrap().exists());

    // Reported until answered; then forgotten.
    assert!(operations.pending_reports().iter().any(|message| matches!(
        message,
        Message::AgentVirtualBoxOperationResult(reported) if reported.operation_id == request.operation_id
    )));
    let entries = sync_entries(&operations);
    assert_eq!(
        entries,
        vec![(request.operation_id, VirtualBoxOperationPhase::Reported)]
    );
    operations.handle(Message::ServerVirtualBoxOperationAck(
        VirtualBoxOperationAck {
            operation_id: request.operation_id,
        },
    ));
    assert!(sync_entries(&operations).is_empty());

    // A repeated command after that is a new journal only if the server sends a new operation.
    operations.handle(Message::ServerVirtualBoxImport(request.clone()));
    let again = result_of(&operations, request.operation_id).await;
    assert_eq!(again.code.as_deref(), Some("target_name_in_use"));
    assert_eq!(imports(&vbox), (1, 1));
}

fn sync_entries(operations: &AgentOperations) -> Vec<(Uuid, VirtualBoxOperationPhase)> {
    operations
        .sync_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::AgentRegistrationSync(sync) => Some(
                sync.virtualbox_operations
                    .into_iter()
                    .map(|entry| (entry.operation_id, entry.phase))
                    .collect(),
            ),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn refuses_before_importing_when_the_ova_or_the_name_is_wrong() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));

    let mut tampered = world.import("Fresh name");
    tampered.archive_sha256 = "0".repeat(64);
    operations.handle(Message::ServerVirtualBoxImport(tampered.clone()));
    let result = result_of(&operations, tampered.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Failed);
    assert_eq!(result.code.as_deref(), Some("hash_mismatch"));

    let taken = world.import("xenix 386");
    operations.handle(Message::ServerVirtualBoxImport(taken.clone()));
    assert_eq!(
        result_of(&operations, taken.operation_id)
            .await
            .code
            .as_deref(),
        Some("target_name_in_use")
    );

    let invalid = world.import("-option");
    operations.handle(Message::ServerVirtualBoxImport(invalid.clone()));
    assert_eq!(
        result_of(&operations, invalid.operation_id)
            .await
            .code
            .as_deref(),
        Some("invalid_target_name")
    );

    let mut wrong_key = world.import("Another");
    wrong_key.archive_key = "archives/qemu/xenix-386/x.zip".to_owned();
    operations.handle(Message::ServerVirtualBoxImport(wrong_key.clone()));
    assert_eq!(
        result_of(&operations, wrong_key.operation_id)
            .await
            .code
            .as_deref(),
        Some("invalid_request")
    );

    vbox.write("import_dry_fail.txt", "");
    let unreadable = world.import("Unreadable");
    operations.handle(Message::ServerVirtualBoxImport(unreadable.clone()));
    assert_eq!(
        result_of(&operations, unreadable.operation_id)
            .await
            .code
            .as_deref(),
        Some("dry_run_failed")
    );
    // Only the dry run ever ran: VirtualBox never imported anything.
    assert_eq!(imports(&vbox), (1, 0));
}

#[tokio::test]
async fn reports_machines_it_cannot_attribute_and_never_removes_them() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));

    vbox.write(
        "import_extra.txt",
        "\"Someone else's\" {11111111-2222-4333-8444-555555555555}",
    );
    let ambiguous = world.import("Xenix copy");
    operations.handle(Message::ServerVirtualBoxImport(ambiguous.clone()));
    let result = result_of(&operations, ambiguous.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Uncertain);
    assert_eq!(result.code.as_deref(), Some("import_ambiguous"));
    assert!(result.machine.is_none());
    let mut strays: Vec<Uuid> = result.stray_machines.iter().map(|m| m.uuid).collect();
    strays.sort();
    assert_eq!(
        strays,
        vec![uuid("11111111-2222-4333-8444-555555555555"), uuid(IMPORTED)]
    );

    fs::remove_file(vbox.directory.path().join("import_extra.txt")).unwrap();
    vbox.write("import_fail_after.txt", "");
    vbox.write("import_uuid.txt", "66666666-7777-4888-9999-000000000000");
    let half = world.import("Half done");
    operations.handle(Message::ServerVirtualBoxImport(half.clone()));
    let result = result_of(&operations, half.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Uncertain);
    assert_eq!(
        result
            .stray_machines
            .iter()
            .map(|m| m.uuid)
            .collect::<Vec<_>>(),
        vec![uuid("66666666-7777-4888-9999-000000000000")]
    );

    fs::remove_file(vbox.directory.path().join("import_fail_after.txt")).unwrap();
    vbox.write("import_fail.txt", "");
    let failed = world.import("Not created");
    operations.handle(Message::ServerVirtualBoxImport(failed.clone()));
    let result = result_of(&operations, failed.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Failed);
    assert_eq!(result.code.as_deref(), Some("import_failed"));

    // Whatever happened, nothing was deleted.
    assert!(vbox.calls_of("unregistervm").is_empty());
}

#[tokio::test]
async fn a_restart_during_an_import_is_reconciled_and_never_imports_again() {
    let world = World::new();
    let vbox = Installation::standard();
    vbox.write("import_sleep_ms.txt", "1500");
    let first = world.start(Some(vbox.settings()));
    let request = world.import("Slow import");
    first.handle(Message::ServerVirtualBoxImport(request.clone()));
    // Wait until VirtualBox has been asked to import.
    tokio::time::timeout(Duration::from_secs(20), async {
        while imports(&vbox).1 == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    // Another process on the same state, as after a crash: the import may still be under way.
    let second = world.start(Some(vbox.settings()));
    let result = result_of(&second, request.operation_id).await;
    assert_eq!(
        result.outcome,
        VirtualBoxOperationOutcome::Uncertain,
        "{result:?}"
    );
    assert_eq!(result.code.as_deref(), Some("agent_restarted"));
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert_eq!(imports(&vbox), (1, 1), "never imported twice");
    first.shutdown();
}

#[tokio::test]
async fn refuses_everything_without_virtualbox_and_says_so() {
    let world = World::new();
    let operations = world.start(None);
    assert!(operations.sync_messages().iter().any(|message| matches!(
        message,
        Message::AgentRegistrationSync(sync) if !sync.virtualbox && !sync.virtualbox_management
    )));
    let request = world.import("Anything");
    operations.handle(Message::ServerVirtualBoxImport(request.clone()));
    assert_eq!(
        result_of(&operations, request.operation_id)
            .await
            .code
            .as_deref(),
        Some("virtualbox_unavailable")
    );
}

// Deletions.

fn delete(machine: &str, name: &str) -> VirtualBoxDelete {
    VirtualBoxDelete {
        operation_id: Uuid::new_v4(),
        machine_uuid: uuid(machine),
        machine_name: name.to_owned(),
    }
}

#[tokio::test]
async fn deletes_exactly_the_named_powered_off_machine_by_uuid() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));
    let request = delete(XENIX, "Xenix 386");
    operations.handle(Message::ServerVirtualBoxDelete(request.clone()));
    let result = result_of(&operations, request.operation_id).await;
    assert_eq!(
        result.outcome,
        VirtualBoxOperationOutcome::Succeeded,
        "{result:?}"
    );
    assert_eq!(result.files_removed, Some(true));
    assert_eq!(
        vbox.calls_of("unregistervm"),
        vec![vec![
            "unregistervm".to_owned(),
            XENIX.to_owned(),
            "--delete".to_owned()
        ]]
    );
    assert_eq!(vbox.read("deleted.txt").unwrap().trim(), XENIX);
    // The other machine is untouched.
    assert!(vbox.read(&format!("{XP}.txt")).is_some());
}

#[tokio::test]
async fn deletes_nothing_when_the_machine_is_not_what_was_confirmed() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));

    for (request, code) in [
        (delete(XENIX, "xenix 386"), "machine_name_mismatch"),
        (
            delete(XP, "Windows XP ITA SP3 (x86)"),
            "machine_not_powered_off",
        ),
        (
            delete("00000000-0000-4000-8000-000000000001", "Gone"),
            "machine_missing",
        ),
    ] {
        operations.handle(Message::ServerVirtualBoxDelete(request.clone()));
        let result = result_of(&operations, request.operation_id).await;
        assert_eq!(result.outcome, VirtualBoxOperationOutcome::Failed);
        assert_eq!(result.code.as_deref(), Some(code));
        operations.handle(Message::ServerVirtualBoxOperationAck(
            VirtualBoxOperationAck {
                operation_id: request.operation_id,
            },
        ));
    }
    assert!(vbox.calls_of("unregistervm").is_empty());
}

#[tokio::test]
async fn reports_a_failed_or_unconfirmed_deletion_without_repeating_it() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));

    vbox.write("delete_fail.txt", "");
    let refused = delete(XENIX, "Xenix 386");
    operations.handle(Message::ServerVirtualBoxDelete(refused.clone()));
    let result = result_of(&operations, refused.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Failed);
    assert_eq!(result.code.as_deref(), Some("delete_failed"));
    operations.handle(Message::ServerVirtualBoxOperationAck(
        VirtualBoxOperationAck {
            operation_id: refused.operation_id,
        },
    ));

    fs::remove_file(vbox.directory.path().join("delete_fail.txt")).unwrap();
    vbox.write("delete_keep.txt", "");
    let unconfirmed = delete(XENIX, "Xenix 386");
    operations.handle(Message::ServerVirtualBoxDelete(unconfirmed.clone()));
    let result = result_of(&operations, unconfirmed.operation_id).await;
    assert_eq!(result.outcome, VirtualBoxOperationOutcome::Uncertain);
    assert_eq!(result.code.as_deref(), Some("delete_unconfirmed"));
    // One command per operation, whatever came of it.
    assert_eq!(vbox.calls_of("unregistervm").len(), 2);
    // A repeated command for the same operation runs nothing.
    operations.handle(Message::ServerVirtualBoxDelete(unconfirmed.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(vbox.calls_of("unregistervm").len(), 2);
}

// Screenshots.

/// What was uploaded: the VM, the capture, the SHA-256 and the bytes.
type Upload = (String, Uuid, String, Vec<u8>);

#[derive(Default)]
struct RecordingUploader {
    uploads: Mutex<Vec<Upload>>,
}

impl CaptureUploader for RecordingUploader {
    fn upload<'a>(
        &'a self,
        vm_name: &'a VmName,
        capture_id: Uuid,
        sha256: &'a str,
        file: &'a Path,
    ) -> BoxFuture<'a, Result<(), ApiFailure>> {
        async move {
            let bytes = fs::read(file).unwrap();
            self.uploads.lock().unwrap().push((
                vm_name.as_str().to_owned(),
                capture_id,
                sha256.to_owned(),
                bytes,
            ));
            Ok(())
        }
        .boxed()
    }
}

fn capture(machine: &str) -> VirtualBoxCaptureCommand {
    VirtualBoxCaptureCommand {
        operation_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
        vm_name: VmName::new("windows-xp").unwrap(),
        machine_uuid: uuid(machine),
    }
}

async fn capture_report(
    operations: &AgentOperations,
    operation_id: Uuid,
    state: &str,
) -> emucat_agent::protocol::VirtualBoxCaptureReport {
    match next_message(operations, |message| {
        matches!(message, Message::AgentVirtualBoxCapture(report)
            if report.request.operation_id == operation_id && report.state == state)
    })
    .await
    {
        Message::AgentVirtualBoxCapture(report) => report,
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn captures_a_watched_running_machine_and_uploads_the_png_under_the_vm() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));
    let uploader = Arc::new(RecordingUploader::default());
    operations.set_capture_uploader(uploader.clone());
    operations.handle(Message::ServerVirtualBoxWatch(VirtualBoxWatch {
        machines: vec![uuid(XP), uuid(XENIX)],
    }));

    let request = capture(XP);
    operations.handle(Message::ServerVirtualBoxCapture(request.clone()));
    capture_report(&operations, request.operation_id, "capturing").await;
    let uploading = capture_report(&operations, request.operation_id, "uploading").await;
    let sha256 = uploading.sha256.clone().expect("hashed");

    // The image goes to the catalog VM, labelled by the capture, and its bytes are what VirtualBox wrote.
    tokio::time::timeout(Duration::from_secs(10), async {
        while uploader.uploads.lock().unwrap().is_empty() {
            operations.pending_reports();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let (vm, id, uploaded_sha, bytes) = uploader.uploads.lock().unwrap()[0].clone();
    assert_eq!(vm, "windows-xp");
    assert_eq!(id, request.operation_id);
    assert_eq!(uploaded_sha, sha256);
    assert_eq!(hex(&Sha256::digest(&bytes)), sha256);
    assert!(bytes.starts_with(b"\x89PNG"));
    let screenshot = vbox.calls_of("controlvm");
    assert_eq!(screenshot.len(), 1);
    assert_eq!(&screenshot[0][..3], ["controlvm", XP, "screenshotpng"]);
    assert!(screenshot[0][3].ends_with("pending.png"));

    // Confirmed: the spool copy goes, and nothing is reported any more.
    operations.handle(Message::ServerQemuCaptureAck(CaptureAck {
        operation_id: request.operation_id,
        sha256: sha256.clone(),
        media_id: Uuid::new_v4(),
    }));
    let ready = world
        .state()
        .join("virtualbox-captures")
        .join(request.operation_id.to_string())
        .join("ready.png");
    tokio::time::timeout(Duration::from_secs(10), async {
        while ready.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!operations.pending_reports().iter().any(|message| matches!(
        message,
        Message::AgentVirtualBoxCapture(report) if report.request.operation_id == request.operation_id
    )));
    // A repeated command never captures again.
    operations.handle(Message::ServerVirtualBoxCapture(request.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(vbox.calls_of("controlvm").len(), 1);
}

#[tokio::test]
async fn refuses_a_machine_that_is_not_watched_or_not_running_and_a_file_that_is_not_a_png() {
    let world = World::new();
    let vbox = Installation::standard();
    let operations = world.start(Some(vbox.settings()));
    operations.set_capture_uploader(Arc::new(RecordingUploader::default()));
    operations.handle(Message::ServerVirtualBoxWatch(VirtualBoxWatch {
        machines: vec![uuid(XENIX)],
    }));

    let unwatched = capture(XP);
    operations.handle(Message::ServerVirtualBoxCapture(unwatched.clone()));
    let report = capture_report(&operations, unwatched.operation_id, "failed").await;
    assert_eq!(report.code.as_deref(), Some("machine_not_linked"));

    let stopped = capture(XENIX);
    operations.handle(Message::ServerVirtualBoxCapture(stopped.clone()));
    let report = capture_report(&operations, stopped.operation_id, "failed").await;
    assert_eq!(report.code.as_deref(), Some("machine_not_running"));
    assert!(vbox.calls_of("controlvm").is_empty());

    operations.handle(Message::ServerVirtualBoxWatch(VirtualBoxWatch {
        machines: vec![uuid(XP)],
    }));
    vbox.write("screenshot_garbage.txt", "not a png at all");
    let garbage = capture(XP);
    operations.handle(Message::ServerVirtualBoxCapture(garbage.clone()));
    let report = capture_report(&operations, garbage.operation_id, "failed").await;
    assert_eq!(report.code.as_deref(), Some("capture_failed"));
    assert!(report.sha256.is_none());
}
