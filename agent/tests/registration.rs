//! The registration workflow against a repository held in memory, whose failures can be chosen. The
//! same workflow against a real SFTP server and a real API is in `apps/api/e2e`.
//!
//! The rule under test throughout: nothing but an explicit, matching acknowledgement of a transfer can
//! ever remove a local file. Every destructive test uses a disposable temporary directory.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::archives::VersionId;
use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::packaging::{MANIFEST_ENTRY_NAME, hex, read_manifest};
use emucat_agent::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCancel, RegistrationMode,
    RegistrationPhase, RegistrationRequest, RegistrationResult, RegistrationStage,
    RepositoryConfigSummary,
};
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::removal::quarantine_path;
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use emucat_agent::state::read_local_state;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x7777);

#[derive(Default)]
struct Store {
    objects: HashMap<String, Vec<u8>>,
    uploads: u32,
    /// Failures to produce, in order, by operation name.
    failures: HashMap<&'static str, Vec<RepositoryError>>,
    /// Corrupts what is stored, once, right after an upload.
    corrupt_next_upload: bool,
    publishes: u32,
    /// Blocks an upload until released, so that a test can act while it is running.
    hold_upload: Option<Arc<tokio::sync::Notify>>,
}

#[derive(Clone, Default)]
struct MemoryRepository {
    store: Arc<Mutex<Store>>,
}

impl MemoryRepository {
    fn fail(&self, operation: &'static str, error: RepositoryError) {
        self.store
            .lock()
            .unwrap()
            .failures
            .entry(operation)
            .or_default()
            .push(error);
    }

    fn take_failure(&self, operation: &'static str) -> RepositoryResult<()> {
        let mut store = self.store.lock().unwrap();
        match store.failures.get_mut(operation) {
            Some(errors) if !errors.is_empty() => Err(errors.remove(0)),
            _ => Ok(()),
        }
    }

    fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.store.lock().unwrap().objects.keys().cloned().collect();
        keys.sort();
        keys
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.store.lock().unwrap().objects.get(key).cloned()
    }
}

impl ArchiveRepository for MemoryRepository {
    fn health_check<'a>(
        &'a self,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move {
            self.take_failure("health")?;
            Ok(HealthReport {
                host_key_fingerprint: Some("SHA256:test".to_owned()),
                root_readable: true,
                root_writable: true,
                no_overwrite_publication: true,
                free_bytes: Some(1234),
            })
        }
        .boxed()
    }

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        async move {
            self.take_failure("stat")?;
            Ok(self.object(key.as_str()).map(|object| ObjectMetadata {
                size_bytes: object.len() as u64,
            }))
        }
        .boxed()
    }

    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        async move {
            self.take_failure("free_space")?;
            Ok(None)
        }
        .boxed()
    }

    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move {
            assert!(key.is_staging(), "uploads only ever go to staging");
            let hold = self.store.lock().unwrap().hold_upload.clone();
            if let Some(hold) = hold {
                tokio::select! {
                    () = hold.notified() => {}
                    () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                }
            }
            self.take_failure("upload")?;
            let mut bytes = fs::read(source).unwrap();
            let size = bytes.len() as u64;
            let mut store = self.store.lock().unwrap();
            store.uploads += 1;
            if store.corrupt_next_upload {
                store.corrupt_next_upload = false;
                bytes[0] ^= 0xff;
            }
            store.objects.insert(key.as_str().to_owned(), bytes);
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
            self.take_failure("verify")?;
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
            self.take_failure("publish")?;
            let mut store = self.store.lock().unwrap();
            store.publishes += 1;
            if store.objects.contains_key(final_key.as_str()) {
                return Err(RepositoryError::new(Kind::AlreadyExists, "exists"));
            }
            let object = store
                .objects
                .remove(staging.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            store.objects.insert(final_key.as_str().to_owned(), object);
            Ok(())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            self.store.lock().unwrap().objects.remove(key.as_str());
            Ok(())
        }
        .boxed()
    }
}

struct Provider {
    repository: MemoryRepository,
    attempts: u32,
}

impl RepositoryProvider for Provider {
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
        self.attempts
    }
}

struct World {
    _directory: TempDir,
    state: PathBuf,
    staging: PathBuf,
    qemu: PathBuf,
    box86: PathBuf,
    repository: MemoryRepository,
    attempts: u32,
}

