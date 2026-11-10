//! Takes an archive apart safely, and puts the result in place without ever replacing anything.
//!
//! An archive is treated as untrusted even when its SHA-256 matches what was recorded: the hash says that
//! these are the bytes somebody registered, and nothing about what those bytes try to do. So every entry is
//! checked before any file is created, the whole archive must agree with its manifest, and each file's hash
//! is computed as its bytes are written. Nothing here follows a link, and nothing writes outside the
//! directory it is given. See decision 0022.
//!
//! This blocks, so call it from `spawn_blocking`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::discovery::is_link_like;
use crate::emulators::{EmulatorType, VmName, is_windows_device_name};
use crate::packaging::{
    DirectoryIdentity, MANIFEST_ENTRY_NAME, MANIFEST_VERSION, Manifest, ManifestEntry,
    ManifestEntryType, directory_identity, hex,
};
use crate::repository::CancelFlag;
use crate::zip_directory::{DirectoryError, DirectoryLimits, RawEntry, read_central_directory};

const BUFFER_BYTES: usize = 1024 * 1024;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATED: u16 = 8;
/// Encrypted (bit 0), patched data (bit 5) and strong encryption (bit 6).
const FLAGS_REFUSED: u16 = 0x0001 | 0x0020 | 0x0040;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const UNIX_FILE_TYPE_MASK: u32 = 0o170_000;
const UNIX_REGULAR: u32 = 0o100_000;
const UNIX_DIRECTORY: u32 = 0o040_000;
const MAX_SEGMENT_BYTES: usize = 255;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveErrorKind {
    /// The bytes are not the ones that were registered, or a file does not match its hash.
    Integrity,
    /// The manifest is missing, unreadable, or does not describe this archive.
    ManifestInvalid,
    /// An entry could do something it must not: a path, a link, or a special file.
    Unsafe,
    /// The archive is larger than this agent accepts.
    Limit,
    Cancelled,
    /// Not enough room.
    InsufficientSpace,
    /// A local disk problem, which says nothing about the archive.
    Staging,
    /// The final directory exists, in some capitalization.
    DestinationExists,
    /// The base path or the staged directory is a link, or has been replaced.
    DestinationUnsafe,
    /// The agent cannot tell what a directory is, and leaves it alone.
    Ambiguous,
    /// Replacing a persistent copy failed, and the previous copy was put back.
    ReplacementFailed,
}

impl ArchiveErrorKind {
    /// Stable code, shared with `RESTORE_ERROR_CODES` in the contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Integrity => "restore_integrity_failed",
            Self::ManifestInvalid => "restore_manifest_invalid",
            Self::Unsafe => "restore_unsafe_archive",
            Self::Limit => "restore_limit_exceeded",
            Self::Cancelled => "cancelled",
            Self::InsufficientSpace => "restore_insufficient_space",
            Self::Staging => "restore_staging_failed",
            Self::DestinationExists => "restore_destination_exists",
            Self::DestinationUnsafe => "restore_destination_unsafe",
            Self::Ambiguous => "restore_ambiguous_directory",
            Self::ReplacementFailed => "restore_replacement_failed",
        }
    }
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct ArchiveError {
    pub kind: ArchiveErrorKind,
    pub message: String,
}

pub(crate) fn archive_error(kind: ArchiveErrorKind, message: impl Into<String>) -> ArchiveError {
    ArchiveError {
        kind,
        message: message.into(),
    }
}

fn unsafe_entry(name: &str, why: &str) -> ArchiveError {
    let shown: String = name.chars().take(200).collect();
    archive_error(
        ArchiveErrorKind::Unsafe,
        format!("The entry {shown:?} {why}"),
    )
}

fn local_failure(what: &str, error: &io::Error) -> ArchiveError {
    if error.kind() == io::ErrorKind::StorageFull || error.kind() == io::ErrorKind::QuotaExceeded {
        return archive_error(
            ArchiveErrorKind::InsufficientSpace,
            format!("The disk ran out of space while {what}"),
        );
    }
    archive_error(
        ArchiveErrorKind::Staging,
        format!("Failed while {what}: {error}"),
    )
}

/// What an archive may hold. Configuration sets these, and none of them comes from the archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractionLimits {
    pub max_entries: u64,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_manifest_bytes: u64,
}

impl Default for ExtractionLimits {
    fn default() -> Self {
        Self {
            max_entries: 1_000_000,
            max_total_bytes: 4 * 1024 * 1024 * 1024 * 1024,
            max_file_bytes: 4 * 1024 * 1024 * 1024 * 1024,
            max_manifest_bytes: 256 * 1024 * 1024,
        }
    }
}

