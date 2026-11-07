//! Restoring a master, against a repository held in memory whose failures can be chosen. The same workflow
//! against a real SFTP server and a real API is in `apps/api/e2e`.
//!
//! The rule under test throughout: a failed restore leaves no VM behind and harms no existing directory.
//! Hostile archives are written byte by byte here, because a well-behaved ZIP writer would refuse them.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::archive_cache::ArchiveCache;
use emucat_agent::archives::VersionId;
use emucat_agent::config::EmulatorConfig;
use emucat_agent::emulators::{EmulatorType, VmIdentity, VmName};
use emucat_agent::extraction::{
    ArchiveErrorKind, ArchiveExpectation, ExtractionLimits, Publication, check_entry_path,
    extract_archive, inspect_archive, publish_directory, rename_no_replace, staged_directory,
};
use emucat_agent::packaging::{
    BuildRequest, MANIFEST_ENTRY_NAME, Manifest, ManifestEntry, ManifestEntryType, build_archive,
    directory_identity, hex,
};
use emucat_agent::protocol::{
    LocalCopyCondition, Message, RepositoryConfigSummary, RestoreAck, RestoreAckOutcome,
    RestoreCancel, RestoreRequest, RestoreResult, RestoreStage, VerifyResultStatus, VmExecutionAck,
    VmVerifyAck, VmVerifyRequest, VmVerifyResult,
};
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind as Kind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use emucat_agent::restore::RestoreSettings;
use emucat_agent::state::read_local_state;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x7777);
const FOREVER: Duration = Duration::from_secs(30);

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

// A ZIP written byte by byte. Everything a ZIP writer would refuse to produce can be produced here.

#[derive(Clone)]
struct RawEntry {
    name: Vec<u8>,
    data: Vec<u8>,
    host: u8,
    external: u32,
    flags: u16,
    method: u16,
    /// What the headers claim, when that should differ from the truth.
    claimed_size: Option<u64>,
}

impl RawEntry {
    fn file(name: &str, data: &[u8]) -> Self {
        Self {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            host: 3,
            external: 0o100_644 << 16,
            flags: 0x0800,
            method: 0,
            claimed_size: None,
        }
    }

    fn directory(name: &str) -> Self {
        Self {
            name: format!("{name}/").into_bytes(),
            data: Vec::new(),
            host: 3,
            external: 0o040_755 << 16,
            flags: 0x0800,
            method: 0,
            claimed_size: None,
        }
    }
}

/// CRC-32, as ZIP uses it. Written out because a hostile fixture should not depend on a writer library.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn write_zip(path: &Path, entries: &[RawEntry], zip64: bool) {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for entry in entries {
        let offset = out.len() as u32;
        let crc = crc32(&entry.data);
        let size = entry.claimed_size.unwrap_or(entry.data.len() as u64) as u32;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&entry.flags.to_le_bytes());
        out.extend_from_slice(&entry.method.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0x21, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&entry.data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&[20, entry.host]);
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&entry.flags.to_le_bytes());
        central.extend_from_slice(&entry.method.to_le_bytes());
        central.extend_from_slice(&[0, 0, 0x21, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 8]);
        central.extend_from_slice(&entry.external.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(&entry.name);
    }
    let directory_offset = out.len() as u64;
    let directory_size = central.len() as u64;
    out.extend_from_slice(&central);
    let count = entries.len() as u64;
    if zip64 {
        let record_offset = out.len() as u64;
        out.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        out.extend_from_slice(&44u64.to_le_bytes());
        out.extend_from_slice(&[45, 3, 45, 0]);
        out.extend_from_slice(&[0u8; 8]);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&directory_size.to_le_bytes());
        out.extend_from_slice(&directory_offset.to_le_bytes());
        out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&record_offset.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
    }
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    if zip64 {
        out.extend_from_slice(&[0xFF; 12]);
    } else {
        out.extend_from_slice(&(count as u16).to_le_bytes());
        out.extend_from_slice(&(count as u16).to_le_bytes());
        out.extend_from_slice(&(directory_size as u32).to_le_bytes());
        out.extend_from_slice(&(directory_offset as u32).to_le_bytes());
    }
    out.extend_from_slice(&0u16.to_le_bytes());
    fs::write(path, out).unwrap();
}

fn manifest_for(entries: &[(&str, Option<&[u8]>)]) -> Manifest {
    let mut listed: Vec<ManifestEntry> = entries
        .iter()
        .map(|(path, data)| ManifestEntry {
            path: (*path).to_owned(),
            entry_type: if data.is_some() {
                ManifestEntryType::File
            } else {
                ManifestEntryType::Directory
            },
            size_bytes: data.map(|data| data.len() as u64),
            sha256: data.map(sha256),
        })
        .collect();
    listed.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Manifest {
        manifest_version: 1,
        emulator_type: EmulatorType::Qemu,
        vm_name: "Win98".to_owned(),
        file_count: entries.iter().filter(|(_, data)| data.is_some()).count() as u64,
        total_uncompressed_bytes: entries
            .iter()
            .filter_map(|(_, data)| data.map(|data| data.len() as u64))
            .sum(),
        entries: listed,
    }
}

/// A valid archive of these entries, before any tampering.
fn zip_of(entries: &[(&str, Option<&[u8]>)]) -> Vec<RawEntry> {
    let mut raw: Vec<RawEntry> = entries
        .iter()
        .map(|(path, data)| match data {
            Some(data) => RawEntry::file(path, data),
            None => RawEntry::directory(path),
        })
        .collect();
    raw.push(RawEntry::file(
        MANIFEST_ENTRY_NAME,
        &manifest_for(entries).canonical_bytes(),
    ));
    raw
}

const VALID: &[(&str, Option<&[u8]>)] = &[
    ("run.bat", Some(b"@echo never run\n")),
    ("disk.qcow2", Some(b"disk image bytes")),
    ("nested", None),
    ("nested/deep", None),
    ("nested/deep/file.bin", Some(b"\x00\x01\x02")),
    ("empty", None),
];

fn expectation(name: &VmName) -> ArchiveExpectation<'_> {
    ArchiveExpectation {
        emulator: EmulatorType::Qemu,
        vm_name: name,
        manifest_sha256: None,
    }
}

struct Inspected {
    directory: TempDir,
    archive: PathBuf,
}

fn archive_with(entries: &[RawEntry], zip64: bool) -> Inspected {
    let directory = TempDir::new().unwrap();
    let archive = directory.path().join("a.zip");
    write_zip(&archive, entries, zip64);
    Inspected { directory, archive }
}

fn inspect_kind(entries: &[RawEntry]) -> ArchiveErrorKind {
    let fixture = archive_with(entries, false);
    let name = VmName::new("Win98").unwrap();
    let mut file = File::open(&fixture.archive).unwrap();
    inspect_archive(&mut file, &expectation(&name), &ExtractionLimits::default())
        .expect_err("this archive must be refused")
        .kind
}

fn extract(fixture: &Inspected, limits: &ExtractionLimits) -> Result<PathBuf, ArchiveErrorKind> {
    let name = VmName::new("Win98").unwrap();
    let mut file = File::open(&fixture.archive).unwrap();
    let inspected =
        inspect_archive(&mut file, &expectation(&name), limits).map_err(|error| error.kind)?;
    let target = fixture.directory.path().join("target");
    extract_archive(
        &mut file,
        &inspected,
        &target,
        limits,
        &mut |_, _| {},
        &CancelFlag::new(),
    )
    .map_err(|error| error.kind)?;
    Ok(target)
}

// Archive structure and paths.

#[test]
fn a_valid_archive_extracts_with_nested_and_empty_directories() {
    let fixture = archive_with(&zip_of(VALID), false);
    let target = extract(&fixture, &ExtractionLimits::default()).unwrap();
    assert_eq!(
        fs::read(target.join("disk.qcow2")).unwrap(),
        b"disk image bytes"
    );
    assert_eq!(
        fs::read(target.join("nested/deep/file.bin")).unwrap(),
        b"\x00\x01\x02"
    );
    assert!(target.join("empty").is_dir());
    assert_eq!(fs::read_dir(target.join("empty")).unwrap().count(), 0);
    assert!(
        !target.join(MANIFEST_ENTRY_NAME).exists(),
        "the manifest describes the VM, and is not part of it"
    );
}

#[test]
fn a_zip64_directory_is_understood() {
    let fixture = archive_with(&zip_of(VALID), true);
    let target = extract(&fixture, &ExtractionLimits::default()).unwrap();
    assert_eq!(
        fs::read(target.join("run.bat")).unwrap(),
        b"@echo never run\n"
    );
}

