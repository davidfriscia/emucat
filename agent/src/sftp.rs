//! [`ArchiveRepository`] over SSH and SFTP, using `russh` and `russh-sftp`.
//!
//! The agent talks to the SSH server directly; no archive byte ever passes through the EmuCat API.
//! Host keys are always verified against what is configured locally, and an unknown or changed key
//! ends the connection before authentication. Only SFTP is used: no shell is requested, so a restricted
//! `internal-sftp` account is enough. See decision 0013.
//!
//! Publication uses `hardlink@openssh.com`, because `link(2)` fails atomically if the target exists.
//! Plain SFTP rename is not used for this: what it does with an existing target varies between
//! servers, and `posix-rename@openssh.com` replaces it on purpose. A server without working hard links
//! fails the health check and every publication, rather than falling back to something weaker.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesOrdered, FuturesUnordered};
use futures_util::{FutureExt, StreamExt};
use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::config::RepositoryConfig;
use crate::credentials::{Secret, load_repository_passphrase};
use crate::packaging::hex;
use crate::protocol::RepositoryConfigSummary;
use crate::registration::RepositoryProvider;
use crate::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};

const CHUNK_BYTES: u32 = 64 * 1024;
/// Requests in flight at once. With the chunk size, this is the most memory a transfer needs.
const WINDOW: usize = 16;
const HARDLINK_EXTENSION: &str = "hardlink@openssh.com";
const STATVFS_EXTENSION: &str = "statvfs@openssh.com";
const FSYNC_EXTENSION: &str = "fsync@openssh.com";

/// Which server keys are trusted. At least one source is required, and there is no way to say "any".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostKeyPolicy {
    /// `SHA256:…`, as printed by `ssh-keygen -lf`.
    pub pinned_fingerprints: Vec<String>,
    pub known_hosts: Option<PathBuf>,
}

impl HostKeyPolicy {
    pub fn is_configured(&self) -> bool {
        !self.pinned_fingerprints.is_empty() || self.known_hosts.is_some()
    }
}

#[derive(Debug, Clone)]
pub struct SftpSettings {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Everything this repository stores is under this directory.
    pub remote_root: String,
    pub private_key: PathBuf,
    pub passphrase: Option<Secret>,
    pub host_keys: HostKeyPolicy,
    pub connect_timeout: Duration,
    /// How long a single SFTP request may take. A transfer that stops making progress ends here.
    pub transfer_timeout: Duration,
    /// How many times to try connecting again after a network failure.
    pub connect_retries: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostKeyProblem {
    Unknown,
    Changed,
}

/// The only place a server key is judged. The verdict is kept, because `russh` reports any refusal the
/// same way and a changed key must be told apart from an unknown one.
struct Verifier {
    host: String,
    port: u16,
    policy: HostKeyPolicy,
    seen: Arc<Mutex<SeenKey>>,
}

#[derive(Default)]
struct SeenKey {
    fingerprint: Option<String>,
    problem: Option<HostKeyProblem>,
}

impl Verifier {
    fn judge(&self, key: &russh::keys::PublicKey) -> Result<(), HostKeyProblem> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        self.seen.lock().expect("poisoned").fingerprint = Some(fingerprint.clone());
        if self.policy.pinned_fingerprints.contains(&fingerprint) {
            return Ok(());
        }
        if let Some(path) = &self.policy.known_hosts {
            return match russh::keys::check_known_hosts_path(&self.host, self.port, key, path) {
                Ok(true) => Ok(()),
                Ok(false) => Err(HostKeyProblem::Unknown),
                Err(russh::keys::Error::KeyChanged { .. }) => Err(HostKeyProblem::Changed),
                Err(_) => Err(HostKeyProblem::Unknown),
            };
        }
        // Keys are pinned, and this is not one of them: the server is not who it was.
        Err(HostKeyProblem::Changed)
    }
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let verdict = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => self.judge(key),
            // Host certificates need a trusted CA, which there is no configuration for.
            PublicKeyOrCertificate::Certificate(_) => Err(HostKeyProblem::Unknown),
        };
        match verdict {
            Ok(()) => Ok(true),
            Err(problem) => {
                self.seen.lock().expect("poisoned").problem = Some(problem);
                Ok(false)
            }
        }
    }
}

struct Connection {
    // Held so that the SSH session outlives the SFTP stream that runs over it.
    _ssh: client::Handle<Verifier>,
    sftp: Arc<RawSftpSession>,
    extensions: HashMap<String, String>,
    fingerprint: Option<String>,
}

