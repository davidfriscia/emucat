//! Builds a standalone ZIP of a VM, with a deterministic manifest of what it holds.
//!
//! Source files are only ever opened for reading, and the ZIP is built in a staging directory that
//! must be outside every VM root. The archive holds the contents of the VM directory with no wrapper,
//! plus [`MANIFEST_ENTRY_NAME`] as its last entry. The manifest lists every other entry and so never
//! describes itself.
//!
//! A VM can be in use while it is archived, so the rule is conservative. Metadata is recorded before
//! reading; each file must look the same before and after its bytes are read; and the whole tree is
//! compared again at the end. On Windows, each file is also opened denying writers, which additionally
//! means that a file an emulator holds open for writing fails with `source_in_use`. None of this is a
//! transactional snapshot, as decision 0014 explains. It only makes a torn archive very unlikely, and
//! a detected change is always a failure, never a warning.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::archives::is_excluded_from_archive;
use crate::discovery::is_link_like;
use crate::emulators::{EmulatorType, VmName, VmRootEntry, is_valid_vm_root};
use crate::repository::CancelFlag;

pub const MANIFEST_VERSION: u32 = 1;
/// Reserved: a VM with a file of this name in its root cannot be archived.
pub const MANIFEST_ENTRY_NAME: &str = ".emucat-manifest.json";

const READ_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 1_000_000;
/// Sizes at or above this need ZIP64 in the entry's headers. A little below 4 GiB, because deflating
/// can make a file slightly larger than it was.
const ZIP64_ENTRY_THRESHOLD: u64 = 0xF000_0000;
/// Above this size a file is deflated at the fastest level: a disk image can be tens of gigabytes.
const FAST_COMPRESSION_THRESHOLD: u64 = 256 * 1024 * 1024;

/// File types that are already compressed, or whose contents rarely compress further. Stored as they
/// are, since deflating tens of gigabytes for nothing is expensive. A raw `.img` or `.vhd` is not on
/// this list, because a mostly empty raw disk compresses very well.
const STORED_EXTENSIONS: &[&str] = &[
    "qcow", "qcow2", "vmdk", "vhdx", "vdi", "chd", "zip", "7z", "rar", "gz", "bz2", "xz", "zst",
    "cab", "jpg", "jpeg", "png", "mp3", "mp4",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// Relative, with `/` separators, in the original capitalization.
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: ManifestEntryType,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
}

/// Depends only on names and contents: no timestamp, operation or version appears in it, so the same
/// VM always produces the same bytes and two manifests can be compared to find what changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub manifest_version: u32,
    pub emulator_type: EmulatorType,
    pub vm_name: String,
    pub file_count: u64,
    pub total_uncompressed_bytes: u64,
    /// In canonical order: sorted by the bytes of `path`.
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(self).expect("a manifest always serializes");
        bytes.push(b'\n');
        bytes
    }

    pub fn sha256(&self) -> String {
        hex(&Sha256::digest(self.canonical_bytes()))
    }
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceErrorKind {
    /// The VM's directory is not there, or is spelled differently.
    Missing,
    /// It is not a valid VM, or holds names an archive cannot represent.
    Invalid,
    /// A link, junction, reparse point or special file.
    Unsafe,
    /// It changed while it was being read.
    Changed,
    /// A file is held open by another program, probably a running emulator.
    InUse,
    /// Reading failed for another reason.
    Unreadable,
    Cancelled,
    /// Not enough room for the staging file.
    InsufficientSpace,
    /// The staging directory cannot be used.
    Staging,
}

impl SourceErrorKind {
    /// Stable code, shared with `REGISTRATION_ERROR_CODES` in the contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Missing => "source_missing",
            Self::Invalid => "source_invalid",
            Self::Unsafe => "source_unsafe",
            Self::Changed => "source_changed",
            Self::InUse => "source_in_use",
            Self::Unreadable => "source_unreadable",
            Self::Cancelled => "cancelled",
            Self::InsufficientSpace => "insufficient_staging_space",
            Self::Staging => "staging_failed",
        }
    }
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct SourceError {
    pub kind: SourceErrorKind,
    pub message: String,
}