#[test]
fn unsafe_paths_are_refused() {
    for path in [
        "../evil",
        "a/../../evil",
        "..",
        ".",
        "a/./b",
        "a//b",
        "/absolute",
        "//server/share/x",
        "\\\\server\\share\\x",
        "C:\\windows\\x",
        "C:/windows/x",
        "C:x",
        "a\\..\\..\\b",
        "file.txt:stream",
        "file.txt::$DATA",
        "CON",
        "con.txt",
        "NUL",
        "aux.tar.gz",
        "COM1",
        "lpt9.log",
        "a/PRN/b",
        "CONIN$",
        "trailing.",
        "trailing ",
        "wild*card",
        "what?",
        "pipe|name",
        "ctrl\u{1}char",
        "",
    ] {
        assert!(check_entry_path(path).is_err(), "{path:?} must be refused");
    }
    for path in [
        "run.bat",
        "a/b/c.txt",
        "CONFIG.SYS",
        "com10",
        ".hidden",
        "dir.d/x y.bin",
    ] {
        assert!(check_entry_path(path).is_ok(), "{path:?} is fine");
    }
}

#[test]
fn zip_slip_never_reaches_the_disk() {
    let mut entries = zip_of(VALID);
    entries.insert(0, RawEntry::file("../escaped.txt", b"evil"));
    let fixture = archive_with(&entries, false);
    assert_eq!(
        extract(&fixture, &ExtractionLimits::default()).unwrap_err(),
        ArchiveErrorKind::Unsafe
    );
    assert!(!fixture.directory.path().join("escaped.txt").exists());
    assert!(!fixture.directory.path().join("target").exists());
}

#[test]
fn absolute_and_drive_entries_are_refused_before_any_file_is_created() {
    for name in ["/etc/passwd", "C:\\evil.txt", "C:/evil.txt", "CON", "a\\b"] {
        let mut entries = zip_of(VALID);
        entries.push(RawEntry::file(name, b"evil"));
        assert_eq!(inspect_kind(&entries), ArchiveErrorKind::Unsafe, "{name}");
    }
}

#[test]
fn duplicates_and_case_collisions_are_refused() {
    // The zip crate's reader would quietly keep one of these, so this needs its own directory reader.
    let mut duplicate = zip_of(VALID);
    duplicate.push(RawEntry::file("run.bat", b"different content"));
    assert_eq!(inspect_kind(&duplicate), ArchiveErrorKind::Unsafe);

    let mut collision = zip_of(VALID);
    collision.push(RawEntry::file("RUN.BAT", b"different content"));
    assert_eq!(inspect_kind(&collision), ArchiveErrorKind::Unsafe);

    let mut directory_collision = zip_of(VALID);
    directory_collision.push(RawEntry::directory("NESTED"));
    assert_eq!(inspect_kind(&directory_collision), ArchiveErrorKind::Unsafe);

    let mut sharp_s = zip_of(VALID);
    sharp_s.push(RawEntry::file("stra\u{df}e", b"x"));
    sharp_s.push(RawEntry::file("STRASSE", b"y"));
    assert_eq!(inspect_kind(&sharp_s), ArchiveErrorKind::Unsafe);
}

#[test]
fn links_and_special_entries_are_refused() {
    for (name, external, host) in [
        ("link", 0o120_777u32 << 16, 3u8),
        ("fifo", 0o010_644 << 16, 3),
        ("device", 0o020_644 << 16, 3),
        ("socket", 0o140_644 << 16, 3),
        ("junction", 0x0400, 0),
    ] {
        let mut entries = zip_of(VALID);
        let mut entry = RawEntry::file(name, b"C:\\Windows");
        entry.external = external;
        entry.host = host;
        entries.push(entry);
        assert_eq!(inspect_kind(&entries), ArchiveErrorKind::Unsafe, "{name}");
    }
}

#[test]
fn encryption_and_unknown_compression_are_refused() {
    let mut encrypted = zip_of(VALID);
    encrypted[0].flags |= 0x0001;
    assert_eq!(inspect_kind(&encrypted), ArchiveErrorKind::Unsafe);

    let mut unknown = zip_of(VALID);
    unknown[0].method = 12;
    assert_eq!(inspect_kind(&unknown), ArchiveErrorKind::Unsafe);
}

#[test]
fn a_missing_or_invalid_manifest_is_refused() {
    let without: Vec<RawEntry> = zip_of(VALID)
        .into_iter()
        .filter(|entry| entry.name != MANIFEST_ENTRY_NAME.as_bytes())
        .collect();
    assert_eq!(inspect_kind(&without), ArchiveErrorKind::ManifestInvalid);

    let replace = |bytes: &[u8]| -> Vec<RawEntry> {
        let mut entries = zip_of(VALID);
        entries.last_mut().unwrap().data = bytes.to_vec();
        entries
    };
    assert_eq!(
        inspect_kind(&replace(b"not json")),
        ArchiveErrorKind::ManifestInvalid
    );

    let mut wrong_version = manifest_for(VALID);
    wrong_version.manifest_version = 2;
    assert_eq!(
        inspect_kind(&replace(&wrong_version.canonical_bytes())),
        ArchiveErrorKind::ManifestInvalid
    );

    let mut other_vm = manifest_for(VALID);
    other_vm.vm_name = "Other".to_owned();
    assert_eq!(
        inspect_kind(&replace(&other_vm.canonical_bytes())),
        ArchiveErrorKind::ManifestInvalid
    );

    let mut other_emulator = manifest_for(VALID);
    other_emulator.emulator_type = EmulatorType::Box86;
    assert_eq!(
        inspect_kind(&replace(&other_emulator.canonical_bytes())),
        ArchiveErrorKind::ManifestInvalid
    );

    // Valid JSON that is not what a registration writes: order, spacing or extra fields.
    let mut pretty = serde_json::to_vec_pretty(&manifest_for(VALID)).unwrap();
    pretty.push(b'\n');
    assert_eq!(
        inspect_kind(&replace(&pretty)),
        ArchiveErrorKind::ManifestInvalid
    );

    let mut unordered = manifest_for(VALID);
    unordered.entries.reverse();
    assert_eq!(
        inspect_kind(&replace(&unordered.canonical_bytes())),
        ArchiveErrorKind::ManifestInvalid
    );

    let mut totals = manifest_for(VALID);
    totals.total_uncompressed_bytes += 1;
    assert_eq!(
        inspect_kind(&replace(&totals.canonical_bytes())),
        ArchiveErrorKind::ManifestInvalid
    );
}

#[test]
fn a_manifest_other_than_the_registered_one_is_refused() {
    let fixture = archive_with(&zip_of(VALID), false);
    let name = VmName::new("Win98").unwrap();
    let mut file = File::open(&fixture.archive).unwrap();
    let wrong = sha256(b"something else");
    let error = inspect_archive(
        &mut file,
        &ArchiveExpectation {
            emulator: EmulatorType::Qemu,
            vm_name: &name,
            manifest_sha256: Some(&wrong),
        },
        &ExtractionLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Integrity);
}

#[test]
fn entries_must_match_the_manifest_exactly() {
    let mut extra = zip_of(VALID);
    extra.push(RawEntry::file("unlisted.bin", b"x"));
    assert_eq!(inspect_kind(&extra), ArchiveErrorKind::ManifestInvalid);

    let missing: Vec<RawEntry> = zip_of(VALID)
        .into_iter()
        .filter(|entry| entry.name != b"disk.qcow2")
        .collect();
    assert_eq!(inspect_kind(&missing), ArchiveErrorKind::ManifestInvalid);
}

#[test]
fn a_wrong_file_hash_stops_extraction() {
    let mut entries = zip_of(VALID);
    // Same size, different bytes: only the hash can tell. The CRC is recomputed to be valid.
    let entry = entries
        .iter_mut()
        .find(|entry| entry.name == b"disk.qcow2")
        .unwrap();
    entry.data = b"DISK IMAGE BYTES".to_vec();
    let fixture = archive_with(&entries, false);
    assert_eq!(
        extract(&fixture, &ExtractionLimits::default()).unwrap_err(),
        ArchiveErrorKind::Integrity
    );
}

#[test]
fn a_file_claiming_to_be_smaller_than_it_is_never_gets_written_past_its_size() {
    let mut entries = zip_of(VALID);
    let entry = entries
        .iter_mut()
        .find(|entry| entry.name == b"disk.qcow2")
        .unwrap();
    entry.claimed_size = Some(4);
    assert_eq!(inspect_kind(&entries), ArchiveErrorKind::Integrity);
}

#[test]
fn excessive_sizes_and_counts_are_refused() {
    let fixture = archive_with(&zip_of(VALID), false);
    let name = VmName::new("Win98").unwrap();

    let mut file = File::open(&fixture.archive).unwrap();
    let total = ExtractionLimits {
        max_total_bytes: 8,
        ..ExtractionLimits::default()
    };
    assert_eq!(
        inspect_archive(&mut file, &expectation(&name), &total)
            .unwrap_err()
            .kind,
        ArchiveErrorKind::Limit
    );

    let per_file = ExtractionLimits {
        max_file_bytes: 8,
        ..ExtractionLimits::default()
    };
    assert_eq!(
        inspect_archive(&mut file, &expectation(&name), &per_file)
            .unwrap_err()
            .kind,
        ArchiveErrorKind::Limit
    );

    let count = ExtractionLimits {
        max_entries: 2,
        ..ExtractionLimits::default()
    };
    assert_eq!(
        inspect_archive(&mut file, &expectation(&name), &count)
            .unwrap_err()
            .kind,
        ArchiveErrorKind::Limit
    );
}