fn sftp_error(error: SftpError, what: &str) -> RepositoryError {
    match &error {
        SftpError::Status(status) => {
            let kind = match status.status_code {
                StatusCode::NoSuchFile => Kind::NotFound,
                StatusCode::PermissionDenied => Kind::PermissionDenied,
                StatusCode::NoConnection | StatusCode::ConnectionLost => Kind::Interrupted,
                _ => Kind::Protocol,
            };
            RepositoryError::new(kind, format!("{what}: {}", status.status_code))
        }
        SftpError::Timeout => RepositoryError::new(
            Kind::Interrupted,
            format!("{what}: the server did not answer in time"),
        ),
        SftpError::IO(_) | SftpError::UnexpectedBehavior(_) => RepositoryError::new(
            Kind::Interrupted,
            format!("{what}: the connection was lost"),
        ),
        _ => RepositoryError::new(Kind::Protocol, format!("{what}: {error}")),
    }
}

fn is_no_such_file(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

pub struct SftpArchiveRepository {
    settings: SftpSettings,
}

impl SftpArchiveRepository {
    pub fn new(settings: SftpSettings) -> RepositoryResult<Self> {
        if !settings.host_keys.is_configured() {
            return Err(RepositoryError::new(
                Kind::NotConfigured,
                "No trusted host key is configured for this repository",
            ));
        }
        Ok(Self { settings })
    }

    fn remote_path(&self, key: &str) -> String {
        let root = self.settings.remote_root.trim_end_matches('/');
        format!("{root}/{key}")
    }

    fn load_key(&self) -> RepositoryResult<PrivateKey> {
        let passphrase = self.settings.passphrase.as_ref().map(Secret::expose);
        // The error can describe the file, but never its contents or the passphrase.
        russh::keys::load_secret_key(&self.settings.private_key, passphrase).map_err(|_| {
            RepositoryError::new(
                Kind::NotConfigured,
                format!(
                    "Cannot load the private key {}, or its passphrase is wrong",
                    self.settings.private_key.display()
                ),
            )
        })
    }

    async fn connect_once(&self, key: &PrivateKey) -> RepositoryResult<Connection> {
        let settings = &self.settings;
        let seen = Arc::new(Mutex::new(SeenKey::default()));
        let verifier = Verifier {
            host: settings.host.clone(),
            port: settings.port,
            policy: settings.host_keys.clone(),
            seen: Arc::clone(&seen),
        };
        let config = Arc::new(client::Config {
            window_size: 8 * 1024 * 1024,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let host_key_verdict = |seen: &Mutex<SeenKey>| -> Option<RepositoryError> {
            let seen = seen.lock().expect("poisoned");
            let fingerprint = seen.fingerprint.as_deref().unwrap_or("unknown");
            match seen.problem? {
                HostKeyProblem::Unknown => Some(RepositoryError::new(
                    Kind::HostKeyUnknown,
                    format!(
                        "The server's host key {fingerprint} is not trusted. Add it to the agent's \
                         configuration after checking it out of band"
                    ),
                )),
                HostKeyProblem::Changed => Some(RepositoryError::new(
                    Kind::HostKeyChanged,
                    format!(
                        "The server's host key {fingerprint} differs from the trusted one. Refusing \
                         to connect: this can mean an attack, or a reinstalled server"
                    ),
                )),
            }
        };

        let address = (settings.host.as_str(), settings.port);
        let connected = tokio::time::timeout(
            settings.connect_timeout,
            client::connect(config, address, verifier),
        )
        .await
        .map_err(|_| {
            RepositoryError::new(Kind::Unreachable, "Timed out connecting to the server")
        })?;
        let mut ssh = match connected {
            Ok(handle) => handle,
            Err(error) => {
                if let Some(problem) = host_key_verdict(&seen) {
                    return Err(problem);
                }
                return Err(RepositoryError::new(
                    Kind::Unreachable,
                    format!(
                        "Cannot connect to {}:{}: {error}",
                        settings.host, settings.port
                    ),
                ));
            }
        };

        let authenticated = tokio::time::timeout(settings.connect_timeout, async {
            let hash = ssh.best_supported_rsa_hash().await?.flatten();
            let signed = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), hash);
            ssh.authenticate_publickey(settings.username.as_str(), signed)
                .await
        })
        .await
        .map_err(|_| RepositoryError::new(Kind::Unreachable, "Timed out authenticating"))?
        .map_err(|error| {
            RepositoryError::new(Kind::Unreachable, format!("Authentication failed: {error}"))
        })?;
        if !matches!(authenticated, AuthResult::Success) {
            // A connection lost during authentication is also reported as a failure. It says nothing
            // about the key, and telling someone to fix a key that is fine would be misleading.
            tokio::time::sleep(Duration::from_millis(100)).await;
            if ssh.is_closed() {
                return Err(RepositoryError::new(
                    Kind::Interrupted,
                    "The connection was lost while authenticating",
                ));
            }
            return Err(RepositoryError::new(
                Kind::AuthenticationFailed,
                format!(
                    "The server refused the key for user {}. Check authorized_keys on the server",
                    settings.username
                ),
            ));
        }

        let open_channel = async {
            let channel = ssh.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            Ok::<_, russh::Error>(channel)
        };
        let channel = tokio::time::timeout(settings.connect_timeout, open_channel)
            .await
            .map_err(|_| RepositoryError::new(Kind::Unreachable, "Timed out opening SFTP"))?
            .map_err(|error| {
                RepositoryError::new(Kind::Interrupted, format!("Cannot open SFTP: {error}"))
            })?;
        let sftp = RawSftpSession::new(channel.into_stream());
        sftp.set_timeout(settings.transfer_timeout.as_secs().max(1));
        let version = sftp
            .init()
            .await
            .map_err(|error| sftp_error(error, "Cannot start SFTP"))?;
        let fingerprint = seen.lock().expect("poisoned").fingerprint.clone();
        Ok(Connection {
            _ssh: ssh,
            sftp: Arc::new(sftp),
            extensions: version.extensions,
            fingerprint,
        })
    }

    async fn connect(&self) -> RepositoryResult<Connection> {
        let key = self.load_key()?;
        let mut attempt = 0;
        loop {
            match self.connect_once(&key).await {
                Ok(connection) => return Ok(connection),
                Err(error)
                    if error.kind.is_retryable() && attempt < self.settings.connect_retries =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(500 << attempt.min(5))).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Creates the directories above a key. A directory that already exists is what was wanted, and
    /// the server's answer for that is only a generic failure, so the result is checked afterwards.
    async fn ensure_parents(
        &self,
        connection: &Connection,
        key: &RepositoryKey,
    ) -> RepositoryResult<()> {
        for parent in key.parents() {
            let path = self.remote_path(parent);
            match connection.sftp.lstat(path.clone()).await {
                Ok(found) if found.attrs.is_dir() => continue,
                Ok(_) => {
                    return Err(RepositoryError::new(
                        Kind::Protocol,
                        format!("{parent} exists in the repository and is not a directory"),
                    ));
                }
                Err(error) if is_no_such_file(&error) => {}
                Err(error) => return Err(sftp_error(error, "Cannot inspect a directory")),
            }
            if let Err(error) = connection
                .sftp
                .mkdir(path.clone(), FileAttributes::default())
                .await
            {
                // Somebody else may have just created it. Only a directory that is still missing
                // is a problem.
                let exists =
                    matches!(connection.sftp.lstat(path).await, Ok(found) if found.attrs.is_dir());
                if !exists {
                    return Err(sftp_error(error, "Cannot create a directory"));
                }
            }
        }
        Ok(())
    }

    async fn stat_on(
        &self,
        connection: &Connection,
        key: &RepositoryKey,
    ) -> RepositoryResult<Option<ObjectMetadata>> {
        match connection.sftp.lstat(self.remote_path(key.as_str())).await {
            Ok(found) if found.attrs.is_regular() => Ok(Some(ObjectMetadata {
                size_bytes: found.attrs.size.unwrap_or(0),
            })),
            Ok(_) => Err(RepositoryError::new(
                Kind::Protocol,
                format!("{} is not a regular file", key.as_str()),
            )),
            Err(error) if is_no_such_file(&error) => Ok(None),
            Err(error) => Err(sftp_error(error, "Cannot read object metadata")),
        }
    }

    async fn free_space_on(&self, connection: &Connection) -> RepositoryResult<Option<u64>> {
        if !connection.extensions.contains_key(STATVFS_EXTENSION) {
            return Ok(None);
        }
        match connection
            .sftp
            .statvfs(self.settings.remote_root.clone())
            .await
        {
            Ok(stats) => Ok(Some(
                stats
                    .blocks_avail
                    .saturating_mul(stats.fragment_size.max(1)),
            )),
            // Knowing the free space is an optimization. The upload itself will find out.
            Err(_) => Ok(None),
        }
    }

    /// Reads an object to the end through `sink`, with a bounded window of requests in flight. The
    /// order of the data is preserved, and a short read is completed before moving on.
    async fn read_object(
        &self,
        connection: &Connection,
        key: &RepositoryKey,
        progress: &ProgressFn,
        cancel: &CancelFlag,
        mut sink: impl AsyncSink,
    ) -> RepositoryResult<u64> {
        let sftp = &connection.sftp;
        let metadata = self
            .stat_on(connection, key)
            .await?
            .ok_or_else(|| RepositoryError::new(Kind::NotFound, "The object does not exist"))?;
        let total = metadata.size_bytes;
        let handle = sftp
            .open(
                self.remote_path(key.as_str()),
                OpenFlags::READ,
                FileAttributes::default(),
            )
            .await
            .map_err(|error| sftp_error(error, "Cannot open the object"))?
            .handle;

        let mut pending = FuturesOrdered::new();
        let mut next_offset = 0u64;
        let mut received = 0u64;
        let outcome: RepositoryResult<()> = async {
            loop {
                while pending.len() < WINDOW && next_offset < total {
                    let length = u64::from(CHUNK_BYTES).min(total - next_offset) as u32;
                    let offset = next_offset;
                    let session = Arc::clone(sftp);
                    let handle = handle.clone();
                    pending.push_back(
                        async move {
                            let data = session.read(handle, offset, length).await;
                            (offset, length, data)
                        }
                        .boxed(),
                    );
                    next_offset += u64::from(length);
                }
                let Some((offset, length, result)) = (tokio::select! {
                    next = pending.next() => next,
                    () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                }) else {
                    return Ok(());
                };
                let mut data = match result {
                    Ok(data) => data.data,
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        Vec::new()
                    }
                    Err(error) => return Err(sftp_error(error, "Cannot read the object")),
                };
                // Servers may answer with less than was asked for.
                let mut have = data.len() as u64;
                while have < u64::from(length) {
                    let more = sftp
                        .read(handle.clone(), offset + have, length - have as u32)
                        .await;
                    match more {
                        Ok(more) if !more.data.is_empty() => {
                            have += more.data.len() as u64;
                            data.extend_from_slice(&more.data);
                        }
                        Ok(_) => break,
                        Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                            break;
                        }
                        Err(error) => return Err(sftp_error(error, "Cannot read the object")),
                    }
                }
                if have < u64::from(length) {
                    return Err(RepositoryError::new(
                        Kind::Interrupted,
                        "The object ended before its reported size",
                    ));
                }
                sink.accept(data).await?;
                received += have;
                progress(received, total);
            }
        }
        .await;
        let _ = sftp.close(handle).await;
        outcome?;
        Ok(received)
    }
}

/// Where the bytes of an object go as they are read.
trait AsyncSink: Send {
    fn accept(&mut self, data: Vec<u8>) -> BoxFuture<'_, RepositoryResult<()>>;
}

struct HashSink<'a> {
    hasher: &'a mut Sha256,
}