/// Whether one path segment is a name no archive of a VM may use, on any system. A name that means
/// nothing special here would still be dangerous once the VM reaches Windows.
fn check_segment(segment: &str) -> Result<(), &'static str> {
    if segment.is_empty() || segment == "." || segment == ".." {
        return Err("has an empty or relative path segment");
    }
    if segment.len() > MAX_SEGMENT_BYTES {
        return Err("has a path segment that is too long");
    }
    if segment.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/'
            )
    }) {
        return Err("has a character that is not allowed in a file name");
    }
    // Windows quietly drops these, so `name.` and `name` would be the same file.
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err("ends with a dot or a space");
    }
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper = stem.to_uppercase();
    if is_windows_device_name(stem)
        || matches!(upper.as_str(), "CONIN$" | "CONOUT$")
        || matches!(
            upper.as_str(),
            "COM¹" | "COM²" | "COM³" | "LPT¹" | "LPT²" | "LPT³"
        )
    {
        return Err("is a reserved device name on Windows");
    }
    Ok(())
}

/// Checks a path as written in an archive. Rejects anything absolute, relative to something else, or
/// able to mean more than one thing: drive letters, UNC paths and alternate data streams all need a
/// colon or a backslash, and neither gets through.
pub fn check_entry_path(path: &str) -> Result<(), ArchiveError> {
    if path.is_empty() {
        return Err(unsafe_entry(path, "has an empty name"));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(unsafe_entry(path, "has a path that is too long"));
    }
    if path.starts_with('/') {
        return Err(unsafe_entry(path, "has an absolute path"));
    }
    if path.contains('\\') {
        return Err(unsafe_entry(
            path,
            "uses a backslash, which could escape on Windows",
        ));
    }
    if path.contains(':') {
        return Err(unsafe_entry(
            path,
            "has a drive letter or an alternate data stream",
        ));
    }
    for segment in path.split('/') {
        check_segment(segment).map_err(|why| unsafe_entry(path, why))?;
    }
    Ok(())
}

/// Refuses anything that is not a plain file or a plain directory, by what the entry says about itself.
fn check_entry_kind(entry: &RawEntry) -> Result<(), ArchiveError> {
    if entry.flags & FLAGS_REFUSED != 0 {
        return Err(unsafe_entry(&entry.name, "is encrypted"));
    }
    if entry.method != METHOD_STORED && entry.method != METHOD_DEFLATED {
        return Err(unsafe_entry(
            &entry.name,
            "uses an unsupported compression method",
        ));
    }
    if entry.external_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && entry.unix_mode().is_none()
    {
        return Err(unsafe_entry(&entry.name, "is a reparse point"));
    }
    if let Some(mode) = entry.unix_mode() {
        match mode & UNIX_FILE_TYPE_MASK {
            0 | UNIX_REGULAR | UNIX_DIRECTORY => {}
            0o120_000 => return Err(unsafe_entry(&entry.name, "is a symbolic link")),
            _ => return Err(unsafe_entry(&entry.name, "is a special file")),
        }
        if mode & UNIX_FILE_TYPE_MASK == UNIX_DIRECTORY && !entry.is_directory_name() {
            return Err(unsafe_entry(
                &entry.name,
                "says it is a directory, and has a file's name",
            ));
        }
        if mode & UNIX_FILE_TYPE_MASK == UNIX_REGULAR && entry.is_directory_name() {
            return Err(unsafe_entry(
                &entry.name,
                "says it is a file, and has a directory's name",
            ));
        }
    }
    if entry.is_directory_name() && entry.uncompressed_size != 0 {
        return Err(unsafe_entry(&entry.name, "is a directory holding data"));
    }
    Ok(())
}

