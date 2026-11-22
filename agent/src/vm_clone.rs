//! Clones one version of a VM into a new, independent VM (decision 0052).
//!
//! The server names a source version and a new identity. This agent downloads the source's archive from the
//! repository, checks it is exactly the registered one, writes it again for the new VM, checks every file of the
//! result against its manifest, and publishes it at the new VM's own key with the usual upload, verification and
//! no-overwrite publication. The source archive is only ever read: nothing here writes, renames or deletes it.
//!
//! - **An EmuCat ZIP** (86Box, QEMU) names its VM inside its manifest, which restores check, so it cannot simply be
//!   copied. Every entry is copied as it is, compressed bytes and CRC included, and the manifest is written again
//!   with the new name and the same entries. Every file is then decompressed and hashed, and must match the
//!   manifest: the clone holds exactly the content of the version it came from.
//! - **A VirtualBox OVA** carries no EmuCat identity: it is checked as an OVA and copied byte for byte.
//!
//! Every version is a complete standalone archive (decision 0014), a snapshot included, so the archive of the
//! chosen version is the whole VM: there is nothing to reconstruct from parents.
//!
//! Like every operation this shares the agent's single operation slot, and its journal phases make it survive a
//! restart: before publication a restart fails it and removes what it staged; during publication the repository
//! says whether the clone's object is there and is what was built.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::archives::{VersionId, archive_object_key};
use crate::emulators::{EmulatorType, VmIdentity, VmName};
use crate::extraction::{ArchiveExpectation, ExtractionLimits, inspect_archive};
use crate::packaging::{
    MANIFEST_ENTRY_NAME, Manifest, ManifestEntryType, available_disk_bytes, hash_file, hex,
};
use crate::protocol::{
    AckOutcome, LocalCopyStatus, Message, RegistrationAck, RegistrationCleanup,
    RegistrationFailure, RegistrationPhase, RegistrationProgress, RegistrationResult,
    RegistrationStage, RegistrationSyncEntry, VirtualBoxRegistrationResult,
};
use crate::registration::RepositoryProvider;
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
};

const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const REMOTE_CLEANUP_ATTEMPTS: u32 = 6;
const READ_BUFFER_BYTES: usize = 1024 * 1024;

/// The catalog types a clone can be of. Unlike [`EmulatorType`], VirtualBox is one: a clone reads no directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CloneEmulator {
    #[serde(rename = "86box")]
    Box86,
    #[serde(rename = "qemu")]
    Qemu,
    #[serde(rename = "virtualbox")]
    VirtualBox,
}

impl CloneEmulator {
    fn filesystem(self) -> Option<EmulatorType> {
        match self {
            Self::Box86 => Some(EmulatorType::Box86),
            Self::Qemu => Some(EmulatorType::Qemu),
            Self::VirtualBox => None,
        }
    }

