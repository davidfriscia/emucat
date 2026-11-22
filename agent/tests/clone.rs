//! Cloning a version (decision 0052) against a repository held in memory: real archives built by registration, a
//! clone written again under a new name, and every check that keeps a clone exactly the content of its source.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::archives::VersionId;
use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::extraction::{ArchiveExpectation, ExtractionLimits, inspect_archive};
use emucat_agent::packaging::{MANIFEST_ENTRY_NAME, hex, read_manifest};
use emucat_agent::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCancel, RegistrationMode,
    RegistrationRequest, RegistrationResult, RepositoryConfigSummary,
};
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use emucat_agent::vm_clone::{CloneEmulator, CloneRequest, CloneSource, CloneTarget};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x7777);

#[derive(Clone, Default)]
struct MemoryRepository {
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    hold_download: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
}

impl MemoryRepository {
    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.objects.lock().unwrap().get(key).cloned()
    }
    fn put(&self, key: &str, bytes: Vec<u8>) {
        self.objects.lock().unwrap().insert(key.to_owned(), bytes);
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
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move { unreachable!() }.boxed()
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
            self.put(key.as_str(), bytes);
            progress(size, size);
            Ok(ObjectMetadata { size_bytes: size })
        }
        .boxed()
    }
    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let hold = self.hold_download.lock().unwrap().clone();
            if let Some(hold) = hold {
                tokio::select! {
                    () = hold.notified() => {}
                    () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                }
            }
            let object = self
                .object(key.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            assert!(!destination.exists(), "a download never replaces a file");
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
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let object = self
                .object(key.as_str())
                .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?;
            let sha256 = hex(&Sha256::digest(&object));
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

struct Provider(MemoryRepository);

impl RepositoryProvider for Provider {
    fn repository_ids(&self) -> Vec<Uuid> {
        vec![REPOSITORY]
    }
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        if repository_id == REPOSITORY {
            Ok(Arc::new(self.0.clone()))
        } else {
            Err(RepositoryError::new(Kind::NotConfigured, "not configured"))
        }
    }
    fn summary(&self, _: Uuid) -> Option<RepositoryConfigSummary> {
        None
    }
    fn upload_attempts(&self, _: Uuid) -> u32 {
        2
    }
}

struct World {
    directory: TempDir,
    repository: MemoryRepository,
}