/// What an inspection established, for extracting.
#[derive(Debug, Clone)]
pub struct InspectedArchive {
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

/// What this archive is supposed to be.
#[derive(Debug, Clone, Copy)]
pub struct ArchiveExpectation<'a> {
    pub emulator: EmulatorType,
    pub vm_name: &'a VmName,
    /// What the registration verified, when that is known.
    pub manifest_sha256: Option<&'a str>,
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn manifest_problem(message: impl Into<String>) -> ArchiveError {
    archive_error(ArchiveErrorKind::ManifestInvalid, message)
}

/// A manifest has to be what the registration would have written, for this VM, and consistent with itself.
pub fn validate_manifest(
    manifest: &Manifest,
    raw: &[u8],
    expected: &ArchiveExpectation<'_>,
    limits: &ExtractionLimits,
) -> Result<(), ArchiveError> {
    if manifest.manifest_version != MANIFEST_VERSION {
        return Err(manifest_problem(format!(
            "This agent reads manifest version {MANIFEST_VERSION}, and the archive has version {}",
            manifest.manifest_version
        )));
    }
    if manifest.canonical_bytes() != raw {
        return Err(manifest_problem(
            "The manifest is not in canonical form, so it was not written by a registration",
        ));
    }
    if manifest.emulator_type != expected.emulator {
        return Err(manifest_problem(
            "The manifest describes a VM of another emulator",
        ));
    }
    if !manifest
        .vm_name
        .eq_ignore_ascii_case(expected.vm_name.as_str())
    {
        return Err(manifest_problem("The manifest describes another VM"));
    }
    if let Some(wanted) = expected.manifest_sha256 {
        let actual = hex(&Sha256::digest(raw));
        if actual != wanted {
            return Err(archive_error(
                ArchiveErrorKind::Integrity,
                format!("The manifest's SHA-256 is {actual}, and {wanted} was registered"),
            ));
        }
    }
    let mut previous: Option<&str> = None;
    let mut files = 0u64;
    let mut total = 0u64;
    for entry in &manifest.entries {
        if previous.is_some_and(|before| before.as_bytes() >= entry.path.as_bytes()) {
            return Err(manifest_problem(
                "The manifest's entries are not in canonical order",
            ));
        }
        previous = Some(&entry.path);
        check_entry_path(&entry.path)?;
        match entry.entry_type {
            ManifestEntryType::File => {
                let (Some(size), Some(sha256)) = (entry.size_bytes, entry.sha256.as_deref()) else {
                    return Err(manifest_problem(format!(
                        "{} is a file with no size or hash",
                        entry.path
                    )));
                };
                if !is_lowercase_sha256(sha256) {
                    return Err(manifest_problem(format!(
                        "{} has an invalid hash",
                        entry.path
                    )));
                }
                if size > limits.max_file_bytes {
                    return Err(archive_error(
                        ArchiveErrorKind::Limit,
                        format!(
                            "{} is {size} bytes, and the limit is {}",
                            entry.path, limits.max_file_bytes
                        ),
                    ));
                }
                files += 1;
                total = total
                    .checked_add(size)
                    .ok_or_else(|| manifest_problem("The manifest's sizes do not add up"))?;
            }
            ManifestEntryType::Directory => {
                if entry.size_bytes.is_some() || entry.sha256.is_some() {
                    return Err(manifest_problem(format!(
                        "{} is a directory with a size or a hash",
                        entry.path
                    )));
                }
            }
        }
    }
    if files != manifest.file_count || total != manifest.total_uncompressed_bytes {
        return Err(manifest_problem(
            "The manifest's totals do not match its entries",
        ));
    }
    if total > limits.max_total_bytes {
        return Err(archive_error(
            ArchiveErrorKind::Limit,
            format!(
                "This VM holds {total} bytes, and this agent's limit is {}",
                limits.max_total_bytes
            ),
        ));
    }
    // Every parent has to be listed. Sorting by bytes puts a directory before what it holds.
    let directories: HashSet<&str> = manifest
        .entries
        .iter()
        .filter(|entry| entry.entry_type == ManifestEntryType::Directory)
        .map(|entry| entry.path.as_str())
        .collect();
    for entry in &manifest.entries {
        if let Some((parent, _)) = entry.path.rsplit_once('/')
            && !directories.contains(parent)
        {
            return Err(manifest_problem(format!(
                "{} is in a directory the manifest does not list",
                entry.path
            )));
        }
    }
    Ok(())
}

/// Two names that are one file on Windows. Both foldings are used, since neither alone covers every
/// character NTFS treats as equal. Whatever slips past this is still stopped when the file is created,
/// because nothing is ever opened over an existing file.
fn folded(path: &str) -> [String; 2] {
    [path.to_lowercase(), path.to_uppercase()]
}

/// Everything that can be decided without creating a file: the structure, every entry, and the manifest.
pub fn inspect_archive(
    file: &mut File,
    expected: &ArchiveExpectation<'_>,
    limits: &ExtractionLimits,
) -> Result<InspectedArchive, ArchiveError> {
    let entries = read_central_directory(
        file,
        DirectoryLimits {
            max_entries: limits.max_entries,
            max_directory_bytes: limits.max_manifest_bytes.saturating_mul(2),
        },
    )
    .map_err(|error| match error {
        DirectoryError::Malformed(message) => archive_error(
            ArchiveErrorKind::Integrity,
            format!("The ZIP is damaged: {message}"),
        ),
        DirectoryError::TooLarge(message) => archive_error(ArchiveErrorKind::Limit, message),
        DirectoryError::Io(error) => local_failure("reading the archive", &error),
    })?;

    let mut seen_lower: HashSet<String> = HashSet::with_capacity(entries.len());
    let mut seen_upper: HashSet<String> = HashSet::with_capacity(entries.len());
    let mut by_name: HashMap<&str, &RawEntry> = HashMap::with_capacity(entries.len());
    let mut manifest_entries = 0;
    for entry in &entries {
        check_entry_kind(entry)?;
        let path = entry.name.strip_suffix('/').unwrap_or(&entry.name);
        check_entry_path(path)?;
        let [lower, upper] = folded(path);
        if !seen_lower.insert(lower) || !seen_upper.insert(upper) {
            return Err(unsafe_entry(
                &entry.name,
                "duplicates another entry, at least when capitalization is ignored",
            ));
        }
        by_name.insert(path, entry);
        if entry.name.eq_ignore_ascii_case(MANIFEST_ENTRY_NAME) {
            if entry.name != MANIFEST_ENTRY_NAME {
                return Err(unsafe_entry(&entry.name, "imitates the manifest's name"));
            }
            manifest_entries += 1;
        }
    }
    if manifest_entries == 0 {
        return Err(manifest_problem(format!(
            "The archive has no {MANIFEST_ENTRY_NAME}"
        )));
    }
    let declared = by_name
        .get(MANIFEST_ENTRY_NAME)
        .map_or(0, |entry| entry.uncompressed_size);
    if declared > limits.max_manifest_bytes {
        return Err(archive_error(
            ArchiveErrorKind::Limit,
            format!(
                "The manifest is {declared} bytes, and the limit is {}",
                limits.max_manifest_bytes
            ),
        ));
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| local_failure("reading the archive", &error))?;
    let mut archive = zip::ZipArchive::new(&*file).map_err(|error| {
        archive_error(
            ArchiveErrorKind::Integrity,
            format!("The ZIP is damaged: {error}"),
        )
    })?;
    let raw = {
        let entry = archive.by_name(MANIFEST_ENTRY_NAME).map_err(|error| {
            archive_error(
                ArchiveErrorKind::Integrity,
                format!("Cannot read the manifest: {error}"),
            )
        })?;
        let mut raw = Vec::with_capacity(declared.min(16 * 1024 * 1024) as usize);
        entry
            .take(limits.max_manifest_bytes + 1)
            .read_to_end(&mut raw)
            .map_err(|error| {
                archive_error(
                    ArchiveErrorKind::Integrity,
                    format!("Cannot read the manifest: {error}"),
                )
            })?;
        raw
    };
    if raw.len() as u64 > limits.max_manifest_bytes {
        return Err(archive_error(
            ArchiveErrorKind::Limit,
            "The manifest is too large",
        ));
    }
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|error| manifest_problem(format!("The manifest cannot be read: {error}")))?;
    validate_manifest(&manifest, &raw, expected, limits)?;