impl SourceError {
    fn new(kind: SourceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

fn unreadable(what: &str, error: &io::Error) -> SourceError {
    if error.kind() == io::ErrorKind::NotFound {
        return SourceError::new(
            SourceErrorKind::Changed,
            format!("{what} disappeared while it was being read"),
        );
    }
    if is_in_use(error) {
        return SourceError::new(
            SourceErrorKind::InUse,
            format!("{what} is in use by another program. Stop the VM and try again"),
        );
    }
    SourceError::new(
        SourceErrorKind::Unreadable,
        format!("Cannot read {what}: {error}"),
    )
}

/// Whether an error means that another program holds the file open.
#[cfg(windows)]
pub fn is_in_use(error: &io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    matches!(
        error.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
    )
}

/// Whether an error means that another program holds the file open.
#[cfg(not(windows))]
pub fn is_in_use(_error: &io::Error) -> bool {
    false
}

/// Who a directory is, so that it can be recognized even after a path has been reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryIdentity {
    pub volume: u64,
    pub file: u64,
}

#[cfg(windows)]
pub fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        GetFileInformationByHandle,
    };

    // The reparse flag opens a link itself rather than whatever it points to.
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    // SAFETY: an all-zero value is valid for this plain structure, which the call fills in.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle stays open for the call, and the pointer is valid for writes.
    let succeeded =
        unsafe { GetFileInformationByHandle(directory.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(DirectoryIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(unix)]
pub fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    Ok(DirectoryIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

/// Bytes free for new files, where the platform can tell.
#[cfg(windows)]
pub fn available_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0u64;
    // SAFETY: the path is NUL-terminated, the pointer is valid, and the others may be null.
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (succeeded != 0).then_some(available)
}

#[cfg(not(windows))]
pub fn available_disk_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Finds a VM's directory: exactly `BASE/NAME`, spelled exactly so, a real directory and not a link,
/// and carrying a marker in its root. The name comes from a validated [`VmName`], so that the result
/// cannot be anywhere but directly under the base path.
pub fn resolve_vm_root(
    base_path: &Path,
    vm_name: &VmName,
    emulator: EmulatorType,
) -> Result<PathBuf, SourceError> {
    // Listed rather than probed: on Windows, opening `win98` would also find `WIN98`, which would be a
    // directory other than the one that was discovered.
    let listing = fs::read_dir(base_path).map_err(|error| {
        SourceError::new(
            SourceErrorKind::Missing,
            format!("Cannot read the {emulator} base path: {error}"),
        )
    })?;
    let exists = listing
        .flatten()
        .any(|entry| entry.file_name().to_str() == Some(vm_name.as_str()));
    if !exists {
        return Err(SourceError::new(
            SourceErrorKind::Missing,
            format!("There is no directory named {vm_name} in the {emulator} base path"),
        ));
    }
    let root = crate::filesystem::vm_directory(base_path, vm_name);
    let metadata =
        fs::symlink_metadata(&root).map_err(|error| unreadable(vm_name.as_str(), &error))?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(SourceError::new(
            SourceErrorKind::Unsafe,
            format!("{vm_name} is a link or not a directory"),
        ));
    }
    check_markers(&root, emulator, vm_name.as_str())?;
    Ok(root)
}

fn check_markers(root: &Path, emulator: EmulatorType, name: &str) -> Result<(), SourceError> {
    let markers = emulator.root_markers();
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| unreadable(name, &error))? {
        let entry = entry.map_err(|error| unreadable(name, &error))?;
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        if markers.contains(&file_name.as_str()) {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| unreadable(&file_name, &error))?;
            entries.push(VmRootEntry {
                is_file: metadata.is_file() && !is_link_like(&metadata),
                name: file_name,
            });
        }
    }
    if !is_valid_vm_root(emulator, &entries) {
        return Err(SourceError::new(
            SourceErrorKind::Invalid,
            format!("{name} has no marker file for {emulator}"),
        ));
    }
    Ok(())
}

/// What a file looked like at one moment. Equal values do not prove that a file did not change, but
/// different ones prove that it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub size_bytes: u64,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
}