    /// The object key of a version of a VM of this type. Mirrors `archiveObjectKey` in the contracts.
    pub fn archive_key(self, vm_name: &VmName, version_id: Uuid) -> String {
        match self.filesystem() {
            Some(emulator_type) => archive_object_key(
                &VmIdentity {
                    emulator_type,
                    vm_name: vm_name.clone(),
                },
                VersionId(version_id),
            ),
            None => crate::virtualbox_registration::archive_key(vm_name, version_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneSource {
    pub vm_name: VmName,
    pub version_id: Uuid,
    pub archive_key: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
    pub manifest_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneTarget {
    pub vm_name: VmName,
    pub version_id: Uuid,
    pub archive_key: String,
}

/// `server.clone_request`. It holds no path and no address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneRequest {
    pub operation_id: Uuid,
    pub emulator_type: CloneEmulator,
    pub repository_id: Uuid,
    pub source: CloneSource,
    pub target: CloneTarget,
}

/// What was published, in the form of the report it is sent as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "format", content = "result", rename_all = "snake_case")]
enum Published {
    Zip(RegistrationResult),
    Ova(VirtualBoxRegistrationResult),
}

impl Published {
    fn message(&self) -> Message {
        match self {
            Self::Zip(result) => Message::AgentRegistrationResult(result.clone()),
            Self::Ova(result) => Message::AgentVirtualBoxRegistrationResult(result.clone()),
        }
    }

    fn key_size_sha(&self) -> (&str, u64, &str) {
        match self {
            Self::Zip(result) => (
                &result.archive_key,
                result.archive_size_bytes,
                &result.archive_sha256,
            ),
            Self::Ova(result) => (
                &result.archive_key,
                result.archive_size_bytes,
                &result.archive_sha256,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "report", rename_all = "snake_case")]
enum Report {
    Failure(RegistrationFailure),
    Cleanup(RegistrationCleanup),
}

/// Everything needed to carry on after a restart. It holds no secret and no VM contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request: CloneRequest,
    phase: RegistrationPhase,
    published: Option<Published>,
    report: Option<Report>,
}

#[derive(Debug)]
pub struct JobFailure {
    pub code: String,
    pub message: String,
}

fn failure(code: &str, message: impl Into<String>) -> JobFailure {
    JobFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

impl From<RepositoryError> for JobFailure {
    fn from(error: RepositoryError) -> Self {
        failure(error.kind.code(), error.message)
    }
}

/// Where a clone stages: a directory of its own, named by the operation, inside the staging directory.
fn work_directory(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("clone-{operation_id}"))
}

/// Removes what a clone staged. Only the directory this module created for the operation.
fn remove_work(staging_dir: &Path, operation_id: Uuid) {
    let directory = work_directory(staging_dir, operation_id);
    if directory.exists() {
        let _ = fs::remove_dir_all(directory);
    }
}

/// What a request must say, checked before anything is read. The keys are derived here and must be the ones given.
pub fn check_request(request: &CloneRequest) -> Result<(), JobFailure> {
    let emulator = request.emulator_type;
    if emulator.archive_key(&request.source.vm_name, request.source.version_id)
        != request.source.archive_key
    {
        return Err(failure(
            "invalid_request",
            "The source archive key does not belong to the source VM and version",
        ));
    }
    if emulator.archive_key(&request.target.vm_name, request.target.version_id)
        != request.target.archive_key
    {
        return Err(failure(
            "invalid_request",
            "The new archive key does not belong to the new VM and version",
        ));
    }
    if request.source.vm_name == request.target.vm_name {
        return Err(failure(
            "invalid_request",
            "A clone needs a name of its own",
        ));
    }
    if request.source.version_id == request.target.version_id {
        return Err(failure(
            "invalid_request",
            "A clone needs a version of its own",
        ));
    }
    if request.source.archive_size_bytes == 0
        || request.source.archive_sha256.len() != 64
        || !request
            .source
            .archive_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(failure(
            "invalid_request",
            "The source archive is not described",
        ));
    }
    Ok(())
}

/// What [`rewrite_zip`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewrittenZip {
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

fn zip_problem(message: impl Into<String>) -> JobFailure {
    failure("source_archive_invalid", message)
}

fn local_problem(error: &std::io::Error) -> JobFailure {
    if error.kind() == std::io::ErrorKind::StorageFull {
        return failure(
            "insufficient_staging_space",
            "The staging disk filled up while the clone was written",
        );
    }
    failure("staging_failed", format!("Cannot write the clone: {error}"))
}

/// Writes `source`, an EmuCat ZIP of `source_name`, again as one of `target_name`, into `target`, which must not
/// exist. The source is first inspected as a restore would inspect it: its structure, every entry, and a manifest
/// that is canonical, describes this VM, and is the one registered when `manifest_sha256` is known. Every entry but
/// the manifest is copied exactly, compressed bytes and CRC included; directories are written as packaging writes
/// them; the manifest is written last, with the new name and nothing else changed.
#[allow(clippy::too_many_arguments)]
pub fn rewrite_zip(
    source: &Path,
    target: &Path,
    emulator: EmulatorType,
    source_name: &VmName,
    target_name: &VmName,
    manifest_sha256: Option<&str>,
    limits: &ExtractionLimits,
    cancel: &CancelFlag,
) -> Result<RewrittenZip, JobFailure> {
    let mut file = File::open(source).map_err(|error| local_problem(&error))?;
    let inspected = inspect_archive(
        &mut file,
        &ArchiveExpectation {
            emulator,
            vm_name: source_name,
            manifest_sha256,
        },
        limits,
    )
    .map_err(|error| zip_problem(format!("The source archive was refused: {}", error.message)))?;

    let manifest = Manifest {
        vm_name: target_name.as_str().to_owned(),
        ..inspected.manifest.clone()
    };
    let manifest_bytes = manifest.canonical_bytes();

    let mut archive = ZipArchive::new(file).map_err(|error| zip_problem(error.to_string()))?;
    let output = File::options()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| local_problem(&error))?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(READ_BUFFER_BYTES, output));
    let zip_error = |error: zip::result::ZipError| match error {
        zip::result::ZipError::Io(error) => local_problem(&error),
        other => zip_problem(other.to_string()),
    };
    for index in 0..archive.len() {
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }
        let entry = archive.by_index_raw(index).map_err(zip_error)?;
        let name = entry.name().to_owned();
        if name == MANIFEST_ENTRY_NAME {
            continue;
        }
        if name.ends_with('/') {
            drop(entry);
            zip.add_directory(name, SimpleFileOptions::default())
                .map_err(zip_error)?;
        } else {
            zip.raw_copy_file(entry).map_err(zip_error)?;
        }
    }
    zip.start_file(
        MANIFEST_ENTRY_NAME,
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .map_err(zip_error)?;
    zip.write_all(&manifest_bytes)
        .map_err(|error| local_problem(&error))?;
    let writer = zip.finish().map_err(zip_error)?;
    let output = writer
        .into_inner()
        .map_err(|error| local_problem(error.error()))?;
    output.sync_all().map_err(|error| local_problem(&error))?;
    Ok(RewrittenZip {
        manifest,
        manifest_sha256: hex(&Sha256::digest(&manifest_bytes)),
    })
}

/// Checks a written clone as a restore would, then decompresses every file and compares its size and SHA-256 with
/// the manifest. Progress is in uncompressed bytes.
pub fn verify_zip(
    path: &Path,
    emulator: EmulatorType,
    vm_name: &VmName,
    rewritten: &RewrittenZip,
    limits: &ExtractionLimits,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &CancelFlag,
) -> Result<(), JobFailure> {
    let mut file = File::open(path).map_err(|error| local_problem(&error))?;
    let inspected = inspect_archive(
        &mut file,
        &ArchiveExpectation {
            emulator,
            vm_name,
            manifest_sha256: Some(&rewritten.manifest_sha256),
        },
        limits,
    )
    .map_err(|error| {
        failure(
            "hash_mismatch",
            format!("The written clone was refused: {}", error.message),
        )
    })?;
    if inspected.manifest != rewritten.manifest {
        return Err(failure(
            "hash_mismatch",
            "The written clone has another manifest",
        ));
    }
    let total = inspected.manifest.total_uncompressed_bytes;
    let mut done = 0u64;
    progress(done, total);
    let mut archive =
        ZipArchive::new(file).map_err(|error| failure("hash_mismatch", error.to_string()))?;
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    for listed in &inspected.manifest.entries {
        if listed.entry_type != ManifestEntryType::File {
            continue;
        }
        let mut entry = archive
            .by_name(&listed.path)
            .map_err(|error| failure("hash_mismatch", format!("{}: {error}", listed.path)))?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        loop {
            if cancel.is_cancelled() {
                return Err(RepositoryError::cancelled().into());
            }
            // Reading to the end also checks the entry's CRC.
            let count = entry.read(&mut buffer).map_err(|error| {
                failure(
                    "hash_mismatch",
                    format!("{} cannot be read: {error}", listed.path),
                )
            })?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            size += count as u64;
            done += count as u64;
            progress(done, total);
        }
        if Some(size) != listed.size_bytes
            || Some(hex(&hasher.finalize()).as_str()) != listed.sha256.as_deref()
        {
            return Err(failure(
                "hash_mismatch",
                format!("{} differs from the source's manifest", listed.path),
            ));
        }
    }
    Ok(())
}

pub struct VmClones {
    state_dir: PathBuf,
    staging_dir: PathBuf,
    repositories: Arc<dyn RepositoryProvider>,
    retry_delay: Duration,
    limits: ExtractionLimits,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    /// Shared with every other operation: one at a time on this agent.
    running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
    stopping: CancelFlag,
}

pub struct VmClonesConfig {
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub repositories: Arc<dyn RepositoryProvider>,
    pub retry_delay: Duration,
    pub limits: ExtractionLimits,
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("clones")
}

impl VmClones {
    /// Loads what an earlier run left behind, and resumes or fails it as a restart requires.
    pub fn load(
        config: VmClonesConfig,
        outbound: mpsc::Sender<Message>,
        running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
        stopping: CancelFlag,
    ) -> Result<Arc<Self>, String> {
        let directory = journal_directory(&config.state_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
        let mut journals = HashMap::new();
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|text| text.to_str()) != Some("journal") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
            // As for any journal: a damaged one is kept for inspection, and the server sees the operation as lost,
            // which deletes nothing and frees the name.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a clone journal that cannot be read");
                continue;
            };
            journals.insert(journal.request.operation_id, journal);
        }
        let clones = Arc::new(Self {
            state_dir: config.state_dir,
            staging_dir: config.staging_dir,
            repositories: config.repositories,
            retry_delay: config.retry_delay,
            limits: config.limits,
            outbound,
            journals: Mutex::new(journals),
            running,
            stopping,
        });
        clones.recover_interrupted();
        Ok(clones)
    }