    // The two have to list the same things, and neither may hold anything the other does not.
    for listed in &manifest.entries {
        let Some(stored) = by_name.get(listed.path.as_str()) else {
            return Err(manifest_problem(format!(
                "{} is missing from the archive",
                listed.path
            )));
        };
        match listed.entry_type {
            ManifestEntryType::File => {
                if stored.is_directory_name() {
                    return Err(manifest_problem(format!(
                        "{} is a file in the manifest and a directory in the archive",
                        listed.path
                    )));
                }
                if Some(stored.uncompressed_size) != listed.size_bytes {
                    return Err(archive_error(
                        ArchiveErrorKind::Integrity,
                        format!(
                            "{} has a different size in the archive and the manifest",
                            listed.path
                        ),
                    ));
                }
            }
            ManifestEntryType::Directory => {
                if !stored.is_directory_name() {
                    return Err(manifest_problem(format!(
                        "{} is a directory in the manifest and a file in the archive",
                        listed.path
                    )));
                }
            }
        }
    }
    if entries.len() != manifest.entries.len() + 1 {
        let listed: HashSet<&str> = manifest
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        let extra = entries
            .iter()
            .map(|entry| entry.name.strip_suffix('/').unwrap_or(&entry.name))
            .find(|name| *name != MANIFEST_ENTRY_NAME && !listed.contains(name))
            .unwrap_or("An entry");
        return Err(manifest_problem(format!(
            "{extra} is in the archive and not in the manifest"
        )));
    }

    let manifest_sha256 = hex(&Sha256::digest(&raw));
    Ok(InspectedArchive {
        manifest,
        manifest_sha256,
    })
}

/// Bytes done and bytes in total.
pub type ExtractionProgress<'a> = &'a mut dyn FnMut(u64, u64);