impl World {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let qemu = directory.path().join("qemu");
        let box86 = directory.path().join("86box");
        fs::create_dir(&qemu).unwrap();
        fs::create_dir(&box86).unwrap();
        Self {
            state: directory.path().join("state"),
            staging: directory.path().join("staging"),
            _directory: directory,
            qemu,
            box86,
            repository: MemoryRepository::default(),
            attempts: 2,
        }
    }

    fn start(&self) -> Arc<AgentOperations> {
        let emulators: BTreeMap<EmulatorType, EmulatorConfig> = [
            (
                EmulatorType::Qemu,
                EmulatorConfig {
                    base_path: self.qemu.clone(),
                    executable: PathBuf::from("unused"),
                },
            ),
            (
                EmulatorType::Box86,
                EmulatorConfig {
                    base_path: self.box86.clone(),
                    executable: PathBuf::from("unused"),
                },
            ),
        ]
        .into();
        AgentOperations::load(OperationsConfig {
            agent_id: Uuid::from_u128(1),
            state_dir: self.state.clone(),
            staging_dir: self.staging.clone(),
            emulators: Arc::new(emulators),
            repositories: Arc::new(Provider {
                repository: self.repository.clone(),
                attempts: self.attempts,
            }),
            retry_delay: Duration::from_millis(1),
        })
        .unwrap()
    }

    fn qemu_vm(&self, name: &str) -> PathBuf {
        let root = self.qemu.join(name);
        fs::create_dir(&root).unwrap();
        fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
        fs::write(root.join("disk.qcow2"), vec![9u8; 200 * 1024]).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        root
    }
}

fn request(name: &str, mode: RegistrationMode) -> RegistrationRequest {
    let vm_name = VmName::new(name).unwrap();
    let version_id = Uuid::new_v4();
    let identity = VmIdentity {
        emulator_type: EmulatorType::Qemu,
        vm_name: vm_name.clone(),
    };
    RegistrationRequest {
        operation_id: Uuid::new_v4(),
        emulator_type: EmulatorType::Qemu,
        vm_name,
        mode,
        repository_id: REPOSITORY,
        version_id,
        archive_key: RepositoryKey::for_version(&identity, VersionId(version_id))
            .as_str()
            .to_owned(),
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

async fn result_of(operations: &AgentOperations) -> RegistrationResult {
    let message = next_message(operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationResult(_) | Message::AgentRegistrationError(_)
        )
    })
    .await;
    match message {
        Message::AgentRegistrationResult(result) => result,
        Message::AgentRegistrationError(error) => panic!("failed: {error:?}"),
        _ => unreachable!(),
    }
}

async fn failure_of(operations: &AgentOperations) -> (String, String) {
    match next_message(operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationResult(_) | Message::AgentRegistrationError(_)
        )
    })
    .await
    {
        Message::AgentRegistrationError(error) => (error.code, error.message),
        Message::AgentRegistrationResult(result) => panic!("unexpected success: {result:?}"),
        _ => unreachable!(),
    }
}

async fn cleanup_of(operations: &AgentOperations) -> emucat_agent::protocol::RegistrationCleanup {
    match next_message(operations, |message| {
        matches!(message, Message::AgentRegistrationCleanup(_))
    })
    .await
    {
        Message::AgentRegistrationCleanup(report) => report,
        _ => unreachable!(),
    }
}

fn start(operations: &AgentOperations, request: &RegistrationRequest) {
    operations.handle(Message::ServerRegistrationRequest(request.clone()));
}

fn committed(request: &RegistrationRequest, remove_local: bool) -> Message {
    Message::ServerRegistrationAck(RegistrationAck {
        operation_id: request.operation_id,
        outcome: AckOutcome::Committed,
        version_id: Some(request.version_id),
        remove_local,
        delete_published: false,
    })
}

fn closed(request: &RegistrationRequest) -> Message {
    Message::ServerRegistrationAck(RegistrationAck {
        operation_id: request.operation_id,
        outcome: AckOutcome::Closed,
        version_id: None,
        remove_local: false,
        delete_published: false,
    })
}

