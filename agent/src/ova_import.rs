//! `emucat-agent import-ova`: an existing OVA becomes the master of a new VirtualBox catalog VM (decision 0049).
//!
//! The command runs on its own, beside or without `emucat-agent run`. It reuses the agent's configuration, its
//! paired credential and its repository settings, and nothing else: it talks to the API over HTTPS for control
//! messages, and sends the archive straight to the repository, exactly as a registration does (decision 0012). The
//! file is never changed, extracted or imported into VirtualBox.
//!
//! Steps, and where each is recorded:
//!
//! 1. Validate the OVA locally ([`crate::ova`]): nothing exists anywhere yet.
//! 2. Ask the server whether the name is free and which repository to use (a preflight, read-only).
//! 3. Hash the whole file, checking each part against the OVA's own manifest on the way.
//! 4. Write the journal, then reserve the name: the server creates a registration operation (`mode = 'import'`)
//!    with the version ID and archive key, under a request ID taken from the journal, so a repeated request finds
//!    the same operation.
//! 5. Upload to the staging key, read it back and verify size and SHA-256 there, publish to the final key with the
//!    no-overwrite publication, and check the published size. The journal says `publishing` before publication.
//! 6. Report the published archive. The server commits the VM and its master in one transaction, or rejects it,
//!    saying whether the published archive is unreferenced, in which case it is removed.
//!
//! A run that finds a journal for the same name reconciles with the server before anything irreversible: an archive
//! already published or already staged and verified is not uploaded again, an import already committed is reported
//! as done, and an ended one is cleaned up and started over.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::credentials::Secret;
use crate::emulators::VmName;
use crate::ova::{self, OvaError, OvaErrorKind, OvaInspection};
use crate::protocol::PROTOCOL_VERSION;
use crate::registration::RepositoryProvider;
use crate::repository::{
    ArchiveRepository, CancelFlag, ProgressFn, RepositoryError, RepositoryErrorKind, RepositoryKey,
    no_progress,
};
use crate::virtualbox_registration::archive_key;

const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const JOURNAL_DIRECTORY: &str = "ova-imports";

// What went wrong, in terms of what to do about it.

/// Each kind has its own exit code, so that a script can tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportErrorKind {
    /// An argument is not acceptable: the name, or the path. Exit code 2, like a usage error.
    InvalidInput,
    /// The file is not an OVA that can be imported. Exit code 3.
    InvalidOva,
    /// This agent cannot do this as configured: not paired, credential refused, no repository. Exit code 4.
    Configuration,
    /// The catalog says no: the name is taken, or another operation runs. Exit code 5.
    Conflict,
    /// The server or the repository could not be reached, or failed. Trying again later may work. Exit code 6.
    Unavailable,
    /// Stopped by Ctrl+C or by an administrator. Exit code 130.
    Cancelled,
    /// Anything else. Exit code 1.
    Internal,
}

impl ImportErrorKind {
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Internal => 1,
            Self::InvalidInput => 2,
            Self::InvalidOva => 3,
            Self::Configuration => 4,
            Self::Conflict => 5,
            Self::Unavailable => 6,
            Self::Cancelled => 130,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub kind: ImportErrorKind,
    pub code: String,
    pub message: String,
    /// The server's operation, once there is one.
    pub operation_id: Option<Uuid>,
    /// Its state as last seen, which is what really happened.
    pub operation_state: Option<String>,
}

impl ImportError {
    pub fn new(kind: ImportErrorKind, code: &str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.to_owned(),
            message: message.into(),
            operation_id: None,
            operation_state: None,
        }
    }

    fn on(mut self, operation: &ImportOperation) -> Self {
        self.operation_id = Some(operation.id);
        self.operation_state = Some(operation.state.clone());
        self
    }
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl From<OvaError> for ImportError {
    fn from(source: OvaError) -> Self {
        let kind = match source.kind {
            OvaErrorKind::Cancelled => ImportErrorKind::Cancelled,
            OvaErrorKind::NotAFile | OvaErrorKind::Unreadable | OvaErrorKind::Changed => {
                ImportErrorKind::InvalidInput
            }
            _ => ImportErrorKind::InvalidOva,
        };
        let code = match source.kind {
            OvaErrorKind::Cancelled => "cancelled",
            OvaErrorKind::NotAFile => "file_not_found",
            OvaErrorKind::Unreadable => "file_unreadable",
            OvaErrorKind::Changed => "file_changed",
            _ => "ova_invalid",
        };
        Self::new(kind, code, source.message)
    }
}

fn repository_error(source: &RepositoryError) -> ImportError {
    let kind = match source.kind {
        RepositoryErrorKind::NotConfigured
        | RepositoryErrorKind::AuthenticationFailed
        | RepositoryErrorKind::HostKeyUnknown
        | RepositoryErrorKind::HostKeyChanged
        | RepositoryErrorKind::PermissionDenied
        | RepositoryErrorKind::PublicationUnsupported => ImportErrorKind::Configuration,
        RepositoryErrorKind::Cancelled => ImportErrorKind::Cancelled,
        RepositoryErrorKind::AlreadyExists => ImportErrorKind::Conflict,
        _ => ImportErrorKind::Unavailable,
    };
    ImportError::new(kind, source.kind.code(), source.message.clone())
}

// The server, as the command line sees it.

/// A registration operation of mode `import`, as much of it as the command line needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOperation {
    pub id: Uuid,
    pub state: String,
    pub vm_name: String,
    pub version_id: Uuid,
    pub archive_key: String,
    pub repository_id: Uuid,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default)]
    pub error: Option<OperationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OperationError {
    pub code: String,
    pub message: String,
}

impl ImportOperation {
    pub fn is_committed(&self) -> bool {
        matches!(
            self.state.as_str(),
            "cleaning_local" | "succeeded" | "partial_success"
        )
    }

    pub fn is_ended(&self) -> bool {
        matches!(
            self.state.as_str(),
            "succeeded" | "failed" | "cancelled" | "partial_success"
        )
    }

    pub fn is_active(&self) -> bool {
        !self.is_ended() && !self.is_committed()
    }

