//! The registration workflow against a repository held in memory, whose failures can be chosen. The
//! same workflow against a real SFTP server and a real API is in `apps/api/e2e`.
//!
//! The rule under test throughout: nothing but an explicit, matching acknowledgement of a transfer can
//! ever remove a local file. Every destructive test uses a disposable temporary directory.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::archives::VersionId;
use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::media_queue::EntryError;
use emucat_agent::media_sync::{ApiFailure, MediaPreservation};
use emucat_agent::packaging::{MANIFEST_ENTRY_NAME, hex, read_manifest};
use emucat_agent::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCancel, RegistrationMode,
    RegistrationPhase, RegistrationRequest, RegistrationResult, RegistrationRetryCleanup,
    RegistrationStage, RepositoryConfigSummary,
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
    media: Option<Arc<dyn MediaPreservation>>,
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
            media: None,
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
        let restore = emucat_agent::restore::RestoreSettings::under(&self.state);
        AgentOperations::load(OperationsConfig {
            restore,
            agent_id: Uuid::from_u128(1),
            state_dir: self.state.clone(),
            staging_dir: self.staging.clone(),
            emulators: Arc::new(emulators),
            repositories: Arc::new(Provider {
                repository: self.repository.clone(),
                attempts: self.attempts,
            }),
            retry_delay: Duration::from_millis(1),
            execution: emucat_agent::execution::ExecutionSettings::default(),
            media: self.media.clone(),
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
        parent_version_id: None,
        workspace_id: None,
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
        parent_version_id: None,
        workspace_id: None,
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

// A transfer of a VM with screenshots: only the server's acknowledgement of the exact content counts.

#[derive(Default)]
struct PreservationState {
    held: BTreeSet<String>,
    unavailable: bool,
    failures: HashMap<String, EntryError>,
    /// Runs once, right after the next answer: this is how something changes at the worst moment.
    after_answer: Option<Box<dyn FnOnce() + Send>>,
    /// Hashes that become acknowledged when the agent asks for them to be uploaded.
    upload_on_request: bool,
    sync_requests: u32,
    holds: Vec<bool>,
}

#[derive(Clone)]
struct FakePreservation {
    state: Arc<Mutex<PreservationState>>,
    wait: Duration,
}

impl FakePreservation {
    fn new() -> Self {
        Self {
            state: Arc::default(),
            wait: Duration::from_millis(600),
        }
    }

    fn hold_bytes(&self, bytes: &[u8]) {
        self.state.lock().unwrap().held.insert(hash(bytes));
    }
}

fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

impl MediaPreservation for FakePreservation {
    fn acknowledged<'a>(
        &'a self,
        _vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> futures_util::future::BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            if state.unavailable {
                return Err(ApiFailure::Transient {
                    code: "server_unreachable".to_owned(),
                    message: "Cannot connect to the server".to_owned(),
                });
            }
            let answer = hashes
                .iter()
                .filter(|hash| state.held.contains(*hash))
                .cloned()
                .collect();
            if let Some(action) = state.after_answer.take() {
                action();
            }
            Ok(answer)
        })
    }

    fn request_sync(&self, _vm: &VmIdentity) {
        self.state.lock().unwrap().sync_requests += 1;
    }

    fn requeue(&self, _vm: &VmIdentity, hashes: &BTreeSet<String>) {
        let mut state = self.state.lock().unwrap();
        if state.upload_on_request {
            state.held.extend(hashes.iter().cloned());
        }
    }

    fn failure_of(&self, _vm: &VmIdentity, sha256: &str) -> Option<EntryError> {
        self.state.lock().unwrap().failures.get(sha256).cloned()
    }

    fn hold(&self, _vm: &VmIdentity, held: bool) {
        self.state.lock().unwrap().holds.push(held);
    }

    fn transfer_wait(&self) -> Duration {
        self.wait
    }
}

const SHOT: &[u8] = b"P6 a screenshot";

/// A transfer whose archive is published, and which is about to be told that its master is committed.
async fn transfer_with_screenshot() -> (
    World,
    FakePreservation,
    PathBuf,
    Arc<AgentOperations>,
    RegistrationRequest,
) {
    let mut world = World::new();
    let fake = FakePreservation::new();
    world.media = Some(Arc::new(fake.clone()));
    let root = world.qemu_vm("Disposable");
    fs::write(root.join("capture.ppm"), SHOT).unwrap();
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    start(&operations, &transfer);
    result_of(&operations).await;
    (world, fake, root, operations, transfer)
}