fn rejected(request: &RegistrationRequest, delete_published: bool) -> Message {
    Message::ServerRegistrationAck(RegistrationAck {
        operation_id: request.operation_id,
        outcome: AckOutcome::Rejected,
        version_id: None,
        remove_local: false,
        delete_published,
    })
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn a_copy_publishes_a_verified_archive_and_keeps_the_source() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let before = fs::read(root.join("disk.qcow2")).unwrap();
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);

    let result = result_of(&operations).await;
    assert_eq!(result.archive_key, copy.archive_key);
    assert_eq!(result.version_id, copy.version_id);
    assert_eq!(result.file_count, 2);
    assert_eq!(world.repository.keys(), vec![copy.archive_key.clone()]);
    let stored = world.repository.object(&copy.archive_key).unwrap();
    assert_eq!(stored.len() as u64, result.archive_size_bytes);
    assert_eq!(hex(&Sha256::digest(&stored)), result.archive_sha256);

    // Nothing has happened to the source, and nothing is left in staging.
    assert_eq!(fs::read(root.join("disk.qcow2")).unwrap(), before);
    assert_eq!(fs::read_dir(&world.staging).unwrap().count(), 0);

    // Until the server answers, this report keeps being offered.
    assert!(operations.pending_reports().iter().any(|message| matches!(
        message,
        Message::AgentRegistrationResult(pending) if pending == &result
    )));

    operations.handle(committed(&copy, false));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    assert!(root.join("disk.qcow2").exists());

    let local = read_local_state(
        &world.state,
        EmulatorType::Qemu,
        &VmName::new("Win98").unwrap(),
    )
    .unwrap();
    assert_eq!(
        local.local_source_version_id.map(|version| version.0),
        Some(copy.version_id)
    );

    operations.handle(closed(&copy));
    assert!(operations.open_operations().is_empty());
    assert!(operations.pending_reports().is_empty());
}

#[tokio::test]
async fn the_archive_in_the_repository_is_a_complete_standalone_zip() {
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    result_of(&operations).await;

    let local = TempDir::new().unwrap();
    let path = local.path().join("archive.zip");
    fs::write(&path, world.repository.object(&copy.archive_key).unwrap()).unwrap();
    let manifest = read_manifest(&path).unwrap();
    assert_eq!(manifest.vm_name, "Win98");
    let archive = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    let names: Vec<&str> = archive.file_names().collect();
    for name in ["run.bat", "disk.qcow2", "empty/", MANIFEST_ENTRY_NAME] {
        assert!(names.contains(&name), "{name} is missing from {names:?}");
    }
}

#[tokio::test]
async fn a_transfer_removes_the_source_only_after_a_matching_acknowledgement() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    let result = result_of(&operations).await;

    settle().await;
    assert!(root.exists(), "publication alone must not delete anything");

    // An acknowledgement for another version is not an acknowledgement of this one.
    operations.handle(Message::ServerRegistrationAck(RegistrationAck {
        operation_id: transfer.operation_id,
        outcome: AckOutcome::Committed,
        version_id: Some(Uuid::new_v4()),
        remove_local: true,
        delete_published: false,
    }));
    settle().await;
    assert!(root.exists());

    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
    assert!(!root.exists());
    assert!(!quarantine_path(&world.qemu, transfer.operation_id).exists());
    assert!(world.repository.object(&result.archive_key).is_some());
    operations.handle(closed(&transfer));
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_server_saying_remove_cannot_turn_a_copy_into_a_deletion() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    result_of(&operations).await;
    operations.handle(committed(&copy, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    assert!(root.exists());
}

#[tokio::test]
async fn a_transfer_with_screenshots_is_blocked_before_anything_is_uploaded() {
    let world = World::new();
    let root = world.box86.join("Box");
    fs::create_dir_all(root.join("screenshots")).unwrap();
    fs::write(root.join("86box.cfg"), b"x").unwrap();
    fs::write(root.join("screenshots/one.png"), b"keep me").unwrap();
    let operations = world.start();
    let vm_name = VmName::new("Box").unwrap();
    let version_id = Uuid::new_v4();
    let transfer = RegistrationRequest {
        operation_id: Uuid::new_v4(),
        emulator_type: EmulatorType::Box86,
        vm_name: vm_name.clone(),
        mode: RegistrationMode::Transfer,
        repository_id: REPOSITORY,
        version_id,
        archive_key: RepositoryKey::for_version(
            &VmIdentity {
                emulator_type: EmulatorType::Box86,
                vm_name,
            },
            VersionId(version_id),
        )
        .as_str()
        .to_owned(),
    };
    start(&operations, &transfer);
    let (code, message) = failure_of(&operations).await;
    assert_eq!(code, "transfer_blocked_media");
    assert!(message.contains("screenshot"), "{message}");
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.repository.store.lock().unwrap().uploads, 0);
    assert_eq!(
        fs::read(root.join("screenshots/one.png")).unwrap(),
        b"keep me"
    );
}