impl FileStamp {
    fn of(metadata: &Metadata) -> Self {
        Self {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeEntry {
    File(FileStamp),
    Directory,
}

/// Everything found under a VM's root, in canonical order. Reading it opens no file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeSnapshot {
    pub archived: BTreeMap<String, TreeEntry>,
    /// Media files that are excluded from archives, and would be lost if the directory were deleted.
    pub excluded_files: Vec<String>,
}

impl TreeSnapshot {
    pub fn total_bytes(&self) -> u64 {
        self.archived
            .values()
            .map(|entry| match entry {
                TreeEntry::File(stamp) => stamp.size_bytes,
                TreeEntry::Directory => 0,
            })
            .sum()
    }
}

/// Lists a VM's tree without following anything. Anything that is not a plain file or directory fails
/// the whole VM rather than being skipped: leaving it out would make the archive silently incomplete.
pub fn scan_tree(root: &Path, emulator: EmulatorType) -> Result<TreeSnapshot, SourceError> {
    let mut snapshot = TreeSnapshot {
        archived: BTreeMap::new(),
        excluded_files: Vec::new(),
    };
    let mut seen_lowercase = HashSet::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, prefix)) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|error| unreadable(&display(&prefix), &error))?
        {
            let entry = entry.map_err(|error| unreadable(&display(&prefix), &error))?;
            let name = entry.file_name().into_string().map_err(|raw| {
                SourceError::new(
                    SourceErrorKind::Invalid,
                    format!("The name {} is not valid Unicode", raw.to_string_lossy()),
                )
            })?;
            if name
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
            {
                return Err(SourceError::new(
                    SourceErrorKind::Invalid,
                    format!("The name {name:?} cannot be stored in an archive"),
                ));
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if relative.eq_ignore_ascii_case(MANIFEST_ENTRY_NAME) {
                return Err(SourceError::new(
                    SourceErrorKind::Invalid,
                    format!("{MANIFEST_ENTRY_NAME} is a reserved name, and this VM has one"),
                ));
            }
            // Only possible on a case-sensitive filesystem, and fatal when extracted on Windows.
            if !seen_lowercase.insert(relative.to_lowercase()) {
                return Err(SourceError::new(
                    SourceErrorKind::Invalid,
                    format!("{relative} differs from another name only by capitalization"),
                ));
            }
            if snapshot.archived.len() + snapshot.excluded_files.len() >= MAX_TREE_ENTRIES {
                return Err(SourceError::new(
                    SourceErrorKind::Invalid,
                    "This VM holds too many files",
                ));
            }

            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|error| unreadable(&relative, &error))?;
            if is_link_like(&metadata) {
                return Err(SourceError::new(
                    SourceErrorKind::Unsafe,
                    format!("{relative} is a symbolic link, junction or other reparse point"),
                ));
            }
            let in_screenshots = emulator == EmulatorType::Box86
                && relative
                    .split('/')
                    .next()
                    .is_some_and(|first| first.eq_ignore_ascii_case("screenshots"));
            if metadata.is_dir() {
                if !in_screenshots {
                    snapshot
                        .archived
                        .insert(relative.clone(), TreeEntry::Directory);
                }
                pending.push((path, relative));
            } else if metadata.is_file() {
                let excluded = is_excluded_from_archive(emulator, &relative).map_err(|_| {
                    SourceError::new(
                        SourceErrorKind::Invalid,
                        format!("{relative} is not a safe relative path"),
                    )
                })?;
                if excluded {
                    snapshot.excluded_files.push(relative);
                } else {
                    snapshot
                        .archived
                        .insert(relative, TreeEntry::File(FileStamp::of(&metadata)));
                }
            } else {
                return Err(SourceError::new(
                    SourceErrorKind::Unsafe,
                    format!("{relative} is a special file"),
                ));
            }
        }
    }
    snapshot.excluded_files.sort();
    Ok(snapshot)
}

fn display(prefix: &str) -> String {
    if prefix.is_empty() {
        "the VM directory".to_owned()
    } else {
        prefix.to_owned()
    }
}

/// Opens a source file for reading, denying writers where the platform can: on Windows a file that
/// is open for writing elsewhere then fails at once, which is the best evidence of a running VM.
pub fn open_for_reading(path: &Path) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