    /// Why it ended without a master, as the server says.
    fn ended_error(&self) -> ImportError {
        let (code, message) = match &self.error {
            Some(error) => (error.code.as_str(), error.message.clone()),
            None => (
                "import_ended",
                format!("The import ended as {}", self.state),
            ),
        };
        let kind = if self.state == "cancelled" {
            ImportErrorKind::Cancelled
        } else {
            ImportErrorKind::Unavailable
        };
        ImportError::new(kind, code, message).on(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub repository_id: Uuid,
    pub repository_name: String,
    pub max_archive_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImport {
    pub request_id: Uuid,
    pub vm_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source_file_name: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteImport {
    pub version_id: Uuid,
    pub archive_key: String,
    pub archive_size_bytes: u64,
    pub archive_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStage {
    Uploading,
    Verifying,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteAnswer {
    pub outcome: String,
    pub delete_published: bool,
    pub operation: ImportOperation,
}

/// What the API answered, or why there was no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// No answer: the network, a timeout, or a server that is restarting or failing. Nothing is known.
    Unreachable(String),
    /// The credential was refused: revoked, or from another server.
    Unauthorized,
    /// The server does not have these routes: it is older than this agent.
    Unsupported,
    /// An answer that says no, with the API's code.
    Refused {
        status: u16,
        code: String,
        message: String,
    },
}

impl ApiError {
    fn into_import(self) -> ImportError {
        match self {
            Self::Unreachable(message) => {
                ImportError::new(ImportErrorKind::Unavailable, "server_unreachable", message)
            }
            Self::Unauthorized => ImportError::new(
                ImportErrorKind::Configuration,
                "unauthorized",
                "The server refused this agent's credential. If the agent was revoked, pair it again with \
                 `emucat-agent pair --force`",
            ),
            Self::Unsupported => ImportError::new(
                ImportErrorKind::Configuration,
                "server_unsupported",
                "The server does not support OVA import. Update the EmuCat server",
            ),
            Self::Refused {
                status,
                code,
                message,
            } => {
                let kind = match (status, code.as_str()) {
                    (_, "repository_not_authorized" | "unsupported_protocol_version") => {
                        ImportErrorKind::Configuration
                    }
                    (413, _) => ImportErrorKind::InvalidOva,
                    (400, _) => ImportErrorKind::InvalidInput,
                    (409, _) => ImportErrorKind::Conflict,
                    (404, _) => ImportErrorKind::Conflict,
                    _ => ImportErrorKind::Unavailable,
                };
                ImportError::new(kind, &code, message)
            }
        }
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// The import routes of the API. The HTTP implementation is [`HttpImportApi`]; tests script their own.
pub trait ImportApi: Send + Sync {
    fn preflight<'a>(&'a self, vm_name: &'a str, size: u64) -> BoxFuture<'a, ApiResult<Preflight>>;
    fn create<'a>(&'a self, request: &'a CreateImport)
    -> BoxFuture<'a, ApiResult<ImportOperation>>;
    fn get(&self, operation_id: Uuid) -> BoxFuture<'_, ApiResult<ImportOperation>>;
    fn progress(
        &self,
        operation_id: Uuid,
        stage: ImportStage,
        done: Option<u64>,
        total: Option<u64>,
    ) -> BoxFuture<'_, ApiResult<ImportOperation>>;
    fn complete<'a>(
        &'a self,
        operation_id: Uuid,
        request: &'a CompleteImport,
    ) -> BoxFuture<'a, ApiResult<CompleteAnswer>>;
    fn fail<'a>(
        &'a self,
        operation_id: Uuid,
        code: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, ApiResult<ImportOperation>>;
}

// What the command line reports as it goes.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Validating,
    CheckingCatalog,
    Hashing,
    Reserving,
    Uploading,
    Verifying,
    Publishing,
    Registering,
}

impl Step {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Validating => "Validating archive",
            Self::CheckingCatalog => "Checking catalog",
            Self::Hashing => "Calculating SHA-256",
            Self::Reserving => "Reserving catalog name",
            Self::Uploading => "Uploading archive",
            Self::Verifying => "Verifying remote archive",
            Self::Publishing => "Publishing archive",
            Self::Registering => "Registering master",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Started(Step),
    Bytes(Step, u64, u64),
    Done(Step),
    Skipped(Step, String),
    Note(String),
}

pub type Reporter = Arc<dyn Fn(Event) + Send + Sync>;

// The request and its result.

#[derive(Debug, Clone)]
pub struct ImportRequest {
    pub file: PathBuf,
    pub vm_name: VmName,
    pub description: Option<String>,
    pub dry_run: bool,
    /// The file's inspection, when the caller already made it. It is made again otherwise.
    pub inspection: Option<OvaInspection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Everything was checked, and nothing was reserved, uploaded or registered.
    DryRun,
    /// The master is registered.
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub status: Outcome,
    pub source: String,
    pub vm_name: String,
    pub emulator_type: &'static str,
    pub size_bytes: u64,
    pub sha256: String,
    pub repository_id: Uuid,
    pub repository_name: Option<String>,
    pub operation_id: Option<Uuid>,
    pub version_id: Option<Uuid>,
    pub archive_key: Option<String>,
    /// Whether this run carried on an import that an earlier one began.
    pub resumed: bool,
    pub ovf: OvfSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OvfSummary {
    pub descriptor: String,
    pub version: String,
    pub virtual_systems: Vec<String>,
    pub files: usize,
    pub virtualbox_machine: bool,
    /// The manifest's name, when there is one. It may be empty, and then nothing was checked against it.
    pub manifest: Option<String>,
    /// How many parts were hashed and matched a SHA-256 in the manifest. Zero without one, or with an empty one.
    pub manifest_digests_checked: usize,
}

impl OvfSummary {
    fn of(inspection: &OvaInspection) -> Self {
        Self {
            descriptor: inspection.descriptor.clone(),
            version: inspection.ovf_version.clone(),
            virtual_systems: inspection.virtual_systems.clone(),
            files: inspection.entries.len(),
            virtualbox_machine: inspection.virtualbox_machine,
            manifest: inspection.manifest.clone(),
            manifest_digests_checked: inspection.checked_digests().count(),
        }
    }
}

// The journal.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    /// The request is about to be sent; the server may or may not have it.
    Requested,
    /// The server created the operation.
    Created,
    /// Publication may have happened. Only the repository can say.
    Publishing,
    /// The final archive is in place, verified. Only the server's answer remains.
    Published,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceStamp {
    path: PathBuf,
    size_bytes: u64,
    modified_ns: Option<u128>,
}

impl SourceStamp {
    fn of(path: &Path) -> Result<Self, ImportError> {
        let metadata = fs::metadata(path).map_err(|source| {
            ImportError::new(
                ImportErrorKind::InvalidInput,
                "file_unreadable",
                format!("Cannot read the file: {source}"),
            )
        })?;
        Ok(Self {
            path: path.to_path_buf(),
            size_bytes: metadata.len(),
            modified_ns: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos()),
        })
    }
}

/// Everything needed to reconcile after an interruption. No secret, and nothing of the file but its name, size,
/// time and hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    request_id: Uuid,
    server_origin: String,
    vm_name: String,
    vm_name_key: String,
    description: Option<String>,
    source: SourceStamp,
    sha256: String,
    phase: Phase,
    operation_id: Option<Uuid>,
    version_id: Option<Uuid>,
    archive_key: Option<String>,
    repository_id: Option<Uuid>,
    updated_at: u64,
}

struct Journals {
    directory: PathBuf,
}

impl Journals {
    fn new(state_dir: &Path) -> Self {
        Self {
            directory: state_dir.join(JOURNAL_DIRECTORY),
        }
    }

    fn path(&self, request_id: Uuid) -> PathBuf {
        self.directory.join(format!("{request_id}.json"))
    }

    /// The journal of an earlier import of this name on this server. A damaged one is kept, and ignored.
    fn find(&self, server_origin: &str, vm_name_key: &str) -> Option<Journal> {
        let entries = fs::read_dir(&self.directory).ok()?;
        entries
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice::<Journal>(&bytes).ok())
            .filter(|journal| {
                journal.server_origin == server_origin && journal.vm_name_key == vm_name_key
            })
            .max_by_key(|journal| journal.updated_at)
    }

    /// Replaces the journal atomically and durably.
    fn save(&self, journal: &mut Journal) -> Result<(), ImportError> {
        journal.updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let failed = |source: std::io::Error| {
            ImportError::new(
                ImportErrorKind::Configuration,
                "state_unwritable",
                format!("Cannot write the import journal in the state directory: {source}"),
            )
        };
        fs::create_dir_all(&self.directory).map_err(failed)?;
        let path = self.path(journal.request_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(journal).expect("a journal always serializes");
        {
            use std::io::Write;
            let mut file = fs::File::create(&temporary).map_err(failed)?;
            file.write_all(&bytes).map_err(failed)?;
            file.sync_all().map_err(failed)?;
        }
        fs::rename(&temporary, &path).map_err(failed)
    }

    fn remove(&self, request_id: Uuid) {
        let _ = fs::remove_file(self.path(request_id));
    }
}

// The workflow.

pub struct ImportSettings {
    pub state_dir: PathBuf,
    pub server_origin: String,
    pub api: Arc<dyn ImportApi>,
    pub repositories: Arc<dyn RepositoryProvider>,
    pub reporter: Reporter,
    /// How long to wait between attempts at a transfer.
    pub retry_delay: Duration,
}

/// Where an interrupted import was, and what is known about it.
struct Resumed {
    journal: Journal,
    operation: ImportOperation,
}

/// Shared between the transfer and the task that reports its progress to the server.
#[derive(Default)]
struct Progress {
    stage: Mutex<Option<ImportStage>>,
    done: AtomicU64,
    total: AtomicU64,
    stopped_by_server: AtomicBool,
    last_operation: Mutex<Option<ImportOperation>>,
}

pub async fn run(
    settings: &ImportSettings,
    request: ImportRequest,
    cancel: &CancelFlag,
) -> Result<ImportReport, ImportError> {
    let report = &settings.reporter;
    let source_name = request
        .file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| {
            ImportError::new(
                ImportErrorKind::InvalidInput,
                "invalid_path",
                "The path names no file",
            )
        })?;

    report(Event::Started(Step::Validating));
    let inspection = match request.inspection.clone() {
        Some(inspection) => inspection,
        None => {
            let path = request.file.clone();
            tokio::task::spawn_blocking(move || ova::inspect(&path))
                .await
                .map_err(|error| {
                    ImportError::new(
                        ImportErrorKind::Internal,
                        "internal_error",
                        error.to_string(),
                    )
                })??
        }
    };
    report(Event::Done(Step::Validating));
    if !inspection.virtualbox_machine {
        report(Event::Note(
            "The descriptor has no VirtualBox machine section: it was not exported by VirtualBox. VirtualBox may \
             still import it, with its own defaults for what the descriptor leaves out."
                .to_owned(),
        ));
    }
    if cancel.is_cancelled() {
        return Err(ImportError::new(
            ImportErrorKind::Cancelled,
            "cancelled",
            "Cancelled. Nothing was changed",
        ));
    }

    let journals = Journals::new(&settings.state_dir);
    let vm_name = request.vm_name.as_str().to_owned();
    let resumed = if request.dry_run {
        None
    } else {
        reconcile(settings, &journals, &request).await?
    };

    // Checking the catalog: skipped when this carries on an operation the server already has.
    let mut repository_name = None;
    let repository_id = if let Some(resumed) = &resumed {
        report(Event::Skipped(
            Step::CheckingCatalog,
            format!("resuming operation {}", resumed.operation.id),
        ));
        resumed.operation.repository_id
    } else {
        report(Event::Started(Step::CheckingCatalog));
        let preflight = settings
            .api
            .preflight(&vm_name, inspection.size_bytes)
            .await
            .map_err(ApiError::into_import)?;
        if inspection.size_bytes > preflight.max_archive_bytes {
            return Err(ImportError::new(
                ImportErrorKind::InvalidOva,
                "archive_too_large",
                "The OVA is larger than the server accepts",
            ));
        }
        report(Event::Done(Step::CheckingCatalog));
        repository_name = Some(preflight.repository_name);
        preflight.repository_id
    };
    // The repository must be one this agent's own configuration knows; the server only names it.
    let repository = settings
        .repositories
        .open(repository_id)
        .map_err(|error| repository_error(&error))?;

    report(Event::Started(Step::Hashing));
    let (size_bytes, sha256) = {
        let path = request.file.clone();
        let inspection = inspection.clone();
        let cancel = cancel.clone();
        let reporter = Arc::clone(report);
        tokio::task::spawn_blocking(move || {
            ova::hash(&path, &inspection, &cancel, &|done, total| {
                reporter(Event::Bytes(Step::Hashing, done, total));
            })
        })
        .await
        .map_err(|error| {
            ImportError::new(
                ImportErrorKind::Internal,
                "internal_error",
                error.to_string(),
            )
        })??
    };
    report(Event::Done(Step::Hashing));
    if let Some(free) = repository
        .free_space()
        .await
        .map_err(|error| repository_error(&error))?
        && free < size_bytes
    {
        return Err(ImportError::new(
            ImportErrorKind::Unavailable,
            "insufficient_remote_space",
            format!("The repository has {free} bytes free, and the OVA is {size_bytes} bytes"),
        ));
    }

    let summary = OvfSummary::of(&inspection);
    let mut report_of =
        |operation: Option<&ImportOperation>, status: Outcome, resumed: bool| ImportReport {
            status,
            source: request.file.display().to_string(),
            vm_name: operation
                .map_or_else(|| vm_name.clone(), |operation| operation.vm_name.clone()),
            emulator_type: "virtualbox",
            size_bytes,
            sha256: sha256.clone(),
            repository_id,
            repository_name: repository_name.take(),
            operation_id: operation.map(|operation| operation.id),
            version_id: operation.map(|operation| operation.version_id),
            archive_key: operation.map(|operation| operation.archive_key.clone()),
            resumed,
            ovf: summary.clone(),
        };
    if request.dry_run {
        return Ok(report_of(None, Outcome::DryRun, false));
    }

    // The journal comes first: whatever happens to the request, the next run can find it again.
    let was_resumed = resumed.is_some();
    let (mut journal, operation) = match resumed {
        Some(Resumed { journal, operation }) => {
            if journal.sha256 != sha256 || journal.source.size_bytes != size_bytes {
                return Err(ImportError::new(
                    ImportErrorKind::Conflict,
                    "source_changed",
                    format!(
                        "An unfinished import of {vm_name} was started from a different file, or this file changed \
                         since. Cancel operation {} in the web app, then run the command again",
                        operation.id
                    ),
                )
                .on(&operation));
            }
            report(Event::Skipped(
                Step::Reserving,
                format!("operation {}", operation.id),
            ));
            (journal, operation)
        }
        None => {
            report(Event::Started(Step::Reserving));
            let mut journal = Journal {
                request_id: Uuid::new_v4(),
                server_origin: settings.server_origin.clone(),
                vm_name: vm_name.clone(),
                vm_name_key: request.vm_name.key(),
                description: request.description.clone(),
                source: SourceStamp::of(&request.file)?,
                sha256: sha256.clone(),
                phase: Phase::Requested,
                operation_id: None,
                version_id: None,
                archive_key: None,
                repository_id: None,
                updated_at: 0,
            };
            journals.save(&mut journal)?;
            let created = settings
                .api
                .create(&CreateImport {
                    request_id: journal.request_id,
                    vm_name: vm_name.clone(),
                    description: request.description.clone(),
                    source_file_name: bounded_file_name(&source_name),
                    archive_size_bytes: size_bytes,
                    archive_sha256: sha256.clone(),
                })
                .await;
            let operation = match created {
                Ok(operation) => operation,
                Err(error @ ApiError::Unreachable(_)) => {
                    // The server may have created it: the journal's request ID finds it next time.
                    return Err(error.into_import());
                }
                Err(error) => {
                    journals.remove(journal.request_id);
                    return Err(error.into_import());
                }
            };
            journal.phase = Phase::Created;
            journal.operation_id = Some(operation.id);
            journal.version_id = Some(operation.version_id);
            journal.archive_key = Some(operation.archive_key.clone());
            journal.repository_id = Some(operation.repository_id);
            journals.save(&mut journal)?;
            report(Event::Done(Step::Reserving));
            (journal, operation)
        }
    };
    if operation.is_committed() {
        journals.remove(journal.request_id);
        return Ok(report_of(Some(&operation), Outcome::Completed, was_resumed));
    }
    if !operation.is_active() {
        journals.remove(journal.request_id);
        return Err(operation.ended_error());
    }

    // The server issues the key, and this checks that it means what it must.
    let expected_key = archive_key(&request.vm_name, operation.version_id);
    if operation.archive_key != expected_key || operation.repository_id != repository_id {
        let _ = settings
            .api
            .fail(
                operation.id,
                "invalid_request",
                "The archive key does not belong to this VM and version",
            )
            .await;
        journals.remove(journal.request_id);
        return Err(ImportError::new(
            ImportErrorKind::Internal,
            "invalid_request",
            "The server issued an archive key that does not belong to this VM and version",
        )
        .on(&operation));
    }

    let outcome = transfer(
        settings,
        &*repository,
        &journals,
        &mut journal,
        &operation,
        &request.file,
        size_bytes,
        &sha256,
        cancel,
    )
    .await;
    match outcome {
        Ok(()) => {}
        Err(failure) => {
            return Err(stop(
                settings,
                &*repository,
                &journals,
                &journal,
                &operation,
                failure,
            )
            .await);
        }
    }

    if cancel.is_cancelled() {
        let failure = ImportError::new(ImportErrorKind::Cancelled, "cancelled", "Cancelled");
        return Err(stop(
            settings,
            &*repository,
            &journals,
            &journal,
            &operation,
            failure,
        )
        .await);
    }

    // The server's word. A cancellation from here on cannot stop a commit already on its way.
    report(Event::Started(Step::Registering));
    let committed = complete(
        settings,
        &*repository,
        &journals,
        &journal,
        &operation,
        size_bytes,
        &sha256,
    )
    .await?;
    report(Event::Done(Step::Registering));
    Ok(report_of(Some(&committed), Outcome::Completed, was_resumed))
}

/// The file's own name, as a label for the operation: at most 255 characters, no control characters.
fn bounded_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|character| !character.is_control() && *character != '/' && *character != '\\')
        .take(255)
        .collect();
    if cleaned.is_empty() {
        "import.ova".to_owned()
    } else {
        cleaned
    }
}

/// Finds an earlier import of this name and settles it with the server, before anything new is done.
async fn reconcile(
    settings: &ImportSettings,
    journals: &Journals,
    request: &ImportRequest,
) -> Result<Option<Resumed>, ImportError> {
    let Some(journal) = journals.find(&settings.server_origin, &request.vm_name.key()) else {
        return Ok(None);
    };
    let report = &settings.reporter;
    let same_file = SourceStamp::of(&request.file).is_ok_and(|stamp| {
        stamp.size_bytes == journal.source.size_bytes
            && stamp.modified_ns == journal.source.modified_ns
            && fs::canonicalize(&stamp.path).ok() == fs::canonicalize(&journal.source.path).ok()
    });
    let Some(operation_id) = journal.operation_id else {
        // The request may have reached the server. Repeating it with the same request ID finds out.
        if !same_file {
            journals.remove(journal.request_id);
            return Ok(None);
        }
        let created = settings
            .api
            .create(&CreateImport {
                request_id: journal.request_id,
                vm_name: journal.vm_name.clone(),
                description: journal.description.clone(),
                source_file_name: bounded_file_name(
                    &request
                        .file
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                ),
                archive_size_bytes: journal.source.size_bytes,
                archive_sha256: journal.sha256.clone(),
            })
            .await;
        return match created {
            Ok(operation) if operation.is_active() || operation.is_committed() => {
                let mut journal = journal;
                journal.phase = Phase::Created;
                journal.operation_id = Some(operation.id);
                journal.version_id = Some(operation.version_id);
                journal.archive_key = Some(operation.archive_key.clone());
                journal.repository_id = Some(operation.repository_id);
                journals.save(&mut journal)?;
                report(Event::Note(format!(
                    "Found the import this command began earlier: operation {}",
                    operation.id
                )));
                Ok(Some(Resumed { journal, operation }))
            }
            Ok(_) => {
                journals.remove(journal.request_id);
                Ok(None)
            }
            Err(error @ ApiError::Unreachable(_)) => Err(error.into_import()),
            Err(_) => {
                // Refused: the name is taken, or a conflict. A fresh attempt says which.
                journals.remove(journal.request_id);
                Ok(None)
            }
        };
    };

    let operation = match settings.api.get(operation_id).await {
        Ok(operation) => operation,
        Err(ApiError::Refused { status: 404, .. }) => {
            // The server does not know it: a restored database, or another server. Nothing is deleted on that word.
            report(Event::Note(format!(
                "The server no longer knows the earlier import (operation {operation_id}). Its archive, if one was \
                 published, stays at {} until an administrator removes it",
                journal.archive_key.as_deref().unwrap_or("its key")
            )));
            journals.remove(journal.request_id);
            return Ok(None);
        }
        Err(error) => return Err(error.into_import()),
    };
    if operation.is_committed() {
        journals.remove(journal.request_id);
        if same_file {
            report(Event::Note(format!(
                "The earlier import (operation {}) was already registered",
                operation.id
            )));
            return Ok(Some(Resumed { journal, operation }));
        }
        return Ok(None);
    }
    if operation.is_active() {
        report(Event::Note(format!(
            "Resuming the import this command began earlier: operation {}",
            operation.id
        )));
        return Ok(Some(Resumed { journal, operation }));
    }

    // It ended without a master. What it published, if anything, is removed if the server says nothing refers to it.
    if journal.phase >= Phase::Publishing
        && let (Some(version_id), Some(key), Some(repository_id)) = (
            journal.version_id,
            journal.archive_key.clone(),
            journal.repository_id,
        )
        && let Ok(repository) = settings.repositories.open(repository_id)
    {
        let answer = settings
            .api
            .complete(
                operation.id,
                &CompleteImport {
                    version_id,
                    archive_key: key.clone(),
                    archive_size_bytes: journal.source.size_bytes,
                    archive_sha256: journal.sha256.clone(),
                },
            )
            .await
            .map_err(ApiError::into_import)?;
        if answer.outcome == "rejected"
            && answer.delete_published
            && let Ok(key) = RepositoryKey::new(key)
        {
            let _ = repository.delete(&key).await;
        }
    }
    if let (Some(repository_id), Some(operation_id)) = (journal.repository_id, journal.operation_id)
        && let Ok(repository) = settings.repositories.open(repository_id)
    {
        let _ = repository
            .delete(&RepositoryKey::staging(operation_id))
            .await;
    }
    report(Event::Note(format!(
        "An earlier import of this name ended as {} (operation {}); starting a new one",
        operation.state, operation.id
    )));
    journals.remove(journal.request_id);
    Ok(None)
}

/// Upload, verification and publication, reconciled with what the repository already holds.
#[allow(clippy::too_many_arguments)]
async fn transfer(
    settings: &ImportSettings,
    repository: &dyn ArchiveRepository,
    journals: &Journals,
    journal: &mut Journal,
    operation: &ImportOperation,
    file: &Path,
    size_bytes: u64,
    sha256: &str,
    cancel: &CancelFlag,
) -> Result<(), ImportError> {
    let report = &settings.reporter;
    let final_key = RepositoryKey::new(operation.archive_key.clone()).map_err(|_| {
        ImportError::new(
            ImportErrorKind::Internal,
            "invalid_request",
            "The archive key is not valid",
        )
    })?;
    let staging = RepositoryKey::staging(operation.id);
    let failed = |error: RepositoryError| repository_error(&error);

    // Already published, by an earlier run: verified where it is, and never uploaded again or overwritten.
    if repository.stat(&final_key).await.map_err(failed)?.is_some() {
        report(Event::Skipped(
            Step::Uploading,
            "already published by an earlier run".to_owned(),
        ));
        report(Event::Started(Step::Verifying));
        let verifying = progress_reporter(report, Step::Verifying);
        match repository
            .verify(&final_key, size_bytes, sha256, verifying, cancel)
            .await
        {
            Ok(_) => {}
            Err(error) if error.kind == RepositoryErrorKind::HashMismatch => {
                return Err(ImportError::new(
                    ImportErrorKind::Conflict,
                    "archive_exists",
                    "Another archive already has this version's key, and archives are never overwritten",
                ));
            }
            Err(error) => return Err(failed(error)),
        }
        report(Event::Done(Step::Verifying));
        journal.phase = Phase::Published;
        journals.save(journal)?;
        return Ok(());
    }

    let shared = Arc::new(Progress::default());
    let reporter_task = spawn_progress(
        Arc::clone(&settings.api),
        operation.id,
        Arc::clone(&shared),
        cancel.clone(),
    );
    let result = async {
        // Staged and verified by an earlier run: not uploaded again.
        let staged = repository
            .stat(&staging)
            .await
            .map_err(failed)?
            .is_some_and(|object| object.size_bytes == size_bytes);
        let mut verified = false;
        if staged {
            announce(settings, operation, ImportStage::Verifying, &shared).await?;
            report(Event::Skipped(
                Step::Uploading,
                "already uploaded by an earlier run".to_owned(),
            ));
            report(Event::Started(Step::Verifying));
            verified = repository
                .verify(
                    &staging,
                    size_bytes,
                    sha256,
                    tracked(report, Step::Verifying, &shared),
                    cancel,
                )
                .await
                .is_ok();
            if verified {
                report(Event::Done(Step::Verifying));
            } else {
                report(Event::Note(
                    "The earlier upload did not verify; uploading again".to_owned(),
                ));
            }
        }
        let attempts = settings
            .repositories
            .upload_attempts(operation.repository_id)
            .max(1);
        let mut attempt = 0;
        while !verified {
            attempt += 1;
            stopped(cancel, &shared)?;
            announce(settings, operation, ImportStage::Uploading, &shared).await?;
            report(Event::Started(Step::Uploading));
            let outcome = async {
                repository
                    .upload(
                        &staging,
                        file,
                        tracked(report, Step::Uploading, &shared),
                        cancel,
                    )
                    .await?;
                report(Event::Done(Step::Uploading));
                Ok::<_, RepositoryError>(())
            }
            .await;
            let outcome = match outcome {
                Ok(()) => {
                    stopped(cancel, &shared)?;
                    announce(settings, operation, ImportStage::Verifying, &shared).await?;
                    report(Event::Started(Step::Verifying));
                    repository
                        .verify(
                            &staging,
                            size_bytes,
                            sha256,
                            tracked(report, Step::Verifying, &shared),
                            cancel,
                        )
                        .await
                        .map(|_| ())
                }
                Err(error) => Err(error),
            };
            match outcome {
                Ok(()) => {
                    report(Event::Done(Step::Verifying));
                    verified = true;
                }
                Err(error) if error.kind == RepositoryErrorKind::Cancelled => {
                    stopped(cancel, &shared)?;
                    return Err(failed(error));
                }
                Err(error) if error.kind.is_retryable() && attempt < attempts => {
                    report(Event::Note(format!(
                        "{} ({}); trying again",
                        error.message,
                        error.kind.code()
                    )));
                    let _ = repository.delete(&staging).await;
                    tokio::select! {
                        () = tokio::time::sleep(settings.retry_delay) => {}
                        () = cancel.cancelled() => {}
                    }
                }
                Err(error) => return Err(failed(error)),
            }
        }
        Ok(())
    }
    .await;
    reporter_task.abort();
    result?;
    stopped(cancel, &shared)?;

    // Publication: the journal says so first, so that an interruption is resolved against the repository.
    report(Event::Started(Step::Publishing));
    journal.phase = Phase::Publishing;
    journals.save(journal)?;
    match repository.publish(&staging, &final_key).await {
        Ok(()) => {}
        Err(error) if error.kind == RepositoryErrorKind::AlreadyExists => {
            repository
                .verify(
                    &final_key,
                    size_bytes,
                    sha256,
                    no_progress(),
                    &CancelFlag::new(),
                )
                .await
                .map_err(|_| repository_error(&error))?;
        }
        Err(error) => {
            journal.phase = Phase::Created;
            journals.save(journal)?;
            return Err(failed(error));
        }
    }
    let stored = repository.stat(&final_key).await.map_err(failed)?;
    if stored.map(|object| object.size_bytes) != Some(size_bytes) {
        return Err(ImportError::new(
            ImportErrorKind::Unavailable,
            "hash_mismatch",
            "The published archive does not have the expected size",
        ));
    }
    journal.phase = Phase::Published;
    journals.save(journal)?;
    report(Event::Done(Step::Publishing));
    Ok(())
}

/// Bytes, for the terminal and for the server's progress.
fn tracked(report: &Reporter, step: Step, shared: &Arc<Progress>) -> ProgressFn {
    let report = Arc::clone(report);
    let shared = Arc::clone(shared);
    Arc::new(move |done, total| {
        shared.done.store(done, Ordering::Relaxed);
        shared.total.store(total, Ordering::Relaxed);
        report(Event::Bytes(step, done, total));
    })
}

fn progress_reporter(report: &Reporter, step: Step) -> ProgressFn {
    let report = Arc::clone(report);
    Arc::new(move |done, total| report(Event::Bytes(step, done, total)))
}

/// Tells the server which stage this is, and finds out whether it still wants the import.
async fn announce(
    settings: &ImportSettings,
    operation: &ImportOperation,
    stage: ImportStage,
    shared: &Arc<Progress>,
) -> Result<(), ImportError> {
    *shared.stage.lock().expect("poisoned") = Some(stage);
    shared.done.store(0, Ordering::Relaxed);
    let answer = settings
        .api
        .progress(operation.id, stage, Some(0), None)
        .await
        .map_err(ApiError::into_import)?;
    if !answer.is_active() {
        shared.stopped_by_server.store(true, Ordering::Relaxed);
        let error = answer.ended_error();
        *shared.last_operation.lock().expect("poisoned") = Some(answer);
        return Err(error);
    }
    Ok(())
}

/// Reports bytes every few seconds, and stops the transfer when the server says the import ended.
fn spawn_progress(
    api: Arc<dyn ImportApi>,
    operation_id: Uuid,
    shared: Arc<Progress>,
    cancel: CancelFlag,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(PROGRESS_INTERVAL).await;
            let Some(stage) = *shared.stage.lock().expect("poisoned") else {
                continue;
            };
            let done = shared.done.load(Ordering::Relaxed);
            let total = shared.total.load(Ordering::Relaxed);
            match api
                .progress(
                    operation_id,
                    stage,
                    Some(done),
                    (total > 0).then_some(total),
                )
                .await
            {
                Ok(answer) if !answer.is_active() => {
                    shared.stopped_by_server.store(true, Ordering::Relaxed);
                    *shared.last_operation.lock().expect("poisoned") = Some(answer);
                    cancel.cancel();
                    return;
                }
                // A refused or lost report is not a reason to stop: the next one, or the completion, settles it.
                Ok(_) | Err(_) => {}
            }
        }
    })
}