fn check_parent(parent: &Path, path: &str) -> Result<(), ArchiveError> {
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| local_failure(&format!("preparing {path}"), &error))?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("The directory for {path} is a link, or was replaced"),
        ));
    }
    Ok(())
}

/// Extracts into `target`, which must not exist yet. Stops at the first problem, and leaves whatever it
/// has written for the caller to remove: it is all under `target`, which nothing else refers to.
pub fn extract_archive(
    file: &mut File,
    inspected: &InspectedArchive,
    target: &Path,
    limits: &ExtractionLimits,
    progress: ExtractionProgress<'_>,
    cancel: &CancelFlag,
) -> Result<(), ArchiveError> {
    fs::create_dir(target)
        .map_err(|error| local_failure("creating the extraction directory", &error))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| local_failure("reading the archive", &error))?;
    let mut archive = zip::ZipArchive::new(&*file).map_err(|error| {
        archive_error(
            ArchiveErrorKind::Integrity,
            format!("The ZIP is damaged: {error}"),
        )
    })?;
    let total = inspected.manifest.total_uncompressed_bytes;
    let mut done = 0u64;
    let mut last_report = 0u64;
    let mut buffer = vec![0u8; BUFFER_BYTES];
    progress(0, total);

    for entry in &inspected.manifest.entries {
        if cancel.is_cancelled() {
            return Err(archive_error(ArchiveErrorKind::Cancelled, "Cancelled"));
        }
        // Validated when the manifest was read. Each segment is a plain name, so this stays inside.
        let path = entry
            .path
            .split('/')
            .fold(target.to_path_buf(), |path, segment| path.join(segment));
        if let Some(parent) = path.parent() {
            check_parent(parent, &entry.path)?;
        }
        match entry.entry_type {
            ManifestEntryType::Directory => {
                fs::create_dir(&path)
                    .map_err(|error| local_failure(&format!("creating {}", entry.path), &error))?;
            }
            ManifestEntryType::File => {
                extract_file(
                    &mut archive,
                    entry,
                    &path,
                    limits,
                    &mut buffer,
                    &mut done,
                    &mut last_report,
                    total,
                    progress,
                    cancel,
                )?;
            }
        }
    }
    verify_tree(target, &inspected.manifest)?;
    progress(done, total);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn extract_file(
    archive: &mut zip::ZipArchive<&File>,
    entry: &ManifestEntry,
    path: &Path,
    limits: &ExtractionLimits,
    buffer: &mut [u8],
    done: &mut u64,
    last_report: &mut u64,
    total: u64,
    progress: ExtractionProgress<'_>,
    cancel: &CancelFlag,
) -> Result<(), ArchiveError> {
    let name = entry.path.as_str();
    let expected_size = entry.size_bytes.unwrap_or_default();
    let mut stored = archive.by_name(name).map_err(|error| {
        archive_error(
            ArchiveErrorKind::Integrity,
            format!("Cannot read {name}: {error}"),
        )
    })?;
    // Never over an existing file, whatever it is. A link cannot be followed, since none can be opened.
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                unsafe_entry(name, "collides with another entry on this system")
            } else {
                local_failure(&format!("creating {name}"), &error)
            }
        })?;
    let mut writer = BufWriter::with_capacity(BUFFER_BYTES, output);
    let mut hasher = Sha256::new();
    let mut written = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(archive_error(ArchiveErrorKind::Cancelled, "Cancelled"));
        }
        let count = stored.read(buffer).map_err(|error| {
            archive_error(
                ArchiveErrorKind::Integrity,
                format!("Cannot decompress {name}: {error}"),
            )
        })?;
        if count == 0 {
            break;
        }
        written += count as u64;
        // Whatever the headers claim, nothing is written past what the manifest allows.
        if written > expected_size || written > limits.max_file_bytes {
            return Err(archive_error(
                ArchiveErrorKind::Integrity,
                format!("{name} expands beyond its recorded size"),
            ));
        }
        hasher.update(&buffer[..count]);
        writer
            .write_all(&buffer[..count])
            .map_err(|error| local_failure(&format!("writing {name}"), &error))?;
        *done += count as u64;
        if *done - *last_report >= 16 * 1024 * 1024 {
            *last_report = *done;
            progress(*done, total);
        }
    }
    let actual = hex(&hasher.finalize());
    if written != expected_size || Some(actual.as_str()) != entry.sha256.as_deref() {
        return Err(archive_error(
            ArchiveErrorKind::Integrity,
            format!("{name} does not match the manifest: {written} bytes with SHA-256 {actual}"),
        ));
    }
    let file = writer
        .into_inner()
        .map_err(|error| local_failure(&format!("writing {name}"), error.error()))?;
    file.sync_all()
        .map_err(|error| local_failure(&format!("writing {name}"), &error))
}

