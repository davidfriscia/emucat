//! The durable side of restoring a master on the agent.
//!
//! Each operation has a journal, written before anything that cannot be taken back, as registration does.
//! Everything up to publication happens in places nothing else looks at: the download in the staging
//! directory, the extraction in a directory named after this operation. Publication is one rename that
//! refuses to replace anything. So whatever goes wrong before it, and wherever the agent stops, there is
//! nothing to undo, and no existing directory can be harmed. See decisions 0021 to 0024.
//!
//! The agent decides where a VM goes, from its own configuration, and it recomputes the archive key. The
//! server names identities only.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::archive_cache::{ArchiveCache, CachePin};
use crate::archives::VersionId;
use crate::config::EmulatorConfig;
use crate::emulators::{EmulatorType, VmIdentity, VmName};
use crate::execution::ActivityProbe;
use crate::extraction::{
    ArchiveError, ArchiveErrorKind, ArchiveExpectation, ExtractionLimits, InspectedArchive,
    Publication, archive_error, check_base_path, check_destination_free, extract_archive,
    inspect_archive, publish_directory, remove_staged_directory, staged_directory,
};
use crate::media_sync::MediaPreservation;
use crate::packaging::{
    DirectoryIdentity, MANIFEST_VERSION, Manifest, ManifestEntryType, TreeEntry,
    available_disk_bytes, directory_identity, hex, open_for_reading, resolve_vm_root, scan_tree,
};
use crate::protocol::{
    LocalCopyCondition, LocalCopyReport, Message, RestoreAck, RestoreCache, RestoreCancel,
    RestoreCapabilities, RestoreEmulator, RestoreFailure, RestorePhase, RestoreProgress,
    RestoreRequest, RestoreResult, RestoreStage, RestoreSync, RestoreSyncEntry, VerifyPathList,
    VerifyResultStatus, VmVerifyAck, VmVerifyRequest, VmVerifyResult,
};
use crate::registration::RepositoryProvider;
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
};
use crate::state::{local_source_entries, record_local_source};
use crate::verification::{PathList, VerifyStatus, verify_local_copy};

/// Progress is informational, so it is thinned out to well below the server's message limit.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
/// Room left over when checking free space, so that the check errs on the side of refusing.
const SPACE_MARGIN_BYTES: u64 = 16 * 1024 * 1024;
const LOCAL_COPIES_MAX: usize = 256;

/// Where restores keep things, and how much they accept. All of it local configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreSettings {
    pub cache_dir: PathBuf,
    pub cache_max_bytes: u64,
    pub limits: ExtractionLimits,
}

impl RestoreSettings {
    pub const DEFAULT_CACHE_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;

    pub fn under(state_dir: &Path) -> Self {
        Self {
            cache_dir: state_dir.join("archive-cache"),
            cache_max_bytes: Self::DEFAULT_CACHE_MAX_BYTES,
            limits: ExtractionLimits::default(),
        }
    }
}

pub struct RestoreConfig {
    pub agent_id: Uuid,
    pub state_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub emulators: Arc<BTreeMap<EmulatorType, EmulatorConfig>>,
    pub repositories: Arc<dyn RepositoryProvider>,
    pub retry_delay: Duration,
    pub media: Option<Arc<dyn MediaPreservation>>,
    pub settings: RestoreSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "report", rename_all = "snake_case")]
enum Report {
    Failure(RestoreFailure),
    Result(RestoreResult),
}

/// Everything needed to carry on after a restart. It holds no secret and no VM contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request: RestoreRequest,
    phase: RestorePhase,
    /// The directory assembled for this operation, recorded before it is moved into place.
    staged_identity: Option<DirectoryIdentity>,
    /// What will be reported once the rename has happened.
    result: Option<RestoreResult>,
    report: Option<Report>,
}

#[derive(Debug)]
struct JobFailure {
    code: String,
    message: String,
}

impl From<ArchiveError> for JobFailure {
    fn from(error: ArchiveError) -> Self {
        Self {
            code: error.kind.code().to_owned(),
            message: error.message,
        }
    }
}

impl From<RepositoryError> for JobFailure {
    fn from(error: RepositoryError) -> Self {
        Self {
            code: error.kind.code().to_owned(),
            message: error.message,
        }
    }
}

fn failure(code: &str, message: impl Into<String>) -> JobFailure {
    JobFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

fn bounded(message: &str) -> String {
    message.chars().take(1000).collect()
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn journal_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("restores")
}

/// The manifest of a restored VM, kept so that a later difference can be noticed.
fn local_manifest_path(state_dir: &Path, emulator: EmulatorType, vm_name: &VmName) -> PathBuf {
    state_dir
        .join("local-manifests")
        .join(format!("{emulator}-{}.json", vm_name.key()))
}

/// Keeps the manifest of the master a local VM is a copy of, replacing an older one atomically.
pub fn keep_local_manifest(
    state_dir: &Path,
    emulator: EmulatorType,
    vm_name: &VmName,
    manifest: &Manifest,
) -> std::io::Result<()> {
    let path = local_manifest_path(state_dir, emulator, vm_name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, manifest.canonical_bytes())?;
    fs::rename(&temporary, &path)
}

fn verification_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("verifications")
}

/// A verification, kept until the server has its result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyJournal {
    request: VmVerifyRequest,
    result: Option<VmVerifyResult>,
}

fn path_list(list: PathList) -> VerifyPathList {
    VerifyPathList {
        count: list.count,
        paths: list.paths,
    }
}

/// A download's name while it is being written, unique to the attempt: a failed attempt's file can stay
/// locked for a moment on Windows, and that must not stop the next one.
fn download_path(staging_dir: &Path, operation_id: Uuid, attempt: u32) -> PathBuf {
    staging_dir.join(format!("restore-{operation_id}.{attempt}.zip.part"))
}

fn finished_download_path(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("restore-{operation_id}.zip"))
}

/// Removes everything this operation left in the staging directory. Only names holding its UUID.
fn remove_staging_files(staging_dir: &Path, operation_id: Uuid) {
    let prefix = format!("restore-{operation_id}");
    let Ok(listing) = fs::read_dir(staging_dir) else {
        return;
    };
    for item in listing.flatten() {
        if item.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_file(item.path());
        }
    }
}