/// Whether to stop, and why: the server ended the import, or Ctrl+C.
fn stopped(cancel: &CancelFlag, shared: &Progress) -> Result<(), ImportError> {
    if shared.stopped_by_server.load(Ordering::Relaxed) {
        let last = shared.last_operation.lock().expect("poisoned").clone();
        return Err(match last {
            Some(operation) => operation.ended_error(),
            None => ImportError::new(
                ImportErrorKind::Cancelled,
                "cancelled",
                "The server ended this import",
            ),
        });
    }
    if cancel.is_cancelled() {
        return Err(ImportError::new(
            ImportErrorKind::Cancelled,
            "cancelled",
            "Cancelled",
        ));
    }
    Ok(())
}

/// Ends an import that will not be committed: tells the server, then removes what it uploaded. What happened is
/// what the server says, which can be a commit that a cancellation came too late for.
async fn stop(
    settings: &ImportSettings,
    repository: &dyn ArchiveRepository,
    journals: &Journals,
    journal: &Journal,
    operation: &ImportOperation,
    failure: ImportError,
) -> ImportError {
    let report = &settings.reporter;
    let staging = RepositoryKey::staging(operation.id);
    let cancelled = failure.kind == ImportErrorKind::Cancelled;
    let ended_by_server = failure.operation_id.is_some() && failure.operation_state.is_some();
    let answer = if ended_by_server {
        Ok(None)
    } else {
        let message: String = failure.message.chars().take(1000).collect();
        settings
            .api
            .fail(
                operation.id,
                if cancelled {
                    "cancelled"
                } else {
                    &failure.code
                },
                &message,
            )
            .await
            .map(Some)
    };
    match answer {
        Ok(Some(answer)) if answer.is_committed() => {
            // Too late: the server committed it. The import succeeded, whatever happened here.
            journals.remove(journal.request_id);
            ImportError::new(
                ImportErrorKind::Internal,
                "already_committed",
                format!(
                    "The import was already registered (operation {}) when this stopped: {}",
                    answer.id, failure.message
                ),
            )
            .on(&answer)
        }
        Ok(answer) => {
            let _ = repository.delete(&staging).await;
            if journal.phase >= Phase::Publishing
                && let Ok(answer) = settings
                    .api
                    .complete(
                        operation.id,
                        &CompleteImport {
                            version_id: operation.version_id,
                            archive_key: operation.archive_key.clone(),
                            archive_size_bytes: journal.source.size_bytes,
                            archive_sha256: journal.sha256.clone(),
                        },
                    )
                    .await
                && answer.outcome == "rejected"
                && answer.delete_published
                && let Ok(key) = RepositoryKey::new(operation.archive_key.clone())
            {
                let _ = repository.delete(&key).await;
            }
            journals.remove(journal.request_id);
            let state = answer.map_or_else(
                || failure.operation_state.clone(),
                |answer| Some(answer.state),
            );
            let mut failure = failure;
            failure.operation_id = Some(operation.id);
            failure.operation_state = state;
            if cancelled && failure.code == "cancelled" {
                failure.message = "Cancelled. Nothing was registered".to_owned();
            }
            failure
        }
        Err(error) => {
            // The server could not be told. The journal stays, so that the next run settles it.
            report(Event::Note(format!(
                "The server could not be told ({}). Run the same command again to settle operation {}, or cancel it \
                 in the web app",
                error.clone().into_import().message,
                operation.id
            )));
            let mut failure = failure;
            failure.operation_id = Some(operation.id);
            failure.operation_state = Some(operation.state.clone());
            failure
        }
    }
}