/// Lists what was written, without following anything, and compares it with the manifest.
pub fn verify_tree(target: &Path, manifest: &Manifest) -> Result<(), ArchiveError> {
    let expected: BTreeMap<&str, &ManifestEntry> = manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut found = 0usize;
    let mut pending = vec![(target.to_path_buf(), String::new())];
    while let Some((directory, prefix)) = pending.pop() {
        let listing = fs::read_dir(&directory)
            .map_err(|error| local_failure("checking the extraction", &error))?;
        for item in listing {
            let item = item.map_err(|error| local_failure("checking the extraction", &error))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let metadata = fs::symlink_metadata(item.path())
                .map_err(|error| local_failure("checking the extraction", &error))?;
            if is_link_like(&metadata) {
                return Err(archive_error(
                    ArchiveErrorKind::DestinationUnsafe,
                    format!("{relative} appeared as a link during extraction"),
                ));
            }
            let Some(entry) = expected.get(relative.as_str()) else {
                return Err(archive_error(
                    ArchiveErrorKind::DestinationUnsafe,
                    format!("{relative} appeared during extraction"),
                ));
            };
            found += 1;
            match entry.entry_type {
                ManifestEntryType::Directory if metadata.is_dir() => {
                    pending.push((item.path(), relative));
                }
                ManifestEntryType::File
                    if metadata.is_file() && Some(metadata.len()) == entry.size_bytes => {}
                _ => {
                    return Err(archive_error(
                        ArchiveErrorKind::Integrity,
                        format!("{relative} is not what was extracted"),
                    ));
                }
            }
        }
    }
    if found != expected.len() {
        return Err(archive_error(
            ArchiveErrorKind::Integrity,
            "The extraction does not hold everything the manifest lists",
        ));
    }
    Ok(())
}

/// Where a VM is assembled, inside the base path so that publishing is a rename on one volume. A leading
/// dot is not a valid VM name, so discovery reports it as skipped and nothing can register it.
pub fn staged_directory(base_path: &Path, operation_id: Uuid) -> PathBuf {
    base_path.join(format!(".emucat-restoring-{operation_id}"))
}

/// A base path that can be published into. A link could point it somewhere else later, so none is accepted.
pub fn check_base_path(base_path: &Path) -> Result<DirectoryIdentity, ArchiveError> {
    let metadata = fs::symlink_metadata(base_path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot examine the base path: {error}"),
        )
    })?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The base path is a link, a junction or not a directory",
        ));
    }
    directory_identity(base_path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot identify the base path: {error}"),
        )
    })
}

/// Refuses a destination that exists in any capitalization. Listed rather than probed, because this has
/// to give the same answer on any filesystem, and has to see a link without following it.
pub fn check_destination_free(base_path: &Path, vm_name: &VmName) -> Result<(), ArchiveError> {
    let listing = fs::read_dir(base_path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot read the base path: {error}"),
        )
    })?;
    for item in listing {
        let item = item.map_err(|error| {
            archive_error(
                ArchiveErrorKind::DestinationUnsafe,
                format!("Cannot read the base path: {error}"),
            )
        })?;
        let name = item.file_name();
        if name
            .to_string_lossy()
            .eq_ignore_ascii_case(vm_name.as_str())
        {
            return Err(archive_error(
                ArchiveErrorKind::DestinationExists,
                format!(
                    "{} already exists in the base path, and is never overwritten",
                    name.to_string_lossy()
                ),
            ));
        }
    }
    Ok(())
}

/// A rename that fails rather than replace anything. On Windows that is what `MoveFileExW` does without
/// its replace flag, atomically and only on one volume. See decision 0023 for other systems.
#[cfg(windows)]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both strings are NUL-terminated and live for the call, and no flag is passed.
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if moved == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A rename that fails rather than replace anything. `rename(2)` itself would replace an empty directory
/// or a file, so this checks first: a directory appearing in that moment loses nothing, because it would
/// have to be empty. See decision 0023.
#[cfg(not(windows))]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "the destination already exists",
        ));
    }
    fs::rename(from, to)
}

#[cfg(windows)]
fn is_transiently_locked(error: &io::Error) -> bool {
    // An indexer or a virus scanner looking at what was just written. It lets go by itself.
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    matches!(
        error.raw_os_error(),
        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION)
    )
}

#[cfg(not(windows))]
fn is_transiently_locked(_error: &io::Error) -> bool {
    false
}