fn compression_for(relative: &str, size: u64) -> (CompressionMethod, Option<i64>) {
    let extension = relative
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension.to_ascii_lowercase());
    let stored = extension.is_some_and(|extension| STORED_EXTENSIONS.contains(&extension.as_str()));
    if stored {
        (CompressionMethod::Stored, None)
    } else if size >= FAST_COMPRESSION_THRESHOLD {
        (CompressionMethod::Deflated, Some(1))
    } else {
        (CompressionMethod::Deflated, Some(6))
    }
}

fn zip_options(relative: &str, stamp: &FileStamp) -> SimpleFileOptions {
    let (method, level) = compression_for(relative, stamp.size_bytes);
    let mut options = SimpleFileOptions::default()
        .compression_method(method)
        .compression_level(level)
        .large_file(stamp.size_bytes >= ZIP64_ENTRY_THRESHOLD);
    // A convenience for whoever extracts it. Nothing relies on ZIP timestamps.
    if let Some(modified) = stamp.modified
        && let Ok(when) = zip::DateTime::try_from(OffsetDateTime::from(modified))
    {
        options = options.last_modified_time(when);
    }
    options
}

/// What is happening, for progress reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildProgress {
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub struct BuildRequest<'a> {
    pub emulator: EmulatorType,
    pub vm_name: &'a VmName,
    pub root: &'a Path,
    pub staging_dir: &'a Path,
    pub operation_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct BuiltArchive {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

/// The file a build for this operation leaves behind, for cleaning up after a crash.
pub fn staging_path(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("{operation_id}.zip"))
}

fn partial_path(staging_dir: &Path, operation_id: Uuid) -> PathBuf {
    staging_dir.join(format!("{operation_id}.zip.partial"))
}

/// Removes whatever a build for this operation left in the staging directory.
pub fn remove_staging_files(staging_dir: &Path, operation_id: Uuid) {
    let _ = fs::remove_file(partial_path(staging_dir, operation_id));
    let _ = fs::remove_file(staging_path(staging_dir, operation_id));
}

/// Builds the archive. On any failure nothing is left in the staging directory, and the source is
/// exactly as it was: nothing here opens a source file for writing. This blocks, so call it from
/// `spawn_blocking`.
pub fn build_archive(
    request: &BuildRequest<'_>,
    progress: &mut dyn FnMut(BuildProgress),
    cancel: &CancelFlag,
) -> Result<BuiltArchive, SourceError> {
    let result = build_inner(request, progress, cancel);
    if result.is_err() {
        remove_staging_files(request.staging_dir, request.operation_id);
    }
    result
}

fn staging_failure(error: &io::Error) -> SourceError {
    if error.kind() == io::ErrorKind::StorageFull || error.kind() == io::ErrorKind::QuotaExceeded {
        return SourceError::new(
            SourceErrorKind::InsufficientSpace,
            "The staging disk ran out of space",
        );
    }
    SourceError::new(
        SourceErrorKind::Staging,
        format!("Cannot write to the staging directory: {error}"),
    )
}