#[test]
fn malformed_zips_are_refused() {
    let directory = TempDir::new().unwrap();
    let name = VmName::new("Win98").unwrap();
    for (label, bytes) in [
        ("empty", Vec::new()),
        ("garbage", vec![0x41; 4096]),
        ("signature only", 0x0605_4b50u32.to_le_bytes().to_vec()),
    ] {
        let path = directory.path().join(format!("{label}.zip"));
        fs::write(&path, &bytes).unwrap();
        let mut file = File::open(&path).unwrap();
        let error = inspect_archive(&mut file, &expectation(&name), &ExtractionLimits::default())
            .unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::Integrity, "{label}");
    }

    // A real archive cut short has no directory left to read.
    let good = directory.path().join("good.zip");
    write_zip(&good, &zip_of(VALID), false);
    let bytes = fs::read(&good).unwrap();
    let cut = directory.path().join("cut.zip");
    fs::write(&cut, &bytes[..bytes.len() - 30]).unwrap();
    let mut file = File::open(&cut).unwrap();
    assert_eq!(
        inspect_archive(&mut file, &expectation(&name), &ExtractionLimits::default())
            .unwrap_err()
            .kind,
        ArchiveErrorKind::Integrity
    );

    // A directory claiming more entries than it can hold.
    let mut lying = bytes.clone();
    let end = lying.len() - 22;
    lying[end + 10] = 0xFE;
    lying[end + 11] = 0xFF;
    let path = directory.path().join("lying.zip");
    fs::write(&path, &lying).unwrap();
    let mut file = File::open(&path).unwrap();
    assert_eq!(
        inspect_archive(&mut file, &expectation(&name), &ExtractionLimits::default())
            .unwrap_err()
            .kind,
        ArchiveErrorKind::Integrity
    );
}

#[test]
fn cancellation_stops_extraction() {
    let fixture = archive_with(&zip_of(VALID), false);
    let name = VmName::new("Win98").unwrap();
    let limits = ExtractionLimits::default();
    let mut file = File::open(&fixture.archive).unwrap();
    let inspected = inspect_archive(&mut file, &expectation(&name), &limits).unwrap();
    let cancel = CancelFlag::new();
    cancel.cancel();
    let error = extract_archive(
        &mut file,
        &inspected,
        &fixture.directory.path().join("target"),
        &limits,
        &mut |_, _| {},
        &cancel,
    )
    .unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Cancelled);
}

#[test]
fn the_real_writer_and_this_reader_agree() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("Win98");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("run.bat"), b"@echo\n").unwrap();
    fs::write(root.join("disk.img"), vec![7u8; 300 * 1024]).unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::write(root.join("a/b/c.bin"), b"deep").unwrap();
    let name = VmName::new("Win98").unwrap();
    let staging = directory.path().join("staging");
    let built = build_archive(
        &BuildRequest {
            emulator: EmulatorType::Qemu,
            vm_name: &name,
            root: &root,
            staging_dir: &staging,
            operation_id: Uuid::new_v4(),
        },
        &mut |_| {},
        &CancelFlag::new(),
    )
    .unwrap();
    let limits = ExtractionLimits::default();
    let mut file = File::open(&built.path).unwrap();
    let inspected = inspect_archive(
        &mut file,
        &ArchiveExpectation {
            emulator: EmulatorType::Qemu,
            vm_name: &name,
            manifest_sha256: Some(&built.manifest_sha256),
        },
        &limits,
    )
    .unwrap();
    assert_eq!(inspected.manifest, built.manifest);
    let target = directory.path().join("out");
    extract_archive(
        &mut file,
        &inspected,
        &target,
        &limits,
        &mut |_, _| {},
        &CancelFlag::new(),
    )
    .unwrap();
    assert_eq!(
        fs::read(target.join("disk.img")).unwrap(),
        vec![7u8; 300 * 1024]
    );
    assert!(target.join("empty").is_dir());
}

// Local publication.

fn staged_fixture(base: &Path, operation_id: Uuid) -> PathBuf {
    let staged = staged_directory(base, operation_id);
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("run.bat"), b"x").unwrap();
    staged
}

#[test]
fn rename_no_replace_never_replaces() {
    let directory = TempDir::new().unwrap();
    let (from, to) = (directory.path().join("from"), directory.path().join("to"));
    fs::create_dir(&from).unwrap();
    fs::create_dir(&to).unwrap();
    fs::write(to.join("existing"), b"keep").unwrap();
    assert!(rename_no_replace(&from, &to).is_err());
    assert_eq!(fs::read(to.join("existing")).unwrap(), b"keep");

    // An empty directory counts too: `rename` alone could silently replace one of those.
    let empty = directory.path().join("empty");
    fs::create_dir(&empty).unwrap();
    assert!(rename_no_replace(&from, &empty).is_err());
    assert!(from.exists());

    let free = directory.path().join("free");
    rename_no_replace(&from, &free).unwrap();
    assert!(free.is_dir() && !from.exists());
}

#[test]
fn publication_moves_the_same_directory_into_place() {
    let base = TempDir::new().unwrap();
    let operation_id = Uuid::new_v4();
    let staged = staged_fixture(base.path(), operation_id);
    let name = VmName::new("Win98").unwrap();
    let identity = directory_identity(&staged).unwrap();
    let destination = publish_directory(&Publication {
        base_path: base.path(),
        base_identity: directory_identity(base.path()).unwrap(),
        vm_name: &name,
        staged: &staged,
        staged_identity: identity,
    })
    .unwrap();
    assert_eq!(destination, base.path().join("Win98"));
    assert_eq!(directory_identity(&destination).unwrap(), identity);
    assert!(!staged.exists());
}

#[test]
fn an_existing_destination_is_never_replaced_in_any_capitalization() {
    for existing in ["Win98", "WIN98", "win98"] {
        let base = TempDir::new().unwrap();
        let operation_id = Uuid::new_v4();
        let staged = staged_fixture(base.path(), operation_id);
        let holder = base.path().join(existing);
        fs::create_dir(&holder).unwrap();
        fs::write(holder.join("precious"), b"keep").unwrap();
        let name = VmName::new("Win98").unwrap();
        let error = publish_directory(&Publication {
            base_path: base.path(),
            base_identity: directory_identity(base.path()).unwrap(),
            vm_name: &name,
            staged: &staged,
            staged_identity: directory_identity(&staged).unwrap(),
        })
        .unwrap_err();
        assert_eq!(
            error.kind,
            ArchiveErrorKind::DestinationExists,
            "{existing}"
        );
        assert_eq!(fs::read(holder.join("precious")).unwrap(), b"keep");
        assert!(
            staged.exists(),
            "what was assembled is still there to clean up"
        );
    }
}

#[test]
fn a_substituted_directory_is_not_published() {
    let base = TempDir::new().unwrap();
    let operation_id = Uuid::new_v4();
    let staged = staged_fixture(base.path(), operation_id);
    let name = VmName::new("Win98").unwrap();
    let identity = directory_identity(&staged).unwrap();
    // Someone replaced it after it was verified. Keeping a reference stops the system reusing the ID.
    let moved_aside = base.path().join("moved-aside");
    fs::rename(&staged, &moved_aside).unwrap();
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("evil"), b"not what was verified").unwrap();
    let error = publish_directory(&Publication {
        base_path: base.path(),
        base_identity: directory_identity(base.path()).unwrap(),
        vm_name: &name,
        staged: &staged,
        staged_identity: identity,
    })
    .unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::DestinationUnsafe);
    assert!(!base.path().join("Win98").exists());
}

#[test]
fn a_replaced_base_path_stops_publication() {
    let parent = TempDir::new().unwrap();
    let base = parent.path().join("base");
    fs::create_dir(&base).unwrap();
    let identity = directory_identity(&base).unwrap();
    let operation_id = Uuid::new_v4();
    fs::rename(&base, parent.path().join("old")).unwrap();
    fs::create_dir(&base).unwrap();
    let staged = staged_fixture(&base, operation_id);
    let name = VmName::new("Win98").unwrap();
    let error = publish_directory(&Publication {
        base_path: &base,
        base_identity: identity,
        vm_name: &name,
        staged: &staged,
        staged_identity: directory_identity(&staged).unwrap(),
    })
    .unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::DestinationUnsafe);
}

// The cache.

