//! The screenshot watcher and its durable queue, against real files and a stand-in for the server whose
//! answers can be chosen. The same thing against the real API is in `apps/api/e2e`.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use emucat_agent::config::{EmulatorConfig, MediaSettings};
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::media::{
    MediaFileProblem, MediaScanLimits, checked_media_path, hash_media_file, is_watched_media_path,
    scan_vm_media,
};
use emucat_agent::media_queue::{EntryState, MediaQueue, QueueEntry, queue_path, retry_delay};
use emucat_agent::media_sync::{
    AgentMediaVms, ApiFailure, BlockReason, MediaApi, MediaPreservation, MediaSync,
    MediaSyncConfig, bounded_status, classify_response, relevant_vm,
};
use emucat_agent::protocol::Message;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const AGENT: Uuid = Uuid::from_u128(0x4444);

fn sha256(bytes: &[u8]) -> String {
    emucat_agent::packaging::hex(&Sha256::digest(bytes))
}

#[derive(Default)]
struct ServerState {
    vms: Vec<VmIdentity>,
    held: BTreeSet<(String, String)>,
    uploads: Vec<(String, String, Vec<u8>)>,
    upload_failures: VecDeque<ApiFailure>,
    list_failures: u32,
    list_calls: u32,
    ack_calls: u32,
    max_concurrent_seen: u32,
    concurrent: u32,
    upload_delay: Duration,
}

#[derive(Clone, Default)]
struct FakeServer {
    state: Arc<Mutex<ServerState>>,
}

fn key(vm: &VmIdentity) -> String {
    format!("{}/{}", vm.emulator_type, vm.vm_name.key())
}

fn transient(code: &str) -> ApiFailure {
    ApiFailure::Transient {
        code: code.to_owned(),
        message: "try later".to_owned(),
    }
}

impl MediaApi for FakeServer {
    fn list_vms(&self) -> BoxFuture<'_, Result<AgentMediaVms, ApiFailure>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            state.list_calls += 1;
            if state.list_failures > 0 {
                state.list_failures -= 1;
                return Err(transient("server_unreachable"));
            }
            Ok(AgentMediaVms {
                vms: state.vms.clone(),
                max_upload_bytes: 1024 * 1024,
            })
        })
    }

    fn acknowledged<'a>(
        &'a self,
        vm: &'a VmIdentity,
        hashes: &'a [String],
    ) -> BoxFuture<'a, Result<BTreeSet<String>, ApiFailure>> {
        Box::pin(async move {
            let mut state = self.state.lock().unwrap();
            state.ack_calls += 1;
            Ok(hashes
                .iter()
                .filter(|hash| state.held.contains(&(key(vm), (*hash).clone())))
                .cloned()
                .collect())
        })
    }

    fn upload<'a>(
        &'a self,
        vm: &'a VmIdentity,
        entry: &'a QueueEntry,
        mut file: fs::File,
    ) -> BoxFuture<'a, Result<(), ApiFailure>> {
        Box::pin(async move {
            let delay = {
                let mut state = self.state.lock().unwrap();
                if let Some(failure) = state.upload_failures.pop_front() {
                    return Err(failure);
                }
                state.concurrent += 1;
                state.max_concurrent_seen = state.max_concurrent_seen.max(state.concurrent);
                state.upload_delay
            };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            let mut state = self.state.lock().unwrap();
            state.concurrent -= 1;
            assert_eq!(
                sha256(&bytes),
                entry.sha256,
                "the bytes sent are the bytes hashed"
            );
            state.held.insert((key(vm), entry.sha256.clone()));
            state
                .uploads
                .push((key(vm), entry.source_path.clone(), bytes));
            Ok(())
        })
    }
}

struct World {
    _directory: TempDir,
    state_dir: PathBuf,
    box86: PathBuf,
    qemu: PathBuf,
    server: FakeServer,
    settings: MediaSettings,
}