/// The published archive, reported. The journal stays until the server has answered.
async fn complete(
    settings: &ImportSettings,
    repository: &dyn ArchiveRepository,
    journals: &Journals,
    journal: &Journal,
    operation: &ImportOperation,
    size_bytes: u64,
    sha256: &str,
) -> Result<ImportOperation, ImportError> {
    let answer = settings
        .api
        .complete(
            operation.id,
            &CompleteImport {
                version_id: operation.version_id,
                archive_key: operation.archive_key.clone(),
                archive_size_bytes: size_bytes,
                archive_sha256: sha256.to_owned(),
            },
        )
        .await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) => {
            let mut failure = error.into_import();
            failure.message = format!(
                "{}. The archive is published and verified, but is not registered yet. Run the same command again \
                 to finish: nothing will be uploaded again",
                failure.message
            );
            return Err(failure.on(operation));
        }
    };
    if answer.outcome == "committed" {
        journals.remove(journal.request_id);
        return Ok(answer.operation);
    }
    if answer.delete_published
        && let Ok(key) = RepositoryKey::new(operation.archive_key.clone())
    {
        let _ = repository.delete(&key).await;
    }
    journals.remove(journal.request_id);
    Err(answer.operation.ended_error())
}

// The API over HTTP(S).

/// The real server. Redirects are not followed, since one could carry the credential elsewhere.
pub struct HttpImportApi {
    client: reqwest::Client,
    base: Url,
    credential: Secret,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    message: String,
}