#[test]
fn the_cache_evicts_the_least_recently_used_and_never_what_is_in_use() {
    let directory = TempDir::new().unwrap();
    let cache = ArchiveCache::open(directory.path().join("cache"), 2500);
    let digests: Vec<String> = (0..3).map(|n| sha256(&[n])).collect();
    let versions: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    let source = directory.path().join("source");
    let add = |index: usize| {
        fs::write(&source, vec![index as u8; 1000]).unwrap();
        cache.insert(
            versions[index],
            &digests[index],
            1000,
            &source,
            Uuid::new_v4(),
        )
    };
    let first = add(0);
    let second = add(1);
    assert_eq!(cache.usage().entries, 2);
    std::thread::sleep(Duration::from_millis(30));
    assert!(
        cache.find(versions[0], &digests[0]).is_some(),
        "the first is now the most recent"
    );

    // Room for the third has to come from somewhere, and the second was used longest ago.
    let third = add(2);
    assert!(third.starts_with(cache.directory()));
    assert!(first.exists());
    assert!(!second.exists());
    assert_eq!(
        cache.usage(),
        emucat_agent::archive_cache::CacheUsage {
            entries: 2,
            total_bytes: 2000,
        }
    );

    // Everything pinned, and nothing can be evicted for a new arrival, which simply is not cached.
    let _pins = [
        cache.pin(versions[0], &digests[0]),
        cache.pin(versions[2], &digests[2]),
    ];
    fs::write(&source, vec![9u8; 1000]).unwrap();
    let digest = sha256(b"new");
    let version = Uuid::new_v4();
    let kept = cache.insert(version, &digest, 1000, &source, Uuid::new_v4());
    assert_eq!(kept, source);
    assert!(source.exists());
    assert!(first.exists() && third.exists());
}

#[test]
fn the_cache_refuses_what_could_never_fit_and_can_be_turned_off() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("source");
    fs::write(&source, vec![1u8; 100]).unwrap();
    let small = ArchiveCache::open(directory.path().join("small"), 10);
    let digest = sha256(b"x");
    assert_eq!(
        small.insert(Uuid::new_v4(), &digest, 100, &source, Uuid::new_v4()),
        source
    );

    let off = ArchiveCache::open(directory.path().join("off"), 0);
    assert_eq!(
        off.insert(Uuid::new_v4(), &digest, 100, &source, Uuid::new_v4()),
        source
    );
    assert!(off.find(Uuid::new_v4(), &digest).is_none());
}

#[test]
fn opening_the_cache_clears_what_an_interrupted_write_left() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("cache");
    fs::create_dir(&path).unwrap();
    let digest = sha256(b"x");
    let version = Uuid::new_v4();
    let name = ArchiveCache::entry_name(version, &digest);
    let unfinished = path.join(format!("{name}.{}.part", Uuid::new_v4()));
    fs::write(&unfinished, b"half").unwrap();
    let cache = ArchiveCache::open(path, 1000);
    assert!(!unfinished.exists());
    assert!(
        cache.find(version, &digest).is_none(),
        "never exposed as an entry"
    );
}

// The workflow.

#[derive(Default)]
struct Store {
    objects: HashMap<String, Vec<u8>>,
    downloads: u32,
    failures: HashMap<&'static str, Vec<RepositoryError>>,
    hold_download: Option<Arc<tokio::sync::Notify>>,
    /// Damages what a download writes, as many times as this says.
    corrupt_downloads: u32,
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

    fn downloads(&self) -> u32 {
        self.store.lock().unwrap().downloads
    }

    fn hold_downloads(&self) -> Arc<tokio::sync::Notify> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.store.lock().unwrap().hold_download = Some(Arc::clone(&notify));
        notify
    }
}

impl ArchiveRepository for MemoryRepository {
    fn health_check<'a>(
        &'a self,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move {
            Ok(HealthReport {
                host_key_fingerprint: None,
                root_readable: true,
                root_writable: true,
                no_overwrite_publication: true,
                free_bytes: None,
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
            let store = self.store.lock().unwrap();
            Ok(store
                .objects
                .get(key.as_str())
                .map(|object| ObjectMetadata {
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
        _key: &'a RepositoryKey,
        _source: &'a Path,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move { panic!("a restore never uploads") }.boxed()
    }

    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move {
            let hold = self.store.lock().unwrap().hold_download.clone();
            if let Some(hold) = hold {
                tokio::select! {
                    () = hold.notified() => {}
                    () = cancel.cancelled() => return Err(RepositoryError::cancelled()),
                }
            }
            self.take_failure("download")?;
            let (mut data, corrupt) = {
                let mut store = self.store.lock().unwrap();
                store.downloads += 1;
                let corrupt = store.corrupt_downloads > 0;
                if corrupt {
                    store.corrupt_downloads -= 1;
                }
                (
                    store
                        .objects
                        .get(key.as_str())
                        .cloned()
                        .ok_or_else(|| RepositoryError::new(Kind::NotFound, "missing"))?,
                    corrupt,
                )
            };
            if corrupt {
                data[0] ^= 0xFF;
            }
            fs::write(destination, &data).unwrap();
            progress(data.len() as u64, data.len() as u64);
            Ok(VerifiedObject {
                size_bytes: data.len() as u64,
                sha256: sha256(&data),
            })
        }
        .boxed()
    }

    fn verify<'a>(
        &'a self,
        _key: &'a RepositoryKey,
        _size: u64,
        _sha256: &'a str,
        _progress: ProgressFn,
        _cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { panic!("a restore verifies what it downloaded, locally") }.boxed()
    }

    fn publish<'a>(
        &'a self,
        _staging: &'a RepositoryKey,
        _final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { panic!("a restore never publishes to the repository") }.boxed()
    }

    fn delete<'a>(&'a self, _key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move { panic!("a restore never deletes from the repository") }.boxed()
    }
}

struct Provider {
    repository: MemoryRepository,
    attempts: u32,
}

impl RepositoryProvider for Provider {
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        if repository_id == REPOSITORY {
            Ok(Arc::new(self.repository.clone()))
        } else {
            Err(RepositoryError::new(Kind::NotConfigured, "not configured"))
        }
    }

    fn summary(&self, _repository_id: Uuid) -> Option<RepositoryConfigSummary> {
        None
    }

    fn upload_attempts(&self, _repository_id: Uuid) -> u32 {
        self.attempts
    }

    fn repository_ids(&self) -> Vec<Uuid> {
        vec![REPOSITORY]
    }
}

struct Harness {
    _directory: TempDir,
    base: PathBuf,
    source: PathBuf,
    state: PathBuf,
    staging: PathBuf,
    cache: PathBuf,
    repository: MemoryRepository,
    attempts: u32,
    limits: ExtractionLimits,
    cache_max_bytes: u64,
    archive: Vec<u8>,
    manifest: Manifest,
    manifest_sha256: String,
    version: Uuid,
    vm_name: VmName,
}

