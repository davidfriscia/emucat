//! `SftpArchiveRepository` against a real OpenSSH server in a container, restricted the way the
//! repository guide recommends. Nothing here is a mock: each test starts its own server, with its own
//! keys, and removes it afterwards.
//!
//! These need Docker and `ssh-keygen`, so `cargo test` skips them. `pnpm test:sftp` runs them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use emucat_agent::credentials::Secret;
use emucat_agent::packaging::hex;
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, RepositoryErrorKind as Kind, RepositoryKey, no_progress,
};
use emucat_agent::sftp::{HostKeyPolicy, SftpArchiveRepository, SftpSettings};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const IMAGE: &str = "emucat-sftp-test:local";

fn docker(args: &[&str]) -> std::process::Output {
    Command::new("docker")
        .args(args)
        .output()
        .expect("Docker must be installed for these tests")
}

fn docker_ok(args: &[&str]) -> String {
    let output = docker(args);
    assert!(
        output.status.success(),
        "docker {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn build_image() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| {
        let context = Path::new(env!("CARGO_MANIFEST_DIR")).join("../infra/docker/sftp-test");
        docker_ok(&["build", "-q", "-t", IMAGE, context.to_str().unwrap()]);
    });
}

/// A new key pair. Returns the private key's path; the public key is next to it, as `.pub`.
fn generate_key(directory: &Path, name: &str, passphrase: &str) -> PathBuf {
    let path = directory.join(name);
    let output = Command::new("ssh-keygen")
        .args([
            "-q",
            "-t",
            "ed25519",
            "-C",
            "emucat-test",
            "-N",
            passphrase,
            "-f",
        ])
        .arg(&path)
        .output()
        .expect("ssh-keygen must be installed for these tests");
    assert!(output.status.success(), "{output:?}");
    path
}