fn build_inner(
    request: &BuildRequest<'_>,
    progress: &mut dyn FnMut(BuildProgress),
    cancel: &CancelFlag,
) -> Result<BuiltArchive, SourceError> {
    let check_cancel = || {
        if cancel.is_cancelled() {
            Err(SourceError::new(SourceErrorKind::Cancelled, "Cancelled"))
        } else {
            Ok(())
        }
    };
    let before = scan_tree(request.root, request.emulator)?;
    let total_bytes = before.total_bytes();

    fs::create_dir_all(request.staging_dir).map_err(|error| staging_failure(&error))?;
    // Configuration validation refuses this too. This check also sees through links, and it is what
    // actually stands between a mistake and an archive that contains itself.
    let staging = fs::canonicalize(request.staging_dir).map_err(|error| staging_failure(&error))?;
    let source = fs::canonicalize(request.root).map_err(|error| unreadable("the VM", &error))?;
    if staging.starts_with(&source) {
        return Err(SourceError::new(
            SourceErrorKind::Staging,
            "The staging directory is inside the VM's directory",
        ));
    }
    // The worst case is a VM that does not compress at all, plus room for the archive's own overhead.
    let overhead = 64 * 1024 + 512 * before.archived.len() as u64;
    if let Some(available) = available_disk_bytes(request.staging_dir)
        && available < total_bytes.saturating_add(overhead)
    {
        return Err(SourceError::new(
            SourceErrorKind::InsufficientSpace,
            format!(
                "The staging disk has {available} bytes free, and this VM may need up to {} bytes",
                total_bytes + overhead
            ),
        ));
    }

    let partial = partial_path(request.staging_dir, request.operation_id);
    let output = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|error| staging_failure(&error))?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(READ_BUFFER_BYTES, output));

    let mut entries = Vec::with_capacity(before.archived.len());
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut done_bytes = 0u64;
    let mut file_count = 0u64;
    let mut last_report = done_bytes;
    progress(BuildProgress {
        done_bytes,
        total_bytes,
    });

    for (relative, expected) in &before.archived {
        check_cancel()?;
        match expected {
            TreeEntry::Directory => {
                zip.add_directory(format!("{relative}/"), SimpleFileOptions::default())
                    .map_err(zip_failure)?;
                entries.push(ManifestEntry {
                    path: relative.clone(),
                    entry_type: ManifestEntryType::Directory,
                    size_bytes: None,
                    sha256: None,
                });
            }
            TreeEntry::File(stamp) => {
                let path = request.root.join(relative);
                let mut file =
                    open_for_reading(&path).map_err(|error| unreadable(relative, &error))?;
                let opened = file
                    .metadata()
                    .map_err(|error| unreadable(relative, &error))?;
                if FileStamp::of(&opened) != *stamp {
                    return Err(changed(relative));
                }
                zip.start_file(relative.as_str(), zip_options(relative, stamp))
                    .map_err(zip_failure)?;
                let mut hasher = Sha256::new();
                let mut read_bytes = 0u64;
                loop {
                    check_cancel()?;
                    let count = file
                        .read(&mut buffer)
                        .map_err(|error| unreadable(relative, &error))?;
                    if count == 0 {
                        break;
                    }
                    hasher.update(&buffer[..count]);
                    zip.write_all(&buffer[..count])
                        .map_err(|error| staging_failure(&error))?;
                    read_bytes += count as u64;
                    done_bytes += count as u64;
                    if done_bytes - last_report >= 16 * 1024 * 1024 {
                        last_report = done_bytes;
                        progress(BuildProgress {
                            done_bytes,
                            total_bytes,
                        });
                    }
                }
                // Both through the open file and by name: the name may now point at something else.
                let after_read = file
                    .metadata()
                    .map_err(|error| unreadable(relative, &error))?;
                let by_name =
                    fs::symlink_metadata(&path).map_err(|error| unreadable(relative, &error))?;
                if read_bytes != stamp.size_bytes
                    || FileStamp::of(&after_read) != *stamp
                    || FileStamp::of(&by_name) != *stamp
                    || is_link_like(&by_name)
                {
                    return Err(changed(relative));
                }
                entries.push(ManifestEntry {
                    path: relative.clone(),
                    entry_type: ManifestEntryType::File,
                    size_bytes: Some(read_bytes),
                    sha256: Some(hex(&hasher.finalize())),
                });
                file_count += 1;
            }
        }
    }

    check_cancel()?;
    let after = scan_tree(request.root, request.emulator)?;
    if after.archived != before.archived {
        let difference = first_difference(&before, &after);
        return Err(changed(&difference));
    }
    check_markers(request.root, request.emulator, request.vm_name.as_str())?;

    let manifest = Manifest {
        manifest_version: MANIFEST_VERSION,
        emulator_type: request.emulator,
        vm_name: request.vm_name.as_str().to_owned(),
        file_count,
        total_uncompressed_bytes: done_bytes,
        entries,
    };
    let manifest_bytes = manifest.canonical_bytes();
    zip.start_file(
        MANIFEST_ENTRY_NAME,
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .map_err(zip_failure)?;
    zip.write_all(&manifest_bytes)
        .map_err(|error| staging_failure(&error))?;

    let writer = zip.finish().map_err(zip_failure)?;
    let file = writer
        .into_inner()
        .map_err(|error| staging_failure(error.error()))?;
    file.sync_all().map_err(|error| staging_failure(&error))?;
    drop(file);

    check_archive_structure(&partial, &manifest)?;
    check_cancel()?;
    let (size_bytes, sha256) = hash_file(&partial, cancel)?;

    let path = staging_path(request.staging_dir, request.operation_id);
    fs::rename(&partial, &path).map_err(|error| staging_failure(&error))?;
    progress(BuildProgress {
        done_bytes,
        total_bytes,
    });
    Ok(BuiltArchive {
        path,
        size_bytes,
        sha256,
        manifest_sha256: hex(&Sha256::digest(&manifest_bytes)),
        manifest,
    })
}