impl World {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let box86 = directory.path().join("86box");
        let qemu = directory.path().join("qemu");
        fs::create_dir(&box86).unwrap();
        fs::create_dir(&qemu).unwrap();
        Self {
            state_dir: directory.path().join("state"),
            _directory: directory,
            box86,
            qemu,
            server: FakeServer::default(),
            settings: MediaSettings {
                max_concurrent_uploads: 2,
                max_upload_bytes: 1024 * 1024,
                reconcile_interval: Duration::from_secs(3600),
                retry_initial: Duration::from_millis(20),
                retry_ceiling: Duration::from_millis(100),
                stability_window: Duration::from_millis(100),
                transfer_wait: Duration::from_millis(500),
            },
        }
    }

    fn box86_vm(&self, name: &str) -> PathBuf {
        let root = self.box86.join(name);
        fs::create_dir_all(root.join("screenshots")).unwrap();
        fs::write(root.join("86box.cfg"), b"machine = x\n").unwrap();
        self.register(EmulatorType::Box86, name);
        root
    }

    fn qemu_vm(&self, name: &str) -> PathBuf {
        let root = self.qemu.join(name);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
        self.register(EmulatorType::Qemu, name);
        root
    }

    fn register(&self, emulator_type: EmulatorType, name: &str) {
        self.server.state.lock().unwrap().vms.push(VmIdentity {
            emulator_type,
            vm_name: VmName::new(name).unwrap(),
        });
    }

    fn start(&self) -> Running {
        let emulators: BTreeMap<EmulatorType, EmulatorConfig> = [
            (
                EmulatorType::Box86,
                EmulatorConfig {
                    base_path: self.box86.clone(),
                    executable: PathBuf::from("unused"),
                },
            ),
            (
                EmulatorType::Qemu,
                EmulatorConfig {
                    base_path: self.qemu.clone(),
                    executable: PathBuf::from("unused"),
                },
            ),
        ]
        .into();
        let sync = MediaSync::new(MediaSyncConfig {
            agent_id: AGENT,
            state_dir: self.state_dir.clone(),
            emulators: Arc::new(emulators),
            settings: self.settings.clone(),
            api: Arc::new(self.server.clone()),
            scan_limits: MediaScanLimits::default(),
        })
        .unwrap();
        let task = tokio::spawn(Arc::clone(&sync).run());
        Running { sync, task }
    }

    fn uploads(&self) -> Vec<(String, String, Vec<u8>)> {
        self.server.state.lock().unwrap().uploads.clone()
    }

    fn uploaded_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.uploads().into_iter().map(|upload| upload.1).collect();
        paths.sort();
        paths
    }

    async fn until(&self, what: &str, mut check: impl FnMut(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !check(self) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn until_uploaded(&self, count: usize) {
        self.until(&format!("{count} uploads"), |world| {
            world.uploads().len() >= count
        })
        .await;
    }
}

struct Running {
    sync: Arc<MediaSync>,
    task: tokio::task::JoinHandle<()>,
}

impl Running {
    async fn stop(self) {
        self.sync.shutdown();
        tokio::time::timeout(Duration::from_secs(10), self.task)
            .await
            .expect("stops promptly")
            .unwrap();
    }

    async fn settled(&self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let (pending, uploading, _, _) = self.sync.counts();
            if pending == 0 && uploading == 0 {
                return;
            }
            assert!(Instant::now() < deadline, "the queue never settled");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// Longer than anything a working watcher would need, for asserting that nothing happens.
async fn quiet_period() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

// The rules for what counts as a screenshot.

#[test]
fn the_paths_that_are_watched() {
    use EmulatorType::{Box86, Qemu};
    assert!(is_watched_media_path(Box86, "screenshots/one.png"));
    assert!(is_watched_media_path(Box86, "Screenshots/a/b/ONE.JPG"));
    assert!(is_watched_media_path(Box86, "screenshots/one.bmp"));
    assert!(!is_watched_media_path(Box86, "screenshots/notes.txt"));
    assert!(!is_watched_media_path(Box86, "one.png"));
    assert!(!is_watched_media_path(Box86, "disks/screenshots/one.png"));
    assert!(is_watched_media_path(Qemu, "one.ppm"));
    assert!(is_watched_media_path(Qemu, "ONE.PPM"));
    assert!(!is_watched_media_path(Qemu, "nested/one.ppm"));
    assert!(!is_watched_media_path(Qemu, "one.png"));
    assert!(!is_watched_media_path(Qemu, "screenshots/one.ppm"));
    assert!(!is_watched_media_path(Qemu, "../one.ppm"));
}

#[test]
fn a_scan_of_86box_covers_the_whole_tree_and_only_images() {
    let directory = TempDir::new().unwrap();
    let root = directory.path();
    fs::create_dir_all(root.join("Screenshots/a/b")).unwrap();
    fs::write(root.join("Screenshots/top.png"), b"1").unwrap();
    fs::write(root.join("Screenshots/a/b/deep.JPG"), b"2").unwrap();
    fs::write(root.join("Screenshots/notes.txt"), b"3").unwrap();
    fs::write(root.join("outside.png"), b"4").unwrap();
    let scan = scan_vm_media(root, EmulatorType::Box86, &MediaScanLimits::default()).unwrap();
    let names: Vec<&str> = scan
        .files
        .iter()
        .map(|file| file.source_path.as_str())
        .collect();
    assert_eq!(names, ["Screenshots/a/b/deep.JPG", "Screenshots/top.png"]);
}

#[test]
fn a_scan_of_qemu_looks_at_the_root_only() {
    let directory = TempDir::new().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("one.ppm"), b"1").unwrap();
    fs::write(root.join("TWO.PPM"), b"2").unwrap();
    fs::write(root.join("nested/three.ppm"), b"3").unwrap();
    fs::write(root.join("four.png"), b"4").unwrap();
    let scan = scan_vm_media(root, EmulatorType::Qemu, &MediaScanLimits::default()).unwrap();
    let names: Vec<&str> = scan
        .files
        .iter()
        .map(|file| file.source_path.as_str())
        .collect();
    assert_eq!(names, ["TWO.PPM", "one.ppm"]);
}

#[test]
fn a_scan_stops_at_its_limits() {
    let directory = TempDir::new().unwrap();
    let root = directory.path();
    fs::create_dir_all(root.join("screenshots/a/b/c")).unwrap();
    for index in 0..5 {
        fs::write(root.join(format!("screenshots/{index}.png")), b"x").unwrap();
    }
    fs::write(root.join("screenshots/a/b/c/deep.png"), b"x").unwrap();
    let scan = scan_vm_media(
        root,
        EmulatorType::Box86,
        &MediaScanLimits {
            max_files: 3,
            max_depth: 2,
        },
    )
    .unwrap();
    assert_eq!(scan.files.len(), 3);
    assert!(scan.truncated);
    assert!(
        !scan
            .files
            .iter()
            .any(|file| file.source_path.contains("deep"))
    );
}

#[test]
fn a_relative_path_cannot_leave_the_vm() {
    let directory = TempDir::new().unwrap();
    fs::write(directory.path().join("secret.png"), b"no").unwrap();
    let root = directory.path().join("vm");
    fs::create_dir(&root).unwrap();
    for path in ["../secret.png", "..\\secret.png", "C:/secret.png", ""] {
        assert!(matches!(
            checked_media_path(&root, path),
            Err(MediaFileProblem::Unsafe(_))
        ));
    }
}

#[test]
fn hashing_reads_the_whole_file() {
    let directory = TempDir::new().unwrap();
    let bytes = vec![7u8; 700_000];
    fs::write(directory.path().join("one.ppm"), &bytes).unwrap();
    let hashed = hash_media_file(directory.path(), "one.ppm").unwrap();
    assert_eq!(hashed.sha256, sha256(&bytes));
    assert_eq!(hashed.stamp.size_bytes, 700_000);
}

#[test]
fn only_changes_near_a_screenshot_mean_anything() {
    let base = Path::new("C:/vms");
    let box86 = EmulatorType::Box86;
    let qemu = EmulatorType::Qemu;
    let vm = Some("Win98".to_owned());
    assert_eq!(relevant_vm(box86, base, Path::new("C:/vms/Win98")), vm);
    assert_eq!(
        relevant_vm(box86, base, Path::new("C:/vms/Win98/screenshots/a/b.png")),
        vm
    );
    assert_eq!(
        relevant_vm(box86, base, Path::new("C:/vms/Win98/disk.img")),
        None
    );
    assert_eq!(
        relevant_vm(qemu, base, Path::new("C:/vms/Win98/shot.PPM")),
        vm
    );
    assert_eq!(
        relevant_vm(qemu, base, Path::new("C:/vms/Win98/nested/shot.ppm")),
        None
    );
    assert_eq!(
        relevant_vm(qemu, base, Path::new("C:/vms/Win98/disk.qcow2")),
        None
    );
    assert_eq!(
        relevant_vm(qemu, base, Path::new("C:/elsewhere/x.ppm")),
        None
    );
}

#[test]
fn answers_are_classified_by_what_they_say_about_the_bytes() {
    for (status, code) in [
        (413, "upload_too_large"),
        (415, "unsupported_image"),
        (422, "invalid_image"),
        (422, "image_too_large"),
        (400, "invalid_source_path"),
    ] {
        assert!(classify_response(status, code, "").is_permanent(), "{code}");
    }
    for (status, code) in [
        (401, "unauthorized"),
        (403, "vm_not_assigned"),
        (404, "vm_not_registered"),
        (408, "upload_timeout"),
        (422, "hash_mismatch"),
        (429, "rate_limited"),
        (500, "internal_error"),
        (503, "media_busy"),
        (503, "processing_timeout"),
    ] {
        assert!(
            !classify_response(status, code, "").is_permanent(),
            "{code}"
        );
    }
}

#[test]
fn the_wait_doubles_up_to_the_ceiling_with_jitter() {
    let initial = Duration::from_secs(5);
    let ceiling = Duration::from_secs(60);
    for _ in 0..100 {
        let first = retry_delay(1, initial, ceiling);
        assert!(first >= Duration::from_millis(2500) && first <= initial);
        let third = retry_delay(3, initial, ceiling);
        assert!(third >= Duration::from_secs(10) && third <= Duration::from_secs(20));
        let late = retry_delay(40, initial, ceiling);
        assert!(late >= Duration::from_secs(30) && late <= ceiling);
    }
}

// The queue.

fn stamp(size_bytes: u64) -> emucat_agent::media::MediaStamp {
    emucat_agent::media::MediaStamp {
        size_bytes,
        modified_ms: 1000,
    }
}

#[test]
fn the_queue_survives_a_restart_and_resumes_what_was_interrupted() {
    let directory = TempDir::new().unwrap();
    let vm = VmName::new("Win98").unwrap();
    let emulator = EmulatorType::Box86;
    {
        let mut queue = MediaQueue::load(directory.path(), AGENT).unwrap();
        assert!(queue.record(emulator, &vm, "screenshots/a.png", "aa", stamp(1)));
        assert!(queue.record(emulator, &vm, "screenshots/b.png", "bb", stamp(2)));
        queue.set_state(emulator, &vm, "screenshots/a.png", EntryState::Uploading);
        queue.set_state(emulator, &vm, "screenshots/b.png", EntryState::Completed);
        queue.save().unwrap();
    }
    let queue = MediaQueue::load(directory.path(), AGENT).unwrap();
    assert_eq!(queue.len(), 2);
    let a = queue.get(emulator, &vm, "screenshots/a.png").unwrap();
    assert_eq!(
        a.state,
        EntryState::Pending,
        "an interrupted upload starts over"
    );
    let b = queue.get(emulator, &vm, "screenshots/b.png").unwrap();
    assert_eq!(b.state, EntryState::Completed);
}

#[test]
fn identical_content_is_not_queued_twice_and_new_content_replaces_it() {
    let directory = TempDir::new().unwrap();
    let vm = VmName::new("Win98").unwrap();
    let emulator = EmulatorType::Qemu;
    let mut queue = MediaQueue::load(directory.path(), AGENT).unwrap();
    assert!(queue.record(emulator, &vm, "a.ppm", "aa", stamp(1)));
    queue.set_state(emulator, &vm, "a.ppm", EntryState::Completed);
    // Touched, with the same bytes.
    assert!(!queue.record(emulator, &vm, "a.ppm", "aa", stamp(9)));
    let entry = queue.get(emulator, &vm, "a.ppm").unwrap();
    assert_eq!(entry.state, EntryState::Completed);
    assert_eq!(entry.stamp, stamp(9));
    // Changed.
    assert!(queue.record(emulator, &vm, "a.ppm", "cc", stamp(10)));
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue.get(emulator, &vm, "a.ppm").unwrap().state,
        EntryState::Pending
    );
}

#[test]
fn a_damaged_queue_is_kept_aside_and_does_not_stop_the_agent() {
    let directory = TempDir::new().unwrap();
    let path = queue_path(directory.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{ not json").unwrap();
    let queue = MediaQueue::load(directory.path(), AGENT).unwrap();
    assert!(queue.is_empty());
    assert!(path.with_extension("damaged").exists());
}

#[test]
fn a_queue_from_another_identity_is_not_used() {
    let directory = TempDir::new().unwrap();
    let vm = VmName::new("Win98").unwrap();
    let mut queue = MediaQueue::load(directory.path(), AGENT).unwrap();
    queue.record(EmulatorType::Qemu, &vm, "a.ppm", "aa", stamp(1));
    queue.save().unwrap();
    let other = MediaQueue::load(directory.path(), Uuid::from_u128(5)).unwrap();
    assert!(other.is_empty());
}

// The watcher, end to end against the stand-in.

#[tokio::test]
async fn existing_screenshots_are_found_at_startup_in_a_stopped_vm() {
    let world = World::new();
    let box86 = world.box86_vm("Win98");
    fs::create_dir_all(box86.join("screenshots/nested/deep")).unwrap();
    fs::write(box86.join("screenshots/top.png"), b"top").unwrap();
    fs::write(box86.join("screenshots/nested/deep/low.png"), b"low").unwrap();
    fs::write(box86.join("screenshots/ignored.txt"), b"not an image").unwrap();
    let qemu = world.qemu_vm("Dos");
    fs::create_dir(qemu.join("nested")).unwrap();
    fs::write(qemu.join("screenshot001.ppm"), b"P6 one").unwrap();
    fs::write(qemu.join("nested/not-this.ppm"), b"P6 two").unwrap();
    fs::write(qemu.join("not-this.png"), b"png").unwrap();

    let running = world.start();
    world.until_uploaded(3).await;
    running.settled().await;
    quiet_period().await;
    assert_eq!(
        world.uploaded_paths(),
        [
            "screenshot001.ppm",
            "screenshots/nested/deep/low.png",
            "screenshots/top.png"
        ]
    );
    running.stop().await;
}

#[tokio::test]
async fn new_and_modified_screenshots_are_noticed_and_unchanged_ones_are_not() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("first.ppm"), b"first").unwrap();
    let running = world.start();
    world.until_uploaded(1).await;

    fs::write(root.join("second.ppm"), b"second").unwrap();
    world.until_uploaded(2).await;

    fs::write(root.join("second.ppm"), b"second, changed").unwrap();
    world.until_uploaded(3).await;
    assert_eq!(world.uploads()[2].2, b"second, changed");

    // Neither a disk write nor a reconciliation sends anything again.
    fs::write(root.join("disk.qcow2"), vec![1u8; 4096]).unwrap();
    running.sync.on_connected();
    running.settled().await;
    quiet_period().await;
    assert_eq!(world.uploads().len(), 3);
    running.stop().await;
}

#[tokio::test]
async fn a_new_directory_of_screenshots_is_noticed() {
    let world = World::new();
    let root = world.box86_vm("Win98");
    fs::remove_dir(root.join("screenshots")).unwrap();
    let running = world.start();
    running.settled().await;
    quiet_period().await;

    fs::create_dir_all(root.join("screenshots/today")).unwrap();
    fs::write(root.join("screenshots/today/one.png"), b"one").unwrap();
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn a_file_is_not_uploaded_until_it_stops_changing() {
    let mut world = World::new();
    world.settings.stability_window = Duration::from_millis(400);
    let root = world.qemu_vm("Dos");
    let running = world.start();
    let path = root.join("growing.ppm");
    for size in 1..=8usize {
        fs::write(&path, vec![b'x'; size * 1000]).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(world.uploads().is_empty(), "uploaded while being written");
    world.until_uploaded(1).await;
    assert_eq!(world.uploads()[0].2.len(), 8000);
    quiet_period().await;
    assert_eq!(world.uploads().len(), 1, "partial versions were never sent");
    running.stop().await;
}

#[tokio::test]
async fn a_deleted_screenshot_stays_on_the_server() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    let path = root.join("gone.ppm");
    fs::write(&path, b"keep me").unwrap();
    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;

    fs::remove_file(&path).unwrap();
    let held = (key_of(EmulatorType::Qemu, "Dos"), sha256(b"keep me"));
    world
        .until("the queue to forget the file", |_| {
            running.sync.counts().2 == 0
        })
        .await;
    assert!(world.server.state.lock().unwrap().held.contains(&held));
    // The stand-in has no way to delete, and neither does the real interface: nothing could be called.
    running.stop().await;
}

fn key_of(emulator_type: EmulatorType, name: &str) -> String {
    key(&VmIdentity {
        emulator_type,
        vm_name: VmName::new(name).unwrap(),
    })
}

#[tokio::test]
async fn a_vm_nobody_registered_uploads_nothing() {
    let world = World::new();
    let registered = world.qemu_vm("Registered");
    fs::write(registered.join("yes.ppm"), b"yes").unwrap();
    // On the disk, with a marker and a screenshot, and not registered.
    let other = world.qemu.join("Discovered");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("run.bat"), b"@echo x\n").unwrap();
    fs::write(other.join("no.ppm"), b"no").unwrap();

    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;
    quiet_period().await;
    assert_eq!(world.uploaded_paths(), ["yes.ppm"]);
    running.stop().await;
}

#[tokio::test]
async fn a_registered_vm_with_no_directory_is_not_a_problem() {
    let world = World::new();
    world.register(EmulatorType::Qemu, "Absent");
    let present = world.qemu_vm("Present");
    fs::write(present.join("one.ppm"), b"one").unwrap();
    let running = world.start();
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn missing_base_paths_are_not_a_problem() {
    let world = World::new();
    fs::remove_dir(&world.box86).unwrap();
    fs::remove_dir(&world.qemu).unwrap();
    world.register(EmulatorType::Qemu, "Dos");
    let running = world.start();
    running.settled().await;
    quiet_period().await;
    assert!(world.uploads().is_empty());
    running.stop().await;
}

#[cfg(windows)]
#[tokio::test]
async fn links_and_junctions_are_not_followed() {
    let world = World::new();
    let root = world.box86_vm("Win98");
    fs::write(root.join("screenshots/real.png"), b"real").unwrap();
    let outside = world.box86.parent().unwrap().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.png"), b"private").unwrap();
    junction(&root.join("screenshots").join("linked"), &outside);

    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;
    quiet_period().await;
    assert_eq!(world.uploaded_paths(), ["screenshots/real.png"]);
    running.stop().await;
}

#[cfg(windows)]
#[tokio::test]
async fn a_screenshots_directory_that_is_a_junction_is_not_followed() {
    let world = World::new();
    let root = world.box86_vm("Win98");
    fs::remove_dir(root.join("screenshots")).unwrap();
    let outside = world.box86.parent().unwrap().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.png"), b"private").unwrap();
    junction(&root.join("screenshots"), &outside);

    let running = world.start();
    running.settled().await;
    quiet_period().await;
    assert!(world.uploads().is_empty());
    running.stop().await;
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn a_restart_uploads_nothing_new() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    fs::write(root.join("two.ppm"), b"two").unwrap();
    let running = world.start();
    world.until_uploaded(2).await;
    running.settled().await;
    running.stop().await;

    let running = world.start();
    running.settled().await;
    quiet_period().await;
    assert_eq!(world.uploads().len(), 2);

    // And a file taken while it was away is picked up.
    fs::write(root.join("three.ppm"), b"three").unwrap();
    world.until_uploaded(3).await;
    running.stop().await;
}

#[tokio::test]
async fn a_lost_queue_is_rebuilt_from_the_servers_answers_without_uploading() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;
    running.stop().await;

    fs::remove_file(queue_path(&world.state_dir)).unwrap();
    let running = world.start();
    world
        .until("the server's answer", |_| running.sync.counts().2 == 1)
        .await;
    quiet_period().await;
    assert_eq!(world.uploads().len(), 1);
    running.stop().await;
}

#[tokio::test]
async fn content_the_server_already_has_is_not_sent_again() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"same bytes").unwrap();
    fs::write(root.join("two.ppm"), b"same bytes").unwrap();
    world
        .server
        .state
        .lock()
        .unwrap()
        .held
        .insert((key_of(EmulatorType::Qemu, "Dos"), sha256(b"same bytes")));
    let running = world.start();
    world
        .until("both to be known", |_| running.sync.counts().2 == 2)
        .await;
    assert!(world.uploads().is_empty());
    running.stop().await;
}