impl AsyncSink for HashSink<'_> {
    fn accept(&mut self, data: Vec<u8>) -> BoxFuture<'_, RepositoryResult<()>> {
        self.hasher.update(&data);
        async { Ok(()) }.boxed()
    }
}

struct FileSink<'a> {
    hasher: &'a mut Sha256,
    file: &'a mut tokio::fs::File,
}

impl AsyncSink for FileSink<'_> {
    fn accept(&mut self, data: Vec<u8>) -> BoxFuture<'_, RepositoryResult<()>> {
        self.hasher.update(&data);
        async move {
            self.file.write_all(&data).await.map_err(|error| {
                RepositoryError::new(Kind::Protocol, format!("Cannot write locally: {error}"))
            })
        }
        .boxed()
    }
}

impl ArchiveRepository for SftpArchiveRepository {
    fn health_check<'a>(
        &'a self,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move {
            let connection = self.connect().await?;
            let sftp = &connection.sftp;

            let root = sftp
                .stat(self.settings.remote_root.clone())
                .await
                .map_err(|error| sftp_error(error, "Cannot reach the remote root"))?;
            if !root.attrs.is_dir() {
                return Err(RepositoryError::new(
                    Kind::NotConfigured,
                    "The remote root is not a directory",
                ));
            }
            let listing = sftp
                .opendir(self.settings.remote_root.clone())
                .await
                .map_err(|error| sftp_error(error, "Cannot read the remote root"))?;
            let _ = sftp.close(listing.handle).await;