impl World {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        fs::create_dir(directory.path().join("qemu")).unwrap();
        fs::create_dir(directory.path().join("86box")).unwrap();
        Self {
            directory,
            repository: MemoryRepository::default(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.directory.path().join(name)
    }

    fn start(&self) -> Arc<AgentOperations> {
        let emulators: BTreeMap<EmulatorType, EmulatorConfig> = [
            (
                EmulatorType::Qemu,
                EmulatorConfig {
                    base_path: self.path("qemu"),
                    executable: PathBuf::from("unused"),
                },
            ),
            (
                EmulatorType::Box86,
                EmulatorConfig {
                    base_path: self.path("86box"),
                    executable: PathBuf::from("unused"),
                },
            ),
        ]
        .into();
        AgentOperations::load(OperationsConfig {
            restore: emucat_agent::restore::RestoreSettings::under(&self.path("state")),
            agent_id: Uuid::from_u128(1),
            state_dir: self.path("state"),
            staging_dir: self.path("staging"),
            emulators: Arc::new(emulators),
            repositories: Arc::new(Provider(self.repository.clone())),
            retry_delay: Duration::from_millis(1),
            execution: emucat_agent::execution::ExecutionSettings::default(),
            virtualbox: None,
            media: None,
        })
        .unwrap()
    }

    /// An 86Box VM with nested directories, an empty directory, a large file and screenshots, which archives leave out.
    fn box86_vm(&self, name: &str) -> PathBuf {
        let root = self.path("86box").join(name);
        fs::create_dir_all(root.join("disks/extra")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("screenshots")).unwrap();
        fs::write(root.join("86box.cfg"), b"[Machine]\nmachine = ibmpc\n").unwrap();
        let disk: Vec<u8> = (0..600 * 1024).map(|index| (index % 251) as u8).collect();
        fs::write(root.join("disks/hdd.img"), &disk).unwrap();
        fs::write(root.join("disks/extra/notes.txt"), "Ünïcödé content\n").unwrap();
        fs::write(root.join("screenshots/shot.png"), b"not in the archive").unwrap();
        root
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

fn ack(
    operation_id: Uuid,
    outcome: AckOutcome,
    version_id: Option<Uuid>,
    delete_published: bool,
) -> Message {
    Message::ServerRegistrationAck(RegistrationAck {
        operation_id,
        outcome,
        version_id,
        remove_local: false,
        delete_published,
    })
}

/// Registers a VM the ordinary way, and returns what the repository then holds for it.
async fn register(
    operations: &AgentOperations,
    emulator: EmulatorType,
    name: &str,
) -> RegistrationResult {
    let vm_name = VmName::new(name).unwrap();
    let version_id = Uuid::new_v4();
    let request = RegistrationRequest {
        operation_id: Uuid::new_v4(),
        emulator_type: emulator,
        vm_name: vm_name.clone(),
        mode: RegistrationMode::Copy,
        repository_id: REPOSITORY,
        version_id,
        archive_key: RepositoryKey::for_version(
            &VmIdentity {
                emulator_type: emulator,
                vm_name,
            },
            VersionId(version_id),
        )
        .as_str()
        .to_owned(),
        parent_version_id: None,
        workspace_id: None,
    };
    operations.handle(Message::ServerRegistrationRequest(request.clone()));
    let Message::AgentRegistrationResult(result) = next_message(operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationResult(_) | Message::AgentRegistrationError(_)
        )
    })
    .await
    else {
        panic!("the registration failed");
    };
    operations.handle(ack(
        request.operation_id,
        AckOutcome::Committed,
        Some(version_id),
        false,
    ));
    next_message(operations, |message| {
        matches!(message, Message::AgentRegistrationCleanup(_))
    })
    .await;
    operations.handle(ack(request.operation_id, AckOutcome::Closed, None, false));
    tokio::time::sleep(Duration::from_millis(50)).await;
    result
}

fn clone_request(
    emulator: CloneEmulator,
    source_name: &str,
    source: &RegistrationResult,
    target_name: &str,
    manifest_sha256: Option<String>,
) -> CloneRequest {
    let target_vm = VmName::new(target_name).unwrap();
    let target_version = Uuid::new_v4();
    CloneRequest {
        operation_id: Uuid::new_v4(),
        emulator_type: emulator,
        repository_id: REPOSITORY,
        source: CloneSource {
            vm_name: VmName::new(source_name).unwrap(),
            version_id: source.version_id,
            archive_key: source.archive_key.clone(),
            archive_size_bytes: source.archive_size_bytes,
            archive_sha256: source.archive_sha256.clone(),
            manifest_sha256,
        },
        target: CloneTarget {
            archive_key: emulator.archive_key(&target_vm, target_version),
            vm_name: target_vm,
            version_id: target_version,
        },
    }
}

enum Outcome {
    Zip(RegistrationResult),
    Ova(emucat_agent::protocol::VirtualBoxRegistrationResult),
    Failed(String, String),
}

async fn outcome(operations: &AgentOperations) -> Outcome {
    match next_message(operations, |message| {
        matches!(
            message,
            Message::AgentRegistrationResult(_)
                | Message::AgentVirtualBoxRegistrationResult(_)
                | Message::AgentRegistrationError(_)
        )
    })
    .await
    {
        Message::AgentRegistrationResult(result) => Outcome::Zip(result),
        Message::AgentVirtualBoxRegistrationResult(result) => Outcome::Ova(result),
        Message::AgentRegistrationError(error) => Outcome::Failed(error.code, error.message),
        _ => unreachable!(),
    }
}

async fn failure_code(operations: &AgentOperations) -> String {
    match outcome(operations).await {
        Outcome::Failed(code, message) => {
            assert!(!message.is_empty(), "{code} has no message");
            code
        }
        _ => panic!("unexpected success"),
    }
}

/// Every file of a ZIP, decompressed, by path. The manifest is left out.
fn contents(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut files = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.name() == MANIFEST_ENTRY_NAME {
            continue;
        }
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
        files.insert(entry.name().to_owned(), data);
    }
    files
}