#[tokio::test]
async fn a_passing_failure_is_retried_until_it_works() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    {
        let mut state = world.server.state.lock().unwrap();
        for code in ["server_unreachable", "media_busy", "unauthorized"] {
            state.upload_failures.push_back(transient(code));
        }
    }
    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;
    assert_eq!(running.sync.counts().3, 0);
    running.stop().await;
}

#[tokio::test]
async fn a_refused_image_is_not_sent_again() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("bad.ppm"), b"corrupt").unwrap();
    world
        .server
        .state
        .lock()
        .unwrap()
        .upload_failures
        .push_back(ApiFailure::Permanent {
            code: "invalid_image".to_owned(),
            message: "The image could not be decoded".to_owned(),
        });
    let running = world.start();
    world
        .until("it to be marked as failed", |_| {
            running.sync.counts().3 == 1
        })
        .await;
    running.sync.on_connected();
    quiet_period().await;
    assert!(world.uploads().is_empty(), "it was sent again");

    // The status says why, and which file.
    let Some(Message::AgentMediaSyncStatus(status)) = running.sync.status_message() else {
        panic!("a status was due");
    };
    let vm = &status.vms[0];
    assert_eq!(vm.failed, 1);
    let error = vm.last_error.as_ref().unwrap();
    assert_eq!(error.code, "invalid_image");
    assert_eq!(error.source_path.as_deref(), Some("bad.ppm"));

    // Changing the file makes it new content, which gets its chance.
    fs::write(root.join("bad.ppm"), b"now fine").unwrap();
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn a_file_over_the_limit_is_not_sent() {
    let mut world = World::new();
    world.settings.max_upload_bytes = 10;
    let root = world.qemu_vm("Dos");
    fs::write(root.join("big.ppm"), vec![1u8; 100]).unwrap();
    let running = world.start();
    world
        .until("it to be marked as failed", |_| {
            running.sync.counts().3 == 1
        })
        .await;
    quiet_period().await;
    assert!(world.uploads().is_empty());
    running.stop().await;
}