/// An archive opened so that nobody can write to it, hashed through that handle, and used through that
/// same handle afterwards. What is extracted is what was hashed, whatever happens to the name.
fn open_verified(
    path: &Path,
    size: u64,
    sha256: &str,
    progress: &ProgressFn,
    cancel: &CancelFlag,
) -> Result<fs::File, ArchiveError> {
    let mut file = open_for_reading(path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::Staging,
            format!("Cannot open the downloaded archive: {error}"),
        )
    })?;
    let actual_size = file
        .metadata()
        .map_err(|error| {
            archive_error(
                ArchiveErrorKind::Staging,
                format!("Cannot examine the archive: {error}"),
            )
        })?
        .len();
    if actual_size != size {
        return Err(archive_error(
            ArchiveErrorKind::Integrity,
            format!("The archive is {actual_size} bytes, and {size} were registered"),
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; HASH_BUFFER_BYTES];
    let mut done = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(archive_error(ArchiveErrorKind::Cancelled, "Cancelled"));
        }
        let count = file.read(&mut buffer).map_err(|error| {
            archive_error(
                ArchiveErrorKind::Staging,
                format!("Cannot read the archive: {error}"),
            )
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        done += count as u64;
        progress(done, size);
    }
    let actual = hex(&hasher.finalize());
    if actual != sha256 {
        return Err(archive_error(
            ArchiveErrorKind::Integrity,
            format!("The archive's SHA-256 is {actual}, and {sha256} was registered"),
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        archive_error(
            ArchiveErrorKind::Staging,
            format!("Cannot read the archive: {error}"),
        )
    })?;
    Ok(file)
}

struct ObtainedArchive {
    file: fs::File,
    path: PathBuf,
    cached: bool,
    hit: bool,
    downloaded_bytes: u64,
    _pin: CachePin,
}

pub struct RestoreManager {
    config: RestoreConfig,
    cache: ArchiveCache,
    outbound: mpsc::Sender<Message>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    /// Work in progress on this agent, of any kind, and how to stop it. Shared with registration, since
    /// one disk is enough work at a time.
    running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
    /// Set when the process is stopping. Work then ends as a crash would leave it, for the next start.
    stopping: CancelFlag,
    /// Whether an emulator is running a VM, which no restore or verification may touch then.
    activity: OnceLock<ActivityProbe>,
    verifications: Mutex<HashMap<Uuid, VerifyJournal>>,
    /// Operations whose progress nobody asked for: verifications, which reuse the archive download.
    quiet: Mutex<HashSet<Uuid>>,
}

impl RestoreManager {
    /// Loads what an earlier run left behind, and settles it. Nothing here can touch a final directory
    /// that this agent cannot prove it put there.
    pub fn load(
        config: RestoreConfig,
        outbound: mpsc::Sender<Message>,
        running: Arc<Mutex<HashMap<Uuid, CancelFlag>>>,
        stopping: CancelFlag,
    ) -> Result<Arc<Self>, String> {
        let directory = journal_directory(&config.state_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;

        let mut journals = HashMap::new();
        for item in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
            .flatten()
        {
            let path = item.path();
            if path.extension().and_then(|text| text.to_str()) != Some("journal") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
            // A damaged journal must not make the agent guess. Without it, the server treats the
            // operation as lost, which deletes nothing, and the file is kept for inspection.
            let Ok(journal) = serde_json::from_str::<Journal>(&text) else {
                tracing::error!(path = %path.display(), "Ignored a journal that cannot be read");
                continue;
            };
            journals.insert(journal.request.operation_id, journal);
        }

        let directory = verification_directory(&config.state_dir);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
        let mut verifications = HashMap::new();
        for item in fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
            .flatten()
        {
            let path = item.path();
            if path.extension().and_then(|text| text.to_str()) != Some("journal") {
                continue;
            }
            let Some(journal) = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<VerifyJournal>(&bytes).ok())
            else {
                tracing::error!(path = %path.display(), "Ignored a verification journal that cannot be read");
                continue;
            };
            verifications.insert(journal.request.operation_id, journal);
        }

        let cache = ArchiveCache::open(
            config.settings.cache_dir.clone(),
            config.settings.cache_max_bytes,
        );
        let manager = Arc::new(Self {
            config,
            cache,
            outbound,
            journals: Mutex::new(journals),
            running,
            stopping,
            activity: OnceLock::new(),
            verifications: Mutex::new(verifications),
            quiet: Mutex::new(HashSet::new()),
        });
        manager.recover_interrupted();
        manager.recover_verifications();
        Ok(manager)
    }

    pub fn set_activity_probe(&self, probe: ActivityProbe) {
        let _ = self.activity.set(probe);
    }

    fn vm_activity(&self, vm: &VmIdentity) -> Option<String> {
        self.activity.get().and_then(|probe| probe(vm))
    }

    /// Why `vm` must not be launched now, if a restore or verification is working on it.
    pub fn working_on(&self, vm: &VmIdentity) -> Option<String> {
        let running = self.running.lock().expect("poisoned");
        let journals = self.journals.lock().expect("poisoned");
        let verifications = self.verifications.lock().expect("poisoned");
        let same = |emulator: EmulatorType, name: &VmName| {
            emulator == vm.emulator_type && *name == vm.vm_name
        };
        running.keys().find_map(|operation_id| {
            if let Some(journal) = journals.get(operation_id)
                && same(journal.request.emulator_type, &journal.request.vm_name)
            {
                return Some(format!("A restore of {} is in progress", vm.vm_name));
            }
            if let Some(journal) = verifications.get(operation_id)
                && same(journal.request.emulator_type, &journal.request.vm_name)
            {
                return Some(format!("{} is being verified", vm.vm_name));
            }
            None
        })
    }

    pub fn cache(&self) -> &ArchiveCache {
        &self.cache
    }

    fn journal_path(&self, operation_id: Uuid) -> PathBuf {
        journal_directory(&self.config.state_dir).join(format!("{operation_id}.journal"))
    }

    /// Replaces the journal atomically and durably, and then updates the copy in memory.
    fn persist(&self, journal: Journal) -> std::io::Result<()> {
        let operation_id = journal.request.operation_id;
        let path = self.journal_path(operation_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&journal).expect("a journal always serializes");
        {
            use std::io::Write;
            let mut file = fs::File::create(&temporary)?;
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
        // Nobody may be connected. Anything that matters is in a journal, and is sent again.
        let _ = self.outbound.try_send(message);
    }

    fn base_path(&self, emulator: EmulatorType) -> Option<PathBuf> {
        self.config
            .emulators
            .get(&emulator)
            .map(|config| config.base_path.clone())
    }

    /// Where a restore publishes: the emulator's base path, or a working copy's own directory, which the
    /// agent derives from its state directory and the working copy's UUID alone.
    fn target_base(&self, request: &RestoreRequest) -> Option<PathBuf> {
        match request.workspace_id {
            Some(workspace_id) => {
                self.base_path(request.emulator_type)?;
                Some(crate::workspaces::workspace_base(
                    &self.config.state_dir,
                    workspace_id,
                ))
            }
            None => self.base_path(request.emulator_type),
        }
    }

    fn record_failure(&self, mut journal: Journal, failed: JobFailure) {
        let operation_id = journal.request.operation_id;
        let report = RestoreFailure {
            operation_id,
            code: failed.code,
            message: bounded(&failed.message),
        };
        journal.phase = RestorePhase::Reported;
        journal.report = Some(Report::Failure(report.clone()));
        journal.result = None;
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a failure");
        }
        self.send(Message::AgentRestoreError(report));
    }

    fn recover_interrupted(&self) {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .cloned()
            .collect();
        for journal in journals {
            let operation_id = journal.request.operation_id;
            remove_staging_files(&self.config.staging_dir, operation_id);
            match journal.phase {
                RestorePhase::Running => {
                    if let Some(base) = self.target_base(&journal.request) {
                        remove_staged_directory(&staged_directory(&base, operation_id));
                    }
                    if let Some(workspace_id) = journal.request.workspace_id {
                        crate::workspaces::forget_unpublished(&self.config.state_dir, workspace_id);
                    }
                    self.record_failure(
                        journal,
                        failure(
                            "agent_restarted",
                            "The agent restarted before the VM was published. Nothing was published, \
                             and it is safe to try again",
                        ),
                    );
                }
                RestorePhase::Publishing => self.resolve_publishing(journal),
                RestorePhase::Published | RestorePhase::Reported => {}
            }
        }
    }

    /// The agent stopped around the rename. Whether it happened is a question for the disk: a directory
    /// is this operation's only if it is the very one that was assembled. Anything else is left alone.
    fn resolve_publishing(&self, mut journal: Journal) {
        let operation_id = journal.request.operation_id;
        let Some(base) = self.target_base(&journal.request) else {
            self.record_failure(
                journal,
                failure(
                    "restore_emulator_not_configured",
                    "This emulator is no longer configured, so the agent cannot tell whether the VM \
                     was published",
                ),
            );
            return;
        };
        let staged = staged_directory(&base, operation_id);
        let destination = crate::filesystem::vm_directory(&base, &journal.request.vm_name);
        let staged_exists = fs::symlink_metadata(&staged).is_ok();
        let final_exists = fs::symlink_metadata(&destination).is_ok();
        let recorded = journal.staged_identity;
        let is_recorded =
            |path: &Path| recorded.is_some() && directory_identity(path).ok() == recorded;

        if final_exists && is_recorded(&destination) {
            tracing::info!(%operation_id, "A restore finished publishing before the agent stopped");
            self.finish_published(&mut journal);
            return;
        }
        if staged_exists && !is_recorded(&staged) {
            self.record_failure(
                journal,
                failure(
                    "restore_ambiguous_directory",
                    format!(
                        "{} is not the directory this restore assembled, so it was left alone",
                        staged.display()
                    ),
                ),
            );
            return;
        }
        if staged_exists {
            remove_staged_directory(&staged);
        }
        let failed = if final_exists {
            failure(
                "restore_destination_exists",
                format!(
                    "{} exists, and is not what this restore assembled, so it was left alone",
                    destination.display()
                ),
            )
        } else {
            failure(
                "agent_restarted",
                "The agent restarted before the VM was published. Nothing was published, and it is \
                 safe to try again",
            )
        };
        self.record_failure(journal, failed);
    }

    /// The rename has happened. From here on the directory stays, whatever anyone answers.
    fn finish_published(&self, journal: &mut Journal) {
        let operation_id = journal.request.operation_id;
        let Some(result) = journal.result.clone() else {
            tracing::error!(%operation_id, "A published restore has no result recorded");
            return;
        };
        journal.phase = RestorePhase::Published;
        journal.report = Some(Report::Result(result.clone()));
        if let Err(error) = self.persist(journal.clone()) {
            tracing::error!(%error, %operation_id, "Cannot record a publication");
        }
        // A working copy's record was written before the rename, and the persistent copy's state is not
        // this restore's business.
        if journal.request.workspace_id.is_some() {
            self.send(Message::AgentRestoreResult(result));
            return;
        }
        // Local bookkeeping. If it fails, the server still knows, and the next report says so.
        if let Err(error) = record_local_source(
            &self.config.state_dir,
            self.config.agent_id,
            journal.request.emulator_type,
            &journal.request.vm_name,
            journal.request.version_id,
            Some(&result.manifest_sha256),
            // The rename moved the directory this restore assembled; its identity is that one's.
            journal.staged_identity,
        ) {
            tracing::warn!(%error, "Cannot record the local source version");
        }
        self.send(Message::AgentRestoreResult(result));
    }

    /// What a new connection must say: what this agent could restore, which operations exist here, and
    /// what it can tell about the copies it holds.
    pub fn sync_message(&self) -> Message {
        let operations = self
            .journals
            .lock()
            .expect("poisoned")
            .iter()
            .map(|(operation_id, journal)| RestoreSyncEntry {
                operation_id: *operation_id,
                phase: journal.phase,
            })
            .collect();
        Message::AgentRestoreSync(RestoreSync {
            operations,
            capabilities: self.capabilities(),
            local_copies: self.local_copies(),
            workspaces: crate::workspaces::held(&self.config.state_dir),
        })
    }

    fn capabilities(&self) -> RestoreCapabilities {
        RestoreCapabilities {
            emulators: self
                .config
                .emulators
                .iter()
                .map(|(emulator, config)| RestoreEmulator {
                    emulator_type: *emulator,
                    base_path: config
                        .base_path
                        .to_string_lossy()
                        .chars()
                        .take(1024)
                        .collect(),
                })
                .collect(),
            repository_ids: self.config.repositories.repository_ids(),
            cache_max_bytes: self.cache.max_bytes(),
            cache_used_bytes: self.cache.usage().total_bytes,
        }
    }

    /// A difference from what was restored proves a change, and no difference proves nothing. So this can
    /// say `modified` or `absent`, and otherwise only `unverified`. Files are not opened here: this runs
    /// on every connection, and hashing a VM's disk images is a job for an explicit check.
    fn local_copies(&self) -> Vec<LocalCopyReport> {
        let mut copies = Vec::new();
        for state in local_source_entries(&self.config.state_dir) {
            if copies.len() >= LOCAL_COPIES_MAX {
                break;
            }
            let Some(version) = state.local_source_version_id else {
                continue;
            };
            let Some(base) = self.base_path(state.emulator_type) else {
                continue;
            };
            let status = match resolve_vm_root(&base, &state.vm_name, state.emulator_type) {
                Err(error) if error.kind == crate::packaging::SourceErrorKind::Missing => {
                    LocalCopyCondition::Absent
                }
                Err(_) => LocalCopyCondition::Modified,
                Ok(root) => self.compare_with_manifest(&root, &state.emulator_type, &state.vm_name),
            };
            copies.push(LocalCopyReport {
                emulator_type: state.emulator_type,
                vm_name: state.vm_name,
                version_id: version.0,
                status,
            });
        }
        copies
    }

    fn compare_with_manifest(
        &self,
        root: &Path,
        emulator: &EmulatorType,
        vm_name: &VmName,
    ) -> LocalCopyCondition {
        let path = local_manifest_path(&self.config.state_dir, *emulator, vm_name);
        let Some(manifest) = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
        else {
            return LocalCopyCondition::Unverified;
        };
        let Ok(tree) = scan_tree(root, *emulator) else {
            return LocalCopyCondition::Modified;
        };
        let same = tree.archived.len() == manifest.entries.len()
            && manifest.entries.iter().all(|entry| {
                match (tree.archived.get(&entry.path), entry.entry_type) {
                    (Some(TreeEntry::Directory), ManifestEntryType::Directory) => true,
                    (Some(TreeEntry::File(stamp)), ManifestEntryType::File) => {
                        Some(stamp.size_bytes) == entry.size_bytes
                    }
                    _ => false,
                }
            });
        if same {
            LocalCopyCondition::Unverified
        } else {
            LocalCopyCondition::Modified
        }
    }

    /// Reports that have no answer yet. Sent again on each heartbeat, as registration's are.
    pub fn pending_reports(&self) -> Vec<Message> {
        let mut reports: Vec<Message> = {
            let journals = self.journals.lock().expect("poisoned");
            journals
                .values()
                .filter_map(|journal| match &journal.report {
                    Some(Report::Failure(report)) => {
                        Some(Message::AgentRestoreError(report.clone()))
                    }
                    Some(Report::Result(result)) => {
                        Some(Message::AgentRestoreResult(result.clone()))
                    }
                    None => None,
                })
                .collect()
        };
        reports.extend(
            self.verifications
                .lock()
                .expect("poisoned")
                .values()
                .filter_map(|journal| journal.result.clone().map(Message::AgentVmVerifyResult)),
        );
        reports
    }

    /// Acts on a message for this module. Anything else is ignored.
    pub fn handle(self: &Arc<Self>, message: Message) {
        match message {
            Message::ServerRestoreRequest(request) => self.start(request),
            Message::ServerRestoreCancel(cancel) => self.cancel(&cancel),
            Message::ServerRestoreAck(ack) => self.acknowledged(&ack),
            Message::ServerVmVerify(request) => self.verify(request),
            Message::ServerVmVerifyAck(ack) => self.verification_acknowledged(&ack),
            _ => {}
        }
    }

    /// A request that failed validation still deserves an answer, if it can be identified.
    pub fn refuse_invalid(&self, operation_id: Uuid) {
        self.send(Message::AgentRestoreError(RestoreFailure {
            operation_id,
            code: "invalid_request".to_owned(),
            message: "The request failed validation".to_owned(),
        }));
    }

    pub fn open_operations(&self) -> Vec<Uuid> {
        self.journals
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect()
    }

    fn start(self: &Arc<Self>, request: RestoreRequest) {
        let operation_id = request.operation_id;
        if let Some(existing) = self.journal(operation_id) {
            if existing.request != request {
                tracing::error!(%operation_id, "Refused a repeated restore request with other identities");
            } else {
                tracing::debug!(%operation_id, "Ignored a repeated restore request");
            }
            return;
        }
        if let Some(reason) = self.vm_activity(&VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        }) {
            self.send(Message::AgentRestoreError(RestoreFailure {
                operation_id,
                code: "vm_running".to_owned(),
                message: bounded(&format!("{reason}. Nothing was restored")),
            }));
            return;
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                self.send(Message::AgentRestoreError(RestoreFailure {
                    operation_id,
                    code: "agent_busy".to_owned(),
                    message: "This agent is already running another operation".to_owned(),
                }));
                return;
            }
            running.insert(operation_id, cancel.clone());
        }

        let target = self.target_base(&request);
        let workspace = request.workspace_id;
        let journal = Journal {
            request,
            phase: RestorePhase::Running,
            staged_identity: None,
            result: None,
            report: None,
        };
        if let Err(error) = self.persist(journal) {
            tracing::error!(%error, %operation_id, "Cannot create a journal");
            self.running.lock().expect("poisoned").remove(&operation_id);
            self.send(Message::AgentRestoreError(RestoreFailure {
                operation_id,
                code: "restore_staging_failed".to_owned(),
                message: "The agent cannot write to its state directory".to_owned(),
            }));
            return;
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, "Restore started");
            let outcome = this.run_job(operation_id, &cancel).await;
            this.running.lock().expect("poisoned").remove(&operation_id);
            if this.stopping.is_cancelled() {
                // Left exactly as a crash would leave it. The next start deals with it.
                return;
            }
            if let Err(failed) = outcome {
                tracing::warn!(%operation_id, code = %failed.code, message = %failed.message, "Restore failed");
                remove_staging_files(&this.config.staging_dir, operation_id);
                if let Some(base) = &target {
                    remove_staged_directory(&staged_directory(base, operation_id));
                }
                if let Some(workspace_id) = workspace {
                    crate::workspaces::forget_unpublished(&this.config.state_dir, workspace_id);
                }
                if let Some(journal) = this.journal(operation_id) {
                    this.record_failure(journal, failed);
                }
            }
        });
    }

    fn cancel(&self, cancel: &RestoreCancel) {
        let operation_id = cancel.operation_id;
        if let Some(flag) = self.running.lock().expect("poisoned").get(&operation_id) {
            let phase = self.journal(operation_id).map(|journal| journal.phase);
            // Past this point the VM may already be in place, and the result will say so.
            if matches!(phase, Some(RestorePhase::Running)) {
                tracing::info!(%operation_id, "Restore cancelled");
                flag.cancel();
            }
        }
    }

    fn acknowledged(&self, ack: &RestoreAck) {
        let operation_id = ack.operation_id;
        let Some(journal) = self.journal(operation_id) else {
            tracing::debug!(%operation_id, "An answer about an operation that is already closed");
            return;
        };
        if journal.report.is_none() {
            // Nothing has been reported, so this cannot be an answer to anything of ours.
            return;
        }
        let published = matches!(journal.report, Some(Report::Result(_)));
        tracing::info!(%operation_id, outcome = ?ack.outcome, published, "Restore closed");
        if published && let Some(media) = &self.config.media {
            media.request_sync(&VmIdentity {
                emulator_type: journal.request.emulator_type,
                vm_name: journal.request.vm_name.clone(),
            });
        }
        // A published directory stays, whatever the answer was. Removing a VM is never the answer.
        self.forget(operation_id);
    }

    fn progress_reporter(
        self: &Arc<Self>,
        operation_id: Uuid,
        stage: RestoreStage,
        cache_hit: Option<bool>,
    ) -> ProgressFn {
        let this = Arc::clone(self);
        let last = Mutex::new(
            Instant::now()
                .checked_sub(PROGRESS_INTERVAL)
                .unwrap_or_else(Instant::now),
        );
        self.send_progress(operation_id, stage, None, None, cache_hit);
        Arc::new(move |done: u64, total: u64| {
            let mut last = last.lock().expect("poisoned");
            if last.elapsed() >= PROGRESS_INTERVAL || done == total {
                *last = Instant::now();
                this.send_progress(operation_id, stage, Some(done), Some(total), cache_hit);
            }
        })
    }

    fn send_progress(
        &self,
        operation_id: Uuid,
        stage: RestoreStage,
        done_bytes: Option<u64>,
        total_bytes: Option<u64>,
        cache_hit: Option<bool>,
    ) {
        if self.quiet.lock().expect("poisoned").contains(&operation_id) {
            return;
        }
        self.send(Message::AgentRestoreProgress(RestoreProgress {
            operation_id,
            stage,
            done_bytes,
            total_bytes,
            cache_hit,
        }));
    }

    /// Conservative: a download and its extraction may have to share one disk, and it has to fit there.
    fn check_space(
        staging_dir: &Path,
        base_path: &Path,
        download_bytes: u64,
        extract_bytes: u64,
    ) -> Result<(), JobFailure> {
        let staging_free = available_disk_bytes(staging_dir);
        let base_free = available_disk_bytes(base_path);
        let needed_staging = download_bytes.saturating_add(SPACE_MARGIN_BYTES);
        let needed_base = extract_bytes.saturating_add(SPACE_MARGIN_BYTES);
        let same_disk = staging_free == base_free;
        if same_disk {
            let needed = download_bytes
                .saturating_add(extract_bytes)
                .saturating_add(SPACE_MARGIN_BYTES);
            if let Some(free) = base_free
                && free < needed
            {
                return Err(failure(
                    "restore_insufficient_space",
                    format!("The disk has {free} bytes free, and this restore may need {needed}"),
                ));
            }
            return Ok(());
        }
        if let Some(free) = staging_free
            && free < needed_staging
        {
            return Err(failure(
                "restore_insufficient_space",
                format!(
                    "The staging disk has {free} bytes free, and this archive needs {needed_staging}"
                ),
            ));
        }
        if let Some(free) = base_free
            && free < needed_base
        {
            return Err(failure(
                "restore_insufficient_space",
                format!(
                    "The destination disk has {free} bytes free, and this VM needs {needed_base}"
                ),
            ));
        }
        Ok(())
    }

    /// Everything up to and including publication. On success, the result has been recorded and sent.
    async fn run_job(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Result<(), JobFailure> {
        let mut journal = self
            .journal(operation_id)
            .ok_or_else(|| failure("internal_error", "The journal disappeared"))?;
        let request = journal.request.clone();
        self.send_progress(operation_id, RestoreStage::Validating, None, None, None);

        // The server names the key, and this checks that it means what it must.
        let identity = VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        };
        let key = RepositoryKey::for_version(&identity, VersionId(request.version_id));
        if key.as_str() != request.archive_key {
            return Err(failure(
                "invalid_request",
                "The archive key does not belong to this VM and version",
            ));
        }
        if !is_lowercase_sha256(&request.archive_sha256)
            || request
                .manifest_sha256
                .as_deref()
                .is_some_and(|sha256| !is_lowercase_sha256(sha256))
        {
            return Err(failure(
                "invalid_request",
                "A hash in the request is not valid",
            ));
        }
        let base_path = self.target_base(&request).ok_or_else(|| {
            failure(
                "restore_emulator_not_configured",
                format!("{} is not configured on this agent", request.emulator_type),
            )
        })?;
        // A working copy's directory is created here, empty, the first time. Its parent is under the
        // state directory, which is never inside a base path.
        if request.workspace_id.is_some() {
            fs::create_dir_all(&base_path).map_err(|error| {
                failure(
                    "restore_staging_failed",
                    format!("Cannot create the working copy's directory: {error}"),
                )
            })?;
        }
        let repository = self.config.repositories.open(request.repository_id)?;

        let base_identity = {
            let (base, name, staging_dir, cache_dir) = (
                base_path.clone(),
                request.vm_name.clone(),
                self.config.staging_dir.clone(),
                self.config.settings.cache_dir.clone(),
            );
            let (download_bytes, extract_bytes) = (
                request.archive_size_bytes,
                request.expected_uncompressed_bytes.unwrap_or(0),
            );
            blocking(move || -> Result<DirectoryIdentity, JobFailure> {
                let identity = check_base_path(&base)?;
                check_destination_free(&base, &name)?;
                fs::create_dir_all(&staging_dir).map_err(|error| {
                    failure(
                        "restore_staging_failed",
                        format!("Cannot create the staging directory: {error}"),
                    )
                })?;
                let inside = |path: &Path| {
                    fs::canonicalize(path)
                        .ok()
                        .zip(fs::canonicalize(&base).ok())
                        .is_some_and(|(path, base)| path.starts_with(base))
                };
                if inside(&staging_dir) || inside(&cache_dir) {
                    return Err(failure(
                        "restore_staging_failed",
                        "The staging or cache directory is inside the emulator's base path",
                    ));
                }
                Self::check_space(&staging_dir, &base, download_bytes, extract_bytes)?;
                Ok(identity)
            })
            .await??
        };

        let obtained = self
            .obtain_archive(&request, &*repository, &key, cancel)
            .await?;
        let ObtainedArchive {
            mut file,
            path: archive_path,
            cached,
            hit,
            downloaded_bytes,
            _pin,
        } = obtained;

        let inspection = {
            let (emulator, name, manifest_sha256, limits) = (
                request.emulator_type,
                request.vm_name.clone(),
                request.manifest_sha256.clone(),
                self.config.settings.limits,
            );
            blocking(move || {
                let inspected = inspect_archive(
                    &mut file,
                    &ArchiveExpectation {
                        emulator,
                        vm_name: &name,
                        manifest_sha256: manifest_sha256.as_deref(),
                    },
                    &limits,
                );
                (file, inspected)
            })
            .await?
        };
        let (mut file, inspected) = inspection;
        let inspected: InspectedArchive = inspected?;

        // The real total is known now. A cached archive no longer needs room on the staging disk.
        {
            let (staging_dir, base, extract_bytes) = (
                self.config.staging_dir.clone(),
                base_path.clone(),
                inspected.manifest.total_uncompressed_bytes,
            );
            blocking(move || Self::check_space(&staging_dir, &base, 0, extract_bytes)).await??;
        }

        let staged = staged_directory(&base_path, operation_id);
        let extracting = self.progress_reporter(operation_id, RestoreStage::Extracting, Some(hit));
        let staged_identity = {
            let (staged, inspected, limits, cancel) = (
                staged.clone(),
                inspected.clone(),
                self.config.settings.limits,
                cancel.clone(),
            );
            blocking(move || -> Result<DirectoryIdentity, JobFailure> {
                extract_archive(
                    &mut file,
                    &inspected,
                    &staged,
                    &limits,
                    &mut |done, total| extracting(done, total),
                    &cancel,
                )?;
                directory_identity(&staged).map_err(|error| {
                    failure(
                        "restore_staging_failed",
                        format!("Cannot identify the extracted VM: {error}"),
                    )
                })
            })
            .await??
        };

        // The last moment a cancellation can take effect. After it, the VM may be in place.
        if cancel.is_cancelled() {
            return Err(RepositoryError::cancelled().into());
        }
        self.send_progress(
            operation_id,
            RestoreStage::PublishingLocal,
            None,
            None,
            Some(hit),
        );

        let destination = crate::filesystem::vm_directory(&base_path, &request.vm_name);
        // Kept before the rename, so that a crash right after it can be told from one right before it.
        if let Some(workspace_id) = request.workspace_id {
            crate::workspaces::write_record(
                &self.config.state_dir,
                &crate::workspaces::WorkspaceRecord {
                    workspace_id,
                    emulator_type: request.emulator_type,
                    vm_name: request.vm_name.clone(),
                    source_version_id: request.version_id,
                    manifest_sha256: Some(inspected.manifest_sha256.clone()),
                },
            )
            .map_err(|error| {
                failure(
                    "restore_staging_failed",
                    format!("Cannot record the working copy: {error}"),
                )
            })?;
        } else {
            let path = local_manifest_path(
                &self.config.state_dir,
                request.emulator_type,
                &request.vm_name,
            );
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(error) = fs::write(&path, inspected.manifest.canonical_bytes()) {
                tracing::warn!(%error, "Cannot keep the restored manifest");
            }
        }
        let result = RestoreResult {
            operation_id,
            version_id: request.version_id,
            archive_size_bytes: request.archive_size_bytes,
            archive_sha256: request.archive_sha256.clone(),
            manifest_version: MANIFEST_VERSION,
            manifest_sha256: inspected.manifest_sha256.clone(),
            file_count: inspected.manifest.file_count,
            total_uncompressed_bytes: inspected.manifest.total_uncompressed_bytes,
            local_directory: destination.to_string_lossy().chars().take(1024).collect(),
            cache: RestoreCache {
                hit,
                downloaded_bytes,
                archive_cached: cached,
                total_bytes: self.cache.usage().total_bytes,
            },
        };
        journal.phase = RestorePhase::Publishing;
        journal.staged_identity = Some(staged_identity);
        journal.result = Some(result);
        self.persist(journal.clone()).map_err(|error| {
            failure(
                "restore_staging_failed",
                format!("Cannot write the journal: {error}"),
            )
        })?;

        let published = {
            let (base, name, staged) = (base_path.clone(), request.vm_name.clone(), staged.clone());
            blocking(move || {
                publish_directory(&Publication {
                    base_path: &base,
                    base_identity,
                    vm_name: &name,
                    staged: &staged,
                    staged_identity,
                })
            })
            .await?
        };
        if let Err(error) = published {
            // The rename did not happen, or the error says it cannot have.
            journal.phase = RestorePhase::Running;
            journal.result = None;
            journal.staged_identity = None;
            let _ = self.persist(journal);
            return Err(error.into());
        }

        self.finish_published(&mut journal);
        remove_staging_files(&self.config.staging_dir, operation_id);
        if !cached {
            let _ = fs::remove_file(&archive_path);
        }
        tracing::info!(
            %operation_id, directory = %destination.display(), cache_hit = hit, downloaded_bytes,
            "Restored"
        );
        Ok(())
    }

    /// An archive whose bytes were hashed through the handle returned here, from the cache if a good copy
    /// is there, and otherwise straight from the repository.
    async fn obtain_archive(
        self: &Arc<Self>,
        request: &RestoreRequest,
        repository: &dyn ArchiveRepository,
        key: &RepositoryKey,
        cancel: &CancelFlag,
    ) -> Result<ObtainedArchive, JobFailure> {
        let operation_id = request.operation_id;
        let (version, sha256, size) = (
            request.version_id,
            request.archive_sha256.clone(),
            request.archive_size_bytes,
        );
        let pin = self.cache.pin(version, &sha256);

        if let Some(path) = self.cache.find(version, &sha256) {
            let verifying = self.progress_reporter(operation_id, RestoreStage::Verifying, None);
            let checked = {
                let (path, sha256, cancel) = (path.clone(), sha256.clone(), cancel.clone());
                blocking(move || open_verified(&path, size, &sha256, &verifying, &cancel)).await?
            };
            match checked {
                Ok(file) => {
                    return Ok(ObtainedArchive {
                        file,
                        path,
                        cached: true,
                        hit: true,
                        downloaded_bytes: 0,
                        _pin: pin,
                    });
                }
                Err(error) if error.kind == ArchiveErrorKind::Cancelled => {
                    return Err(error.into());
                }
                Err(error) => {
                    tracing::warn!(%operation_id, message = %error.message, "A cached archive failed its check, and was discarded");
                    self.cache.remove(version, &sha256);
                }
            }
        }

        // Before the transfer: the object has to be there, and it has to be the size that was registered.
        let stored = tokio::select! {
            stored = repository.stat(key) => stored?,
            () = cancel.cancelled() => return Err(RepositoryError::cancelled().into()),
        };
        match stored {
            None => {
                return Err(failure(
                    "remote_object_missing",
                    "The archive is not in the repository",
                ));
            }
            Some(object) if object.size_bytes != size => {
                return Err(failure(
                    "restore_integrity_failed",
                    format!(
                        "The stored archive is {} bytes, and {size} were registered",
                        object.size_bytes
                    ),
                ));
            }
            Some(_) => {}
        }

        let attempts = self
            .config
            .repositories
            .upload_attempts(request.repository_id)
            .max(1);
        let finished = finished_download_path(&self.config.staging_dir, operation_id);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let part = download_path(&self.config.staging_dir, operation_id, attempt);
            let progress =
                self.progress_reporter(operation_id, RestoreStage::Downloading, Some(false));
            // Connecting takes time too, and a repository that stopped answering must not hold this up.
            let received = tokio::select! {
                received = repository.download(key, &part, progress, cancel) => received,
                () = cancel.cancelled() => Err(RepositoryError::cancelled()),
            };
            let failed = match received {
                Ok(object) if object.size_bytes == size && object.sha256 == sha256 => {
                    fs::rename(&part, &finished).map_err(|error| {
                        failure(
                            "restore_staging_failed",
                            format!("Cannot keep the download: {error}"),
                        )
                    })?;
                    break;
                }
                Ok(object) => RepositoryError::new(
                    RepositoryErrorKind::HashMismatch,
                    format!(
                        "The download is {} bytes with SHA-256 {}, and {size} bytes with SHA-256 \
                         {sha256} were registered",
                        object.size_bytes, object.sha256
                    ),
                ),
                Err(error) => error,
            };
            let _ = fs::remove_file(&part);
            if failed.kind.is_retryable() && attempt < attempts {
                tracing::warn!(error = %failed, %operation_id, attempt, "Download failed; trying again");
                tokio::select! {
                    () = tokio::time::sleep(self.config.retry_delay) => {}
                    () = cancel.cancelled() => return Err(RepositoryError::cancelled().into()),
                }
                continue;
            }
            return Err(failed.into());
        }

        let path = {
            let this = Arc::clone(self);
            let (source, digest) = (finished.clone(), sha256.clone());
            blocking(move || {
                this.cache
                    .insert(version, &digest, size, &source, operation_id)
            })
            .await?
        };
        let cached = path != finished;

        let verifying = self.progress_reporter(operation_id, RestoreStage::Verifying, Some(false));
        let checked = {
            let (path, sha256, cancel) = (path.clone(), sha256.clone(), cancel.clone());
            blocking(move || open_verified(&path, size, &sha256, &verifying, &cancel)).await?
        };
        match checked {
            Ok(file) => Ok(ObtainedArchive {
                file,
                path,
                cached,
                hit: false,
                downloaded_bytes: size,
                _pin: pin,
            }),
            Err(error) => {
                if cached {
                    self.cache.remove(version, &sha256);
                }
                Err(error.into())
            }
        }
    }
}