/// Everything that must stop a commit from deleting the source, applied just after publication.
async fn transfer_and_change(
    change: impl FnOnce(&Path),
) -> (World, PathBuf, emucat_agent::protocol::RegistrationCleanup) {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    change(&root);
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    (world, root, cleanup)
}

#[tokio::test]
async fn a_source_changed_after_archiving_is_kept() {
    let (_world, root, cleanup) = transfer_and_change(|root| {
        fs::write(root.join("disk.qcow2"), vec![1u8; 200 * 1024]).unwrap();
    })
    .await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_content_changed"));
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_new_file_that_is_not_in_the_archive_is_kept() {
    let (_world, root, cleanup) = transfer_and_change(|root| {
        fs::write(root.join("notes.txt"), b"written after archiving").unwrap();
    })
    .await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_content_changed"));
    assert_eq!(
        fs::read(root.join("notes.txt")).unwrap(),
        b"written after archiving"
    );
}

#[tokio::test]
async fn a_screenshot_taken_after_archiving_is_never_deleted() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    fs::write(root.join("capture.ppm"), b"P6 taken later").unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    assert_eq!(
        fs::read(root.join("capture.ppm")).unwrap(),
        b"P6 taken later"
    );
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_replaced_directory_is_not_the_one_that_was_archived() {
    let (_world, root, cleanup) = transfer_and_change(|root| {
        // The same name and the same contents, but another directory.
        let contents = fs::read(root.join("disk.qcow2")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::create_dir(root).unwrap();
        fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
        fs::write(root.join("disk.qcow2"), contents).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
    })
    .await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_identity_mismatch"));
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn an_archive_that_cannot_be_reverified_keeps_the_source() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    world.repository.fail(
        "verify",
        RepositoryError::new(Kind::Unreachable, "the repository went away"),
    );
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("repository_unreachable"));
    assert!(root.join("disk.qcow2").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn a_file_in_use_keeps_the_source() {
    let world = World::new();
    let root = world.qemu_vm("Running");
    let operations = world.start();
    let transfer = request("Running", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("disk.qcow2"))
        .unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    drop(held);
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_in_use"));
    assert!(root.join("disk.qcow2").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn a_junction_that_appeared_after_archiving_keeps_the_source_and_is_not_followed() {
    let outside = TempDir::new().unwrap();
    let precious = outside.path().join("precious.txt");
    fs::write(&precious, b"outside the VM").unwrap();
    let target = outside.path().to_path_buf();
    let (_world, root, cleanup) = transfer_and_change(|root| {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("linked"))
            .arg(&target)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    })
    .await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_unsafe"));
    assert!(root.join("disk.qcow2").exists());
    assert_eq!(fs::read(precious).unwrap(), b"outside the VM");
}

#[cfg(windows)]
#[tokio::test]
async fn a_vm_replaced_by_a_junction_is_not_removed_and_its_target_is_untouched() {
    let outside = TempDir::new().unwrap();
    let target = outside.path().to_path_buf();
    fs::write(target.join("run.bat"), b"@echo never run\n").unwrap();
    let (_world, root, cleanup) = transfer_and_change(|root| {
        fs::remove_dir_all(root).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root)
            .arg(&target)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    })
    .await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_unsafe"));
    assert!(root.exists());
    assert!(target.join("run.bat").exists());
}

#[tokio::test]
async fn a_vm_that_is_already_gone_is_reported_and_nothing_else_is_touched() {
    let (world, root, cleanup) = transfer_and_change(|root| {
        fs::remove_dir_all(root).unwrap();
    })
    .await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_identity_mismatch"));
    assert!(!root.exists());
    assert_eq!(fs::read_dir(&world.qemu).unwrap().count(), 0);
}

#[tokio::test]
async fn a_failed_upload_keeps_the_source_and_cleans_up() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    world
        .repository
        .fail("upload", RepositoryError::new(Kind::PermissionDenied, "no"));
    let operations = world.start();
    let transfer = request("Win98", RegistrationMode::Transfer);
    start(&operations, &transfer);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "repository_permission_denied");
    assert!(root.join("disk.qcow2").exists());
    assert!(world.repository.keys().is_empty());
    assert_eq!(fs::read_dir(&world.staging).unwrap().count(), 0);
}

#[tokio::test]
async fn a_hash_mismatch_is_retried_and_only_a_verified_object_is_published() {
    let world = World::new();
    world.qemu_vm("Win98");
    world.repository.store.lock().unwrap().corrupt_next_upload = true;
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    let result = result_of(&operations).await;
    assert_eq!(world.repository.store.lock().unwrap().uploads, 2);
    let stored = world.repository.object(&copy.archive_key).unwrap();
    assert_eq!(hex(&Sha256::digest(&stored)), result.archive_sha256);
}

#[tokio::test]
async fn a_persistent_hash_mismatch_never_publishes_and_never_touches_the_source() {
    let mut world = World::new();
    world.attempts = 1;
    let root = world.qemu_vm("Win98");
    world.repository.store.lock().unwrap().corrupt_next_upload = true;
    let operations = world.start();
    let transfer = request("Win98", RegistrationMode::Transfer);
    start(&operations, &transfer);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "hash_mismatch");
    assert_eq!(world.repository.store.lock().unwrap().publishes, 0);
    settle().await;
    assert!(world.repository.keys().is_empty(), "staging is cleaned up");
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn an_interrupted_upload_is_retried() {
    let world = World::new();
    world.qemu_vm("Win98");
    world
        .repository
        .fail("upload", RepositoryError::new(Kind::Interrupted, "dropped"));
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    result_of(&operations).await;
    assert_eq!(world.repository.store.lock().unwrap().uploads, 1);
    assert_eq!(world.repository.keys(), vec![copy.archive_key.clone()]);
}

#[tokio::test]
async fn an_existing_archive_is_never_overwritten() {
    let world = World::new();
    world.qemu_vm("Win98");
    let copy = request("Win98", RegistrationMode::Copy);
    world
        .repository
        .store
        .lock()
        .unwrap()
        .objects
        .insert(copy.archive_key.clone(), b"already here".to_vec());
    let operations = world.start();
    start(&operations, &copy);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "archive_exists");
    assert_eq!(
        world.repository.object(&copy.archive_key).unwrap(),
        b"already here"
    );
}