    /// Whether this module has an operation of this identity. Cancels and answers are routed by it.
    pub fn owns(&self, operation_id: Uuid) -> bool {
        self.journals
            .lock()
            .expect("poisoned")
            .contains_key(&operation_id)
    }

    pub fn sync_entries(&self) -> Vec<RegistrationSyncEntry> {
        self.journals
            .lock()
            .expect("poisoned")
            .iter()
            .map(|(operation_id, journal)| RegistrationSyncEntry {
                operation_id: *operation_id,
                phase: journal.phase,
            })
            .collect()
    }

    /// Reports without an answer yet, sent again on every heartbeat.
    pub fn pending_reports(&self) -> Vec<Message> {
        let journals = self.journals.lock().expect("poisoned");
        let running = self.running.lock().expect("poisoned");
        journals
            .iter()
            .filter_map(
                |(operation_id, journal)| match (&journal.report, journal.phase) {
                    (Some(Report::Failure(report)), _) => {
                        Some(Message::AgentRegistrationError(report.clone()))
                    }
                    (Some(Report::Cleanup(report)), _) => {
                        Some(Message::AgentRegistrationCleanup(report.clone()))
                    }
                    (None, RegistrationPhase::Published) if !running.contains_key(operation_id) => {
                        journal.published.as_ref().map(Published::message)
                    }
                    _ => None,
                },
            )
            .collect()
    }