fn zip_failure(error: zip::result::ZipError) -> SourceError {
    match error {
        zip::result::ZipError::Io(error) => staging_failure(&error),
        other => SourceError::new(
            SourceErrorKind::Staging,
            format!("Cannot build the archive: {other}"),
        ),
    }
}

fn changed(relative: &str) -> SourceError {
    SourceError::new(
        SourceErrorKind::Changed,
        format!("{relative} changed while the VM was being archived. Stop the VM and try again"),
    )
}

fn first_difference(before: &TreeSnapshot, after: &TreeSnapshot) -> String {
    let appeared = after
        .archived
        .iter()
        .find(|(path, entry)| before.archived.get(*path) != Some(entry));
    let vanished = before
        .archived
        .keys()
        .find(|path| !after.archived.contains_key(*path));
    appeared
        .map(|(path, _)| path.clone())
        .or_else(|| vanished.cloned())
        .unwrap_or_else(|| "A file".to_owned())
}

/// Reads the finished archive's directory back, and compares it with the manifest. This catches a
/// truncated or malformed file before anything is uploaded.
fn check_archive_structure(path: &Path, manifest: &Manifest) -> Result<(), SourceError> {
    let malformed = |detail: String| {
        SourceError::new(
            SourceErrorKind::Staging,
            format!("The archive that was built is not valid: {detail}"),
        )
    };
    let file = File::open(path).map_err(|error| staging_failure(&error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| malformed(error.to_string()))?;
    if archive.len() != manifest.entries.len() + 1 {
        return Err(malformed(format!(
            "it has {} entries, and {} were written",
            archive.len(),
            manifest.entries.len() + 1
        )));
    }
    for entry in &manifest.entries {
        let name = match entry.entry_type {
            ManifestEntryType::File => entry.path.clone(),
            ManifestEntryType::Directory => format!("{}/", entry.path),
        };
        let stored = archive
            .by_name(&name)
            .map_err(|_| malformed(format!("{name} is missing")))?;
        if entry
            .size_bytes
            .is_some_and(|expected| stored.size() != expected)
        {
            return Err(malformed(format!("{name} has the wrong size")));
        }
    }
    archive
        .by_name(MANIFEST_ENTRY_NAME)
        .map_err(|_| malformed("the manifest is missing".to_owned()))?;
    Ok(())
}

/// The size and SHA-256 of a file, using bounded memory.
pub fn hash_file(path: &Path, cancel: &CancelFlag) -> Result<(u64, String), SourceError> {
    let mut file = File::open(path).map_err(|error| staging_failure(&error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_BUFFER_BYTES];
    let mut size = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(SourceError::new(SourceErrorKind::Cancelled, "Cancelled"));
        }
        let count = file
            .read(&mut buffer)
            .map_err(|error| staging_failure(&error))?;
        if count == 0 {
            return Ok((size, hex(&hasher.finalize())));
        }
        hasher.update(&buffer[..count]);
        size += count as u64;
    }
}

/// The manifest inside an archive, for tests and for future tools.
pub fn read_manifest(archive_path: &Path) -> Result<Manifest, SourceError> {
    let invalid = |detail: String| {
        SourceError::new(
            SourceErrorKind::Staging,
            format!("Invalid archive: {detail}"),
        )
    };
    let file = File::open(archive_path).map_err(|error| staging_failure(&error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| invalid(error.to_string()))?;
    let mut entry = archive
        .by_name(MANIFEST_ENTRY_NAME)
        .map_err(|error| invalid(error.to_string()))?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|error| invalid(error.to_string()))?;
    serde_json::from_str(&text).map_err(|error| invalid(error.to_string()))
}