#[tokio::test]
async fn a_clone_holds_exactly_the_source_content_under_its_own_name_and_key() {
    let world = World::new();
    world.box86_vm("Windows 95");
    let operations = world.start();
    let source = register(&operations, EmulatorType::Box86, "Windows 95").await;
    let source_bytes = world.repository.object(&source.archive_key).unwrap();

    let request = clone_request(
        CloneEmulator::Box86,
        "Windows 95",
        &source,
        "Windows 95 - Office",
        Some(source.manifest_sha256.clone()),
    );
    operations.handle(Message::ServerCloneRequest(request.clone()));
    let Outcome::Zip(result) = outcome(&operations).await else {
        panic!("the clone failed");
    };
    assert_eq!(result.version_id, request.target.version_id);
    assert_eq!(result.archive_key, request.target.archive_key);
    assert!(
        result
            .archive_key
            .starts_with("archives/86box/windows 95 - office/")
    );
    assert_eq!(result.file_count, source.file_count);
    assert_eq!(
        result.total_uncompressed_bytes,
        source.total_uncompressed_bytes
    );
    assert_ne!(result.manifest_sha256, source.manifest_sha256);

    // The source archive is untouched, and the clone is a separate object.
    assert_eq!(
        world.repository.object(&source.archive_key).unwrap(),
        source_bytes
    );
    let clone_bytes = world.repository.object(&result.archive_key).unwrap();
    assert_eq!(hex(&Sha256::digest(&clone_bytes)), result.archive_sha256);
    assert_eq!(contents(&clone_bytes), contents(&source_bytes));
    assert!(
        !contents(&clone_bytes)
            .keys()
            .any(|path| path.starts_with("screenshots"))
    );

    // The manifest names the new VM, lists the same entries, and is what a restore of the clone accepts.
    let directory = TempDir::new().unwrap();
    let saved = directory.path().join("clone.zip");
    fs::write(&saved, &clone_bytes).unwrap();
    let manifest = read_manifest(&saved).unwrap();
    let original = {
        let path = directory.path().join("source.zip");
        fs::write(&path, &source_bytes).unwrap();
        read_manifest(&path).unwrap()
    };
    assert_eq!(manifest.vm_name, "Windows 95 - Office");
    assert_eq!(manifest.entries, original.entries);
    let target_name = VmName::new("Windows 95 - Office").unwrap();
    let inspected = inspect_archive(
        &mut File::open(&saved).unwrap(),
        &ArchiveExpectation {
            emulator: EmulatorType::Box86,
            vm_name: &target_name,
            manifest_sha256: Some(&result.manifest_sha256),
        },
        &ExtractionLimits::default(),
    )
    .unwrap();
    assert_eq!(inspected.manifest_sha256, result.manifest_sha256);
    // And a restore of the source by its own name still works: nothing about it changed.
    let source_name = VmName::new("Windows 95").unwrap();
    inspect_archive(
        &mut File::open(directory.path().join("source.zip")).unwrap(),
        &ArchiveExpectation {
            emulator: EmulatorType::Box86,
            vm_name: &source_name,
            manifest_sha256: Some(&source.manifest_sha256),
        },
        &ExtractionLimits::default(),
    )
    .unwrap();

    // Committed: a copy's cleanup, then closed, and nothing is left on the agent.
    operations.handle(ack(
        request.operation_id,
        AckOutcome::Committed,
        Some(request.target.version_id),
        false,
    ));
    let Message::AgentRegistrationCleanup(cleanup) = next_message(&operations, |message| {
        matches!(message, Message::AgentRegistrationCleanup(_))
    })
    .await
    else {
        unreachable!()
    };
    assert_eq!(cleanup.local_copy, LocalCopyStatus::Preserved);
    operations.handle(ack(request.operation_id, AckOutcome::Closed, None, false));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(operations.open_operations().is_empty());
    assert!(
        !world
            .path("staging")
            .join(format!("clone-{}", request.operation_id))
            .exists()
    );
    // The local VM was never touched.
    assert!(world.path("86box/Windows 95/screenshots/shot.png").exists());
    assert!(!world.path("86box/Windows 95 - Office").exists());
}

#[tokio::test]
async fn a_source_that_is_not_the_registered_archive_is_never_cloned() {
    let world = World::new();
    world.box86_vm("Win");
    let operations = world.start();
    let source = register(&operations, EmulatorType::Box86, "Win").await;

    // Another hash than the one registered.
    let mut wrong = clone_request(CloneEmulator::Box86, "Win", &source, "Copy", None);
    wrong.source.archive_sha256 = "0".repeat(64);
    operations.handle(Message::ServerCloneRequest(wrong));
    assert_eq!(failure_code(&operations).await, "source_archive_invalid");

    // Another manifest than the one its registration verified.
    let request = clone_request(
        CloneEmulator::Box86,
        "Win",
        &source,
        "Copy",
        Some("1".repeat(64)),
    );
    operations.handle(Message::ServerCloneRequest(request));
    assert_eq!(failure_code(&operations).await, "source_archive_invalid");

    // A source archive whose manifest names another VM.
    let request = clone_request(CloneEmulator::Box86, "Other", &source, "Copy", None);
    // The key is then not the source's own: refused before anything is read.
    operations.handle(Message::ServerCloneRequest(request));
    assert_eq!(failure_code(&operations).await, "invalid_request");

    // Nothing was published under the clone's identity.
    assert!(
        world
            .repository
            .keys()
            .iter()
            .all(|key| !key.contains("/copy/"))
    );
}