    pub fn open_operations(&self) -> Vec<Uuid> {
        self.journals
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect()
    }

    fn journal_path(&self, operation_id: Uuid) -> PathBuf {
        journal_directory(&self.state_dir).join(format!("{operation_id}.journal"))
    }

    fn persist(&self, journal: Journal) -> std::io::Result<()> {
        let operation_id = journal.request.operation_id;
        let path = self.journal_path(operation_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&journal).expect("a journal always serializes");
        {
            let mut file = File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &path)?;
        self.journals
            .lock()
            .expect("poisoned")
            .insert(operation_id, journal);
        Ok(())
    }

    fn journal(&self, operation_id: Uuid) -> Option<Journal> {
        self.journals
            .lock()
            .expect("poisoned")
            .get(&operation_id)
            .cloned()
    }

    fn forget(&self, operation_id: Uuid) {
        self.journals
            .lock()
            .expect("poisoned")
            .remove(&operation_id);
        let _ = fs::remove_file(self.journal_path(operation_id));
    }

    fn send(&self, message: Message) {
        let _ = self.outbound.try_send(message);
    }

    fn refuse(&self, operation_id: Uuid, code: &str, message: &str) {
        self.send(Message::AgentRegistrationError(RegistrationFailure {
            operation_id,
            code: code.to_owned(),
            message: message.to_owned(),
        }));
    }