/// Runs filesystem work on the blocking pool, so that heartbeats continue.
async fn blocking<T, F>(work: F) -> Result<T, JobFailure>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| failure("internal_error", format!("The work stopped: {error}")))
}

/// Where a verification found the manifest it compared with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestSource {
    Local,
    Cache,
    Repository,
}

impl ManifestSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Cache => "cache",
            Self::Repository => "repository",
        }
    }
}

type VerifyRefusal = (VerifyResultStatus, String, String);

/// Verifying a local copy. It only reads the VM, and holds the one-disk slot while it does, so that
/// nothing launches, restores or removes the VM meanwhile. See decision 0032.
impl RestoreManager {
    fn verification_path(&self, operation_id: Uuid) -> PathBuf {
        verification_directory(&self.config.state_dir).join(format!("{operation_id}.journal"))
    }

    fn persist_verification(&self, journal: &VerifyJournal) -> std::io::Result<()> {
        let path = self.verification_path(journal.request.operation_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(journal).expect("a journal always serializes");
        {
            use std::io::Write;
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &path)?;
        self.verifications
            .lock()
            .expect("poisoned")
            .insert(journal.request.operation_id, journal.clone());
        Ok(())
    }

    /// The verifications this agent has not closed yet. Listed on each connection.
    pub fn open_verifications(&self) -> Vec<Uuid> {
        self.verifications
            .lock()
            .expect("poisoned")
            .keys()
            .copied()
            .collect()
    }

    fn empty_result(
        request: &VmVerifyRequest,
        status: VerifyResultStatus,
        code: &str,
        message: String,
    ) -> VmVerifyResult {
        VmVerifyResult {
            operation_id: request.operation_id,
            version_id: request.version_id,
            status,
            files_verified: 0,
            bytes_hashed: 0,
            duration_ms: 0,
            missing: VerifyPathList::default(),
            modified: VerifyPathList::default(),
            unexpected: VerifyPathList::default(),
            manifest_sha256: None,
            manifest_source: None,
            code: Some(code.to_owned()),
            message: Some(bounded(&message)),
        }
    }

    fn finish_verification(&self, request: VmVerifyRequest, result: VmVerifyResult) {
        let operation_id = request.operation_id;
        let journal = VerifyJournal {
            request,
            result: Some(result.clone()),
        };
        if let Err(error) = self.persist_verification(&journal) {
            tracing::error!(%error, %operation_id, "Cannot record a verification result");
            self.verifications
                .lock()
                .expect("poisoned")
                .insert(operation_id, journal);
        }
        tracing::info!(%operation_id, status = ?result.status, files = result.files_verified, "Verification finished");
        self.send(Message::AgentVmVerifyResult(result));
    }

    /// A verification that never finished has no result to trust, so it says it failed.
    fn recover_verifications(&self) {
        let unfinished: Vec<VerifyJournal> = self
            .verifications
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.result.is_none())
            .cloned()
            .collect();
        for journal in unfinished {
            remove_staging_files(&self.config.staging_dir, journal.request.operation_id);
            let result = Self::empty_result(
                &journal.request,
                VerifyResultStatus::VerificationFailed,
                "agent_restarted",
                "The agent restarted during the verification. Verify again".to_owned(),
            );
            self.finish_verification(journal.request, result);
        }
    }