#[tokio::test]
async fn a_clone_never_overwrites_and_never_derives_another_key() {
    let world = World::new();
    world.box86_vm("Win");
    let operations = world.start();
    let source = register(&operations, EmulatorType::Box86, "Win").await;

    let request = clone_request(CloneEmulator::Box86, "Win", &source, "Copy", None);
    world
        .repository
        .put(&request.target.archive_key, b"already here".to_vec());
    operations.handle(Message::ServerCloneRequest(request.clone()));
    assert_eq!(failure_code(&operations).await, "archive_exists");
    assert_eq!(
        world
            .repository
            .object(&request.target.archive_key)
            .unwrap(),
        b"already here"
    );

    let mut elsewhere = clone_request(CloneEmulator::Box86, "Win", &source, "Copy2", None);
    elsewhere.target.archive_key = source.archive_key.clone();
    operations.handle(Message::ServerCloneRequest(elsewhere));
    assert_eq!(failure_code(&operations).await, "invalid_request");

    let same = clone_request(CloneEmulator::Box86, "Win", &source, "WIN", None);
    operations.handle(Message::ServerCloneRequest(same));
    assert_eq!(failure_code(&operations).await, "invalid_request");
}

#[tokio::test]
async fn a_rejected_clone_deletes_only_its_own_object() {
    let world = World::new();
    world.box86_vm("Win");
    let operations = world.start();
    let source = register(&operations, EmulatorType::Box86, "Win").await;
    let request = clone_request(CloneEmulator::Box86, "Win", &source, "Copy", None);
    operations.handle(Message::ServerCloneRequest(request.clone()));
    let Outcome::Zip(result) = outcome(&operations).await else {
        panic!("the clone failed");
    };
    assert!(world.repository.object(&result.archive_key).is_some());
    operations.handle(ack(request.operation_id, AckOutcome::Rejected, None, true));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(world.repository.object(&result.archive_key).is_none());
    assert!(world.repository.object(&source.archive_key).is_some());
    assert!(operations.open_operations().is_empty());
}

#[tokio::test]
async fn a_cancelled_clone_publishes_nothing_and_leaves_no_staging() {
    let world = World::new();
    world.box86_vm("Win");
    let operations = world.start();
    let source = register(&operations, EmulatorType::Box86, "Win").await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *world.repository.hold_download.lock().unwrap() = Some(Arc::clone(&hold));
    let request = clone_request(CloneEmulator::Box86, "Win", &source, "Copy", None);
    operations.handle(Message::ServerCloneRequest(request.clone()));
    tokio::time::sleep(Duration::from_millis(100)).await;
    operations.handle(Message::ServerRegistrationCancel(RegistrationCancel {
        operation_id: request.operation_id,
    }));
    assert_eq!(failure_code(&operations).await, "cancelled");
    assert!(
        world
            .repository
            .object(&request.target.archive_key)
            .is_none()
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !world
            .path("staging")
            .join(format!("clone-{}", request.operation_id))
            .exists()
    );
}