#[tokio::test]
async fn a_publication_lost_in_transit_finds_its_own_object() {
    let world = World::new();
    world.qemu_vm("Win98");
    let copy = request("Win98", RegistrationMode::Copy);
    world
        .repository
        .fail("publish", RepositoryError::new(Kind::Interrupted, "lost"));
    let operations = world.start();
    start(&operations, &copy);
    let result = result_of(&operations).await;
    let stored = world.repository.object(&copy.archive_key).unwrap();
    assert_eq!(hex(&Sha256::digest(&stored)), result.archive_sha256);
}

#[tokio::test]
async fn a_publication_that_finds_a_different_object_fails() {
    let world = World::new();
    world.qemu_vm("Win98");
    let copy = request("Win98", RegistrationMode::Copy);
    let operations = world.start();
    world.repository.fail(
        "publish",
        RepositoryError::new(Kind::AlreadyExists, "something else got there"),
    );
    start(&operations, &copy);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "archive_exists");
}

#[tokio::test]
async fn a_request_for_an_unconfigured_repository_is_refused() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let operations = world.start();
    let mut copy = request("Win98", RegistrationMode::Copy);
    copy.repository_id = Uuid::from_u128(0xbad);
    start(&operations, &copy);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "repository_not_configured");
    assert!(root.exists());
}

#[tokio::test]
async fn a_request_whose_key_does_not_match_its_vm_and_version_is_refused() {
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    for bad_key in [
        "archives/qemu/other/0.zip".to_owned(),
        "../../etc/passwd".to_owned(),
        format!("archives/.staging/{}.part", Uuid::new_v4()),
    ] {
        let mut copy = request("Win98", RegistrationMode::Copy);
        copy.archive_key = bad_key;
        start(&operations, &copy);
        let (code, _) = failure_of(&operations).await;
        assert_eq!(code, "invalid_request");
        // Runs to completion before the next, since only one runs at a time.
        settle().await;
    }
    assert!(world.repository.keys().is_empty());
}