#[tokio::test]
async fn uploads_run_within_the_limit() {
    let mut world = World::new();
    world.settings.max_concurrent_uploads = 2;
    let root = world.qemu_vm("Dos");
    for index in 0..8 {
        fs::write(root.join(format!("{index}.ppm")), format!("{index}")).unwrap();
    }
    world.server.state.lock().unwrap().upload_delay = Duration::from_millis(30);
    let running = world.start();
    world.until_uploaded(8).await;
    assert_eq!(world.server.state.lock().unwrap().max_concurrent_seen, 2);
    running.stop().await;
}

#[tokio::test]
async fn the_list_of_vms_is_retried_and_reconnection_asks_again() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    world.server.state.lock().unwrap().list_failures = 2;
    let running = world.start();
    world.until_uploaded(1).await;
    assert!(world.server.state.lock().unwrap().list_calls >= 3);

    let calls = world.server.state.lock().unwrap().list_calls;
    running.sync.on_connected();
    world
        .until("the server to be asked again", |world| {
            world.server.state.lock().unwrap().list_calls > calls
        })
        .await;
    quiet_period().await;
    assert_eq!(
        world.uploads().len(),
        1,
        "a reconnection duplicated an upload"
    );
    running.stop().await;
}

#[tokio::test]
async fn a_vm_registered_later_is_picked_up_when_asked() {
    let world = World::new();
    let root = world.qemu.join("Later");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("run.bat"), b"@echo x\n").unwrap();
    fs::write(root.join("one.ppm"), b"one").unwrap();
    let running = world.start();
    running.settled().await;
    quiet_period().await;
    assert!(world.uploads().is_empty());

    world.register(EmulatorType::Qemu, "Later");
    running.sync.request_sync(&VmIdentity {
        emulator_type: EmulatorType::Qemu,
        vm_name: VmName::new("Later").unwrap(),
    });
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn stopping_is_prompt_even_during_an_upload_and_nothing_is_lost() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("slow.ppm"), b"slow").unwrap();
    world.server.state.lock().unwrap().upload_delay = Duration::from_secs(3600);
    let running = world.start();
    world
        .until("the upload to start", |_| running.sync.counts().1 == 1)
        .await;
    running.stop().await;

    world.server.state.lock().unwrap().upload_delay = Duration::ZERO;
    world.server.state.lock().unwrap().concurrent = 0;
    let running = world.start();
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn a_held_vm_is_left_alone_until_released() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    let vm = VmIdentity {
        emulator_type: EmulatorType::Qemu,
        vm_name: VmName::new("Dos").unwrap(),
    };
    let running = world.start();
    running.settled().await;
    quiet_period().await;
    running.sync.hold(&vm, true);
    fs::write(root.join("one.ppm"), b"one").unwrap();
    quiet_period().await;
    assert!(world.uploads().is_empty());
    running.sync.hold(&vm, false);
    world.until_uploaded(1).await;
    running.stop().await;
}