fn already_exists(error: &io::Error) -> bool {
    const ERROR_FILE_EXISTS: i32 = 80;
    const ERROR_ALREADY_EXISTS: i32 = 183;
    error.kind() == io::ErrorKind::AlreadyExists
        || (cfg!(windows)
            && matches!(
                error.raw_os_error(),
                Some(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS)
            ))
}

#[derive(Debug)]
pub struct Publication<'a> {
    pub base_path: &'a Path,
    pub base_identity: DirectoryIdentity,
    pub vm_name: &'a VmName,
    pub staged: &'a Path,
    pub staged_identity: DirectoryIdentity,
}

/// Puts a verified VM in place. Everything is looked at again immediately before the rename, which is the
/// only step here that changes what an emulator can see, and it either happens whole or not at all.
pub fn publish_directory(publication: &Publication<'_>) -> Result<PathBuf, ArchiveError> {
    let Publication {
        base_path,
        base_identity,
        vm_name,
        staged,
        staged_identity,
    } = *publication;
    if check_base_path(base_path)? != base_identity {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The base path was replaced during the restore",
        ));
    }
    let metadata = fs::symlink_metadata(staged).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("The extracted VM cannot be found: {error}"),
        )
    })?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The extracted VM was replaced by a link",
        ));
    }
    let identity = directory_identity(staged).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot identify the extracted VM: {error}"),
        )
    })?;
    if identity != staged_identity {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The extracted VM was replaced during the restore",
        ));
    }
    check_destination_free(base_path, vm_name)?;

    let destination = crate::filesystem::vm_directory(base_path, vm_name);
    let mut attempts = 0;
    loop {
        attempts += 1;
        match rename_no_replace(staged, &destination) {
            Ok(()) => return Ok(destination),
            Err(error) if already_exists(&error) => {
                return Err(archive_error(
                    ArchiveErrorKind::DestinationExists,
                    format!("{vm_name} appeared in the base path, and is never overwritten"),
                ));
            }
            Err(error) if is_transiently_locked(&error) && attempts < 20 => {
                drop(error);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(error) => {
                return Err(local_failure("moving the VM into place", &error));
            }
        }
    }
}

/// Where a replaced persistent copy waits, beside the new one, until the new one is in place. Like a staged
/// directory, its leading dot keeps discovery from ever taking it for a VM.
pub fn replaced_directory(base_path: &Path, operation_id: Uuid) -> PathBuf {
    base_path.join(format!(".emucat-replaced-{operation_id}"))
}

/// The one entry of the base path that is this VM, in whatever capitalization, if it is a plain
/// directory. `Ok(None)` when there is none; an error when there is more than one, or it is a link.
pub fn existing_vm_directory(
    base_path: &Path,
    vm_name: &VmName,
) -> Result<Option<PathBuf>, ArchiveError> {
    let unreadable = |error: io::Error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot read the base path: {error}"),
        )
    };
    let mut found = Vec::new();
    for item in fs::read_dir(base_path).map_err(unreadable)? {
        let item = item.map_err(unreadable)?;
        if item
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(vm_name.as_str())
        {
            found.push(item.path());
        }
    }
    match found.as_slice() {
        [] => Ok(None),
        [path] => {
            let metadata = fs::symlink_metadata(path).map_err(|error| {
                archive_error(
                    ArchiveErrorKind::DestinationUnsafe,
                    format!("Cannot examine the local copy: {error}"),
                )
            })?;
            if is_link_like(&metadata) || !metadata.is_dir() {
                return Err(archive_error(
                    ArchiveErrorKind::DestinationUnsafe,
                    "The local copy is a link, a junction or not a directory, and is never replaced",
                ));
            }
            Ok(Some(path.clone()))
        }
        _ => Err(archive_error(
            ArchiveErrorKind::Ambiguous,
            format!(
                "{vm_name} exists more than once in the base path, in different capitalizations"
            ),
        )),
    }
}

fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempts = 0;
    loop {
        attempts += 1;
        match rename_no_replace(from, to) {
            Err(error) if is_transiently_locked(&error) && attempts < 20 => {
                drop(error);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            other => return other,
        }
    }
}

fn plain_directory_identity(path: &Path, what: &str) -> Result<DirectoryIdentity, ArchiveError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("{what} cannot be found: {error}"),
        )
    })?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("{what} is a link or not a directory"),
        ));
    }
    directory_identity(path).map_err(|error| {
        archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            format!("Cannot identify {what}: {error}"),
        )
    })
}

/// Replacing a persistent copy: which directory it is now, and where it waits while the new one moves in.
#[derive(Debug)]
pub struct Replacement<'a> {
    pub current: &'a Path,
    pub current_identity: DirectoryIdentity,
    pub aside: &'a Path,
}