#[tokio::test]
async fn a_vm_that_is_gone_or_not_a_vm_is_refused() {
    let world = World::new();
    fs::create_dir(world.qemu.join("Plain")).unwrap();
    let operations = world.start();
    start(&operations, &request("Missing", RegistrationMode::Copy));
    assert_eq!(failure_of(&operations).await.0, "source_missing");
    settle().await;
    start(&operations, &request("Plain", RegistrationMode::Copy));
    assert_eq!(failure_of(&operations).await.0, "source_invalid");
}

#[tokio::test]
async fn cancelling_during_the_upload_stops_and_keeps_the_source() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let hold = Arc::new(tokio::sync::Notify::new());
    world.repository.store.lock().unwrap().hold_upload = Some(Arc::clone(&hold));
    let operations = world.start();
    let transfer = request("Win98", RegistrationMode::Transfer);
    start(&operations, &transfer);
    next_message(&operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationProgress(progress)
                if progress.stage == RegistrationStage::Uploading
        )
    })
    .await;
    operations.handle(Message::ServerRegistrationCancel(RegistrationCancel {
        operation_id: transfer.operation_id,
    }));
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "cancelled");
    assert!(root.join("disk.qcow2").exists());
    assert!(world.repository.keys().is_empty());
    assert_eq!(fs::read_dir(&world.staging).unwrap().count(), 0);
}

#[tokio::test]
async fn only_one_registration_runs_at_a_time() {
    let world = World::new();
    world.qemu_vm("One");
    world.qemu_vm("Two");
    let hold = Arc::new(tokio::sync::Notify::new());
    world.repository.store.lock().unwrap().hold_upload = Some(Arc::clone(&hold));
    let operations = world.start();
    start(&operations, &request("One", RegistrationMode::Copy));
    let second = request("Two", RegistrationMode::Copy);
    start(&operations, &second);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "agent_busy");
    assert!(!operations.open_operations().contains(&second.operation_id));
}

#[tokio::test]
async fn a_repeated_request_does_not_start_again() {
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    start(&operations, &copy);
    result_of(&operations).await;
    start(&operations, &copy);
    settle().await;
    assert_eq!(world.repository.store.lock().unwrap().uploads, 1);
    assert_eq!(operations.open_operations(), [copy.operation_id]);
}

#[tokio::test]
async fn a_restart_before_publication_reports_failure_and_keeps_the_source() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let hold = Arc::new(tokio::sync::Notify::new());
    world.repository.store.lock().unwrap().hold_upload = Some(Arc::clone(&hold));
    let operations = world.start();
    let transfer = request("Win98", RegistrationMode::Transfer);
    start(&operations, &transfer);
    next_message(&operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationProgress(progress)
                if progress.stage == RegistrationStage::Uploading
        )
    })
    .await;
    // What stopping looks like from the inside: the work ends, and the journal says it was running.
    operations.shutdown();
    settle().await;
    drop(operations);
    world.repository.store.lock().unwrap().hold_upload = None;

    let restarted = world.start();
    let sync = restarted.sync_messages();
    let Message::AgentRegistrationSync(listing) = &sync[0] else {
        panic!("the first message is the sync");
    };
    assert_eq!(listing.operations[0].operation_id, transfer.operation_id);
    assert_eq!(listing.operations[0].phase, RegistrationPhase::Reported);
    assert!(sync.iter().any(|message| matches!(
        message,
        Message::AgentRegistrationError(failure) if failure.code == "agent_restarted"
    )));
    settle().await;
    assert!(root.join("disk.qcow2").exists());
    assert_eq!(fs::read_dir(&world.staging).unwrap().count(), 0);
    assert_eq!(world.repository.store.lock().unwrap().uploads, 0);
    assert_eq!(world.repository.store.lock().unwrap().publishes, 0);

    restarted.handle(closed(&transfer));
    assert!(restarted.open_operations().is_empty());
}

#[tokio::test]
async fn a_restart_after_publication_repeats_the_result_and_does_not_delete_by_itself() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    let result = result_of(&operations).await;
    operations.shutdown();
    drop(operations);

    let restarted = world.start();
    settle().await;
    assert!(
        root.join("disk.qcow2").exists(),
        "a restart deletes nothing"
    );
    assert!(restarted.sync_messages().iter().any(|message| matches!(
        message,
        Message::AgentRegistrationResult(again) if again == &result
    )));
    assert_eq!(world.repository.store.lock().unwrap().publishes, 1);

    // The acknowledgement that was lost is recovered, and only that authorizes the removal.
    restarted.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&restarted).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed);
    assert!(!root.exists());
}