impl HttpImportApi {
    pub fn new(api_url: &Url, credential: Secret) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.without_url().to_string())?;
        Ok(Self {
            client,
            base: api_url.clone(),
            credential,
        })
    }

    fn endpoint(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty()
                .extend(["api", "v1", "agent", "ova-imports"])
                .extend(segments);
        }
        url
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        body: Option<serde_json::Value>,
    ) -> ApiResult<T> {
        // Built separately from the URL, and never printed: the header is the only place the token goes.
        let mut value =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.credential.expose()))
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("Bearer invalid"));
        value.set_sensitive(true);
        let mut request = self
            .client
            .request(method, self.endpoint(segments))
            .header(reqwest::header::AUTHORIZATION, value)
            .header("x-emucat-protocol-version", PROTOCOL_VERSION.to_string());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            ApiError::Unreachable(if error.is_timeout() {
                "The server took too long to answer".to_owned()
            } else if error.is_connect() {
                "Cannot connect to the server".to_owned()
            } else {
                "The connection to the server failed".to_owned()
            })
        })?;
        let status = response.status().as_u16();
        if response.status().is_success() {
            return response.json::<T>().await.map_err(|_| {
                ApiError::Unreachable("The server's answer could not be read".to_owned())
            });
        }
        let body = response.json::<ErrorEnvelope>().await.ok();
        match (status, body) {
            (401, _) => Err(ApiError::Unauthorized),
            // A route this server does not have. An older server, or a proxy that does not know it.
            (404, None) => Err(ApiError::Unsupported),
            (404, Some(body)) if body.error.code == "not_found" => Err(ApiError::Unsupported),
            (500..=599 | 408 | 429, body) => Err(ApiError::Unreachable(body.map_or_else(
                || format!("The server answered {status}"),
                |body| body.error.message,
            ))),
            (_, Some(body)) => Err(ApiError::Refused {
                status,
                code: body.error.code,
                message: body.error.message,
            }),
            (_, None) => Err(ApiError::Refused {
                status,
                code: "server_error".to_owned(),
                message: format!("The server answered {status}"),
            }),
        }
    }
}