fn retry(request: &RegistrationRequest) -> Message {
    Message::ServerRegistrationRetryCleanup(RegistrationRetryCleanup {
        operation_id: request.operation_id,
        version_id: request.version_id,
    })
}

#[tokio::test]
async fn a_transfer_removes_the_vm_when_the_server_holds_every_screenshot() {
    let (world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
    assert!(!root.exists());
    assert!(!quarantine_path(&world.qemu, transfer.operation_id).exists());
    // It kept its hands off the VM's files while it was moving them.
    assert_eq!(fake.state.lock().unwrap().holds, [true, false]);
}

#[tokio::test]
async fn a_screenshot_is_never_in_the_archive_of_a_transfer() {
    let (world, fake, _root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    operations.handle(committed(&transfer, true));
    cleanup_of(&operations).await;
    let store = world.repository.store.lock().unwrap();
    let bytes = store
        .objects
        .get(&transfer.archive_key)
        .expect("the archive")
        .clone();
    drop(store);
    let names = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<&str> = names.file_names().collect();
    assert!(names.contains(&"disk.qcow2"));
    assert!(names.contains(&MANIFEST_ENTRY_NAME));
    assert!(
        !names.iter().any(|name| name.ends_with(".ppm")),
        "{names:?}"
    );
}

#[tokio::test]
async fn a_pending_screenshot_blocks_removal_and_keeps_everything() {
    let (_world, _fake, root, operations, transfer) = transfer_with_screenshot().await;
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    let message = cleanup.message.unwrap();
    assert!(message.contains("capture.ppm"), "{message}");
    assert_eq!(fs::read(root.join("capture.ppm")).unwrap(), SHOT);
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_screenshot_uploaded_during_the_wait_lets_the_removal_proceed() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.state.lock().unwrap().upload_on_request = true;
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
    assert!(!root.exists());
}

#[tokio::test]
async fn a_failed_screenshot_blocks_at_once_and_says_why() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.state.lock().unwrap().failures.insert(
        hash(SHOT),
        EntryError {
            code: "invalid_image".to_owned(),
            message: "The image could not be decoded".to_owned(),
        },
    );
    let started = std::time::Instant::now();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    let message = cleanup.message.unwrap();
    assert!(
        message.contains("capture.ppm") && message.contains("invalid_image"),
        "{message}"
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "it should not wait"
    );
    assert!(root.join("capture.ppm").exists());
}

#[tokio::test]
async fn a_screenshot_created_after_the_archive_blocks_removal() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    fs::write(root.join("later.ppm"), b"P6 taken later").unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    assert!(cleanup.message.unwrap().contains("later.ppm"));
    assert_eq!(fs::read(root.join("later.ppm")).unwrap(), b"P6 taken later");
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_screenshot_modified_after_it_was_uploaded_blocks_removal() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    fs::write(root.join("capture.ppm"), b"P6 different now").unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    assert_eq!(
        fs::read(root.join("capture.ppm")).unwrap(),
        b"P6 different now"
    );
}

#[tokio::test]
async fn a_screenshot_deleted_and_recreated_with_the_same_content_is_still_preserved() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    fs::remove_file(root.join("capture.ppm")).unwrap();
    fs::write(root.join("capture.ppm"), SHOT).unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
}