impl Harness {
    /// Builds a real master with the real writer, and puts it in the repository.
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let (base, source, state, staging, cache) = (
            directory.path().join("base"),
            directory.path().join("source"),
            directory.path().join("state"),
            directory.path().join("staging"),
            directory.path().join("cache"),
        );
        for path in [&base, &source, &state] {
            fs::create_dir(path).unwrap();
        }
        let vm_name = VmName::new("Win98").unwrap();
        let root = source.join("Win98");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("run.bat"), b"@echo never run\n").unwrap();
        fs::write(root.join("disk.qcow2"), vec![9u8; 200 * 1024]).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/c.bin"), b"deep").unwrap();
        let built = build_archive(
            &BuildRequest {
                emulator: EmulatorType::Qemu,
                vm_name: &vm_name,
                root: &root,
                staging_dir: &directory.path().join("build"),
                operation_id: Uuid::new_v4(),
            },
            &mut |_| {},
            &CancelFlag::new(),
        )
        .unwrap();
        let archive = fs::read(&built.path).unwrap();
        let version = Uuid::new_v4();
        let repository = MemoryRepository::default();
        repository
            .store
            .lock()
            .unwrap()
            .objects
            .insert(archive_key(&vm_name, version), archive.clone());
        Self {
            _directory: directory,
            base,
            source,
            state,
            staging,
            cache,
            repository,
            attempts: 2,
            limits: ExtractionLimits::default(),
            cache_max_bytes: 1024 * 1024 * 1024,
            archive,
            manifest: built.manifest,
            manifest_sha256: built.manifest_sha256,
            version,
            vm_name,
        }
    }

    fn operations(&self) -> Arc<AgentOperations> {
        let emulators: BTreeMap<EmulatorType, EmulatorConfig> = [(
            EmulatorType::Qemu,
            EmulatorConfig {
                base_path: self.base.clone(),
                executable: PathBuf::from("unused"),
            },
        )]
        .into();
        AgentOperations::load(OperationsConfig {
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
            media: None,
            restore: RestoreSettings {
                cache_dir: self.cache.clone(),
                cache_max_bytes: self.cache_max_bytes,
                limits: self.limits,
            },
        })
        .unwrap()
    }

    fn request(&self) -> RestoreRequest {
        RestoreRequest {
            operation_id: Uuid::new_v4(),
            emulator_type: EmulatorType::Qemu,
            vm_name: self.vm_name.clone(),
            repository_id: REPOSITORY,
            version_id: self.version,
            archive_key: archive_key(&self.vm_name, self.version),
            archive_size_bytes: self.archive.len() as u64,
            archive_sha256: sha256(&self.archive),
            manifest_sha256: Some(self.manifest_sha256.clone()),
            expected_uncompressed_bytes: Some(self.manifest.total_uncompressed_bytes),
        }
    }

    fn destination(&self) -> PathBuf {
        self.base.join("Win98")
    }

    fn assert_nothing_left_behind(&self) {
        let leftovers: Vec<_> = fs::read_dir(&self.base)
            .unwrap()
            .flatten()
            .map(|item| item.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".emucat-"))
            .collect();
        assert!(leftovers.is_empty(), "left in the base path: {leftovers:?}");
        if self.staging.exists() {
            let staged = fs::read_dir(&self.staging).unwrap().count();
            assert_eq!(staged, 0, "left in the staging directory");
        }
    }

    fn assert_matches_source(&self) {
        let original = self.source.join("Win98");
        let restored = self.destination();
        assert_eq!(
            fs::read(restored.join("run.bat")).unwrap(),
            fs::read(original.join("run.bat")).unwrap()
        );
        assert_eq!(
            fs::read(restored.join("disk.qcow2")).unwrap(),
            fs::read(original.join("disk.qcow2")).unwrap()
        );
        assert_eq!(fs::read(restored.join("a/b/c.bin")).unwrap(), b"deep");
        assert!(restored.join("empty").is_dir());
    }

    fn write_journal(&self, value: &serde_json::Value) {
        let directory = self.state.join("restores");
        fs::create_dir_all(&directory).unwrap();
        let id = value["request"]["operationId"].as_str().unwrap();
        fs::write(
            directory.join(format!("{id}.journal")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

fn archive_key(vm_name: &VmName, version: Uuid) -> String {
    RepositoryKey::for_version(
        &VmIdentity {
            emulator_type: EmulatorType::Qemu,
            vm_name: vm_name.clone(),
        },
        VersionId(version),
    )
    .as_str()
    .to_owned()
}

async fn next_message(operations: &AgentOperations, wanted: impl Fn(&Message) -> bool) -> Message {
    let mut outbound = operations.outbound().await;
    tokio::time::timeout(FOREVER, async {
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

async fn outcome(operations: &AgentOperations) -> Result<RestoreResult, (String, String)> {
    let message = next_message(operations, |message| {
        matches!(
            message,
            Message::AgentRestoreResult(_) | Message::AgentRestoreError(_)
        )
    })
    .await;
    match message {
        Message::AgentRestoreResult(result) => Ok(result),
        Message::AgentRestoreError(error) => Err((error.code, error.message)),
        _ => unreachable!(),
    }
}

fn start(operations: &AgentOperations, request: &RestoreRequest) {
    operations.handle(Message::ServerRestoreRequest(request.clone()));
}

fn close(operations: &AgentOperations, operation_id: Uuid) {
    operations.handle(Message::ServerRestoreAck(RestoreAck {
        operation_id,
        outcome: RestoreAckOutcome::Closed,
    }));
}

#[tokio::test]
async fn a_valid_master_restores_and_matches_what_was_archived() {
    let harness = Harness::new();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    let result = outcome(&operations).await.expect("the restore succeeds");

    harness.assert_matches_source();
    harness.assert_nothing_left_behind();
    assert_eq!(result.version_id, harness.version);
    assert_eq!(result.archive_sha256, request.archive_sha256);
    assert_eq!(result.manifest_sha256, harness.manifest_sha256);
    assert_eq!(result.file_count, 3);
    assert_eq!(
        result.local_directory,
        harness.destination().to_string_lossy()
    );
    assert!(!result.cache.hit);
    assert_eq!(result.cache.downloaded_bytes, harness.archive.len() as u64);
    assert!(result.cache.archive_cached);
    assert_eq!(result.cache.total_bytes, harness.archive.len() as u64);

    let state = read_local_state(&harness.state, EmulatorType::Qemu, &harness.vm_name).unwrap();
    assert_eq!(
        state.local_source_version_id,
        Some(VersionId(harness.version))
    );
    assert_eq!(
        state.last_verified_sha256.as_deref(),
        Some(harness.manifest_sha256.as_str())
    );
}

#[tokio::test]
async fn progress_goes_through_every_stage_with_real_numbers() {
    let harness = Harness::new();
    let operations = harness.operations();
    start(&operations, &harness.request());
    let mut stages = Vec::new();
    let mut downloaded = None;
    {
        let mut outbound = operations.outbound().await;
        loop {
            let message = tokio::time::timeout(FOREVER, outbound.recv())
                .await
                .unwrap()
                .unwrap();
            match message {
                Message::AgentRestoreProgress(progress) => {
                    if stages.last() != Some(&progress.stage) {
                        stages.push(progress.stage);
                    }
                    if progress.stage == RestoreStage::Downloading && progress.done_bytes.is_some()
                    {
                        downloaded = progress.done_bytes;
                        assert_eq!(progress.total_bytes, Some(harness.archive.len() as u64));
                        assert_eq!(progress.cache_hit, Some(false));
                    }
                }
                Message::AgentRestoreResult(_) => break,
                other => panic!("unexpected: {other:?}"),
            }
        }
    }
    assert_eq!(
        stages,
        [
            RestoreStage::Validating,
            RestoreStage::Downloading,
            RestoreStage::Verifying,
            RestoreStage::Extracting,
            RestoreStage::PublishingLocal,
        ]
    );
    assert_eq!(downloaded, Some(harness.archive.len() as u64));
}

#[tokio::test]
async fn a_second_restore_uses_the_cache_and_transfers_nothing() {
    let harness = Harness::new();
    let operations = harness.operations();
    let first = harness.request();
    start(&operations, &first);
    outcome(&operations).await.unwrap();
    close(&operations, first.operation_id);
    assert_eq!(harness.repository.downloads(), 1);

    fs::remove_dir_all(harness.destination()).unwrap();
    let second = harness.request();
    start(&operations, &second);
    let result = outcome(&operations).await.unwrap();
    assert!(result.cache.hit);
    assert_eq!(result.cache.downloaded_bytes, 0);
    assert_eq!(harness.repository.downloads(), 1);
    harness.assert_matches_source();
}

#[tokio::test]
async fn a_corrupted_cache_entry_is_discarded_and_downloaded_again() {
    let harness = Harness::new();
    let operations = harness.operations();
    let first = harness.request();
    start(&operations, &first);
    outcome(&operations).await.unwrap();
    close(&operations, first.operation_id);

    // Same size, one byte different. Only the hash can tell.
    let entry = harness.cache.join(ArchiveCache::entry_name(
        harness.version,
        &first.archive_sha256,
    ));
    let mut bytes = fs::read(&entry).unwrap();
    bytes[10] ^= 0x01;
    fs::write(&entry, &bytes).unwrap();

    fs::remove_dir_all(harness.destination()).unwrap();
    let second = harness.request();
    start(&operations, &second);
    let result = outcome(&operations).await.unwrap();
    assert!(!result.cache.hit, "a bad copy is not a hit");
    assert_eq!(harness.repository.downloads(), 2);
    harness.assert_matches_source();
    assert_eq!(
        fs::read(&entry).unwrap(),
        harness.archive,
        "and it is replaced by a good one"
    );
}

#[tokio::test]
async fn a_truncated_cache_entry_is_discarded() {
    let harness = Harness::new();
    fs::create_dir_all(&harness.cache).unwrap();
    let request = harness.request();
    let entry = harness.cache.join(ArchiveCache::entry_name(
        harness.version,
        &request.archive_sha256,
    ));
    fs::write(&entry, &harness.archive[..100]).unwrap();
    let operations = harness.operations();
    start(&operations, &request);
    let result = outcome(&operations).await.unwrap();
    assert!(!result.cache.hit);
    harness.assert_matches_source();
}

#[tokio::test]
async fn restoring_works_with_the_cache_turned_off() {
    let mut harness = Harness::new();
    harness.cache_max_bytes = 0;
    let operations = harness.operations();
    start(&operations, &harness.request());
    let result = outcome(&operations).await.unwrap();
    assert!(!result.cache.archive_cached);
    harness.assert_matches_source();
    harness.assert_nothing_left_behind();
    assert!(!harness.cache.exists());
}

#[tokio::test]
async fn the_wrong_archive_hash_fails_and_changes_nothing() {
    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.archive_sha256 = sha256(b"something else");
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "hash_mismatch");
    assert!(!harness.destination().exists());
    harness.assert_nothing_left_behind();
}

#[tokio::test]
async fn a_damaged_download_is_tried_again() {
    let harness = Harness::new();
    harness.repository.store.lock().unwrap().corrupt_downloads = 1;
    let operations = harness.operations();
    start(&operations, &harness.request());
    outcome(&operations)
        .await
        .expect("the second attempt is good");
    assert_eq!(harness.repository.downloads(), 2);
    harness.assert_matches_source();
}

#[tokio::test]
async fn a_download_that_stays_damaged_fails() {
    let harness = Harness::new();
    harness.repository.store.lock().unwrap().corrupt_downloads = 5;
    let operations = harness.operations();
    start(&operations, &harness.request());
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "hash_mismatch");
    assert!(!harness.destination().exists());
    harness.assert_nothing_left_behind();
}

#[tokio::test]
async fn an_object_of_the_wrong_size_is_not_even_downloaded() {
    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.archive_size_bytes += 1;
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "restore_integrity_failed");
    assert_eq!(harness.repository.downloads(), 0);
}

#[tokio::test]
async fn a_hostile_archive_with_the_right_hash_is_still_refused() {
    let harness = Harness::new();
    // The hash in the request matches these bytes. That says nothing about what they try to do.
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("evil.zip");
    let mut entries = zip_of(&[("run.bat", Some(b"x"))]);
    entries.insert(0, RawEntry::file("../../escape.txt", b"evil"));
    write_zip(&path, &entries, false);
    let evil = fs::read(&path).unwrap();
    harness
        .repository
        .store
        .lock()
        .unwrap()
        .objects
        .insert(archive_key(&harness.vm_name, harness.version), evil.clone());

    let operations = harness.operations();
    let mut request = harness.request();
    request.archive_size_bytes = evil.len() as u64;
    request.archive_sha256 = sha256(&evil);
    request.manifest_sha256 = None;
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "restore_unsafe_archive");
    assert!(!harness.destination().exists());
    assert!(!harness.base.parent().unwrap().join("escape.txt").exists());
    harness.assert_nothing_left_behind();
}

#[tokio::test]
async fn an_existing_directory_is_never_overwritten() {
    for existing in ["Win98", "WIN98"] {
        let harness = Harness::new();
        let holder = harness.base.join(existing);
        fs::create_dir(&holder).unwrap();
        fs::write(holder.join("precious.txt"), b"keep").unwrap();
        let operations = harness.operations();
        start(&operations, &harness.request());
        let (code, _) = outcome(&operations).await.unwrap_err();
        assert_eq!(code, "restore_destination_exists", "{existing}");
        assert_eq!(fs::read(holder.join("precious.txt")).unwrap(), b"keep");
        assert_eq!(
            harness.repository.downloads(),
            0,
            "refused before anything was transferred"
        );
        harness.assert_nothing_left_behind();
    }
}

#[tokio::test]
async fn a_key_that_does_not_belong_to_the_vm_is_refused() {
    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.archive_key = "archives/qemu/other/00000000-0000-4000-8000-000000000000.zip".to_owned();
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "invalid_request");
    assert_eq!(harness.repository.downloads(), 0);
}

#[tokio::test]
async fn an_unconfigured_repository_or_emulator_is_refused() {
    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.repository_id = Uuid::from_u128(0x8888);
    start(&operations, &request);
    assert_eq!(
        outcome(&operations).await.unwrap_err().0,
        "repository_not_configured"
    );

    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.emulator_type = EmulatorType::Box86;
    request.archive_key = RepositoryKey::for_version(
        &VmIdentity {
            emulator_type: EmulatorType::Box86,
            vm_name: harness.vm_name.clone(),
        },
        VersionId(harness.version),
    )
    .as_str()
    .to_owned();
    start(&operations, &request);
    assert_eq!(
        outcome(&operations).await.unwrap_err().0,
        "restore_emulator_not_configured"
    );
}

#[tokio::test]
async fn repository_failures_keep_their_codes() {
    for (kind, code, retried) in [
        (
            Kind::AuthenticationFailed,
            "ssh_authentication_failed",
            false,
        ),
        (Kind::HostKeyChanged, "host_key_changed", false),
        (Kind::HostKeyUnknown, "host_key_unknown", false),
        (
            Kind::PermissionDenied,
            "repository_permission_denied",
            false,
        ),
        (Kind::Unreachable, "repository_unreachable", true),
    ] {
        let harness = Harness::new();
        harness
            .repository
            .fail("download", RepositoryError::new(kind, "no"));
        if retried {
            harness
                .repository
                .fail("download", RepositoryError::new(kind, "no"));
        }
        let operations = harness.operations();
        start(&operations, &harness.request());
        assert_eq!(outcome(&operations).await.unwrap_err().0, code);
        assert!(!harness.destination().exists());
        harness.assert_nothing_left_behind();
    }
}

#[tokio::test]
async fn a_passing_repository_failure_is_tried_again() {
    let harness = Harness::new();
    harness.repository.fail(
        "download",
        RepositoryError::new(Kind::Interrupted, "connection lost"),
    );
    let operations = harness.operations();
    start(&operations, &harness.request());
    outcome(&operations)
        .await
        .expect("the second attempt works");
    harness.assert_matches_source();
}

#[tokio::test]
async fn cancellation_during_the_download_leaves_nothing() {
    let harness = Harness::new();
    let hold = harness.repository.hold_downloads();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    next_message(&operations, |message| {
        matches!(
            message,
            Message::AgentRestoreProgress(progress) if progress.stage == RestoreStage::Downloading
        )
    })
    .await;
    operations.handle(Message::ServerRestoreCancel(RestoreCancel {
        operation_id: request.operation_id,
    }));
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "cancelled");
    drop(hold);
    assert!(!harness.destination().exists());
    harness.assert_nothing_left_behind();
}