    pub fn refuse_invalid_verification(&self, operation_id: Uuid) {
        self.send(Message::AgentVmVerifyResult(VmVerifyResult {
            operation_id,
            version_id: Uuid::nil(),
            status: VerifyResultStatus::VerificationFailed,
            files_verified: 0,
            bytes_hashed: 0,
            duration_ms: 0,
            missing: VerifyPathList::default(),
            modified: VerifyPathList::default(),
            unexpected: VerifyPathList::default(),
            manifest_sha256: None,
            manifest_source: None,
            code: Some("invalid_request".to_owned()),
            message: Some("The request failed validation".to_owned()),
        }));
    }

    fn verification_acknowledged(&self, ack: &VmVerifyAck) {
        let operation_id = ack.operation_id;
        let mut verifications = self.verifications.lock().expect("poisoned");
        if verifications
            .get(&operation_id)
            .is_some_and(|journal| journal.result.is_some())
        {
            verifications.remove(&operation_id);
            let _ = fs::remove_file(self.verification_path(operation_id));
        }
    }

    fn verify(self: &Arc<Self>, request: VmVerifyRequest) {
        let operation_id = request.operation_id;
        let existing = self
            .verifications
            .lock()
            .expect("poisoned")
            .get(&operation_id)
            .cloned();
        if let Some(existing) = existing {
            if existing.request != request {
                tracing::error!(%operation_id, "Refused a repeated verification with other identities");
            } else if let Some(result) = existing.result {
                self.send(Message::AgentVmVerifyResult(result));
            }
            return;
        }
        // Recorded, so that the answer repeats until the server has it, like any other.
        let refuse = |status: VerifyResultStatus, code: &str, message: String| {
            let result = Self::empty_result(&request, status, code, message);
            self.finish_verification(request.clone(), result);
        };

        let vm = VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        };
        let key = RepositoryKey::for_version(&vm, VersionId(request.version_id));
        if key.as_str() != request.archive_key
            || !is_lowercase_sha256(&request.archive_sha256)
            || request
                .manifest_sha256
                .as_deref()
                .is_some_and(|sha256| !is_lowercase_sha256(sha256))
        {
            return refuse(
                VerifyResultStatus::VerificationFailed,
                "invalid_request",
                "The request does not describe this VM's master".to_owned(),
            );
        }
        if let Some(reason) = self.vm_activity(&vm) {
            return refuse(
                VerifyResultStatus::Unavailable,
                "vm_running",
                format!("{reason}. Stop it, then verify again"),
            );
        }
        let cancel = CancelFlag::new();
        let busy = {
            let mut running = self.running.lock().expect("poisoned");
            if running.is_empty() {
                running.insert(operation_id, cancel.clone());
                false
            } else {
                true
            }
        };
        if busy {
            return refuse(
                VerifyResultStatus::Unavailable,
                "agent_busy",
                "This agent is already running another operation".to_owned(),
            );
        }
        let journal = VerifyJournal {
            request: request.clone(),
            result: None,
        };
        if let Err(error) = self.persist_verification(&journal) {
            self.running.lock().expect("poisoned").remove(&operation_id);
            tracing::error!(%error, %operation_id, "Cannot create a verification journal");
            self.send(Message::AgentVmVerifyResult(Self::empty_result(
                &request,
                VerifyResultStatus::VerificationFailed,
                "state_unwritable",
                "The agent cannot write to its state directory".to_owned(),
            )));
            return;
        }
        self.quiet.lock().expect("poisoned").insert(operation_id);