#[tokio::test]
async fn a_screenshot_taken_right_after_the_answer_is_caught_by_the_last_look() {
    let (world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    let late = root.join("at-the-last-moment.ppm");
    let write_late = late.clone();
    fake.state.lock().unwrap().after_answer = Some(Box::new(move || {
        fs::write(&write_late, b"P6 at the worst moment").unwrap();
    }));
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    // Everything is back where it was, under its own name.
    assert_eq!(fs::read(&late).unwrap(), b"P6 at the worst moment");
    assert_eq!(fs::read(root.join("capture.ppm")).unwrap(), SHOT);
    assert!(root.join("disk.qcow2").exists());
    assert!(!quarantine_path(&world.qemu, transfer.operation_id).exists());
}

#[tokio::test]
async fn an_unavailable_server_keeps_the_local_vm() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    // The local queue may well believe this was uploaded. Only the server's answer counts.
    fake.hold_bytes(SHOT);
    fake.state.lock().unwrap().unavailable = true;
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    assert!(cleanup.message.unwrap().contains("could not confirm"));
    assert!(root.join("capture.ppm").exists());
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_substituted_directory_with_the_same_screenshot_is_refused() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    fake.hold_bytes(SHOT);
    let disk = fs::read(root.join("disk.qcow2")).unwrap();
    fs::remove_dir_all(&root).unwrap();
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
    fs::write(root.join("disk.qcow2"), disk).unwrap();
    fs::write(root.join("capture.ppm"), SHOT).unwrap();
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_identity_mismatch"));
    assert!(root.join("capture.ppm").exists());
}

#[tokio::test]
async fn an_unsupported_file_among_the_screenshots_blocks_removal() {
    let mut world = World::new();
    let fake = FakePreservation::new();
    world.media = Some(Arc::new(fake.clone()));
    let root = world.box86.join("Disposable");
    fs::create_dir_all(root.join("screenshots/nested")).unwrap();
    fs::write(root.join("86box.cfg"), b"machine = x\n").unwrap();
    fs::write(root.join("screenshots/nested/notes.txt"), b"not an image").unwrap();
    let operations = world.start();
    let vm_name = VmName::new("Disposable").unwrap();
    let version_id = Uuid::new_v4();
    let identity = VmIdentity {
        emulator_type: EmulatorType::Box86,
        vm_name: vm_name.clone(),
    };
    let transfer = RegistrationRequest {
        operation_id: Uuid::new_v4(),
        emulator_type: EmulatorType::Box86,
        vm_name,
        mode: RegistrationMode::Transfer,
        repository_id: REPOSITORY,
        version_id,
        archive_key: RepositoryKey::for_version(&identity, VersionId(version_id))
            .as_str()
            .to_owned(),
        parent_version_id: None,
        workspace_id: None,
    };
    start(&operations, &transfer);
    result_of(&operations).await;
    // Even a server that says yes to everything cannot help: this file can never be uploaded.
    fake.hold_bytes(b"not an image");
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));
    assert!(cleanup.message.unwrap().contains("notes.txt"));
    assert_eq!(
        fs::read(root.join("screenshots/nested/notes.txt")).unwrap(),
        b"not an image"
    );
}