            // A unique name under the staging prefix, which can never be an archive.
            let probe_id = Uuid::new_v4();
            let probe = RepositoryKey::new(format!("archives/.staging/.health-{probe_id}.part"))
                .expect("a UUID only produces a valid key");
            let probe_link =
                RepositoryKey::new(format!("archives/.staging/.health-{probe_id}.link"))
                    .expect("a UUID only produces a valid key");
            self.ensure_parents(&connection, &probe).await?;

            let result = self
                .probe_read_write_publish(&connection, &probe, &probe_link, cancel)
                .await;
            let _ = sftp.remove(self.remote_path(probe.as_str())).await;
            let _ = sftp.remove(self.remote_path(probe_link.as_str())).await;
            result?;

            Ok(HealthReport {
                host_key_fingerprint: connection.fingerprint.clone(),
                root_readable: true,
                root_writable: true,
                no_overwrite_publication: true,
                free_bytes: self.free_space_on(&connection).await?,
            })
        }
        .boxed()
    }

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>> {
        async move {
            let connection = self.connect().await?;
            self.stat_on(&connection, key).await
        }
        .boxed()
    }

    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>> {
        async move {
            let connection = self.connect().await?;
            self.free_space_on(&connection).await
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
            if !key.is_staging() {
                return Err(RepositoryError::new(
                    Kind::Protocol,
                    "Uploads may only write to a staging key",
                ));
            }
            let mut file = tokio::fs::File::open(source).await.map_err(|error| {
                RepositoryError::new(Kind::Protocol, format!("Cannot read the archive: {error}"))
            })?;
            let total = file
                .metadata()
                .await
                .map_err(|error| {
                    RepositoryError::new(
                        Kind::Protocol,
                        format!("Cannot read the archive: {error}"),
                    )
                })?
                .len();

            let connection = self.connect().await?;
            let sftp = &connection.sftp;
            self.ensure_parents(&connection, key).await?;
            let handle = sftp
                .open(
                    self.remote_path(key.as_str()),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    FileAttributes::default(),
                )
                .await
                .map_err(|error| sftp_error(error, "Cannot create the staging object"))?
                .handle;

            let mut in_flight = FuturesUnordered::new();
            let mut offset = 0u64;
            let mut written = 0u64;
            let sent: RepositoryResult<()> = async {
                loop {
                    while in_flight.len() < WINDOW && offset < total {
                        let length = u64::from(CHUNK_BYTES).min(total - offset) as usize;
                        let mut chunk = vec![0; length];
                        file.read_exact(&mut chunk).await.map_err(|error| {
                            RepositoryError::new(
                                Kind::Protocol,
                                format!("Cannot read the archive: {error}"),
                            )
                        })?;
                        let session = Arc::clone(sftp);
                        let handle = handle.clone();
                        let at = offset;
                        in_flight.push(
                            async move {
                                session
                                    .write(handle, at, chunk)
                                    .await
                                    .map(|_| length as u64)
                            }
                            .boxed(),
                        );
                        offset += length as u64;
                    }
                    let Some(done) = (tokio::select! {
                        done = in_flight.next() => done,
                        () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                    }) else {
                        return Ok(());
                    };
                    written += done.map_err(upload_error)?;
                    progress(written, total);
                }
            }
            .await;
            if let Err(error) = sent {
                let _ = sftp.close(handle).await;
                return Err(error);
            }

            if connection.extensions.contains_key(FSYNC_EXTENSION) {
                sftp.fsync(handle.clone()).await.map_err(upload_error)?;
            }
            sftp.close(handle).await.map_err(upload_error)?;
            let stored = self.stat_on(&connection, key).await?.ok_or_else(|| {
                RepositoryError::new(Kind::Interrupted, "The staging object disappeared")
            })?;
            if stored.size_bytes != total {
                return Err(RepositoryError::new(
                    Kind::HashMismatch,
                    format!("The server stored {} bytes of {total}", stored.size_bytes),
                ));
            }
            Ok(stored)
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
            let connection = self.connect().await?;
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .await
                .map_err(|error| {
                    RepositoryError::new(Kind::Protocol, format!("Cannot create the file: {error}"))
                })?;
            let mut hasher = Sha256::new();
            let result = self
                .read_object(
                    &connection,
                    key,
                    &progress,
                    cancel,
                    FileSink {
                        hasher: &mut hasher,
                        file: &mut file,
                    },
                )
                .await;
            let size_bytes = match result {
                Ok(size) => size,
                Err(error) => {
                    drop(file);
                    let _ = tokio::fs::remove_file(destination).await;
                    return Err(error);
                }
            };
            file.sync_all().await.map_err(|error| {
                RepositoryError::new(Kind::Protocol, format!("Cannot write locally: {error}"))
            })?;
            Ok(VerifiedObject {
                size_bytes,
                sha256: hex(&hasher.finalize()),
            })
        }
        .boxed()
    }

    fn verify<'a>(
        &'a self,
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let connection = self.connect().await?;
            let mut hasher = Sha256::new();
            let size_bytes = self
                .read_object(
                    &connection,
                    key,
                    &progress,
                    cancel,
                    HashSink {
                        hasher: &mut hasher,
                    },
                )
                .await?;
            let sha256 = hex(&hasher.finalize());
            if size_bytes != expected_size || sha256 != expected_sha256 {
                return Err(RepositoryError::new(
                    Kind::HashMismatch,
                    format!(
                        "The stored object does not match: {size_bytes} bytes with SHA-256 {sha256}"
                    ),
                ));
            }
            Ok(VerifiedObject { size_bytes, sha256 })
        }
        .boxed()
    }

    fn publish<'a>(
        &'a self,
        staging: &'a RepositoryKey,
        final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            let connection = self.connect().await?;
            let sftp = &connection.sftp;
            if !connection.extensions.contains_key(HARDLINK_EXTENSION) {
                return Err(RepositoryError::new(
                    Kind::PublicationUnsupported,
                    "This server has no hardlink@openssh.com extension, so an archive cannot be \
                     published with a guarantee against overwriting",
                ));
            }
            self.ensure_parents(&connection, final_key).await?;
            let linked = sftp
                .hardlink(
                    self.remote_path(staging.as_str()),
                    self.remote_path(final_key.as_str()),
                )
                .await;
            if let Err(error) = linked {
                if self.stat_on(&connection, final_key).await?.is_some() {
                    return Err(RepositoryError::new(
                        Kind::AlreadyExists,
                        format!("An archive already exists at {}", final_key.as_str()),
                    ));
                }
                let mapped = sftp_error(error, "Cannot publish the archive");
                return Err(if mapped.kind == Kind::Protocol {
                    RepositoryError::new(
                        Kind::PublicationUnsupported,
                        format!(
                            "{}. The repository's filesystem may not support hard links",
                            mapped.message
                        ),
                    )
                } else {
                    mapped
                });
            }
            // The archive is safely published. A staging link left behind is only clutter.
            if let Err(error) = sftp.remove(self.remote_path(staging.as_str())).await {
                tracing::warn!(%error, key = staging.as_str(), "Cannot remove a staging object");
            }
            Ok(())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            let connection = self.connect().await?;
            match connection.sftp.remove(self.remote_path(key.as_str())).await {
                Ok(_) => Ok(()),
                Err(error) if is_no_such_file(&error) => Ok(()),
                Err(error) => Err(sftp_error(error, "Cannot delete the object")),
            }
        }
        .boxed()
    }
}