impl ImportApi for HttpImportApi {
    fn preflight<'a>(&'a self, vm_name: &'a str, size: u64) -> BoxFuture<'a, ApiResult<Preflight>> {
        let body = serde_json::json!({ "vmName": vm_name, "archiveSizeBytes": size });
        self.send(reqwest::Method::POST, &["preflight"], Some(body))
            .boxed()
    }

    fn create<'a>(
        &'a self,
        request: &'a CreateImport,
    ) -> BoxFuture<'a, ApiResult<ImportOperation>> {
        let body = serde_json::to_value(request).expect("serializes");
        self.send(reqwest::Method::POST, &[], Some(body)).boxed()
    }

    fn get(&self, operation_id: Uuid) -> BoxFuture<'_, ApiResult<ImportOperation>> {
        async move {
            self.send(reqwest::Method::GET, &[&operation_id.to_string()], None)
                .await
        }
        .boxed()
    }

    fn progress(
        &self,
        operation_id: Uuid,
        stage: ImportStage,
        done: Option<u64>,
        total: Option<u64>,
    ) -> BoxFuture<'_, ApiResult<ImportOperation>> {
        let body = serde_json::json!({ "stage": stage, "doneBytes": done, "totalBytes": total });
        async move {
            self.send(
                reqwest::Method::POST,
                &[&operation_id.to_string(), "progress"],
                Some(body),
            )
            .await
        }
        .boxed()
    }

    fn complete<'a>(
        &'a self,
        operation_id: Uuid,
        request: &'a CompleteImport,
    ) -> BoxFuture<'a, ApiResult<CompleteAnswer>> {
        let body = serde_json::to_value(request).expect("serializes");
        async move {
            self.send(
                reqwest::Method::POST,
                &[&operation_id.to_string(), "complete"],
                Some(body),
            )
            .await
        }
        .boxed()
    }

    fn fail<'a>(
        &'a self,
        operation_id: Uuid,
        code: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, ApiResult<ImportOperation>> {
        let body = serde_json::json!({ "code": code, "message": message });
        async move {
            self.send(
                reqwest::Method::POST,
                &[&operation_id.to_string(), "fail"],
                Some(body),
            )
            .await
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_are_distinct() {
        let kinds = [
            ImportErrorKind::Internal,
            ImportErrorKind::InvalidInput,
            ImportErrorKind::InvalidOva,
            ImportErrorKind::Configuration,
            ImportErrorKind::Conflict,
            ImportErrorKind::Unavailable,
            ImportErrorKind::Cancelled,
        ];
        let codes: std::collections::HashSet<u8> =
            kinds.iter().map(|kind| kind.exit_code()).collect();
        assert_eq!(codes.len(), kinds.len());
        assert!(!codes.contains(&0));
    }

    #[test]
    fn file_names_are_labels_only() {
        assert_eq!(bounded_file_name("DOS 6.22.ova"), "DOS 6.22.ova");
        assert_eq!(bounded_file_name("a\u{0}b\nc.ova"), "abc.ova");
        assert_eq!(bounded_file_name(&"x".repeat(400)).chars().count(), 255);
        assert_eq!(bounded_file_name("\u{1}"), "import.ova");
    }

    #[test]
    fn refusals_map_to_what_can_be_done() {
        let refused = |status, code: &str| ApiError::Refused {
            status,
            code: code.to_owned(),
            message: String::new(),
        };
        assert_eq!(
            refused(409, "vm_already_registered").into_import().kind,
            ImportErrorKind::Conflict
        );
        assert_eq!(
            refused(409, "repository_not_authorized").into_import().kind,
            ImportErrorKind::Configuration
        );
        assert_eq!(
            ApiError::Unauthorized.into_import().kind,
            ImportErrorKind::Configuration
        );
        assert_eq!(
            ApiError::Unreachable(String::new()).into_import().kind,
            ImportErrorKind::Unavailable
        );
        assert_eq!(
            refused(413, "archive_too_large").into_import().kind,
            ImportErrorKind::InvalidOva
        );
    }
}