#[tokio::test]
async fn a_blocked_removal_can_be_retried_after_synchronization() {
    let (world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_media"));

    // The server records the partial success and closes the report. The agent keeps what a retry needs.
    operations.handle(closed(&transfer));
    assert_eq!(operations.open_operations(), [transfer.operation_id]);
    let Message::AgentRegistrationSync(sync) = operations.sync_messages().remove(0) else {
        panic!("a sync comes first");
    };
    assert_eq!(sync.operations[0].phase, RegistrationPhase::MediaBlocked);
    assert!(operations.pending_reports().is_empty(), "nothing to repeat");

    // It survives a restart too, and nothing is removed by that alone.
    drop(operations);
    let operations = world.start();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(root.join("disk.qcow2").exists());
    assert_eq!(operations.open_operations(), [transfer.operation_id]);

    // Still not there: another refusal, and still nothing lost.
    operations.handle(retry(&transfer));
    let again = cleanup_of(&operations).await;
    assert_eq!(again.code.as_deref(), Some("transfer_blocked_media"));
    operations.handle(closed(&transfer));
    assert!(root.join("capture.ppm").exists());

    fake.hold_bytes(SHOT);
    operations.handle(retry(&transfer));
    let done = cleanup_of(&operations).await;
    assert_eq!(done.local_copy, LocalCopyStatus::Removed, "{done:?}");
    assert!(!root.exists());
    operations.handle(closed(&transfer));
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_retry_refuses_a_vm_that_was_used_in_the_meantime() {
    let (_world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    operations.handle(committed(&transfer, true));
    cleanup_of(&operations).await;
    operations.handle(closed(&transfer));

    fake.hold_bytes(SHOT);
    fs::write(root.join("disk.qcow2"), b"changed by using the VM").unwrap();
    operations.handle(retry(&transfer));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.code.as_deref(), Some("cleanup_content_changed"));
    assert!(root.join("disk.qcow2").exists());
    // That is not a screenshot problem, so this one is over.
    operations.handle(closed(&transfer));
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_retry_for_an_unknown_operation_removes_nothing_and_says_so() {
    let mut world = World::new();
    world.media = Some(Arc::new(FakePreservation::new()));
    let root = world.qemu_vm("Disposable");
    let operations = world.start();
    let transfer = request("Disposable", RegistrationMode::Transfer);
    operations.handle(retry(&transfer));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert!(root.join("disk.qcow2").exists());
}

#[tokio::test]
async fn a_restart_during_cleanup_needs_a_fresh_acknowledgement_and_checks_again() {
    let (world, fake, root, operations, transfer) = transfer_with_screenshot().await;
    drop(operations);
    let operations = world.start();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(root.exists(), "a restart by itself deletes nothing");
    // The report is repeated, and the answer to it is what starts the removal.
    assert!(!operations.pending_reports().is_empty());
    fake.hold_bytes(SHOT);
    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
}

#[tokio::test]
async fn a_copy_starts_synchronization_and_never_waits_for_it() {
    let mut world = World::new();
    let fake = FakePreservation::new();
    world.media = Some(Arc::new(fake.clone()));
    let root = world.qemu_vm("Disposable");
    fs::write(root.join("capture.ppm"), SHOT).unwrap();
    let operations = world.start();
    let copy = request("Disposable", RegistrationMode::Copy);
    start(&operations, &copy);
    result_of(&operations).await;
    operations.handle(committed(&copy, false));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    assert!(fake.state.lock().unwrap().sync_requests >= 1);
    assert!(root.join("capture.ppm").exists());
}

/// A session an earlier run left without a process: whether its emulator runs cannot be told, so the
/// VM is treated as running. It stands in for a running emulator without starting one.
fn leave_unknown_session(world: &World, name: &str) -> Uuid {
    let session = Uuid::new_v4();
    let directory = world.state.join("executions");
    fs::create_dir_all(&directory).unwrap();
    let journal = serde_json::json!({
        "request": {
            "sessionId": session,
            "emulatorType": "qemu",
            "vmName": name,
            "mode": "local",
            "versionId": null,
        },
        "state": "running",
        "process": null,
        "graceful": null,
        "startedAt": null,
        "endedAt": null,
        "exitCode": null,
        "stopRequestedAt": null,
        "code": null,
        "message": null,
    });
    fs::write(
        directory.join(format!("{session}.journal")),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    session
}

#[tokio::test]
async fn a_vm_that_may_be_running_is_neither_registered_nor_removed() {
    let world = World::new();
    let root = world.qemu_vm("Disposable");
    let transfer = request("Disposable", RegistrationMode::Transfer);
    {
        let operations = world.start();
        start(&operations, &transfer);
        result_of(&operations).await;
    }

    // The VM is started between publication and the server's answer.
    let session = leave_unknown_session(&world, "Disposable");
    let operations = world.start();
    let other = request("Disposable", RegistrationMode::Copy);
    start(&operations, &other);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "vm_running");

    operations.handle(committed(&transfer, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::CleanupFailed);
    assert_eq!(cleanup.code.as_deref(), Some("transfer_blocked_running"));
    assert!(root.join("disk.qcow2").is_file());

    // Kept for a retry, which works once the session is over.
    operations.handle(closed(&transfer));
    assert_eq!(operations.open_operations(), vec![transfer.operation_id]);
    operations.handle(Message::ServerVmExecutionAck(
        emucat_agent::protocol::VmExecutionAck {
            session_id: session,
        },
    ));
    operations.handle(Message::ServerRegistrationRetryCleanup(
        RegistrationRetryCleanup {
            operation_id: transfer.operation_id,
            version_id: transfer.version_id,
        },
    ));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Removed, "{cleanup:?}");
    assert!(!root.exists());
}

#[tokio::test]
async fn a_kept_copy_keeps_the_archived_manifest_for_later_verification() {
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    let result = result_of(&operations).await;
    operations.handle(committed(&copy, false));
    cleanup_of(&operations).await;
    let kept = world
        .state
        .join("local-manifests")
        .join(format!("qemu-{}.json", VmName::new("Win98").unwrap().key()));
    assert_eq!(
        hex(&Sha256::digest(fs::read(&kept).unwrap())),
        result.manifest_sha256
    );
}

// Snapshots: a further immutable version of a registered VM. See decision 0037.

fn snapshot(name: &str, parent: Uuid, workspace: Option<Uuid>) -> RegistrationRequest {
    RegistrationRequest {
        parent_version_id: Some(parent),
        workspace_id: workspace,
        ..request(name, RegistrationMode::Snapshot)
    }
}

/// Lineage as a restore of `version` into this very directory would have recorded it.
fn record_source(world: &World, name: &str, version: Uuid) {
    let identity = emucat_agent::packaging::directory_identity(&world.qemu.join(name)).unwrap();
    record_lineage(world, name, version, Some(identity));
}

/// `None` is what an agent older than Milestone 7 recorded: a version, but no directory.
fn record_lineage(
    world: &World,
    name: &str,
    version: Uuid,
    directory: Option<emucat_agent::packaging::DirectoryIdentity>,
) {
    fs::create_dir_all(&world.state).unwrap();
    emucat_agent::state::record_local_source(
        &world.state,
        Uuid::from_u128(1),
        EmulatorType::Qemu,
        &VmName::new(name).unwrap(),
        version,
        None,
        directory,
    )
    .unwrap();
}

fn local_source(world: &World, name: &str) -> Option<Uuid> {
    read_local_state(
        &world.state,
        EmulatorType::Qemu,
        &VmName::new(name).unwrap(),
    )
    .and_then(|state| state.local_source_version_id)
    .map(|version| version.0)
}

fn archived_paths(world: &World, key: &str) -> Vec<String> {
    let local = TempDir::new().unwrap();
    let path = local.path().join("archive.zip");
    fs::write(&path, world.repository.object(key).unwrap()).unwrap();
    read_manifest(&path)
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| entry.path)
        .collect()
}

/// A working copy as a restore into it leaves one: its record, and the VM under its own directory.
fn working_copy(world: &World, name: &str, source: Uuid) -> (Uuid, PathBuf) {
    let workspace = Uuid::new_v4();
    emucat_agent::workspaces::write_record(
        &world.state,
        &emucat_agent::workspaces::WorkspaceRecord {
            workspace_id: workspace,
            emulator_type: EmulatorType::Qemu,
            vm_name: VmName::new(name).unwrap(),
            source_version_id: source,
            manifest_sha256: None,
        },
    )
    .unwrap();
    let root = emucat_agent::workspaces::workspace_base(&world.state, workspace).join(name);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
    fs::write(
        root.join("changed-in-session.txt"),
        b"a change made while it ran",
    )
    .unwrap();
    (workspace, root)
}

#[tokio::test]
async fn a_snapshot_publishes_a_new_version_and_the_local_copy_becomes_it() {
    let world = World::new();
    let root = world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_source(&world, "Win98", master);
    let before = fs::read(root.join("disk.qcow2")).unwrap();
    let operations = world.start();
    let request = snapshot("Win98", master, None);
    start(&operations, &request);

    let result = result_of(&operations).await;
    assert_eq!(result.version_id, request.version_id);
    assert_eq!(world.repository.keys(), vec![request.archive_key.clone()]);
    // Until the commit, the local copy is still the master's.
    assert_eq!(local_source(&world, "Win98"), Some(master));

    // A server saying "remove" cannot make a snapshot delete anything.
    operations.handle(committed(&request, true));
    let cleanup = cleanup_of(&operations).await;
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    assert_eq!(fs::read(root.join("disk.qcow2")).unwrap(), before);
    assert_eq!(local_source(&world, "Win98"), Some(request.version_id));
    operations.handle(closed(&request));
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_snapshot_never_overwrites_an_existing_archive() {
    let world = World::new();
    world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_source(&world, "Win98", master);
    let request = snapshot("Win98", master, None);
    world
        .repository
        .store
        .lock()
        .unwrap()
        .objects
        .insert(request.archive_key.clone(), b"an existing archive".to_vec());
    let operations = world.start();
    start(&operations, &request);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "archive_exists");
    assert_eq!(
        world.repository.object(&request.archive_key).unwrap(),
        b"an existing archive".to_vec()
    );
}

#[tokio::test]
async fn a_snapshot_whose_parent_contradicts_the_local_record_is_refused() {
    let world = World::new();
    world.qemu_vm("Win98");
    record_source(&world, "Win98", Uuid::new_v4());
    let operations = world.start();
    let request = snapshot("Win98", Uuid::new_v4(), None);
    start(&operations, &request);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_parent_mismatch");
    assert!(world.repository.keys().is_empty());
}

#[tokio::test]
async fn a_snapshot_of_a_copy_without_a_lineage_record_is_refused_not_attributed() {
    // The server believes the copy came from this master. Nothing on this agent says so.
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    let request = snapshot("Win98", Uuid::new_v4(), None);
    start(&operations, &request);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_lineage_unverified");
    assert!(world.repository.keys().is_empty(), "nothing was published");
    assert_eq!(local_source(&world, "Win98"), None);
}

#[tokio::test]
async fn a_legacy_lineage_record_without_a_directory_is_not_evidence() {
    let world = World::new();
    world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_lineage(&world, "Win98", master, None);
    let operations = world.start();
    start(&operations, &snapshot("Win98", master, None));
    let (code, message) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_lineage_unverified");
    assert!(message.contains("predates"), "{message}");
    assert!(world.repository.keys().is_empty());
    assert_eq!(
        local_source(&world, "Win98"),
        Some(master),
        "the record is kept"
    );
}

#[tokio::test]
async fn a_directory_replaced_under_the_same_name_does_not_inherit_its_lineage() {
    let world = World::new();
    let original = world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_source(&world, "Win98", master);
    // Someone moves the restored copy away and puts another VM with the same name in its place. The old
    // directory is kept, so that the new one cannot reuse its identity.
    fs::rename(&original, world.qemu.join("Win98 moved away")).unwrap();
    world.qemu_vm("Win98");
    let operations = world.start();
    start(&operations, &snapshot("Win98", master, None));
    let (code, message) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_lineage_unverified");
    assert!(message.contains("replaced"), "{message}");
    assert!(world.repository.keys().is_empty());
}

#[tokio::test]
async fn a_copy_registration_records_the_lineage_a_later_snapshot_relies_on() {
    // The production path, with nothing fabricated: copy, commit, then snapshot the same directory.
    let world = World::new();
    world.qemu_vm("Win98");
    let operations = world.start();
    let copy = request("Win98", RegistrationMode::Copy);
    start(&operations, &copy);
    result_of(&operations).await;
    operations.handle(committed(&copy, false));
    cleanup_of(&operations).await;
    operations.handle(closed(&copy));

    let first = snapshot("Win98", copy.version_id, None);
    start(&operations, &first);
    result_of(&operations).await;
    operations.handle(committed(&first, false));
    cleanup_of(&operations).await;
    operations.handle(closed(&first));
    assert_eq!(local_source(&world, "Win98"), Some(first.version_id));

    // The lineage moved with the commit: the master is no longer this copy's parent.
    let stale = snapshot("Win98", copy.version_id, None);
    start(&operations, &stale);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_parent_mismatch");
    let second = snapshot("Win98", first.version_id, None);
    start(&operations, &second);
    result_of(&operations).await;
    assert_eq!(
        world.repository.keys().len(),
        3,
        "the master and two snapshots, each under its own key"
    );
}

#[tokio::test]
async fn a_snapshot_whose_upload_keeps_failing_publishes_nothing_and_changes_nothing() {
    let mut world = World::new();
    world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_source(&world, "Win98", master);
    for _ in 0..2 {
        world
            .repository
            .fail("upload", RepositoryError::new(Kind::Interrupted, "dropped"));
    }
    world.attempts = 2;
    let operations = world.start();
    let request = snapshot("Win98", master, None);
    start(&operations, &request);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "upload_interrupted");
    assert!(
        !world.repository.keys().contains(&request.archive_key),
        "nothing published under the final key"
    );
    assert_eq!(local_source(&world, "Win98"), Some(master));
}

#[tokio::test]
async fn a_snapshot_of_a_working_copy_reads_it_and_leaves_the_persistent_copy_alone() {
    let world = World::new();
    let persistent = world.qemu_vm("Win98");
    let master = Uuid::new_v4();
    record_source(&world, "Win98", master);
    let (workspace, root) = working_copy(&world, "Win98", master);
    let operations = world.start();
    let request = snapshot("Win98", master, Some(workspace));
    start(&operations, &request);
    result_of(&operations).await;

    let paths = archived_paths(&world, &request.archive_key);
    assert!(
        paths.contains(&"changed-in-session.txt".to_owned()),
        "{paths:?}"
    );
    assert!(
        !paths.contains(&"disk.qcow2".to_owned()),
        "the persistent copy was read: {paths:?}"
    );

    operations.handle(committed(&request, true));
    assert_eq!(
        cleanup_of(&operations).await.local_copy,
        LocalCopyStatus::Preserved
    );
    assert!(root.join("changed-in-session.txt").exists());
    assert!(persistent.join("disk.qcow2").exists());
    let record = emucat_agent::workspaces::read_record(&world.state, workspace).unwrap();
    assert_eq!(record.source_version_id, request.version_id);
    assert_eq!(
        local_source(&world, "Win98"),
        Some(master),
        "the persistent copy is untouched"
    );

    // The next snapshot of it must name the one just made.
    let stale = snapshot("Win98", master, Some(workspace));
    operations.handle(closed(&request));
    start(&operations, &stale);
    let (code, _) = failure_of(&operations).await;
    assert_eq!(code, "snapshot_parent_mismatch");
}

#[tokio::test]
async fn a_snapshot_of_a_missing_or_foreign_working_copy_is_refused() {
    let world = World::new();
    let master = Uuid::new_v4();
    let (workspace, _) = working_copy(&world, "Win98", master);
    world.qemu_vm("Other");
    let operations = world.start();
    for request in [
        snapshot("Win98", master, Some(Uuid::new_v4())),
        // A working copy of Win98, named as one of Other.
        snapshot("Other", master, Some(workspace)),
    ] {
        start(&operations, &request);
        let (code, _) = failure_of(&operations).await;
        assert_eq!(code, "workspace_unavailable");
    }
    assert!(world.repository.keys().is_empty());
}

#[tokio::test]
async fn a_working_copy_is_listed_and_discarded_only_when_asked() {
    let world = World::new();
    let (workspace, root) = working_copy(&world, "Win98", Uuid::new_v4());
    let operations = world.start();
    let listed = operations
        .sync_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::AgentRestoreSync(sync) => Some(sync.workspaces),
            _ => None,
        })
        .unwrap();
    assert_eq!(listed, vec![workspace]);

    // Named as another VM's, nothing is removed.
    operations.handle(Message::ServerWorkspaceDiscard(
        emucat_agent::protocol::WorkspaceDiscard {
            workspace_id: workspace,
            emulator_type: EmulatorType::Qemu,
            vm_name: VmName::new("Other").unwrap(),
        },
    ));
    let refused = discard_result(&operations).await;
    assert!(!refused.removed);
    assert_eq!(refused.code.as_deref(), Some("workspace_mismatch"));
    assert!(root.exists());

    operations.handle(Message::ServerWorkspaceDiscard(
        emucat_agent::protocol::WorkspaceDiscard {
            workspace_id: workspace,
            emulator_type: EmulatorType::Qemu,
            vm_name: VmName::new("win98").unwrap(),
        },
    ));
    let removed = discard_result(&operations).await;
    assert!(removed.removed, "{removed:?}");
    assert!(!root.exists());
    assert!(emucat_agent::workspaces::held(&world.state).is_empty());
    // Asking again is harmless.
    operations.handle(Message::ServerWorkspaceDiscard(
        emucat_agent::protocol::WorkspaceDiscard {
            workspace_id: workspace,
            emulator_type: EmulatorType::Qemu,
            vm_name: VmName::new("Win98").unwrap(),
        },
    ));
    assert!(discard_result(&operations).await.removed);
}

async fn discard_result(
    operations: &AgentOperations,
) -> emucat_agent::protocol::WorkspaceDiscardResult {
    match next_message(operations, |message| {
        matches!(message, Message::AgentWorkspaceDiscardResult(_))
    })
    .await
    {
        Message::AgentWorkspaceDiscardResult(result) => result,
        _ => unreachable!(),
    }
}