#[tokio::test]
async fn a_restart_during_removal_continues_with_what_it_set_aside() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    operations.shutdown();
    drop(operations);

    // A crash right after the rename: the name is gone, and everything is still there.
    let quarantine = quarantine_path(&world.qemu, transfer.operation_id);
    fs::rename(&root, &quarantine).unwrap();
    let restarted = world.start();
    restarted.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&restarted).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
    assert!(!quarantine.exists());
}

#[tokio::test]
async fn a_rejected_result_keeps_the_source_and_removes_only_what_it_is_told_to() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let operations = world.start();
    let transfer = request("Win98", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    operations.handle(rejected(&transfer, false));
    settle().await;
    assert!(root.join("disk.qcow2").exists());
    assert_eq!(
        world.repository.keys(),
        vec![transfer.archive_key.clone()],
        "the server did not say that the archive may go"
    );
    assert!(operations.open_operations().is_empty());

    let second_world = World::new();
    let second_root = second_world.qemu_vm("Win98");
    let operations = second_world.start();
    let cancelled = request("Win98", RegistrationMode::Transfer);
    start(&operations, &cancelled);
    result_of(&operations).await;
    operations.handle(rejected(&cancelled, true));
    settle().await;
    assert!(second_world.repository.keys().is_empty());
    assert!(second_root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn an_acknowledgement_for_an_unknown_operation_does_nothing() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let operations = world.start();
    let stranger = request("Win98", RegistrationMode::Transfer);
    operations.handle(committed(&stranger, true));
    settle().await;
    assert!(root.join("disk.qcow2").exists());
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_failure_keeps_being_reported_until_the_server_closes_it() {
    let world = World::new();
    let operations = world.start();
    let copy = request("Missing", RegistrationMode::Copy);
    start(&operations, &copy);
    failure_of(&operations).await;
    assert_eq!(operations.pending_reports().len(), 1);
    assert_eq!(operations.pending_reports().len(), 1);
    operations.handle(closed(&copy));
    assert!(operations.pending_reports().is_empty());
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_health_check_reports_what_is_configured_and_never_a_secret() {
    let world = World::new();
    let operations = world.start();
    operations.handle(Message::ServerRepositoryHealthRequest(
        emucat_agent::protocol::RepositoryHealthRequest {
            operation_id: Uuid::new_v4(),
            repository_id: REPOSITORY,
        },
    ));
    let Message::AgentRepositoryHealthResult(result) = next_message(&operations, |message| {
        matches!(message, Message::AgentRepositoryHealthResult(_))
    })
    .await
    else {
        unreachable!()
    };
    assert!(result.ok);
    assert_eq!(result.configuration.unwrap().host, "nas.test");

    operations.handle(Message::ServerRepositoryHealthRequest(
        emucat_agent::protocol::RepositoryHealthRequest {
            operation_id: Uuid::new_v4(),
            repository_id: Uuid::from_u128(0xbad),
        },
    ));
    let Message::AgentRepositoryHealthResult(result) = next_message(&operations, |message| {
        matches!(message, Message::AgentRepositoryHealthResult(_))
    })
    .await
    else {
        unreachable!()
    };
    assert!(!result.ok);
    assert_eq!(result.code.as_deref(), Some("repository_not_configured"));
    assert_eq!(result.configuration, None);
}

#[test]
fn repository_keys_are_conservative_and_relative() {
    for bad in [
        "",
        "/absolute",
        "../escape",
        "a/../b",
        "a/./b",
        "a//b",
        "a\\b",
        "C:\\windows",
        "a:b",
        "ends/",
        "nul\0byte",
    ] {
        assert!(RepositoryKey::new(bad).is_err(), "{bad:?} must be refused");
    }
    let good = RepositoryKey::new("archives/qemu/win 98/x.zip").unwrap();
    assert_eq!(
        good.parents(),
        ["archives", "archives/qemu", "archives/qemu/win 98"]
    );
    assert!(!good.is_staging());
    assert!(RepositoryKey::staging(Uuid::new_v4()).is_staging());
}