/// The repositories in this agent's configuration. A repository the configuration does not name cannot
/// be used, whatever a message from the server says.
pub struct ConfiguredRepositories {
    repositories: BTreeMap<Uuid, RepositoryConfig>,
    state_dir: PathBuf,
}

impl ConfiguredRepositories {
    pub fn new(repositories: BTreeMap<Uuid, RepositoryConfig>, state_dir: PathBuf) -> Self {
        Self {
            repositories,
            state_dir,
        }
    }

    fn settings(&self, id: Uuid) -> RepositoryResult<SftpSettings> {
        let config = self.repositories.get(&id).ok_or_else(|| {
            RepositoryError::new(
                Kind::NotConfigured,
                format!("This agent has no configuration for repository {id}"),
            )
        })?;
        let passphrase = load_repository_passphrase(&self.state_dir, id).map_err(|error| {
            RepositoryError::new(
                Kind::NotConfigured,
                format!("Cannot read the stored passphrase: {error}"),
            )
        })?;
        Ok(SftpSettings {
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
            remote_root: config.remote_root.clone(),
            private_key: config.private_key_path.clone(),
            passphrase,
            host_keys: HostKeyPolicy {
                pinned_fingerprints: config.host_key_fingerprints.clone(),
                known_hosts: config.known_hosts_path.clone(),
            },
            connect_timeout: Duration::from_secs(config.connect_timeout_seconds),
            transfer_timeout: Duration::from_secs(config.transfer_timeout_seconds),
            connect_retries: config.connect_retries,
        })
    }
}