fn fingerprint_of(key: &Path) -> String {
    let output = Command::new("ssh-keygen")
        .arg("-lf")
        .arg(key.with_extension("pub"))
        .output()
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    text.split_whitespace().nth(1).unwrap().to_owned()
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::new();
    for chunk in bytes.chunks(3) {
        let group = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                text.push(TABLE[(group >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}

struct Server {
    container: String,
    port: u16,
    directory: TempDir,
    client_key: PathBuf,
    host_key: PathBuf,
}

impl Server {
    fn start() -> Self {
        Self::start_with(&[], &[])
    }

    fn start_with(extra_env: &[(&str, &str)], extra_args: &[&str]) -> Self {
        build_image();
        let directory = TempDir::new().unwrap();
        let client_key = generate_key(directory.path(), "client", "");
        let host_key = generate_key(directory.path(), "host", "");
        let server = Self::run(directory, client_key, host_key, extra_env, extra_args);
        server.wait_until_ready();
        server
    }

    fn run(
        directory: TempDir,
        client_key: PathBuf,
        host_key: PathBuf,
        extra_env: &[(&str, &str)],
        extra_args: &[&str],
    ) -> Self {
        let container = format!("emucat-sftp-test-{}", Uuid::new_v4().simple());
        let host_key_env = format!("HOST_KEY_B64={}", base64(&fs::read(&host_key).unwrap()));
        let authorized_env = format!(
            "AUTHORIZED_KEY={}",
            fs::read_to_string(client_key.with_extension("pub"))
                .unwrap()
                .trim()
        );
        let mut args = vec![
            "run",
            "-d",
            "--rm",
            "--name",
            &container,
            "-p",
            "127.0.0.1:0:22",
            "--tmpfs",
            "/srv/sftp/repo:size=64m",
            "-e",
            &host_key_env,
            "-e",
            &authorized_env,
        ];
        let env_args: Vec<String> = extra_env
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect();
        for value in &env_args {
            args.push("-e");
            args.push(value);
        }
        args.extend_from_slice(extra_args);
        args.push(IMAGE);
        docker_ok(&args);
        let mapping = docker_ok(&["port", &container, "22/tcp"]);
        let port = mapping.rsplit(':').next().unwrap().parse().unwrap();
        Self {
            container,
            port,
            directory,
            client_key,
            host_key,
        }
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            use std::io::Read;
            let banner =
                std::net::TcpStream::connect(("127.0.0.1", self.port)).and_then(|mut s| {
                    s.set_read_timeout(Some(Duration::from_secs(1)))?;
                    let mut buffer = [0u8; 4];
                    s.read_exact(&mut buffer)?;
                    Ok(buffer)
                });
            if matches!(banner, Ok(ref bytes) if bytes == b"SSH-") {
                return;
            }
            assert!(Instant::now() < deadline, "the SFTP server did not start");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn settings(&self) -> SftpSettings {
        SftpSettings {
            host: "127.0.0.1".to_owned(),
            port: self.port,
            username: "emucat".to_owned(),
            remote_root: "/repo".to_owned(),
            private_key: self.client_key.clone(),
            passphrase: None,
            host_keys: HostKeyPolicy {
                pinned_fingerprints: vec![fingerprint_of(&self.host_key)],
                known_hosts: None,
            },
            connect_timeout: Duration::from_secs(15),
            transfer_timeout: Duration::from_secs(20),
            connect_retries: 0,
        }
    }

    fn repository(&self) -> SftpArchiveRepository {
        SftpArchiveRepository::new(self.settings()).unwrap()
    }

    /// A command inside the container, as root.
    fn exec(&self, command: &str) -> String {
        docker_ok(&["exec", &self.container, "sh", "-c", command])
    }

    fn remote_files(&self) -> Vec<String> {
        let listing = self.exec("cd /srv/sftp/repo && find . -type f | sort");
        listing
            .lines()
            .map(|line| line.trim_start_matches("./").to_owned())
            .collect()
    }

    fn local_file(&self, name: &str, contents: &[u8]) -> PathBuf {
        let path = self.directory.path().join(name);
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = docker(&["rm", "-f", &self.container]);
    }
}

fn pseudo_random(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut bytes = Vec::with_capacity(length + 8);
    while bytes.len() < length {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes.truncate(length);
    bytes
}

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn final_key(name: &str) -> RepositoryKey {
    RepositoryKey::new(format!("archives/qemu/{name}/{}.zip", Uuid::new_v4())).unwrap()
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_health_check_proves_everything_and_leaves_nothing_behind() {
    let server = Server::start();
    let existing = server.local_file("existing.bin", b"an archive that must survive");
    let repository = server.repository();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let cancel = CancelFlag::new();
    repository
        .upload(&staging, &existing, no_progress(), &cancel)
        .await
        .unwrap();

    let report = repository.health_check(&cancel).await.unwrap();
    assert!(report.root_readable);
    assert!(report.root_writable);
    assert!(report.no_overwrite_publication);
    assert_eq!(
        report.host_key_fingerprint.as_deref(),
        Some(fingerprint_of(&server.host_key).as_str())
    );
    assert!(report.free_bytes.is_some_and(|free| free > 0));

    assert_eq!(
        server.remote_files(),
        [staging.as_str()],
        "only the object that was already there remains"
    );
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn the_wrong_client_key_is_refused() {
    let server = Server::start();
    let other = generate_key(server.directory.path(), "other", "");
    let mut settings = server.settings();
    settings.private_key = other;
    let error = SftpArchiveRepository::new(settings)
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::AuthenticationFailed, "{error}");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_key_with_a_passphrase_needs_the_right_one_and_never_reveals_it() {
    let server = Server::start();
    let secret = "correct horse battery";
    let encrypted = generate_key(server.directory.path(), "encrypted", secret);
    let public = fs::read_to_string(encrypted.with_extension("pub")).unwrap();
    server.exec(&format!(
        "printf '%s\\n' '{}' >> /home/emucat/.ssh/authorized_keys",
        public.trim()
    ));

    let mut settings = server.settings();
    settings.private_key = encrypted;
    settings.passphrase = Some(Secret::new(secret));
    SftpArchiveRepository::new(settings.clone())
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap();

    settings.passphrase = Some(Secret::new("not-the-passphrase"));
    let wrong = SftpArchiveRepository::new(settings.clone())
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(wrong.kind, Kind::NotConfigured);
    assert!(!wrong.message.contains("not-the-passphrase"));

    assert!(!format!("{settings:?}").contains(secret));
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn host_key_policy_is_mandatory() {
    let mut settings = Server::start().settings();
    settings.host_keys = HostKeyPolicy::default();
    assert_eq!(
        SftpArchiveRepository::new(settings).err().unwrap().kind,
        Kind::NotConfigured
    );
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_pinned_key_that_differs_is_refused_before_authenticating() {
    let server = Server::start();
    let elsewhere = generate_key(server.directory.path(), "elsewhere", "");
    let mut settings = server.settings();
    settings.host_keys.pinned_fingerprints = vec![fingerprint_of(&elsewhere)];
    let error = SftpArchiveRepository::new(settings)
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::HostKeyChanged, "{error}");
    assert!(error.message.contains(&fingerprint_of(&server.host_key)));
    let log = docker(&["logs", &server.container]);
    let log = String::from_utf8_lossy(&log.stderr);
    assert!(!log.contains("Accepted publickey"), "{log}");
}

fn known_hosts_line(server: &Server, host_key: &Path) -> String {
    let public = fs::read_to_string(host_key.with_extension("pub")).unwrap();
    let mut parts = public.split_whitespace();
    let (kind, key) = (parts.next().unwrap(), parts.next().unwrap());
    format!("[127.0.0.1]:{} {kind} {key}\n", server.port)
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_known_hosts_file_trusts_the_right_key_and_nothing_else() {
    let server = Server::start();
    let path = server.directory.path().join("known_hosts");
    let mut settings = server.settings();
    settings.host_keys = HostKeyPolicy {
        pinned_fingerprints: Vec::new(),
        known_hosts: Some(path.clone()),
    };

    fs::write(&path, known_hosts_line(&server, &server.host_key)).unwrap();
    SftpArchiveRepository::new(settings.clone())
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap();

    // Not listed at all: unknown, and not added.
    fs::write(&path, "[elsewhere.test]:22 ssh-ed25519 AAAA\n").unwrap();
    let unknown = SftpArchiveRepository::new(settings.clone())
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(unknown.kind, Kind::HostKeyUnknown, "{unknown}");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "[elsewhere.test]:22 ssh-ed25519 AAAA\n",
        "an unknown key is never trusted automatically"
    );

    // Listed with another key: changed.
    let other = generate_key(server.directory.path(), "other-host", "");
    fs::write(&path, known_hosts_line(&server, &other)).unwrap();
    let changed = SftpArchiveRepository::new(settings)
        .unwrap()
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(changed.kind, Kind::HostKeyChanged, "{changed}");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn an_unreachable_server_is_reported_as_such_after_its_retries() {
    let server = Server::start();
    let mut settings = server.settings();
    settings.port = 1;
    settings.connect_retries = 1;
    let started = Instant::now();
    let error = SftpArchiveRepository::new(settings)
        .unwrap()
        .stat(&final_key("gone"))
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::Unreachable, "{error}");
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "it retried"
    );
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn upload_stat_verify_publish_and_download_round_trip_a_large_object() {
    let server = Server::start();
    let content = pseudo_random(32 * 1024 * 1024 + 123);
    let source = server.local_file("source.zip", &content);
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let target = final_key("win 98");

    assert_eq!(repository.stat(&staging).await.unwrap(), None);

    let reports = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&reports);
    let uploaded = repository
        .upload(
            &staging,
            &source,
            Arc::new(move |done, total| sink.lock().unwrap().push((done, total))),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(uploaded.size_bytes, content.len() as u64);
    let seen = reports.lock().unwrap().clone();
    assert!(seen.len() > 10, "progress is reported as it happens");
    assert!(seen.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    assert_eq!(
        *seen.last().unwrap(),
        (content.len() as u64, content.len() as u64)
    );

    assert_eq!(
        repository.stat(&staging).await.unwrap().unwrap().size_bytes,
        content.len() as u64
    );
    let verified = repository
        .verify(
            &staging,
            content.len() as u64,
            &sha(&content),
            no_progress(),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(verified.sha256, sha(&content));

    repository.publish(&staging, &target).await.unwrap();
    assert_eq!(
        repository.stat(&staging).await.unwrap(),
        None,
        "staging is gone"
    );
    assert!(repository.stat(&target).await.unwrap().is_some());

    let downloaded_path = server.directory.path().join("downloaded.zip");
    let downloaded = repository
        .download(&target, &downloaded_path, no_progress(), &cancel)
        .await
        .unwrap();
    assert_eq!(downloaded.sha256, sha(&content));
    assert_eq!(fs::read(&downloaded_path).unwrap(), content);

    // The server's own tools agree with what the agent computed.
    let remote = server.exec(&format!(
        "sha256sum '/srv/sftp/repo/{}' | cut -d' ' -f1",
        target.as_str()
    ));
    assert_eq!(remote, sha(&content));
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn verification_reads_the_stored_bytes_and_notices_a_changed_byte_of_the_same_size() {
    let server = Server::start();
    let content = pseudo_random(1024 * 1024);
    let source = server.local_file("source.zip", &content);
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    repository
        .upload(&staging, &source, no_progress(), &cancel)
        .await
        .unwrap();

    server.exec(&format!(
        "printf 'X' | dd of='/srv/sftp/repo/{}' bs=1 seek=1000 conv=notrunc 2>/dev/null",
        staging.as_str()
    ));
    assert_eq!(
        repository.stat(&staging).await.unwrap().unwrap().size_bytes,
        content.len() as u64,
        "the size alone does not show it"
    );
    let error = repository
        .verify(
            &staging,
            content.len() as u64,
            &sha(&content),
            no_progress(),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::HashMismatch);

    let short = repository
        .verify(
            &staging,
            content.len() as u64 + 1,
            &sha(&content),
            no_progress(),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(short.kind, Kind::HashMismatch);
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn uploads_only_go_to_staging_keys() {
    let server = Server::start();
    let source = server.local_file("source.zip", b"x");
    let error = server
        .repository()
        .upload(
            &final_key("direct"),
            &source,
            no_progress(),
            &CancelFlag::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::Protocol);
    assert!(server.remote_files().is_empty());
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn publication_never_overwrites_an_existing_archive() {
    let server = Server::start();
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let target = final_key("immutable");

    let original = server.local_file("original.zip", b"the first archive");
    let staging = RepositoryKey::staging(Uuid::new_v4());
    repository
        .upload(&staging, &original, no_progress(), &cancel)
        .await
        .unwrap();
    repository.publish(&staging, &target).await.unwrap();

    let other = server.local_file("other.zip", b"a different archive");
    let second = RepositoryKey::staging(Uuid::new_v4());
    repository
        .upload(&second, &other, no_progress(), &cancel)
        .await
        .unwrap();
    let error = repository.publish(&second, &target).await.unwrap_err();
    assert_eq!(error.kind, Kind::AlreadyExists, "{error}");

    repository
        .verify(
            &target,
            17,
            &sha(b"the first archive"),
            no_progress(),
            &cancel,
        )
        .await
        .expect("the archive is untouched");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn concurrent_publication_has_exactly_one_winner() {
    let server = Server::start();
    let repository = Arc::new(server.repository());
    let cancel = CancelFlag::new();
    let target = final_key("race");
    let mut stagings = Vec::new();
    for index in 0..8u8 {
        let source = server.local_file(&format!("racer{index}.zip"), &[index; 4096]);
        let staging = RepositoryKey::staging(Uuid::new_v4());
        repository
            .upload(&staging, &source, no_progress(), &cancel)
            .await
            .unwrap();
        stagings.push((index, staging));
    }

    let racers: Vec<_> = stagings
        .iter()
        .map(|(index, staging)| {
            let repository = Arc::clone(&repository);
            let (staging, target) = (staging.clone(), target.clone());
            let index = *index;
            tokio::spawn(async move { (index, repository.publish(&staging, &target).await) })
        })
        .collect();
    let mut winners = Vec::new();
    for racer in racers {
        let (index, outcome) = racer.await.unwrap();
        match outcome {
            Ok(()) => winners.push(index),
            Err(error) => assert_eq!(error.kind, Kind::AlreadyExists, "{error}"),
        }
    }
    assert_eq!(winners.len(), 1, "exactly one wins: {winners:?}");
    repository
        .verify(
            &target,
            4096,
            &sha(&[winners[0]; 4096]),
            no_progress(),
            &cancel,
        )
        .await
        .expect("the object is the winner's");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_server_without_working_hard_links_fails_closed() {
    let server = Server::start_with(&[("SFTP_DENY", "hardlink")], &[]);
    let repository = server.repository();
    let cancel = CancelFlag::new();

    let error = repository.health_check(&cancel).await.unwrap_err();
    assert!(
        matches!(
            error.kind,
            Kind::PublicationUnsupported | Kind::PermissionDenied
        ),
        "{error}"
    );

    let source = server.local_file("source.zip", b"contents");
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let target = final_key("nolink");
    repository
        .upload(&staging, &source, no_progress(), &cancel)
        .await
        .unwrap();
    let error = repository.publish(&staging, &target).await.unwrap_err();
    assert!(
        matches!(
            error.kind,
            Kind::PublicationUnsupported | Kind::PermissionDenied
        ),
        "{error}"
    );
    assert_eq!(
        repository.stat(&target).await.unwrap(),
        None,
        "nothing was published"
    );
    assert!(
        repository.stat(&staging).await.unwrap().is_some(),
        "and nothing lost"
    );
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_read_only_root_is_a_permission_failure() {
    let server = Server::start();
    server.exec("chmod 555 /srv/sftp/repo");
    let repository = server.repository();
    let error = repository
        .health_check(&CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::PermissionDenied, "{error}");

    let source = server.local_file("source.zip", b"contents");
    let error = repository
        .upload(
            &RepositoryKey::staging(Uuid::new_v4()),
            &source,
            no_progress(),
            &CancelFlag::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::PermissionDenied, "{error}");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_full_disk_is_reported_as_insufficient_space() {
    let server = Server::start();
    let repository = server.repository();
    let free = repository.free_space().await.unwrap().unwrap();
    assert!(
        free <= 64 * 1024 * 1024,
        "the tmpfs limit is visible: {free}"
    );

    let too_big = server.local_file("big.zip", &pseudo_random(70 * 1024 * 1024));
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let error = repository
        .upload(&staging, &too_big, no_progress(), &CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::InsufficientSpace, "{error}");

    // What is left of the attempt can be removed, and the space comes back.
    repository.delete(&staging).await.unwrap();
    assert!(server.remote_files().is_empty());
    assert!(repository.free_space().await.unwrap().unwrap() > 60 * 1024 * 1024);
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_lost_connection_interrupts_an_upload_and_a_retry_replaces_the_partial_object() {
    let server = Server::start();
    let content = pseudo_random(48 * 1024 * 1024);
    let source = server.local_file("source.zip", &content);
    let repository = Arc::new(server.repository());
    let cancel = CancelFlag::new();
    let staging = RepositoryKey::staging(Uuid::new_v4());

    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (trigger, container) = (Arc::clone(&killed), server.container.clone());
    let progress: emucat_agent::repository::ProgressFn = Arc::new(move |done, _| {
        if done > 4 * 1024 * 1024 && !trigger.swap(true, std::sync::atomic::Ordering::SeqCst) {
            // The session's process, leaving the listening daemon alive.
            let _ = docker(&["exec", &container, "pkill", "-KILL", "-f", "sshd.*emucat"]);
        }
    });
    let error = repository
        .upload(&staging, &source, progress, &cancel)
        .await
        .unwrap_err();
    assert!(error.kind.is_retryable(), "{}: {error}", error.kind.code());
    assert_eq!(error.kind, Kind::Interrupted, "{error}");

    // A partial object may remain, under the staging key, where it cannot be taken for an archive.
    let partial = repository.stat(&staging).await.unwrap();
    assert!(partial.is_none_or(|object| object.size_bytes < content.len() as u64));

    repository
        .upload(&staging, &source, no_progress(), &cancel)
        .await
        .unwrap();
    repository
        .verify(
            &staging,
            content.len() as u64,
            &sha(&content),
            no_progress(),
            &cancel,
        )
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn cancelling_stops_a_transfer_and_cleaning_up_removes_the_partial_object() {
    let server = Server::start();
    let content = pseudo_random(48 * 1024 * 1024);
    let source = server.local_file("source.zip", &content);
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let trigger = cancel.clone();
    let error = repository
        .upload(
            &staging,
            &source,
            Arc::new(move |done, _| {
                if done > 1024 * 1024 {
                    trigger.cancel();
                }
            }),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::Cancelled);
    repository.delete(&staging).await.unwrap();
    repository
        .delete(&staging)
        .await
        .expect("deleting twice is fine");
    assert!(server.remote_files().is_empty());
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_missing_object_is_reported_precisely() {
    let server = Server::start();
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let missing = final_key("nothing");
    assert_eq!(repository.stat(&missing).await.unwrap(), None);
    let error = repository
        .verify(&missing, 1, &sha(b"x"), no_progress(), &cancel)
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::NotFound);
    repository
        .delete(&missing)
        .await
        .expect("deleting nothing is fine");
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_download_refuses_the_wrong_key_and_the_wrong_host_key_before_writing_anything() {
    let server = Server::start();
    let content = pseudo_random(1024 * 1024);
    let source = server.local_file("source.zip", &content);
    let repository = server.repository();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let key = final_key("download-identity");
    repository
        .upload(&staging, &source, no_progress(), &CancelFlag::new())
        .await
        .unwrap();
    repository.publish(&staging, &key).await.unwrap();

    let destination = server.directory.path().join("refused.zip");
    let mut wrong_client = server.settings();
    wrong_client.private_key = generate_key(server.directory.path(), "other", "");
    let error = SftpArchiveRepository::new(wrong_client)
        .unwrap()
        .download(&key, &destination, no_progress(), &CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::AuthenticationFailed, "{error}");
    assert!(!destination.exists());

    let mut wrong_host = server.settings();
    let elsewhere = generate_key(server.directory.path(), "elsewhere", "");
    wrong_host.host_keys.pinned_fingerprints = vec![fingerprint_of(&elsewhere)];
    let error = SftpArchiveRepository::new(wrong_host)
        .unwrap()
        .download(&key, &destination, no_progress(), &CancelFlag::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::HostKeyChanged, "{error}");
    assert!(!destination.exists());

    let received = repository
        .download(&key, &destination, no_progress(), &CancelFlag::new())
        .await
        .unwrap();
    assert_eq!(received.sha256, sha(&content));
    assert_eq!(fs::read(&destination).unwrap(), content);
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn a_cancelled_download_stops_and_leaves_no_file() {
    let server = Server::start();
    let content = pseudo_random(48 * 1024 * 1024);
    let source = server.local_file("source.zip", &content);
    let repository = server.repository();
    let staging = RepositoryKey::staging(Uuid::new_v4());
    let key = final_key("download-cancelled");
    repository
        .upload(&staging, &source, no_progress(), &CancelFlag::new())
        .await
        .unwrap();
    repository.publish(&staging, &key).await.unwrap();

    let destination = server.directory.path().join("cancelled.zip");
    let cancel = CancelFlag::new();
    let trigger = cancel.clone();
    let error = repository
        .download(
            &key,
            &destination,
            Arc::new(move |done, _| {
                if done > 1024 * 1024 {
                    trigger.cancel();
                }
            }),
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, Kind::Cancelled);
    assert!(!destination.exists());
}

/// Hands the agent's archive deletion this one real repository, as its configuration would.
struct OneRepository(Uuid, Arc<SftpArchiveRepository>);

impl emucat_agent::registration::RepositoryProvider for OneRepository {
    fn open(
        &self,
        repository_id: Uuid,
    ) -> emucat_agent::repository::RepositoryResult<Arc<dyn ArchiveRepository>> {
        if repository_id == self.0 {
            Ok(self.1.clone())
        } else {
            Err(emucat_agent::repository::RepositoryError::new(
                Kind::NotConfigured,
                "not configured",
            ))
        }
    }

    fn summary(
        &self,
        _repository_id: Uuid,
    ) -> Option<emucat_agent::protocol::RepositoryConfigSummary> {
        None
    }

    fn upload_attempts(&self, _repository_id: Uuid) -> u32 {
        1
    }

    fn repository_ids(&self) -> Vec<Uuid> {
        vec![self.0]
    }
}

#[tokio::test]
#[ignore = "needs Docker. Run by pnpm test:sftp"]
async fn deleting_a_snapshot_archive_removes_that_object_only_and_can_be_repeated() {
    use emucat_agent::archive_deletion::{delete_archive, derived_key};
    use emucat_agent::emulators::{EmulatorType, VmName};
    use emucat_agent::protocol::{ArchiveDelete, ArchiveDeleteOutcome};

    let server = Server::start();
    let repository = server.repository();
    let cancel = CancelFlag::new();
    let repository_id = Uuid::new_v4();
    let contents = b"a disposable snapshot archive";
    let mut request = ArchiveDelete {
        operation_id: Uuid::new_v4(),
        version_id: Uuid::new_v4(),
        emulator_type: EmulatorType::Qemu,
        vm_name: VmName::new("Clean Me").unwrap(),
        repository_id,
        archive_key: String::new(),
        archive_size_bytes: contents.len() as u64,
        archive_sha256: sha(contents),
    };
    let key = derived_key(&request);
    request.archive_key = key.as_str().to_owned();

    // The snapshot's archive, published as registration publishes it, and a neighbour that must stay.
    for (target, bytes) in [
        (key.clone(), &contents[..]),
        (final_key("clean me"), b"keep"),
    ] {
        let staging = RepositoryKey::staging(Uuid::new_v4());
        let file = server.local_file(&format!("{}.zip", Uuid::new_v4()), bytes);
        repository
            .upload(&staging, &file, no_progress(), &cancel)
            .await
            .unwrap();
        repository.publish(&staging, &target).await.unwrap();
    }
    let before = server.remote_files();
    assert_eq!(before.len(), 2, "{before:?}");

    let provider: Arc<dyn emucat_agent::registration::RepositoryProvider> =
        Arc::new(OneRepository(repository_id, Arc::new(server.repository())));

    // A key that is not this version's is never used, whatever the server sends.
    let forged = ArchiveDelete {
        archive_key: before
            .iter()
            .find(|name| *name != key.as_str())
            .unwrap()
            .clone(),
        operation_id: Uuid::new_v4(),
        ..request.clone()
    };
    let refused = delete_archive(&provider, &forged).await;
    assert_eq!(refused.outcome, ArchiveDeleteOutcome::Failed);
    assert_eq!(refused.code.as_deref(), Some("archive_key_mismatch"));
    // Nor an object of another size than the one registered.
    let resized = ArchiveDelete {
        archive_size_bytes: contents.len() as u64 + 1,
        operation_id: Uuid::new_v4(),
        ..request.clone()
    };
    let refused = delete_archive(&provider, &resized).await;
    assert_eq!(refused.code.as_deref(), Some("archive_mismatch"));
    assert_eq!(server.remote_files(), before);

    let result = delete_archive(&provider, &request).await;
    assert_eq!(result.outcome, ArchiveDeleteOutcome::Deleted, "{result:?}");
    assert_eq!(repository.stat(&key).await.unwrap(), None);
    let after = server.remote_files();
    assert_eq!(after.len(), 1);
    assert_ne!(after[0], key.as_str());

    // Asking again, as a retry after a lost answer would, finds nothing and changes nothing.
    let again = delete_archive(
        &provider,
        &ArchiveDelete {
            operation_id: Uuid::new_v4(),
            ..request.clone()
        },
    )
    .await;
    assert_eq!(again.outcome, ArchiveDeleteOutcome::Absent, "{again:?}");
    assert_eq!(server.remote_files(), after);
}