#[tokio::test]
async fn only_one_operation_runs_at_a_time() {
    let harness = Harness::new();
    let hold = harness.repository.hold_downloads();
    let operations = harness.operations();
    let first = harness.request();
    start(&operations, &first);
    next_message(&operations, |message| {
        matches!(
            message,
            Message::AgentRestoreProgress(progress) if progress.stage == RestoreStage::Downloading
        )
    })
    .await;
    let second = harness.request();
    start(&operations, &second);
    let refusal = next_message(&operations, |message| {
        matches!(message, Message::AgentRestoreError(error) if error.operation_id == second.operation_id)
    })
    .await;
    let Message::AgentRestoreError(refusal) = refusal else {
        unreachable!()
    };
    assert_eq!(refusal.code, "agent_busy");
    hold.notify_one();
    outcome(&operations)
        .await
        .expect("the first one is unaffected");
    harness.assert_matches_source();
}

#[tokio::test]
async fn a_repeated_request_does_not_start_a_second_restore() {
    let harness = Harness::new();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    outcome(&operations).await.unwrap();
    start(&operations, &request);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.repository.downloads(), 1);
    assert_eq!(operations.open_restores(), [request.operation_id]);
}

#[tokio::test]
async fn results_repeat_until_answered_and_an_answer_keeps_the_directory() {
    let harness = Harness::new();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    outcome(&operations).await.unwrap();

    // A lost acknowledgement: the report is still pending, on every heartbeat.
    for _ in 0..2 {
        let pending = operations.pending_reports();
        assert!(
            pending
                .iter()
                .any(|message| matches!(message, Message::AgentRestoreResult(_))),
            "{pending:?}"
        );
    }
    close(&operations, request.operation_id);
    assert!(operations.pending_reports().is_empty());
    assert!(operations.open_restores().is_empty());
    harness.assert_matches_source();

    // A server that does not recognize the operation is no reason to delete a verified VM.
    fs::remove_dir_all(harness.destination()).unwrap();
    let second = harness.request();
    start(&operations, &second);
    outcome(&operations).await.unwrap();
    operations.handle(Message::ServerRestoreAck(RestoreAck {
        operation_id: second.operation_id,
        outcome: RestoreAckOutcome::Rejected,
    }));
    assert!(operations.open_restores().is_empty());
    harness.assert_matches_source();
}

#[tokio::test]
async fn an_agent_restart_during_the_download_reports_and_cleans_up() {
    let harness = Harness::new();
    let hold = harness.repository.hold_downloads();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    next_message(&operations, |message| {
        matches!(
            message,
            Message::AgentRestoreProgress(progress) if progress.stage == RestoreStage::Downloading
        )
    })
    .await;
    // What a stop looks like: running work ends, and leaves things as a crash would.
    operations.shutdown();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(operations);
    drop(hold);
    fs::create_dir_all(&harness.staging).unwrap();
    fs::write(
        harness
            .staging
            .join(format!("restore-{}.1.zip.part", request.operation_id)),
        b"partial",
    )
    .unwrap();

    let restarted = harness.operations();
    let pending = restarted.pending_reports();
    assert!(
        pending.iter().any(|message| matches!(
            message,
            Message::AgentRestoreError(error)
                if error.operation_id == request.operation_id && error.code == "agent_restarted"
        )),
        "{pending:?}"
    );
    assert!(!harness.destination().exists());
    harness.assert_nothing_left_behind();

    close(&restarted, request.operation_id);
    assert!(restarted.open_restores().is_empty());
}