        let this = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, vm = %vm.vm_name, "Verification started");
            let started = Instant::now();
            let mut result = this.run_verification(&request, &vm, &cancel).await;
            this.running.lock().expect("poisoned").remove(&operation_id);
            this.quiet.lock().expect("poisoned").remove(&operation_id);
            remove_staging_files(&this.config.staging_dir, operation_id);
            if this.stopping.is_cancelled() {
                return;
            }
            if result.duration_ms == 0 {
                result.duration_ms = started.elapsed().as_millis() as u64;
            }
            this.finish_verification(request, result);
        });
    }

    /// The manifest, from wherever a copy with the expected hash is found first.
    async fn verification_manifest(
        self: &Arc<Self>,
        request: &VmVerifyRequest,
        vm: &VmIdentity,
        cancel: &CancelFlag,
    ) -> Result<(Manifest, String, ManifestSource), VerifyRefusal> {
        let unavailable = |code: &str, message: String| {
            (VerifyResultStatus::Unavailable, code.to_owned(), message)
        };
        // Kept by a restore or a copy registration. Only trusted if its hash is the registered one.
        if let Some(expected) = &request.manifest_sha256 {
            let path = local_manifest_path(&self.config.state_dir, vm.emulator_type, &vm.vm_name);
            if let Some(manifest) = fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
                .filter(|manifest| manifest.sha256() == *expected)
            {
                return Ok((manifest, expected.clone(), ManifestSource::Local));
            }
        }

        // Otherwise the master itself, through the same verified path a restore uses.
        let repository = self
            .config
            .repositories
            .open(request.repository_id)
            .map_err(|error| {
                unavailable(
                    error.kind.code(),
                    format!("The repository cannot be opened: {}", error.message),
                )
            })?;
        let key = RepositoryKey::for_version(vm, VersionId(request.version_id));
        fs::create_dir_all(&self.config.staging_dir).map_err(|error| {
            (
                VerifyResultStatus::VerificationFailed,
                "restore_staging_failed".to_owned(),
                format!("Cannot create the staging directory: {error}"),
            )
        })?;
        let as_restore = RestoreRequest {
            operation_id: request.operation_id,
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
            repository_id: request.repository_id,
            version_id: request.version_id,
            archive_key: request.archive_key.clone(),
            archive_size_bytes: request.archive_size_bytes,
            archive_sha256: request.archive_sha256.clone(),
            manifest_sha256: request.manifest_sha256.clone(),
            expected_uncompressed_bytes: None,
            workspace_id: None,
        };
        let obtained = self
            .obtain_archive(&as_restore, &*repository, &key, cancel)
            .await
            .map_err(|failed| {
                unavailable(
                    &failed.code,
                    format!("The master's manifest cannot be read: {}", failed.message),
                )
            })?;
        let ObtainedArchive {
            file,
            path,
            cached,
            hit,
            _pin,
            ..
        } = obtained;
        let (emulator, name, manifest_sha256, limits) = (
            request.emulator_type,
            request.vm_name.clone(),
            request.manifest_sha256.clone(),
            self.config.settings.limits,
        );
        let inspected = blocking(move || {
            let mut file = file;
            inspect_archive(
                &mut file,
                &ArchiveExpectation {
                    emulator,
                    vm_name: &name,
                    manifest_sha256: manifest_sha256.as_deref(),
                },
                &limits,
            )
        })
        .await
        .map_err(|failed| {
            (
                VerifyResultStatus::VerificationFailed,
                failed.code,
                failed.message,
            )
        })?;
        drop(_pin);
        if !cached {
            let _ = fs::remove_file(&path);
        }
        let inspected = inspected.map_err(|error| {
            let failed = JobFailure::from(error);
            (
                VerifyResultStatus::VerificationFailed,
                failed.code,
                format!("The master's archive failed its checks: {}", failed.message),
            )
        })?;
        let source = if hit {
            ManifestSource::Cache
        } else {
            ManifestSource::Repository
        };
        Ok((inspected.manifest, inspected.manifest_sha256, source))
    }

    async fn run_verification(
        self: &Arc<Self>,
        request: &VmVerifyRequest,
        vm: &VmIdentity,
        cancel: &CancelFlag,
    ) -> VmVerifyResult {
        let failed = |status: VerifyResultStatus, code: &str, message: String| {
            Self::empty_result(request, status, code, message)
        };
        let Some(base) = self.base_path(request.emulator_type) else {
            return failed(
                VerifyResultStatus::Unavailable,
                "emulator_not_configured",
                format!("{} is not configured on this agent", request.emulator_type),
            );
        };
        let root = {
            let (name, emulator) = (request.vm_name.clone(), request.emulator_type);
            match blocking(move || resolve_vm_root(&base, &name, emulator)).await {
                Ok(Ok(root)) => root,
                Ok(Err(error)) if error.kind == crate::packaging::SourceErrorKind::Missing => {
                    return failed(
                        VerifyResultStatus::Missing,
                        "vm_not_found",
                        format!("{} is not on this computer", request.vm_name),
                    );
                }
                Ok(Err(error)) => {
                    return failed(
                        VerifyResultStatus::VerificationFailed,
                        error.kind.code(),
                        error.message,
                    );
                }
                Err(error) => {
                    return failed(
                        VerifyResultStatus::VerificationFailed,
                        &error.code,
                        error.message,
                    );
                }
            }
        };
        // Which directory this is, before and after reading it: a verified result establishes lineage only
        // for the directory that was read.
        let before = directory_identity(&root).ok();
        let (manifest, manifest_sha256, source) =
            match self.verification_manifest(request, vm, cancel).await {
                Ok(found) => found,
                Err((status, code, message)) => return failed(status, &code, message),
            };

        // Checked again right before reading, from the process itself. A launch is refused from here on.
        if let Some(reason) = self.vm_activity(vm) {
            return failed(
                VerifyResultStatus::Unavailable,
                "vm_running",
                format!("{reason}. Stop it, then verify again"),
            );
        }
        let (emulator, cancel) = (request.emulator_type, cancel.clone());
        let compared = manifest.clone();
        let read_root = root.clone();
        let outcome =
            match blocking(move || verify_local_copy(&read_root, emulator, &compared, &cancel))
                .await
            {
                Ok(outcome) => outcome,
                Err(error) => {
                    return failed(
                        VerifyResultStatus::VerificationFailed,
                        &error.code,
                        error.message,
                    );
                }
            };
        let after = directory_identity(&root).ok();
        let status = match outcome.status {
            VerifyStatus::Verified if before.is_none() || before != after => {
                VerifyResultStatus::VerificationFailed
            }
            VerifyStatus::Verified => VerifyResultStatus::Verified,
            VerifyStatus::Modified => VerifyResultStatus::Modified,
            VerifyStatus::Missing => VerifyResultStatus::Missing,
            VerifyStatus::VerificationFailed => VerifyResultStatus::VerificationFailed,
        };
        // Identical, file for file, to this version: this directory is a copy of it, which is what a
        // snapshot's parent must be. Recorded with the directory's identity, as a restore would.
        if status == VerifyResultStatus::Verified
            && let Err(error) = record_local_source(
                &self.config.state_dir,
                self.config.agent_id,
                vm.emulator_type,
                &vm.vm_name,
                request.version_id,
                Some(&manifest_sha256),
                before,
            )
        {
            tracing::warn!(%error, "Cannot record the verified copy's lineage");
        }
        // A verified copy is a copy of this version, so its manifest is worth keeping for next time.
        if status == VerifyResultStatus::Verified
            && source != ManifestSource::Local
            && let Err(error) = keep_local_manifest(
                &self.config.state_dir,
                vm.emulator_type,
                &vm.vm_name,
                &manifest,
            )
        {
            tracing::warn!(%error, "Cannot keep the verified manifest");
        }
        VmVerifyResult {
            operation_id: request.operation_id,
            version_id: request.version_id,
            status,
            files_verified: outcome.files_verified,
            bytes_hashed: outcome.bytes_hashed,
            duration_ms: outcome.duration_ms,
            missing: path_list(outcome.missing),
            modified: path_list(outcome.modified),
            unexpected: path_list(outcome.unexpected),
            manifest_sha256: Some(manifest_sha256),
            manifest_source: Some(source.as_str().to_owned()),
            code: (status == VerifyResultStatus::VerificationFailed)
                .then(|| "verification_failed".to_owned()),
            message: if outcome.status == VerifyStatus::Verified
                && status == VerifyResultStatus::VerificationFailed
            {
                Some("The directory was replaced while it was verified".to_owned())
            } else {
                outcome.message.map(|message| bounded(&message))
            },
        }
    }
}