#[tokio::test]
async fn a_restart_before_publication_fails_the_clone_and_cleans_up() {
    let world = World::new();
    world.box86_vm("Win");
    let request = {
        let operations = world.start();
        let source = register(&operations, EmulatorType::Box86, "Win").await;
        let hold = Arc::new(tokio::sync::Notify::new());
        *world.repository.hold_download.lock().unwrap() = Some(Arc::clone(&hold));
        let request = clone_request(CloneEmulator::Box86, "Win", &source, "Copy", None);
        operations.handle(Message::ServerCloneRequest(request.clone()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        operations.shutdown();
        tokio::time::sleep(Duration::from_millis(100)).await;
        request
    };
    *world.repository.hold_download.lock().unwrap() = None;
    let operations = world.start();
    // The journal survives, says it is a clone, and the server is told it failed.
    let reports = operations.pending_reports();
    assert!(reports.iter().any(|message| matches!(
        message,
        Message::AgentRegistrationError(error)
            if error.operation_id == request.operation_id && error.code == "agent_restarted"
    )));
    assert!(operations.open_operations().contains(&request.operation_id));
    assert!(
        !world
            .path("staging")
            .join(format!("clone-{}", request.operation_id))
            .exists()
    );
    operations.handle(ack(request.operation_id, AckOutcome::Closed, None, false));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(operations.open_operations().is_empty());
}

// VirtualBox.

fn tar_header(name: &str, size: u64) -> [u8; 512] {
    let mut block = [0u8; 512];
    block[..name.len()].copy_from_slice(name.as_bytes());
    block[100..108].copy_from_slice(b"0000644\0");
    block[108..116].copy_from_slice(b"0000000\0");
    block[116..124].copy_from_slice(b"0000000\0");
    block[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    block[136..148].copy_from_slice(b"14725237021\0");
    block[148..156].copy_from_slice(b"        ");
    block[156] = b'0';
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let sum: u32 = block.iter().map(|&byte| u32::from(byte)).sum();
    block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    block
}

fn ova(disk: &[u8]) -> Vec<u8> {
    let descriptor = r#"<?xml version="1.0"?>
<Envelope ovf:version="1.0" xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1">
  <References><File ovf:id="file0" ovf:href="xp-disk001.vmdk"/></References>
  <VirtualSystem ovf:id="xp"><Info>A virtual machine</Info></VirtualSystem>
</Envelope>
"#;
    let mut bytes = Vec::new();
    for (name, data) in [("xp.ovf", descriptor.as_bytes()), ("xp-disk001.vmdk", disk)] {
        bytes.extend_from_slice(&tar_header(name, data.len() as u64));
        bytes.extend_from_slice(data);
        bytes.extend(std::iter::repeat_n(0, (512 - data.len() % 512) % 512));
    }
    bytes.extend(std::iter::repeat_n(0, 1024));
    bytes
}

fn ova_source(world: &World, name: &str, bytes: Vec<u8>) -> RegistrationResult {
    let version_id = Uuid::new_v4();
    let key = CloneEmulator::VirtualBox.archive_key(&VmName::new(name).unwrap(), version_id);
    let result = RegistrationResult {
        operation_id: Uuid::new_v4(),
        version_id,
        archive_key: key.clone(),
        archive_size_bytes: bytes.len() as u64,
        archive_sha256: hex(&Sha256::digest(&bytes)),
        manifest_version: 1,
        manifest_sha256: String::new(),
        file_count: 0,
        total_uncompressed_bytes: 0,
    };
    world.repository.put(&key, bytes);
    result
}

#[tokio::test]
async fn a_virtualbox_clone_is_the_same_ova_byte_for_byte_at_its_own_key() {
    let world = World::new();
    let operations = world.start();
    let bytes = ova(&vec![7u8; 4000]);
    let source = ova_source(&world, "XP-Box", bytes.clone());
    let request = clone_request(
        CloneEmulator::VirtualBox,
        "XP-Box",
        &source,
        "XP-Box-Copy",
        None,
    );
    operations.handle(Message::ServerCloneRequest(request.clone()));
    let Outcome::Ova(result) = outcome(&operations).await else {
        panic!("the clone failed");
    };
    assert_eq!(result.archive_key, request.target.archive_key);
    assert!(result.archive_key.ends_with(".ova"));
    assert_eq!(result.archive_sha256, source.archive_sha256);
    assert_eq!(world.repository.object(&result.archive_key).unwrap(), bytes);
    assert_eq!(world.repository.object(&source.archive_key).unwrap(), bytes);
}

#[tokio::test]
async fn a_virtualbox_source_that_is_not_an_ova_is_refused() {
    let world = World::new();
    let operations = world.start();
    let source = ova_source(&world, "XP-Box", b"not a tar archive at all".repeat(40));
    let request = clone_request(
        CloneEmulator::VirtualBox,
        "XP-Box",
        &source,
        "XP-Box-Copy",
        None,
    );
    operations.handle(Message::ServerCloneRequest(request.clone()));
    assert_eq!(failure_code(&operations).await, "source_archive_invalid");
    assert!(
        world
            .repository
            .object(&request.target.archive_key)
            .is_none()
    );
}

#[test]
fn clone_journals_are_named_by_operation_only() {
    // A request deserializes only with exactly its fields: no path can travel with it.
    let json = serde_json::json!({
        "operationId": Uuid::nil(),
        "emulatorType": "qemu",
        "repositoryId": REPOSITORY,
        "source": {"vmName": "A", "versionId": Uuid::nil(), "archiveKey": "k", "archiveSizeBytes": 1,
                   "archiveSha256": "a".repeat(64), "manifestSha256": null, "path": "C:/"},
        "target": {"vmName": "B", "versionId": Uuid::nil(), "archiveKey": "k"},
    });
    assert!(serde_json::from_value::<CloneRequest>(json).is_err());
}