#[tokio::test]
async fn a_status_message_is_only_due_after_a_change_and_after_a_reconnection() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    let running = world.start();
    world.until_uploaded(1).await;
    running.settled().await;
    assert!(running.sync.status_message().is_some());
    assert!(running.sync.status_message().is_none());
    running.sync.on_connected();
    let Some(Message::AgentMediaSyncStatus(status)) = running.sync.status_message() else {
        panic!("a reconnection makes a status due");
    };
    assert_eq!(status.vms[0].synchronized, 1);
    assert!(status.vms[0].last_error.is_none());
    running.stop().await;
}

#[test]
fn the_largest_status_message_fits_in_a_protocol_message() {
    use emucat_agent::protocol::{
        AGENT_MAX_MESSAGE_BYTES, Envelope, MEDIA_STATUS_MAX_VMS, MediaSyncError, MediaSyncVmStatus,
    };
    let vms: Vec<MediaSyncVmStatus> = (0..MEDIA_STATUS_MAX_VMS + 50)
        .map(|index| MediaSyncVmStatus {
            emulator_type: EmulatorType::Box86,
            vm_name: VmName::new(format!("{index:0>64}")).unwrap(),
            pending: u32::MAX,
            uploading: u32::MAX,
            synchronized: u32::MAX,
            failed: u32::MAX,
            last_error: Some(MediaSyncError {
                code: "x".repeat(64),
                message: "é".repeat(256),
                source_path: Some("é".repeat(256)),
            }),
        })
        .collect();
    let status = bounded_status(vms);
    assert!(status.truncated);
    assert!(!status.vms.is_empty());
    let message = Envelope::new(Message::AgentMediaSyncStatus(status));
    let size = serde_json::to_string(&message).unwrap().len();
    assert!(size < AGENT_MAX_MESSAGE_BYTES, "{size}");
}