impl RepositoryProvider for ConfiguredRepositories {
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        Ok(Arc::new(SftpArchiveRepository::new(
            self.settings(repository_id)?,
        )?))
    }

    fn summary(&self, repository_id: Uuid) -> Option<RepositoryConfigSummary> {
        self.repositories
            .get(&repository_id)
            .map(|config| RepositoryConfigSummary {
                host: config.host.clone(),
                port: config.port,
                username: config.username.clone(),
                remote_root: config.remote_root.clone(),
            })
    }

    fn upload_attempts(&self, repository_id: Uuid) -> u32 {
        self.repositories
            .get(&repository_id)
            .map_or(1, |config| config.upload_attempts)
    }
}

/// A generic failure during an upload is, in practice, the disk being full. OpenSSH reports `ENOSPC`
/// and `EDQUOT` as a plain failure, so this cannot be told apart from other server-side problems, and
/// the message says so.
fn upload_error(error: SftpError) -> RepositoryError {
    match &error {
        SftpError::Status(status) if status.status_code == StatusCode::Failure => {
            RepositoryError::new(
                Kind::InsufficientSpace,
                "The server could not store the data. Its disk or quota is probably full",
            )
        }
        _ => sftp_error(error, "The upload failed"),
    }
}

impl SftpArchiveRepository {
    /// Proves, with objects of its own, that the root can be written and read back, and that a hard
    /// link fails rather than replacing an existing object.
    async fn probe_read_write_publish(
        &self,
        connection: &Connection,
        probe: &RepositoryKey,
        probe_link: &RepositoryKey,
        cancel: &CancelFlag,
    ) -> RepositoryResult<()> {
        let sftp = &connection.sftp;
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled());
        }
        const CONTENT: &[u8] = b"emucat repository health check\n";
        let path = self.remote_path(probe.as_str());
        let link = self.remote_path(probe_link.as_str());

        // `EXCLUDE`: the name is unique, and this could never touch anything that exists.
        let handle = sftp
            .open(
                path.clone(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes::default(),
            )
            .await
            .map_err(|error| sftp_error(error, "Cannot write to the repository"))?
            .handle;
        sftp.write(handle.clone(), 0, CONTENT.to_vec())
            .await
            .map_err(|error| sftp_error(error, "Cannot write to the repository"))?;
        sftp.close(handle)
            .await
            .map_err(|error| sftp_error(error, "Cannot write to the repository"))?;

        let handle = sftp
            .open(path.clone(), OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(|error| sftp_error(error, "Cannot read from the repository"))?
            .handle;
        let read = sftp
            .read(handle.clone(), 0, CONTENT.len() as u32)
            .await
            .map_err(|error| sftp_error(error, "Cannot read from the repository"))?;
        let _ = sftp.close(handle).await;
        if read.data != CONTENT {
            return Err(RepositoryError::new(
                Kind::HashMismatch,
                "The repository returned different bytes than were written",
            ));
        }

        if !connection.extensions.contains_key(HARDLINK_EXTENSION) {
            return Err(RepositoryError::new(
                Kind::PublicationUnsupported,
                "This server has no hardlink@openssh.com extension",
            ));
        }
        sftp.hardlink(path.clone(), link.clone())
            .await
            .map_err(|error| {
                let mapped = sftp_error(error, "");
                RepositoryError::new(
                    if mapped.kind == Kind::PermissionDenied {
                        Kind::PermissionDenied
                    } else {
                        Kind::PublicationUnsupported
                    },
                    "Hard links do not work on the repository's filesystem",
                )
            })?;
        if sftp.hardlink(path, link).await.is_ok() {
            return Err(RepositoryError::new(
                Kind::PublicationUnsupported,
                "The server replaced an existing object when linking over it",
            ));
        }
        Ok(())
    }
}