#[tokio::test]
async fn an_interrupted_extraction_is_cleaned_up_after_a_restart() {
    let harness = Harness::new();
    let request = harness.request();
    let staged = staged_directory(&harness.base, request.operation_id);
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("run.bat"), b"half").unwrap();
    harness.write_journal(&serde_json::json!({
        "request": request,
        "phase": "running",
        "stagedIdentity": null,
        "result": null,
        "report": null,
    }));
    let operations = harness.operations();
    assert!(!staged.exists());
    assert!(!harness.destination().exists());
    assert!(matches!(
        operations.pending_reports().as_slice(),
        [Message::AgentRestoreError(error)] if error.code == "agent_restarted"
    ));
}

fn publishing_journal(
    harness: &Harness,
    request: &RestoreRequest,
    identity: emucat_agent::packaging::DirectoryIdentity,
) -> serde_json::Value {
    serde_json::json!({
        "request": request,
        "phase": "publishing",
        "stagedIdentity": identity,
        "result": RestoreResult {
            operation_id: request.operation_id,
            version_id: request.version_id,
            archive_size_bytes: request.archive_size_bytes,
            archive_sha256: request.archive_sha256.clone(),
            manifest_version: 1,
            manifest_sha256: harness.manifest_sha256.clone(),
            file_count: 3,
            total_uncompressed_bytes: harness.manifest.total_uncompressed_bytes,
            local_directory: harness.destination().to_string_lossy().into_owned(),
            cache: emucat_agent::protocol::RestoreCache {
                hit: false,
                downloaded_bytes: 1,
                archive_cached: true,
                total_bytes: 1,
            },
        },
        "report": null,
    })
}

#[tokio::test]
async fn a_crash_after_the_rename_is_recognized_as_published() {
    let harness = Harness::new();
    let request = harness.request();
    let destination = harness.destination();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("run.bat"), b"x").unwrap();
    let identity = directory_identity(&destination).unwrap();
    harness.write_journal(&publishing_journal(&harness, &request, identity));
    let operations = harness.operations();
    assert!(matches!(
        operations.pending_reports().as_slice(),
        [Message::AgentRestoreResult(result)] if result.operation_id == request.operation_id
    ));
    assert!(destination.join("run.bat").exists());
}

#[tokio::test]
async fn a_crash_before_the_rename_is_recognized_as_not_published() {
    let harness = Harness::new();
    let request = harness.request();
    let staged = staged_directory(&harness.base, request.operation_id);
    fs::create_dir(&staged).unwrap();
    let identity = directory_identity(&staged).unwrap();
    harness.write_journal(&publishing_journal(&harness, &request, identity));
    let operations = harness.operations();
    assert!(matches!(
        operations.pending_reports().as_slice(),
        [Message::AgentRestoreError(error)] if error.code == "agent_restarted"
    ));
    assert!(!staged.exists());
    assert!(!harness.destination().exists());
}

#[tokio::test]
async fn a_directory_that_is_not_this_restores_is_never_touched_after_a_crash() {
    let harness = Harness::new();
    let request = harness.request();
    let staged = staged_directory(&harness.base, request.operation_id);
    fs::create_dir(&staged).unwrap();
    let identity = directory_identity(&staged).unwrap();
    fs::remove_dir(&staged).unwrap();

    // Somebody else's directory took the final name.
    let destination = harness.destination();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("precious"), b"keep").unwrap();
    harness.write_journal(&publishing_journal(&harness, &request, identity));
    let operations = harness.operations();
    assert!(matches!(
        operations.pending_reports().as_slice(),
        [Message::AgentRestoreError(error)] if error.code == "restore_destination_exists"
    ));
    assert_eq!(fs::read(destination.join("precious")).unwrap(), b"keep");
}

#[tokio::test]
async fn a_staged_directory_that_was_replaced_is_left_alone_as_ambiguous() {
    let harness = Harness::new();
    let request = harness.request();
    let staged = staged_directory(&harness.base, request.operation_id);
    fs::create_dir(&staged).unwrap();
    let identity = directory_identity(&staged).unwrap();
    fs::rename(&staged, harness.base.join("moved")).unwrap();
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("unknown"), b"whose is this").unwrap();
    harness.write_journal(&publishing_journal(&harness, &request, identity));
    let operations = harness.operations();
    assert!(matches!(
        operations.pending_reports().as_slice(),
        [Message::AgentRestoreError(error)] if error.code == "restore_ambiguous_directory"
    ));
    assert_eq!(fs::read(staged.join("unknown")).unwrap(), b"whose is this");
}

#[tokio::test]
async fn too_little_disk_space_is_refused_before_transferring() {
    if emucat_agent::packaging::available_disk_bytes(std::env::temp_dir().as_path()).is_none() {
        return;
    }
    let harness = Harness::new();
    let operations = harness.operations();
    let mut request = harness.request();
    request.expected_uncompressed_bytes = Some(1 << 52);
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "restore_insufficient_space");
    assert_eq!(harness.repository.downloads(), 0);
}

#[tokio::test]
async fn configured_limits_stop_an_archive_that_is_too_large() {
    let mut harness = Harness::new();
    harness.limits.max_total_bytes = 1024;
    let operations = harness.operations();
    start(&operations, &harness.request());
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "restore_limit_exceeded");
    assert!(!harness.destination().exists());
    harness.assert_nothing_left_behind();
}

fn sync_of(operations: &AgentOperations) -> emucat_agent::protocol::RestoreSync {
    operations
        .sync_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::AgentRestoreSync(sync) => Some(sync),
            _ => None,
        })
        .expect("a sync always says what it can restore")
}

#[tokio::test]
async fn a_new_connection_hears_what_this_agent_can_restore() {
    let harness = Harness::new();
    let operations = harness.operations();
    let sync = sync_of(&operations);
    assert_eq!(sync.capabilities.repository_ids, [REPOSITORY]);
    assert_eq!(sync.capabilities.emulators.len(), 1);
    assert_eq!(
        sync.capabilities.emulators[0].emulator_type,
        EmulatorType::Qemu
    );
    assert_eq!(
        sync.capabilities.emulators[0].base_path,
        harness.base.to_string_lossy()
    );
    assert!(sync.operations.is_empty());
    assert!(sync.local_copies.is_empty());
}

#[tokio::test]
async fn local_copies_are_reported_without_ever_claiming_to_be_verified() {
    let harness = Harness::new();
    let operations = harness.operations();
    let request = harness.request();
    start(&operations, &request);
    outcome(&operations).await.unwrap();
    close(&operations, request.operation_id);

    let status = |operations: &AgentOperations| {
        let copies = sync_of(operations).local_copies;
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].version_id, harness.version);
        copies[0].status
    };
    assert_eq!(status(&operations), LocalCopyCondition::Unverified);

    // Same names and sizes: no evidence of a change, and no proof of its absence either.
    let disk = harness.destination().join("disk.qcow2");
    let size = fs::metadata(&disk).unwrap().len() as usize;
    fs::write(&disk, vec![1u8; size]).unwrap();
    assert_eq!(status(&operations), LocalCopyCondition::Unverified);

    // A different size is proof.
    fs::OpenOptions::new()
        .append(true)
        .open(&disk)
        .unwrap()
        .write_all(b"more")
        .unwrap();
    assert_eq!(status(&operations), LocalCopyCondition::Modified);

    fs::remove_dir_all(harness.destination()).unwrap();
    assert_eq!(status(&operations), LocalCopyCondition::Absent);
}

#[test]
fn messages_refuse_unknown_fields_and_paths() {
    // A server cannot tell the agent where to put something, because there is nowhere to say it.
    let value = serde_json::json!({
        "operationId": Uuid::new_v4(),
        "emulatorType": "qemu",
        "vmName": "Win98",
        "repositoryId": REPOSITORY,
        "versionId": Uuid::new_v4(),
        "archiveKey": "archives/qemu/win98/x.zip",
        "archiveSizeBytes": 1,
        "archiveSha256": sha256(b"x"),
        "manifestSha256": null,
        "expectedUncompressedBytes": null,
        "destination": "C:\\Windows",
    });
    assert!(serde_json::from_value::<RestoreRequest>(value).is_err());

    let hostile_name = serde_json::json!({
        "operationId": Uuid::new_v4(),
        "emulatorType": "qemu",
        "vmName": "..\\..\\Windows",
        "repositoryId": REPOSITORY,
        "versionId": Uuid::new_v4(),
        "archiveKey": "archives/qemu/win98/x.zip",
        "archiveSizeBytes": 1,
        "archiveSha256": sha256(b"x"),
        "manifestSha256": null,
        "expectedUncompressedBytes": null,
    });
    assert!(serde_json::from_value::<RestoreRequest>(hostile_name).is_err());
}