#[test]
fn authorization_failures_wait_for_a_change_instead_of_a_timer() {
    let reason = |status, code| classify_response(status, code, "").block_reason();
    // The credential: a revoked agent stops on its connection, and an expired one recovers there.
    assert_eq!(reason(401, "unauthorized"), Some(BlockReason::Credential));
    // The association: only the server listing the VM makes another attempt worth anything.
    assert_eq!(reason(403, "vm_not_assigned"), Some(BlockReason::Vm));
    assert_eq!(reason(404, "vm_not_registered"), Some(BlockReason::Vm));
    // A 404 without the API's own code is a proxy having a bad day, and that passes.
    assert_eq!(reason(404, "unreachable"), None);
    assert!(!classify_response(404, "unreachable", "").is_permanent());
    // Passing problems keep their backoff.
    for status in [408, 429, 500, 502, 503, 504] {
        assert_eq!(reason(status, "busy"), None, "{status}");
        assert!(!classify_response(status, "busy", "").is_permanent());
    }
    // None of these say anything about the bytes, so none of them can end an entry for good.
    for (status, code) in [(401, "x"), (403, "x"), (404, "vm_not_registered")] {
        assert!(!classify_response(status, code, "").is_permanent());
    }
}

fn blocked(code: &str, reason: BlockReason) -> ApiFailure {
    ApiFailure::Blocked {
        code: code.to_owned(),
        message: "refused".to_owned(),
        reason,
    }
}