/// Puts a verified VM in place of an existing copy, with no-replace renames on one volume only: the
/// current copy moves aside, then the new one moves in. If the second rename fails, the first is undone,
/// so either the new copy is in place with the old one beside it, or the old one is where it was. The old
/// copy is never deleted here: the caller removes it once the new one is recorded.
pub fn replace_directory(
    publication: &Publication<'_>,
    replacement: &Replacement<'_>,
) -> Result<PathBuf, ArchiveError> {
    let Publication {
        base_path,
        base_identity,
        vm_name,
        staged,
        staged_identity,
    } = *publication;
    if check_base_path(base_path)? != base_identity {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The base path was replaced during the restore",
        ));
    }
    if plain_directory_identity(staged, "The extracted VM")? != staged_identity {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The extracted VM was replaced during the restore",
        ));
    }
    if plain_directory_identity(replacement.current, "The local copy")?
        != replacement.current_identity
    {
        return Err(archive_error(
            ArchiveErrorKind::DestinationUnsafe,
            "The local copy was replaced by another directory during the restore, and was left alone",
        ));
    }
    if existing_vm_directory(base_path, vm_name)?.as_deref() != Some(replacement.current) {
        return Err(archive_error(
            ArchiveErrorKind::Ambiguous,
            "The local copy is no longer the only directory with this VM's name",
        ));
    }

    rename_retrying(replacement.current, replacement.aside).map_err(|error| {
        archive_error(
            ArchiveErrorKind::ReplacementFailed,
            format!(
                "The local copy could not be moved aside, so nothing changed. Is the VM in use? {error}"
            ),
        )
    })?;
    if directory_identity(replacement.aside).ok() != Some(replacement.current_identity) {
        return Err(archive_error(
            ArchiveErrorKind::Ambiguous,
            format!(
                "{} is not the local copy that was moved aside, so everything was left alone",
                replacement.aside.display()
            ),
        ));
    }
    let put_back = |why: String| -> ArchiveError {
        match rename_retrying(replacement.aside, replacement.current) {
            Ok(()) => archive_error(
                ArchiveErrorKind::ReplacementFailed,
                format!("{why}. The previous local copy was put back unchanged"),
            ),
            Err(error) => archive_error(
                ArchiveErrorKind::Ambiguous,
                format!(
                    "{why}, and the previous local copy could not be put back: it is in {}. {error}",
                    replacement.aside.display()
                ),
            ),
        }
    };
    if let Err(error) = check_destination_free(base_path, vm_name) {
        return Err(put_back(error.message));
    }
    let destination = crate::filesystem::vm_directory(base_path, vm_name);
    match rename_retrying(staged, &destination) {
        Ok(()) => Ok(destination),
        Err(error) => Err(put_back(format!(
            "The new version could not be moved into place: {error}"
        ))),
    }
}

/// Removes a replaced copy once its replacement is recorded: only the directory moved aside by this
/// operation, identified as the one that was moved, and never a link. Returns whether it is gone.
pub fn remove_replaced_directory(aside: &Path, identity: DirectoryIdentity) -> bool {
    match fs::symlink_metadata(aside) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Ok(metadata) if !is_link_like(&metadata) && metadata.is_dir() => {
            if directory_identity(aside).ok() != Some(identity) {
                tracing::error!(path = %aside.display(), "A replaced copy is not the one moved aside; left alone");
                return false;
            }
            match fs::remove_dir_all(aside) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(%error, path = %aside.display(), "Cannot remove a replaced copy yet");
                    false
                }
            }
        }
        Ok(_) => {
            tracing::error!(path = %aside.display(), "A replaced copy is not a plain directory; left alone");
            false
        }
        Err(error) => {
            tracing::warn!(%error, path = %aside.display(), "Cannot examine a replaced copy");
            false
        }
    }
}

/// Removes a directory this operation assembled, and nothing else: a link is left where it is, and the
/// name holds this operation's UUID. Returns whether it is gone.
pub fn remove_staged_directory(staged: &Path) -> bool {
    match fs::symlink_metadata(staged) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => {
            tracing::warn!(%error, path = %staged.display(), "Cannot examine a staged directory");
            false
        }
        Ok(metadata) if is_link_like(&metadata) || !metadata.is_dir() => {
            tracing::error!(path = %staged.display(), "A staged directory is not a plain directory; left alone");
            false
        }
        Ok(_) => match fs::remove_dir_all(staged) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, path = %staged.display(), "Cannot remove a staged directory");
                false
            }
        },
    }
}