#[test]
#[ignore = "writes more than 4 GiB. Run by pnpm test:sftp"]
fn a_real_zip64_archive_of_more_than_4_gib_restores() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("Win98");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("run.bat"), b"@echo\n").unwrap();
    {
        // Stored, not deflated, so that the archive itself is past the limit too.
        let mut disk = File::create(root.join("disk.qcow2")).unwrap();
        let block = vec![0x5Au8; 16 * 1024 * 1024];
        let mut written = 0u64;
        while written < 4 * 1024 * 1024 * 1024 + 64 * 1024 * 1024 {
            disk.write_all(&block).unwrap();
            written += block.len() as u64;
        }
    }
    let name = VmName::new("Win98").unwrap();
    let built = build_archive(
        &BuildRequest {
            emulator: EmulatorType::Qemu,
            vm_name: &name,
            root: &root,
            staging_dir: &directory.path().join("staging"),
            operation_id: Uuid::new_v4(),
        },
        &mut |_| {},
        &CancelFlag::new(),
    )
    .unwrap();
    assert!(built.size_bytes > 4 * 1024 * 1024 * 1024);

    let limits = ExtractionLimits::default();
    let mut file = File::open(&built.path).unwrap();
    let inspected = inspect_archive(
        &mut file,
        &ArchiveExpectation {
            emulator: EmulatorType::Qemu,
            vm_name: &name,
            manifest_sha256: Some(&built.manifest_sha256),
        },
        &limits,
    )
    .unwrap();
    let target = directory.path().join("target");
    extract_archive(
        &mut file,
        &inspected,
        &target,
        &limits,
        &mut |_, _| {},
        &CancelFlag::new(),
    )
    .unwrap();
    assert_eq!(
        fs::metadata(target.join("disk.qcow2")).unwrap().len(),
        fs::metadata(root.join("disk.qcow2")).unwrap().len()
    );
}

// Verifying a local copy, which shares the restore's verified path to a master's manifest.

impl Harness {
    fn verify_request(&self) -> VmVerifyRequest {
        VmVerifyRequest {
            operation_id: Uuid::new_v4(),
            emulator_type: EmulatorType::Qemu,
            vm_name: self.vm_name.clone(),
            version_id: self.version,
            repository_id: REPOSITORY,
            archive_key: archive_key(&self.vm_name, self.version),
            archive_size_bytes: self.archive.len() as u64,
            archive_sha256: sha256(&self.archive),
            manifest_sha256: Some(self.manifest_sha256.clone()),
        }
    }

    /// A session an earlier run left without a process: whether it runs cannot be told, so the VM is
    /// treated as running. It stands in for a running emulator without starting one.
    fn leave_unknown_session(&self) -> Uuid {
        let session = Uuid::new_v4();
        let directory = self.state.join("executions");
        fs::create_dir_all(&directory).unwrap();
        let journal = serde_json::json!({
            "request": {
                "sessionId": session,
                "emulatorType": "qemu",
                "vmName": self.vm_name.as_str(),
                "mode": "local",
                "versionId": null,
            },
            "state": "starting",
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
}

async fn verified(operations: &AgentOperations, operation_id: Uuid) -> VmVerifyResult {
    let message = next_message(operations, |message| {
        matches!(message, Message::AgentVmVerifyResult(result) if result.operation_id == operation_id)
    })
    .await;
    match message {
        Message::AgentVmVerifyResult(result) => result,
        _ => unreachable!(),
    }
}

fn verify(operations: &AgentOperations, request: &VmVerifyRequest) {
    operations.handle(Message::ServerVmVerify(request.clone()));
}

#[tokio::test]
async fn a_restored_copy_verifies_from_its_own_manifest_and_a_change_is_found() {
    let harness = Harness::new();
    let operations = harness.operations();
    let restore = harness.request();
    start(&operations, &restore);
    outcome(&operations).await.unwrap();
    close(&operations, restore.operation_id);
    let downloads = harness.repository.downloads();

    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Verified, "{result:?}");
    assert_eq!(result.manifest_source.as_deref(), Some("local"));
    assert_eq!(
        result.manifest_sha256.as_deref(),
        Some(harness.manifest_sha256.as_str())
    );
    assert_eq!(result.files_verified, 3);
    assert_eq!(
        result.bytes_hashed,
        harness.manifest.total_uncompressed_bytes
    );
    // Nothing was downloaded or uploaded for it.
    assert_eq!(harness.repository.downloads(), downloads);

    fs::write(harness.destination().join("a/b/c.bin"), b"DEEP").unwrap();
    fs::write(harness.destination().join("new.txt"), b"x").unwrap();
    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Modified);
    assert_eq!(result.modified.paths, vec!["a/b/c.bin".to_owned()]);
    assert_eq!(result.unexpected.paths, vec!["new.txt".to_owned()]);
    // The VM is never repaired or changed by a verification.
    assert_eq!(
        fs::read(harness.destination().join("a/b/c.bin")).unwrap(),
        b"DEEP"
    );

    fs::remove_file(harness.destination().join("disk.qcow2")).unwrap();
    let request = harness.verify_request();
    verify(&operations, &request);
    assert_eq!(
        verified(&operations, request.operation_id).await.status,
        VerifyResultStatus::Missing
    );
}

#[tokio::test]
async fn without_a_local_manifest_the_cache_and_then_the_repository_are_used() {
    let harness = Harness::new();
    let operations = harness.operations();
    let restore = harness.request();
    start(&operations, &restore);
    outcome(&operations).await.unwrap();
    close(&operations, restore.operation_id);
    fs::remove_dir_all(harness.state.join("local-manifests")).unwrap();

    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Verified, "{result:?}");
    assert_eq!(result.manifest_source.as_deref(), Some("cache"));

    // The verified manifest was kept, so the next one reads nothing remote.
    let request = harness.verify_request();
    verify(&operations, &request);
    assert_eq!(
        verified(&operations, request.operation_id)
            .await
            .manifest_source
            .as_deref(),
        Some("local")
    );

    fs::remove_dir_all(harness.state.join("local-manifests")).unwrap();
    fs::remove_dir_all(&harness.cache).unwrap();
    let operations = harness.operations();
    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Verified, "{result:?}");
    assert_eq!(result.manifest_source.as_deref(), Some("repository"));
    harness.assert_nothing_left_behind();
}

#[tokio::test]
async fn a_verification_reports_what_it_cannot_do_and_repeats_until_answered() {
    let harness = Harness::new();
    let operations = harness.operations();

    // Not on this computer.
    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Missing);
    assert_eq!(result.code.as_deref(), Some("vm_not_found"));

    // A manifest hash other than the master's matches no copy of it.
    fs::create_dir_all(harness.destination()).unwrap();
    fs::write(harness.destination().join("run.bat"), b"x").unwrap();
    let request = VmVerifyRequest {
        manifest_sha256: Some("0".repeat(64)),
        ..harness.verify_request()
    };
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(
        result.status,
        VerifyResultStatus::VerificationFailed,
        "{result:?}"
    );
    assert!(result.files_verified == 0 && result.manifest_sha256.is_none());

    // A key for another VM.
    let request = VmVerifyRequest {
        archive_key: "qemu/other/versions/x.zip".to_owned(),
        ..harness.verify_request()
    };
    verify(&operations, &request);
    assert_eq!(
        verified(&operations, request.operation_id)
            .await
            .code
            .as_deref(),
        Some("invalid_request")
    );

    // The repository cannot be reached, and the cache holds nothing: the earlier attempt cached the
    // genuine archive, which is emptied here.
    fs::remove_dir_all(&harness.cache).unwrap();
    let operations = harness.operations();
    harness.repository.fail(
        "stat",
        RepositoryError::new(Kind::Unreachable, "the server is down"),
    );
    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Unavailable, "{result:?}");

    // Results stay until answered, and survive a restart.
    let pending = |operations: &AgentOperations| {
        operations
            .pending_reports()
            .into_iter()
            .filter(|message| matches!(message, Message::AgentVmVerifyResult(_)))
            .count()
    };
    assert_eq!(pending(&operations), 4);
    drop(operations);
    let operations = harness.operations();
    assert_eq!(pending(&operations), 4);
    operations.handle(Message::ServerVmVerifyAck(VmVerifyAck {
        operation_id: request.operation_id,
    }));
    assert_eq!(pending(&operations), 3);
}

#[tokio::test]
async fn nothing_restores_or_verifies_a_vm_that_may_be_running() {
    let harness = Harness::new();
    let session = harness.leave_unknown_session();
    let operations = harness.operations();

    let request = harness.request();
    start(&operations, &request);
    let (code, _) = outcome(&operations).await.unwrap_err();
    assert_eq!(code, "vm_running");
    assert!(!harness.destination().exists());

    let request = harness.verify_request();
    verify(&operations, &request);
    let result = verified(&operations, request.operation_id).await;
    assert_eq!(result.status, VerifyResultStatus::Unavailable);
    assert_eq!(result.code.as_deref(), Some("vm_running"));

    // Dismissed by an administrator, and then the VM is free again.
    let unknown = operations.execution().pending_reports();
    assert!(
        unknown.is_empty(),
        "an unknown session is not an end: {unknown:?}"
    );
    operations.handle(Message::ServerVmExecutionAck(VmExecutionAck {
        session_id: session,
    }));
    let request = harness.request();
    start(&operations, &request);
    outcome(&operations).await.unwrap();
}