fn queue_refusals(world: &World, failure: &ApiFailure, count: usize) {
    let mut state = world.server.state.lock().unwrap();
    for _ in 0..count {
        state.upload_failures.push_back(failure.clone());
    }
}

fn refusals_left(world: &World) -> usize {
    world.server.state.lock().unwrap().upload_failures.len()
}

#[tokio::test]
async fn a_forbidden_vm_is_not_retried_on_a_timer_and_the_file_stays() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    queue_refusals(&world, &blocked("vm_not_assigned", BlockReason::Vm), 3);
    let running = world.start();
    world
        .until("the refusal", |_| running.sync.counts().3 == 1)
        .await;
    let left = refusals_left(&world);
    assert_eq!(left, 2, "one attempt so far");

    // With a retry delay of a few milliseconds, a timer would have used these up long before this ends.
    quiet_period().await;
    assert_eq!(refusals_left(&world), left, "it was sent again on a timer");
    assert!(world.uploads().is_empty());
    assert!(root.join("one.ppm").exists(), "the file is not discarded");

    // The status says why, and a transfer would see it as a reason to keep the VM.
    let Some(Message::AgentMediaSyncStatus(status)) = running.sync.status_message() else {
        panic!("a status was due");
    };
    assert_eq!(status.vms[0].failed, 1);
    assert_eq!(
        status.vms[0].last_error.as_ref().unwrap().code,
        "vm_not_assigned"
    );
    running.stop().await;
}

#[tokio::test]
async fn an_unknown_vm_goes_when_the_server_lists_it_again() {
    let mut world = World::new();
    world.settings.reconcile_interval = Duration::from_millis(150);
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    queue_refusals(&world, &blocked("vm_not_registered", BlockReason::Vm), 1);
    let running = world.start();
    // Listed by the server, which is the change it was waiting for. It takes one attempt, and it works.
    world.until_uploaded(1).await;
    assert_eq!(refusals_left(&world), 0);
    assert_eq!(running.sync.counts().3, 0);
    running.stop().await;
}