    fn record_failure(&self, mut journal: Journal, failed: JobFailure) {
        let operation_id = journal.request.operation_id;
        let report = RegistrationFailure {
            operation_id,
            code: failed.code,
            message: failed.message.chars().take(1000).collect(),
        };
        journal.phase = RegistrationPhase::Reported;
        journal.report = Some(Report::Failure(report.clone()));
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a failure");
        }
        self.send(Message::AgentRegistrationError(report));
    }

    fn recover_interrupted(self: &Arc<Self>) {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .cloned()
            .collect();
        for journal in journals {
            let operation_id = journal.request.operation_id;
            remove_work(&self.staging_dir, operation_id);
            match journal.phase {
                RegistrationPhase::Running => {
                    let repository_id = journal.request.repository_id;
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the clone was published. Nothing was created, and \
                             the source is unchanged. It is safe to try again",
                        ),
                    );
                    self.spawn_remote_cleanup(operation_id, repository_id);
                }
                RegistrationPhase::Publishing if tokio::runtime::Handle::try_current().is_ok() => {
                    let clones = Arc::clone(self);
                    tokio::spawn(async move { clones.resolve_publishing(journal).await });
                }
                _ => {}
            }
        }
    }

    /// After a restart during publication: the clone's object, if it is there and is what was built, is this
    /// operation's. Otherwise nothing was published, and the operation fails.
    async fn resolve_publishing(self: Arc<Self>, mut journal: Journal) {
        let Some(published) = journal.published.clone() else {
            return;
        };
        let operation_id = journal.request.operation_id;
        let repository = match self.repositories.open(journal.request.repository_id) {
            Ok(repository) => repository,
            Err(error) => {
                self.record_failure(journal, error.into());
                return;
            }
        };
        let (key, size, sha256) = published.key_size_sha();
        let Ok(final_key) = RepositoryKey::new(key.to_owned()) else {
            return;
        };
        let staging = RepositoryKey::staging(operation_id);
        loop {
            if self.stopping.is_cancelled() {
                return;
            }
            let verified = repository
                .verify(
                    &final_key,
                    size,
                    sha256,
                    crate::repository::no_progress(),
                    &self.stopping,
                )
                .await;
            match verified {
                Ok(_) => {
                    let _ = repository.delete(&staging).await;
                    journal.phase = RegistrationPhase::Published;
                    if self.persist(journal.clone()).is_ok() {
                        self.send(published.message());
                    }
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::NotFound => {
                    let _ = repository.delete(&staging).await;
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the clone was published",
                        ),
                    );
                    return;
                }
                Err(error) if error.kind == RepositoryErrorKind::Cancelled => return,
                Err(error) => {
                    tracing::warn!(%error, %operation_id, "Cannot check a publication yet");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        }
    }

    fn spawn_remote_cleanup(self: &Arc<Self>, operation_id: Uuid, repository_id: Uuid) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let clones = Arc::clone(self);
        tokio::spawn(async move {
            let Ok(repository) = clones.repositories.open(repository_id) else {
                return;
            };
            let staging = RepositoryKey::staging(operation_id);
            for attempt in 0..REMOTE_CLEANUP_ATTEMPTS {
                match repository.delete(&staging).await {
                    Ok(()) => return,
                    Err(error) if attempt + 1 == REMOTE_CLEANUP_ATTEMPTS => {
                        tracing::warn!(%error, %operation_id, "Cannot remove a staging object");
                    }
                    Err(_) => tokio::time::sleep(clones.retry_delay).await,
                }
            }
        });
    }

    pub fn start(self: &Arc<Self>, request: CloneRequest) {
        let operation_id = request.operation_id;
        if self.journal(operation_id).is_some() {
            tracing::debug!(%operation_id, "Ignored a repeated clone request");
            return;
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                self.refuse(
                    operation_id,
                    "agent_busy",
                    "This agent is already running an operation",
                );
                return;
            }
            running.insert(operation_id, cancel.clone());
        }
        let journal = Journal {
            request,
            phase: RegistrationPhase::Running,
            published: None,
            report: None,
        };
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot create a journal");
            self.running.lock().expect("poisoned").remove(&operation_id);
            self.refuse(
                operation_id,
                "staging_failed",
                "The agent cannot write to its state directory",
            );
            return;
        }
        let clones = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, "Clone started");
            let outcome = clones.run_job(operation_id, &cancel).await;
            clones
                .running
                .lock()
                .expect("poisoned")
                .remove(&operation_id);
            if clones.stopping.is_cancelled() {
                return;
            }
            remove_work(&clones.staging_dir, operation_id);
            if let Err(failed) = outcome {
                tracing::warn!(%operation_id, code = %failed.code, message = %failed.message, "Clone failed");
                if let Some(journal) = clones.journal(operation_id) {
                    let repository_id = journal.request.repository_id;
                    clones.record_failure(journal, failed);
                    clones.spawn_remote_cleanup(operation_id, repository_id);
                }
            }
        });
    }

    pub fn cancel(&self, operation_id: Uuid) {
        if let Some(flag) = self.running.lock().expect("poisoned").get(&operation_id) {
            let phase = self.journal(operation_id).map(|journal| journal.phase);
            if matches!(phase, Some(RegistrationPhase::Running)) {
                tracing::info!(%operation_id, "Clone cancelled");
                flag.cancel();
            }
        }
    }

    fn send_progress(
        &self,
        operation_id: Uuid,
        stage: RegistrationStage,
        done_bytes: Option<u64>,
        total_bytes: Option<u64>,
    ) {
        self.send(Message::AgentRegistrationProgress(RegistrationProgress {
            operation_id,
            stage,
            done_bytes,
            total_bytes,
        }));
    }

    fn progress_reporter(
        self: &Arc<Self>,
        operation_id: Uuid,
        stage: RegistrationStage,
    ) -> ProgressFn {
        let clones = Arc::clone(self);
        let last = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
        self.send_progress(operation_id, stage, None, None);
        Arc::new(move |done: u64, total: u64| {
            let mut last = last.lock().expect("poisoned");
            if last.elapsed() >= PROGRESS_INTERVAL || done == total {
                *last = Instant::now();
                clones.send_progress(operation_id, stage, Some(done), Some(total));
            }
        })
    }

    async fn run_job(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Result<(), JobFailure> {
        let mut journal = self
            .journal(operation_id)
            .ok_or_else(|| failure("internal_error", "The journal disappeared"))?;
        let request = journal.request.clone();
        self.send_progress(operation_id, RegistrationStage::Validating, None, None);
        check_request(&request)?;
        let source_key = RepositoryKey::new(request.source.archive_key.clone())
            .map_err(|_| failure("invalid_request", "The source archive key is not valid"))?;
        let final_key = RepositoryKey::new(request.target.archive_key.clone())
            .map_err(|_| failure("invalid_request", "The new archive key is not valid"))?;
        let repository = self.repositories.open(request.repository_id)?;
        if repository.stat(&final_key).await?.is_some() {
            return Err(failure(
                "archive_exists",
                "An archive already exists at the clone's key",
            ));
        }
        let expected_size = request.source.archive_size_bytes;
        match repository.stat(&source_key).await? {
            None => {
                return Err(failure(
                    "remote_object_missing",
                    "The source version's archive is not in the repository",
                ));
            }
            Some(object) if object.size_bytes != expected_size => {
                return Err(failure(
                    "source_archive_invalid",
                    "The source version's archive does not have the registered size",
                ));
            }
            Some(_) => {}
        }

        // A ZIP needs room for the download and the clone; an OVA, for the download alone.
        let zip = request.emulator_type.filesystem();
        let needed = if zip.is_some() {
            expected_size.saturating_mul(2)
        } else {
            expected_size
        };
        fs::create_dir_all(&self.staging_dir).map_err(|error| local_problem(&error))?;
        if let Some(free) = available_disk_bytes(&self.staging_dir)
            && free < needed
        {
            return Err(failure(
                "insufficient_staging_space",
                format!("The staging disk has {free} bytes free, and the clone needs {needed}"),
            ));
        }
        let work = work_directory(&self.staging_dir, operation_id);
        remove_work(&self.staging_dir, operation_id);
        fs::create_dir_all(&work).map_err(|error| local_problem(&error))?;
        let extension = if zip.is_some() { "zip" } else { "ova" };
        let downloaded = work.join(format!("source.{extension}"));
        let output = work.join(format!("{operation_id}.{extension}"));

        // The source, exactly as registered: anything else is not cloned.
        let downloading = self.progress_reporter(operation_id, RegistrationStage::Archiving);
        let received = repository
            .download(&source_key, &downloaded, downloading, cancel)
            .await?;
        if received.size_bytes != expected_size || received.sha256 != request.source.archive_sha256
        {
            return Err(failure(
                "source_archive_invalid",
                "The downloaded source archive is not the one that was registered",
            ));
        }

        let manifest = match zip {
            Some(emulator) => {
                let (
                    source_path,
                    output_path,
                    source_name,
                    target_name,
                    manifest_sha256,
                    limits,
                    cancel_job,
                ) = (
                    downloaded.clone(),
                    output.clone(),
                    request.source.vm_name.clone(),
                    request.target.vm_name.clone(),
                    request.source.manifest_sha256.clone(),
                    self.limits,
                    cancel.clone(),
                );
                let verifying = self.progress_reporter(operation_id, RegistrationStage::Archiving);
                let rewritten = blocking(move || -> Result<RewrittenZip, JobFailure> {
                    let rewritten = rewrite_zip(
                        &source_path,
                        &output_path,
                        emulator,
                        &source_name,
                        &target_name,
                        manifest_sha256.as_deref(),
                        &limits,
                        &cancel_job,
                    )?;
                    // The downloaded copy is no longer needed: give its room back before verifying.
                    let _ = fs::remove_file(&source_path);
                    verify_zip(
                        &output_path,
                        emulator,
                        &target_name,
                        &rewritten,
                        &limits,
                        &mut |done, total| verifying(done, total),
                        &cancel_job,
                    )?;
                    Ok(rewritten)
                })
                .await??;
                Some(rewritten)
            }
            None => {
                let (source_path, output_path) = (downloaded.clone(), output.clone());
                blocking(move || -> Result<(), JobFailure> {
                    crate::ova::inspect(&source_path).map_err(|error| {
                        failure(
                            "source_archive_invalid",
                            format!("The source OVA was refused: {}", error.message),
                        )
                    })?;
                    fs::rename(&source_path, &output_path).map_err(|error| local_problem(&error))
                })
                .await??;
                None
            }
        };
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }

        let (size_bytes, sha256) = {
            let (output, cancel) = (output.clone(), cancel.clone());
            blocking(move || hash_file(&output, &cancel))
                .await?
                .map_err(|error| failure(error.kind.code(), error.message))?
        };
        // An OVA is the same bytes, and must say so.
        if manifest.is_none() && sha256 != request.source.archive_sha256 {
            return Err(failure(
                "hash_mismatch",
                "The copied OVA differs from its source",
            ));
        }
        if let Some(free) = repository.free_space().await?
            && free < size_bytes
        {
            return Err(failure(
                "insufficient_remote_space",
                format!(
                    "The repository has {free} bytes free, and the clone is {size_bytes} bytes"
                ),
            ));
        }

        let staging = RepositoryKey::staging(operation_id);
        let attempts = self
            .repositories
            .upload_attempts(request.repository_id)
            .max(1);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = self
                .upload_and_verify(
                    &*repository,
                    &staging,
                    &output,
                    size_bytes,
                    &sha256,
                    operation_id,
                    cancel,
                )
                .await;
            match outcome {
                Ok(()) => break,
                Err(error) if error.kind.is_retryable() && attempt < attempts => {
                    tracing::warn!(%error, %operation_id, attempt, "Upload failed; trying again");
                    let _ = repository.delete(&staging).await;
                    tokio::select! {
                        () = tokio::time::sleep(self.retry_delay) => {}
                        () = cancel.cancelled() => return Err(RepositoryError::cancelled().into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }

        let published = match &manifest {
            Some(rewritten) => Published::Zip(RegistrationResult {
                operation_id,
                version_id: request.target.version_id,
                archive_key: request.target.archive_key.clone(),
                archive_size_bytes: size_bytes,
                archive_sha256: sha256.clone(),
                manifest_version: rewritten.manifest.manifest_version,
                manifest_sha256: rewritten.manifest_sha256.clone(),
                file_count: rewritten.manifest.file_count,
                total_uncompressed_bytes: rewritten.manifest.total_uncompressed_bytes,
            }),
            None => Published::Ova(VirtualBoxRegistrationResult {
                operation_id,
                version_id: request.target.version_id,
                archive_key: request.target.archive_key.clone(),
                archive_size_bytes: size_bytes,
                archive_sha256: sha256.clone(),
            }),
        };
        journal.phase = RegistrationPhase::Publishing;
        journal.published = Some(published.clone());
        self.persist(journal.clone()).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;

        let published_ok = async {
            let mut attempt = 0;
            loop {
                attempt += 1;
                match repository.publish(&staging, &final_key).await {
                    Ok(()) => return Ok(()),
                    Err(error) if error.kind == RepositoryErrorKind::AlreadyExists => {
                        // Only this operation's own earlier attempt counts: the same bytes.
                        return repository
                            .verify(
                                &final_key,
                                size_bytes,
                                &sha256,
                                crate::repository::no_progress(),
                                &CancelFlag::new(),
                            )
                            .await
                            .map(|_| ())
                            .map_err(|_| error);
                    }
                    Err(error) if error.kind.is_retryable() && attempt < attempts => {
                        tracing::warn!(%error, %operation_id, "Publication failed; trying again");
                        tokio::time::sleep(self.retry_delay).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        .await;
        if let Err(error) = published_ok {
            journal.phase = RegistrationPhase::Running;
            journal.published = None;
            let _ = self.persist(journal);
            return Err(error.into());
        }
        let stored = repository.stat(&final_key).await?;
        if stored.map(|object| object.size_bytes) != Some(size_bytes) {
            journal.phase = RegistrationPhase::Running;
            journal.published = None;
            let _ = self.persist(journal);
            return Err(failure(
                "hash_mismatch",
                "The published clone does not have the expected size",
            ));
        }

        journal.phase = RegistrationPhase::Published;
        self.persist(journal).map_err(|error| {
            failure(
                "staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;
        tracing::info!(%operation_id, size = size_bytes, sha256 = %sha256, "Clone published");
        self.send(published.message());
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_and_verify(
        self: &Arc<Self>,
        repository: &dyn ArchiveRepository,
        staging: &RepositoryKey,
        path: &Path,
        size_bytes: u64,
        sha256: &str,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> crate::repository::RepositoryResult<()> {
        let uploading = self.progress_reporter(operation_id, RegistrationStage::Uploading);
        repository.upload(staging, path, uploading, cancel).await?;
        let verifying = self.progress_reporter(operation_id, RegistrationStage::Verifying);
        repository
            .verify(staging, size_bytes, sha256, verifying, cancel)
            .await?;
        Ok(())
    }

    /// The server's answer. A commit is answered with the cleanup report every copy makes: nothing local was ever
    /// touched, so there is nothing to clean up.
    pub fn acknowledged(self: &Arc<Self>, ack: RegistrationAck) {
        let operation_id = ack.operation_id;
        let Some(mut journal) = self.journal(operation_id) else {
            return;
        };
        match ack.outcome {
            AckOutcome::Closed => {
                tracing::info!(%operation_id, "Clone closed");
                self.forget(operation_id);
            }
            AckOutcome::Rejected => {
                tracing::warn!(%operation_id, "The server rejected this clone");
                remove_work(&self.staging_dir, operation_id);
                let clones = Arc::clone(self);
                tokio::spawn(async move {
                    if let Ok(repository) = clones.repositories.open(journal.request.repository_id)
                    {
                        let _ = repository
                            .delete(&RepositoryKey::staging(operation_id))
                            .await;
                        // Only the clone's own object, at the key this operation was issued: never the source's.
                        if ack.delete_published
                            && let Some(published) = &journal.published
                            && published.key_size_sha().0 == journal.request.target.archive_key
                            && let Ok(key) =
                                RepositoryKey::new(journal.request.target.archive_key.clone())
                        {
                            let _ = repository.delete(&key).await;
                        }
                    }
                    clones.forget(operation_id);
                });
            }
            AckOutcome::Committed => {
                if ack.version_id != Some(journal.request.target.version_id) {
                    tracing::error!(%operation_id, "An acknowledgement for a different version was ignored");
                    return;
                }
                if journal.phase != RegistrationPhase::Published {
                    return;
                }
                let report = RegistrationCleanup {
                    operation_id,
                    version_id: journal.request.target.version_id,
                    local_copy: LocalCopyStatus::Preserved,
                    code: None,
                    message: None,
                };
                journal.phase = RegistrationPhase::Reported;
                journal.report = Some(Report::Cleanup(report.clone()));
                if let Err(error) = self.persist(journal) {
                    tracing::error!(%error, %operation_id, "Cannot record the commit");
                }
                self.send(Message::AgentRegistrationCleanup(report));
            }
        }
    }
}

async fn blocking<T, F>(work: F) -> Result<T, JobFailure>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| failure("internal_error", format!("The work stopped: {error}")))
}