#[tokio::test]
async fn a_refused_credential_stops_every_upload_until_the_connection_proves_it_works() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    for name in ["one.ppm", "two.ppm", "three.ppm"] {
        fs::write(root.join(name), name.as_bytes()).unwrap();
    }
    world.server.state.lock().unwrap().upload_delay = Duration::from_millis(20);
    queue_refusals(&world, &blocked("unauthorized", BlockReason::Credential), 2);
    let running = world.start();
    world
        .until("the refusals", |_| refusals_left(&world) == 0)
        .await;
    quiet_period().await;
    let sent_before = world.uploads().len();
    fs::write(root.join("four.ppm"), b"four").unwrap();
    quiet_period().await;
    assert_eq!(
        world.uploads().len(),
        sent_before,
        "nothing goes while the credential is refused"
    );

    // Recovery: the connection worked, which is what this was waiting for. Nothing was lost.
    running.sync.on_connected();
    world.until_uploaded(4).await;
    assert_eq!(running.sync.counts().3, 0);
    running.stop().await;
}

#[tokio::test]
async fn a_blocked_entry_survives_a_restart_and_goes_on_the_next_connection() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    queue_refusals(&world, &blocked("vm_not_assigned", BlockReason::Vm), 1);
    let running = world.start();
    world
        .until("the refusal", |_| running.sync.counts().3 == 1)
        .await;
    running.stop().await;

    let restarted = world.start();
    world.until_uploaded(1).await;
    assert_eq!(world.uploaded_paths(), ["one.ppm"]);
    restarted.stop().await;
}

#[tokio::test]
async fn a_busy_server_is_still_retried_with_backoff() {
    let world = World::new();
    let root = world.qemu_vm("Dos");
    fs::write(root.join("one.ppm"), b"one").unwrap();
    for (status, code) in [(503, "media_busy"), (500, "x"), (429, "x"), (408, "x")] {
        let failure = classify_response(status, code, "");
        assert!(failure.block_reason().is_none() && !failure.is_permanent());
        queue_refusals(&world, &failure, 1);
    }
    let running = world.start();
    world.until_uploaded(1).await;
    assert_eq!(refusals_left(&world), 0);
    running.stop().await;
}

#[tokio::test]
async fn capture_spool_uses_the_existing_uploader_without_a_persistent_vm() {
    let world = World::new();
    let id = Uuid::new_v4();
    let root = world.state_dir.join("captures").join(id.to_string());
    fs::create_dir_all(&root).unwrap();
    let bytes = b"P6\n1 1\n255\n\xff\0\0";
    fs::write(root.join("ready.ppm"), bytes).unwrap();
    let vm = VmIdentity {
        emulator_type: EmulatorType::Qemu,
        vm_name: VmName::new("Remote only").unwrap(),
    };
    let hashed = hash_media_file(&root, "ready.ppm").unwrap();
    let running = world.start();
    running.sync.hold(&vm, true); // A persistent-copy move never touches the capture spool.
    running
        .sync
        .enqueue_capture(id, &vm, &hashed.sha256, hashed.stamp);
    world.until_uploaded(1).await;
    assert_eq!(world.uploads()[0].2, bytes);
    assert_eq!(
        world.uploads()[0].1,
        emucat_agent::capture::source_label(id)
    );
    running.sync.on_connected();
    quiet_period().await;
    assert_eq!(world.uploads().len(), 1);
    assert!(
        root.join("ready.ppm").exists(),
        "HTTP success alone never removes the spool image"
    );
    running.stop().await;
}

#[tokio::test]
async fn capture_failures_retain_output_and_allow_explicit_retry() {
    for (status, code) in [
        (413, "upload_too_large"),
        (401, "unauthorized"),
        (403, "vm_not_assigned"),
        (500, "server_error"),
        (408, "upload_timeout"),
    ] {
        let world = World::new();
        let id = Uuid::new_v4();
        let root = world.state_dir.join("captures").join(id.to_string());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ready.ppm"), b"P6\n1 1\n255\n\xff\0\0").unwrap();
        let vm = VmIdentity {
            emulator_type: EmulatorType::Qemu,
            vm_name: VmName::new("Temporary VM").unwrap(),
        };
        let hashed = hash_media_file(&root, "ready.ppm").unwrap();
        let count = if status >= 500 || status == 408 { 5 } else { 1 };
        queue_refusals(
            &world,
            &classify_response(status, code, "Retained test image"),
            count,
        );
        let running = world.start();
        running
            .sync
            .enqueue_capture(id, &vm, &hashed.sha256, hashed.stamp);
        world
            .until("capture failure status", |_| {
                running.sync.capture_error(id, &vm).is_some()
            })
            .await;
        assert!(root.join("ready.ppm").exists());
        assert!(world.uploads().is_empty());
        // Prove retries are bounded even if the connection remains available.
        quiet_period().await;
        assert_eq!(refusals_left(&world), 0);
        running.sync.on_connected();
        running.sync.retry_capture(id, &vm);
        world.until_uploaded(1).await;
        assert!(root.join("ready.ppm").exists());
        running.stop().await;
    }
}
