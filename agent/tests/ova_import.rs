//! `import-ova` (decision 0049): the OVA checks on real files built here, and the whole workflow against a
//! repository held in memory and a scripted server that keeps the same rules as the real one. The real API is
//! tested in `apps/api/test/ova-import.test.ts`, and the real command line against the real API and a real SFTP
//! server in `apps/api/e2e/registration.e2e.test.ts`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use emucat_agent::emulators::VmName;
use emucat_agent::ova::{self, OvaErrorKind};
use emucat_agent::ova_import::{
    self, ApiError, CompleteAnswer, CompleteImport, CreateImport, Event, ImportApi,
    ImportErrorKind, ImportOperation, ImportRequest, ImportSettings, ImportStage, Outcome,
    Preflight, Step,
};
use emucat_agent::packaging::hex;
use emucat_agent::protocol::RepositoryConfigSummary;
use emucat_agent::registration::RepositoryProvider;
use emucat_agent::repository::{
    ArchiveRepository, CancelFlag, HealthReport, ObjectMetadata, ProgressFn, RepositoryError,
    RepositoryErrorKind, RepositoryKey, RepositoryResult, VerifiedObject,
};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

const REPOSITORY: Uuid = Uuid::from_u128(0x0b0e_0000_0000_4000_8000_0000_0000_0001);
const ORIGIN: &str = "http://127.0.0.1:4000";

// Building OVAs.

/// A TAR archive, written the way GNU tar and VirtualBox write one: ustar headers, data padded to 512 bytes, and
/// two zero blocks at the end.
#[derive(Default)]
struct Tar {
    bytes: Vec<u8>,
}

fn header(name: &str, size: u64, kind: u8) -> [u8; 512] {
    let mut block = [0u8; 512];
    let name = name.as_bytes();
    block[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
    block[100..108].copy_from_slice(b"0000644\0");
    block[108..116].copy_from_slice(b"0000000\0");
    block[116..124].copy_from_slice(b"0000000\0");
    block[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    block[136..148].copy_from_slice(b"14725237021\0");
    block[148..156].copy_from_slice(b"        ");
    block[156] = kind;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let sum: u32 = block.iter().map(|&byte| u32::from(byte)).sum();
    block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    block
}

impl Tar {
    fn entry(mut self, name: &str, kind: u8, data: &[u8]) -> Self {
        self.bytes
            .extend_from_slice(&header(name, data.len() as u64, kind));
        self.bytes.extend_from_slice(data);
        let padding = (512 - data.len() % 512) % 512;
        self.bytes.extend(std::iter::repeat_n(0, padding));
        self
    }

    fn file(self, name: &str, data: &[u8]) -> Self {
        self.entry(name, b'0', data)
    }

    fn pax_path(self, path: &str) -> Self {
        let record_body = format!(" path={path}\n");
        let mut length = record_body.len() + 1;
        while format!("{length}{record_body}").len() != length {
            length += 1;
        }
        self.entry(
            "PaxHeaders/x",
            b'x',
            format!("{length}{record_body}").as_bytes(),
        )
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.extend(std::iter::repeat_n(0, 1024));
        self.bytes
    }
}

fn ovf(name: &str, files: &[&str]) -> String {
    let references: String = files
        .iter()
        .enumerate()
        .map(|(index, file)| format!("    <File ovf:id=\"file{index}\" ovf:href=\"{file}\"/>\n"))
        .collect();
    format!(
        r#"<?xml version="1.0"?>
<Envelope ovf:version="1.0" xml:lang="en-US" xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1" xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData" xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:vbox="http://www.virtualbox.org/ovf/machine">
  <References>
{references}  </References>
  <DiskSection>
    <Info>List of the virtual disks used in the package</Info>
    <Disk ovf:capacity="2147483648" ovf:diskId="vmdisk1" ovf:fileRef="file0" ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
  </DiskSection>
  <VirtualSystem ovf:id="{name}">
    <Info>A virtual machine</Info>
    <OperatingSystemSection ovf:id="1"><Info>The kind of installed guest operating system</Info><Description>DOS &amp; Windows 3.1</Description></OperatingSystemSection>
    <vbox:Machine ovf:required="false" version="1.19-windows" uuid="{{2acda0fc-cea6-406b-8a55-746fac380687}}" name="{name}"/>
  </VirtualSystem>
</Envelope>
"#
    )
}

/// An OVA as VirtualBox exports one: descriptor, disk and a SHA-256 manifest of both.
fn virtualbox_ova(name: &str, disk: &[u8]) -> Vec<u8> {
    let descriptor_name = format!("{name}.ovf");
    let disk_name = format!("{name}-disk001.vmdk");
    let descriptor = ovf(name, &[&disk_name]);
    let manifest = format!(
        "SHA256({descriptor_name})= {}\nSHA256({disk_name})= {}\n",
        hex(&Sha256::digest(descriptor.as_bytes())),
        hex(&Sha256::digest(disk)),
    );
    Tar::default()
        .file(&descriptor_name, descriptor.as_bytes())
        .file(&disk_name, disk)
        .file(&format!("{name}.mf"), manifest.as_bytes())
        .finish()
}

fn disk(size: usize) -> Vec<u8> {
    (0..size).map(|index| (index * 7 % 251) as u8).collect()
}

fn write(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

fn kind_of(bytes: Vec<u8>) -> OvaErrorKind {
    let directory = TempDir::new().unwrap();
    let path = write(directory.path(), "test.ova", &bytes);
    ova::inspect(&path).expect_err("must be refused").kind
}

// Validation.

#[test]
fn a_virtualbox_ova_is_valid_and_described() {
    let directory = TempDir::new().unwrap();
    let path = write(
        directory.path(),
        "DOS-6.22.ova",
        &virtualbox_ova("DOS-6.22", &disk(70_000)),
    );
    let inspection = ova::inspect(&path).unwrap();
    assert_eq!(inspection.descriptor, "DOS-6.22.ovf");
    assert_eq!(inspection.ovf_version, "1.0");
    assert_eq!(inspection.virtual_systems, ["DOS-6.22"]);
    assert_eq!(inspection.referenced_files, ["DOS-6.22-disk001.vmdk"]);
    assert!(inspection.virtualbox_machine);
    assert_eq!(inspection.manifest.as_deref(), Some("DOS-6.22.mf"));
    assert_eq!(inspection.checked_digests().count(), 2);
    assert_eq!(inspection.entries.len(), 3);
    assert_eq!(inspection.entries[1].size_bytes, 70_000);

    let seen = Mutex::new(Vec::new());
    let (size, sha256) = ova::hash(&path, &inspection, &CancelFlag::new(), &|done, total| {
        seen.lock().unwrap().push((done, total));
    })
    .unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(size, bytes.len() as u64);
    assert_eq!(sha256, hex(&Sha256::digest(&bytes)));
    assert_eq!(seen.lock().unwrap().last(), Some(&(size, size)));
}

#[test]
fn unicode_paths_with_spaces_are_read() {
    let directory = TempDir::new().unwrap();
    let folder = directory.path().join("Virtual Machines Ελληνικά テスト");
    fs::create_dir(&folder).unwrap();
    let path = write(
        &folder,
        "Ξ DOS 6.22 — copia.OVA",
        &virtualbox_ova("DOS", &disk(1000)),
    );
    assert!(ova::inspect(&path).is_ok());
}

#[test]
fn only_a_regular_ova_file_is_accepted() {
    let directory = TempDir::new().unwrap();
    let missing = ova::inspect(&directory.path().join("missing.ova")).unwrap_err();
    assert_eq!(missing.kind, OvaErrorKind::NotAFile);
    let folder = directory.path().join("folder.ova");
    fs::create_dir(&folder).unwrap();
    assert_eq!(
        ova::inspect(&folder).unwrap_err().kind,
        OvaErrorKind::NotAFile
    );
    for name in ["dos.ovf", "dos.tar", "dos.ova.zip", "dos"] {
        let path = write(directory.path(), name, &virtualbox_ova("DOS", &disk(10)));
        assert_eq!(
            ova::inspect(&path).unwrap_err().kind,
            OvaErrorKind::WrongExtension,
            "{name}"
        );
    }
}

#[test]
fn a_file_that_is_not_a_tar_archive_is_refused() {
    assert_eq!(kind_of(Vec::new()), OvaErrorKind::Malformed);
    assert_eq!(
        kind_of(b"PK\x03\x04 a zip file".to_vec()),
        OvaErrorKind::Malformed
    );
    assert_eq!(kind_of(disk(4096)), OvaErrorKind::Malformed);
    let mut damaged = virtualbox_ova("DOS", &disk(100));
    damaged[10] ^= 0xff;
    assert_eq!(kind_of(damaged), OvaErrorKind::Malformed);
}

#[test]
fn a_truncated_archive_is_refused() {
    let whole = virtualbox_ova("DOS", &disk(100_000));
    // Under 1024 bytes a file is not a TAR archive at all, which is a different refusal.
    for cut in [1100, 2000, 50_000, whole.len() - 1500] {
        assert_eq!(
            kind_of(whole[..cut].to_vec()),
            OvaErrorKind::Truncated,
            "cut at {cut}"
        );
    }
}

#[test]
fn an_archive_without_a_descriptor_is_refused() {
    let no_descriptor = Tar::default().file("disk.vmdk", &disk(100)).finish();
    assert_eq!(kind_of(no_descriptor), OvaErrorKind::MissingDescriptor);
    let empty = Tar::default().finish();
    assert_eq!(kind_of(empty), OvaErrorKind::MissingDescriptor);
}

#[test]
fn the_descriptor_must_come_first_and_be_alone() {
    let descriptor = ovf("DOS", &["disk.vmdk"]);
    let second = Tar::default()
        .file("disk.vmdk", &disk(10))
        .file("DOS.ovf", descriptor.as_bytes())
        .finish();
    assert_eq!(kind_of(second), OvaErrorKind::Unsupported);
    let two = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .file("disk.vmdk", &disk(10))
        .file("other.ovf", descriptor.as_bytes())
        .finish();
    assert_eq!(kind_of(two), OvaErrorKind::Unsupported);
}

#[test]
fn an_invalid_descriptor_is_refused() {
    let with = |descriptor: &str| {
        Tar::default()
            .file("DOS.ovf", descriptor.as_bytes())
            .file("disk.vmdk", &disk(10))
            .finish()
    };
    let cases = [
        "this is not XML",
        "<Envelope xmlns=\"http://example.com/not-ovf\"><VirtualSystem/></Envelope>",
        "<Root xmlns=\"http://schemas.dmtf.org/ovf/envelope/1\"/>",
        // No virtual system.
        "<Envelope xmlns=\"http://schemas.dmtf.org/ovf/envelope/1\"><References/></Envelope>",
        // Not closed.
        "<Envelope xmlns=\"http://schemas.dmtf.org/ovf/envelope/1\"><VirtualSystem>",
        // A reference to a file that is not there.
        "<Envelope xmlns=\"http://schemas.dmtf.org/ovf/envelope/1\" xmlns:ovf=\"http://schemas.dmtf.org/ovf/envelope/1\"><References><File ovf:href=\"missing.vmdk\"/></References><VirtualSystem ovf:id=\"x\"/></Envelope>",
    ];
    for descriptor in cases {
        assert_eq!(
            kind_of(with(descriptor)),
            OvaErrorKind::InvalidDescriptor,
            "{descriptor}"
        );
    }
}

#[test]
fn a_document_type_declaration_is_refused_and_no_entity_is_expanded() {
    let descriptor = r#"<?xml version="1.0"?>
<!DOCTYPE Envelope [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>
<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1"><VirtualSystem>&b;&xxe;</VirtualSystem></Envelope>"#;
    let bytes = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .finish();
    let directory = TempDir::new().unwrap();
    let error = ova::inspect(&write(directory.path(), "x.ova", &bytes)).unwrap_err();
    assert_eq!(error.kind, OvaErrorKind::InvalidDescriptor);
    assert!(error.message.contains("document type"), "{}", error.message);
}

#[test]
fn external_references_are_not_followed() {
    let descriptor = "<Envelope xmlns=\"http://schemas.dmtf.org/ovf/envelope/1\" xmlns:ovf=\"http://schemas.dmtf.org/ovf/envelope/1\"><References><File ovf:href=\"http://example.com/disk.vmdk\"/></References><VirtualSystem ovf:id=\"x\"/></Envelope>";
    let bytes = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .finish();
    assert_eq!(kind_of(bytes), OvaErrorKind::Unsupported);
}

#[test]
fn unsafe_names_and_links_are_refused() {
    let descriptor = ovf("DOS", &[]);
    let with = |name: &str, kind: u8| {
        Tar::default()
            .file("DOS.ovf", descriptor.as_bytes())
            .entry(name, kind, b"x")
            .finish()
    };
    for name in [
        "../evil.vmdk",
        "/etc/passwd",
        "..\\..\\evil.dll",
        "C:evil",
        "a/../../b",
    ] {
        assert_eq!(
            kind_of(with(name, b'0')),
            OvaErrorKind::UnsafeEntry,
            "{name}"
        );
    }
    assert_eq!(kind_of(with("link.vmdk", b'2')), OvaErrorKind::UnsafeEntry);
    assert_eq!(kind_of(with("hard.vmdk", b'1')), OvaErrorKind::UnsafeEntry);
    assert_eq!(kind_of(with("disks/", b'5')), OvaErrorKind::Unsupported);
    assert_eq!(
        kind_of(with("disks/disk.vmdk", b'0')),
        OvaErrorKind::Unsupported
    );
    assert_eq!(kind_of(with("fifo", b'6')), OvaErrorKind::Unsupported);
    // A PAX path is checked like any other.
    let pax = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .pax_path("../../evil.vmdk")
        .file("harmless.vmdk", b"x")
        .finish();
    assert_eq!(kind_of(pax), OvaErrorKind::UnsafeEntry);
    // The same file twice, whatever the case.
    let twice = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .file("disk.vmdk", b"x")
        .file("DISK.vmdk", b"y")
        .finish();
    assert_eq!(kind_of(twice), OvaErrorKind::Malformed);
}

#[test]
fn a_long_name_in_a_pax_header_is_read() {
    let long = format!("{}-disk001.vmdk", "x".repeat(120));
    let bytes = Tar::default()
        .file("DOS.ovf", ovf("DOS", &[&long]).as_bytes())
        .pax_path(&long)
        .file("ignored-name", &disk(10))
        .finish();
    let directory = TempDir::new().unwrap();
    let inspection = ova::inspect(&write(directory.path(), "x.ova", &bytes)).unwrap();
    assert_eq!(inspection.entries[1].name, long);
}

#[test]
fn a_part_that_does_not_match_the_manifest_is_found_while_hashing() {
    let mut bytes = virtualbox_ova("DOS", &disk(10_000));
    let directory = TempDir::new().unwrap();
    let path = write(directory.path(), "x.ova", &bytes);
    let offset = ova::inspect(&path).unwrap().entries[1].data_offset;
    // Damage the disk's data, which no header check sees.
    bytes[usize::try_from(offset).unwrap() + 100] ^= 0x01;
    fs::write(&path, &bytes).unwrap();
    let inspection = ova::inspect(&path).unwrap();
    let error = ova::hash(&path, &inspection, &CancelFlag::new(), &|_, _| {}).unwrap_err();
    assert_eq!(error.kind, OvaErrorKind::ManifestMismatch);
    assert!(error.message.contains("disk001.vmdk"), "{}", error.message);
}

#[test]
fn a_manifest_naming_a_missing_file_is_refused() {
    let descriptor = ovf("DOS", &[]);
    let bytes = Tar::default()
        .file("DOS.ovf", descriptor.as_bytes())
        .file(
            "DOS.mf",
            format!("SHA256(gone.vmdk)= {}\n", "0".repeat(64)).as_bytes(),
        )
        .finish();
    assert_eq!(kind_of(bytes), OvaErrorKind::InvalidManifest);
}

/// Counts what is read, to show that checking a large archive reads its headers and not its data.
struct Counting<R> {
    inner: R,
    read: Arc<AtomicUsize>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.read.fetch_add(count, Ordering::Relaxed);
        Ok(count)
    }
}

impl<R: Seek> Seek for Counting<R> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(position)
    }
}

#[test]
fn a_large_archive_is_checked_by_seeking_and_hashed_in_one_bounded_pass() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("large.ova");
    // A 1 GiB disk, sparse on disk: header, a hole, padding and the end blocks.
    let disk_size: u64 = 1 << 30;
    let descriptor = ovf("Large", &["large-disk001.vmdk"]);
    let head = Tar::default().file("Large.ovf", descriptor.as_bytes());
    let mut bytes = head.bytes;
    bytes.extend_from_slice(&header("large-disk001.vmdk", disk_size, b'0'));
    let disk_offset = bytes.len() as u64;
    fs::write(&path, &bytes).unwrap();
    let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(disk_offset + disk_size + 1024).unwrap();
    drop(file);

    let read = Arc::new(AtomicUsize::new(0));
    let length = fs::metadata(&path).unwrap().len();
    let mut reader = Counting {
        inner: fs::File::open(&path).unwrap(),
        read: Arc::clone(&read),
    };
    let inspection = ova::inspect_reader(&mut reader, length).unwrap();
    assert_eq!(inspection.entries[1].size_bytes, disk_size);
    assert!(
        read.load(Ordering::Relaxed) < 64 * 1024,
        "checking read {} bytes",
        read.load(Ordering::Relaxed)
    );

    // The hash streams through the whole file, reporting as it goes.
    let reports = AtomicUsize::new(0);
    let (size, _) = ova::hash(&path, &inspection, &CancelFlag::new(), &|done, total| {
        assert!(done <= total);
        reports.fetch_add(1, Ordering::Relaxed);
    })
    .unwrap();
    assert_eq!(size, length);
    assert!(
        reports.load(Ordering::Relaxed) >= 1024,
        "progress is reported per buffer"
    );
}

#[test]
fn hashing_stops_when_cancelled() {
    let bytes = virtualbox_ova("DOS", &disk(5_000_000));
    let inspection = ova::inspect_reader(&mut Cursor::new(&bytes), bytes.len() as u64).unwrap();
    let cancel = CancelFlag::new();
    let error = ova::hash_reader(
        &mut Cursor::new(&bytes),
        &inspection,
        &cancel,
        &|done, _| {
            if done > 1_000_000 {
                cancel.cancel();
            }
        },
    )
    .unwrap_err();
    assert_eq!(error.kind, OvaErrorKind::Cancelled);
}

// The workflow, against a repository in memory and a scripted server.

#[derive(Default)]
struct RepositoryState {
    objects: HashMap<String, Vec<u8>>,
    uploads: usize,
    deletes: Vec<String>,
    /// Upload failures still to come, of this kind.
    upload_failures: Vec<RepositoryErrorKind>,
}

#[derive(Clone, Default)]
struct MemoryRepository {
    state: Arc<Mutex<RepositoryState>>,
    /// Set during an upload, to stand for Ctrl+C at that moment.
    cancel_during_upload: Arc<Mutex<Option<CancelFlag>>>,
}

impl MemoryRepository {
    fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.state.lock().unwrap().objects.keys().cloned().collect();
        keys.sort();
        keys
    }

    fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.state.lock().unwrap().objects.get(key).cloned()
    }

    fn uploads(&self) -> usize {
        self.state.lock().unwrap().uploads
    }
}

impl ArchiveRepository for MemoryRepository {
    fn health_check<'a>(
        &'a self,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>> {
        async move { unreachable!("not used") }.boxed()
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
        async move { Ok(Some(u64::MAX)) }.boxed()
    }

    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>> {
        async move {
            assert!(key.is_staging(), "uploads only ever go to staging");
            if let Some(flag) = self.cancel_during_upload.lock().unwrap().take() {
                flag.cancel();
            }
            if cancel.is_cancelled() {
                return Err(RepositoryError::cancelled());
            }
            let mut state = self.state.lock().unwrap();
            state.uploads += 1;
            if let Some(kind) = state.upload_failures.pop() {
                state
                    .objects
                    .insert(key.as_str().to_owned(), b"partial".to_vec());
                return Err(RepositoryError::new(kind, "The connection dropped"));
            }
            let bytes = fs::read(source).unwrap();
            let size = bytes.len() as u64;
            state.objects.insert(key.as_str().to_owned(), bytes);
            drop(state);
            progress(size / 2, size);
            progress(size, size);
            Ok(ObjectMetadata { size_bytes: size })
        }
        .boxed()
    }

    fn download<'a>(
        &'a self,
        _: &'a RepositoryKey,
        _: &'a Path,
        _: ProgressFn,
        _: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>> {
        async move { unreachable!("an import never downloads") }.boxed()
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
            if cancel.is_cancelled() {
                return Err(RepositoryError::cancelled());
            }
            let bytes = self
                .object(key.as_str())
                .ok_or_else(|| RepositoryError::new(RepositoryErrorKind::NotFound, "missing"))?;
            let sha256 = hex(&Sha256::digest(&bytes));
            progress(bytes.len() as u64, bytes.len() as u64);
            if bytes.len() as u64 != expected_size || sha256 != expected_sha256 {
                return Err(RepositoryError::new(
                    RepositoryErrorKind::HashMismatch,
                    "mismatch",
                ));
            }
            Ok(VerifiedObject {
                size_bytes: expected_size,
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
            let mut state = self.state.lock().unwrap();
            if state.objects.contains_key(final_key.as_str()) {
                return Err(RepositoryError::new(
                    RepositoryErrorKind::AlreadyExists,
                    "exists",
                ));
            }
            let bytes = state
                .objects
                .remove(staging.as_str())
                .ok_or_else(|| RepositoryError::new(RepositoryErrorKind::NotFound, "missing"))?;
            state.objects.insert(final_key.as_str().to_owned(), bytes);
            Ok(())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>> {
        async move {
            let mut state = self.state.lock().unwrap();
            state.objects.remove(key.as_str());
            state.deletes.push(key.as_str().to_owned());
            Ok(())
        }
        .boxed()
    }
}

struct Provider(MemoryRepository);

impl RepositoryProvider for Provider {
    fn open(&self, repository_id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        if repository_id == REPOSITORY {
            Ok(Arc::new(self.0.clone()))
        } else {
            Err(RepositoryError::new(
                RepositoryErrorKind::NotConfigured,
                format!("This agent has no configuration for repository {repository_id}"),
            ))
        }
    }

    fn summary(&self, _: Uuid) -> Option<RepositoryConfigSummary> {
        None
    }

    fn upload_attempts(&self, _: Uuid) -> u32 {
        2
    }

    fn repository_ids(&self) -> Vec<Uuid> {
        vec![REPOSITORY]
    }
}

/// The server's rules for imports, in memory: one per name and per request ID, the declared archive must be the
/// one completed, a cancellation beats a later completion, and a commit is answered again the same way.
#[derive(Default)]
struct ServerState {
    taken: HashSet<String>,
    operations: HashMap<Uuid, (ImportOperation, CreateImport)>,
    by_request: HashMap<Uuid, Uuid>,
    calls: Vec<String>,
    /// Answers to give instead, by route, once each.
    unreachable: HashMap<&'static str, usize>,
    preflight_refusal: Option<ApiError>,
    /// The server ends the import as cancelled at the next progress report.
    cancel_at_progress: bool,
    commits: usize,
}

#[derive(Clone, Default)]
struct ScriptedServer {
    state: Arc<Mutex<ServerState>>,
}

impl ScriptedServer {
    fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }

    fn operation(&self) -> ImportOperation {
        let state = self.state.lock().unwrap();
        assert_eq!(state.operations.len(), 1, "one operation");
        state.operations.values().next().unwrap().0.clone()
    }

    fn unreachable_once(&self, route: &'static str) {
        *self
            .state
            .lock()
            .unwrap()
            .unreachable
            .entry(route)
            .or_default() += 1;
    }

    fn enter(
        &self,
        route: &'static str,
    ) -> Result<std::sync::MutexGuard<'_, ServerState>, ApiError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(route.to_owned());
        if let Some(count) = state.unreachable.get_mut(route)
            && *count > 0
        {
            *count -= 1;
            return Err(ApiError::Unreachable(
                "Cannot connect to the server".to_owned(),
            ));
        }
        Ok(state)
    }
}

fn refused(status: u16, code: &str) -> ApiError {
    ApiError::Refused {
        status,
        code: code.to_owned(),
        message: code.to_owned(),
    }
}

impl ImportApi for ScriptedServer {
    fn preflight<'a>(
        &'a self,
        vm_name: &'a str,
        _: u64,
    ) -> BoxFuture<'a, Result<Preflight, ApiError>> {
        async move {
            let state = self.enter("preflight")?;
            if let Some(refusal) = state.preflight_refusal.clone() {
                return Err(refusal);
            }
            if state.taken.contains(&vm_name.to_lowercase()) {
                return Err(refused(409, "vm_already_registered"));
            }
            Ok(Preflight {
                repository_id: REPOSITORY,
                repository_name: "NAS".to_owned(),
                max_archive_bytes: 1 << 41,
            })
        }
        .boxed()
    }

    fn create<'a>(
        &'a self,
        request: &'a CreateImport,
    ) -> BoxFuture<'a, Result<ImportOperation, ApiError>> {
        async move {
            let mut state = self.enter("create")?;
            if let Some(id) = state.by_request.get(&request.request_id) {
                return Ok(state.operations[id].0.clone());
            }
            if state.taken.contains(&request.vm_name.to_lowercase())
                || state
                    .operations
                    .values()
                    .any(|(operation, _)| operation.is_active())
            {
                return Err(refused(409, "registration_in_progress"));
            }
            let id = Uuid::new_v4();
            let version_id = Uuid::new_v4();
            let vm_name = VmName::new(request.vm_name.clone()).unwrap();
            let operation = ImportOperation {
                id,
                state: "queued".to_owned(),
                vm_name: request.vm_name.clone(),
                version_id,
                archive_key: format!("archives/virtualbox/{}/{version_id}.ova", vm_name.key()),
                repository_id: REPOSITORY,
                cancel_requested: false,
                error: None,
            };
            state.by_request.insert(request.request_id, id);
            state
                .operations
                .insert(id, (operation.clone(), request.clone()));
            Ok(operation)
        }
        .boxed()
    }

    fn get(&self, operation_id: Uuid) -> BoxFuture<'_, Result<ImportOperation, ApiError>> {
        async move {
            let state = self.enter("get")?;
            state
                .operations
                .get(&operation_id)
                .map(|(operation, _)| operation.clone())
                .ok_or_else(|| refused(404, "import_not_found"))
        }
        .boxed()
    }

    fn progress(
        &self,
        operation_id: Uuid,
        stage: ImportStage,
        _: Option<u64>,
        _: Option<u64>,
    ) -> BoxFuture<'_, Result<ImportOperation, ApiError>> {
        async move {
            let mut state = self.enter("progress")?;
            let cancel = state.cancel_at_progress;
            let (operation, _) = state
                .operations
                .get_mut(&operation_id)
                .ok_or_else(|| refused(404, "import_not_found"))?;
            if operation.is_active() {
                if cancel {
                    operation.state = "cancelled".to_owned();
                    operation.cancel_requested = true;
                    operation.error = Some(ova_import::OperationError {
                        code: "cancelled".to_owned(),
                        message: "Cancelled by an administrator.".to_owned(),
                    });
                } else {
                    operation.state = match stage {
                        ImportStage::Uploading => "uploading",
                        ImportStage::Verifying => "verifying",
                    }
                    .to_owned();
                }
            }
            Ok(operation.clone())
        }
        .boxed()
    }

    fn complete<'a>(
        &'a self,
        operation_id: Uuid,
        request: &'a CompleteImport,
    ) -> BoxFuture<'a, Result<CompleteAnswer, ApiError>> {
        async move {
            let mut state = self.enter("complete")?;
            let (operation, created) = state
                .operations
                .get(&operation_id)
                .cloned()
                .ok_or_else(|| refused(404, "import_not_found"))?;
            if operation.is_committed() {
                return Ok(CompleteAnswer {
                    outcome: "committed".to_owned(),
                    delete_published: false,
                    operation,
                });
            }
            let mut operation = operation;
            if !operation.is_active() {
                return Ok(CompleteAnswer {
                    outcome: "rejected".to_owned(),
                    delete_published: request.version_id == operation.version_id,
                    operation,
                });
            }
            assert_eq!(request.version_id, operation.version_id);
            assert_eq!(request.archive_key, operation.archive_key);
            if request.archive_sha256 != created.archive_sha256
                || request.archive_size_bytes != created.archive_size_bytes
            {
                operation.state = "failed".to_owned();
                state.operations.get_mut(&operation_id).unwrap().0 = operation.clone();
                return Ok(CompleteAnswer {
                    outcome: "rejected".to_owned(),
                    delete_published: true,
                    operation,
                });
            }
            operation.state = "succeeded".to_owned();
            state.taken.insert(operation.vm_name.to_lowercase());
            state.commits += 1;
            state.operations.get_mut(&operation_id).unwrap().0 = operation.clone();
            Ok(CompleteAnswer {
                outcome: "committed".to_owned(),
                delete_published: false,
                operation,
            })
        }
        .boxed()
    }

    fn fail<'a>(
        &'a self,
        operation_id: Uuid,
        code: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, Result<ImportOperation, ApiError>> {
        async move {
            let mut state = self.enter("fail")?;
            let (operation, _) = state
                .operations
                .get_mut(&operation_id)
                .ok_or_else(|| refused(404, "import_not_found"))?;
            if operation.is_active() {
                operation.state = if code == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                }
                .to_owned();
                operation.error = Some(ova_import::OperationError {
                    code: code.to_owned(),
                    message: message.to_owned(),
                });
            }
            Ok(operation.clone())
        }
        .boxed()
    }
}

struct World {
    directory: TempDir,
    file: PathBuf,
    bytes: Vec<u8>,
    repository: MemoryRepository,
    server: ScriptedServer,
    events: Arc<Mutex<Vec<Event>>>,
}

impl World {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let bytes = virtualbox_ova("DOS-6.22", &disk(300_000));
        let folder = directory.path().join("My VMs — Ελληνικά");
        fs::create_dir(&folder).unwrap();
        let file = write(&folder, "DOS 6.22.ova", &bytes);
        Self {
            directory,
            file,
            bytes,
            repository: MemoryRepository::default(),
            server: ScriptedServer::default(),
            events: Arc::default(),
        }
    }

    fn state_dir(&self) -> PathBuf {
        self.directory.path().join("state")
    }

    fn journals(&self) -> usize {
        fs::read_dir(self.state_dir().join("ova-imports"))
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    fn settings(&self) -> ImportSettings {
        let events = Arc::clone(&self.events);
        ImportSettings {
            state_dir: self.state_dir(),
            server_origin: ORIGIN.to_owned(),
            api: Arc::new(self.server.clone()),
            repositories: Arc::new(Provider(self.repository.clone())),
            reporter: Arc::new(move |event| events.lock().unwrap().push(event)),
            retry_delay: Duration::from_millis(10),
        }
    }

    fn request(&self, dry_run: bool) -> ImportRequest {
        ImportRequest {
            file: self.file.clone(),
            vm_name: VmName::new("DOS-6.22").unwrap(),
            description: Some("MS-DOS 6.22".to_owned()),
            dry_run,
            inspection: None,
        }
    }

    async fn run(
        &self,
        cancel: &CancelFlag,
    ) -> Result<ova_import::ImportReport, ova_import::ImportError> {
        ova_import::run(&self.settings(), self.request(false), cancel).await
    }

    fn sha256(&self) -> String {
        hex(&Sha256::digest(&self.bytes))
    }

    fn final_key(&self) -> String {
        self.server.operation().archive_key
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn an_import_publishes_the_exact_bytes_and_registers_them() {
    let world = World::new();
    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert_eq!(report.status, Outcome::Completed);
    assert_eq!(report.sha256, world.sha256());
    assert_eq!(report.size_bytes, world.bytes.len() as u64);
    assert_eq!(report.emulator_type, "virtualbox");
    assert!(!report.resumed);

    // Exactly the file, at the issued key, and nothing else left behind.
    let key = world.final_key();
    assert!(key.starts_with("archives/virtualbox/dos-6.22/") && key.ends_with(".ova"));
    assert_eq!(world.repository.keys(), std::slice::from_ref(&key));
    assert_eq!(world.repository.object(&key).unwrap(), world.bytes);
    assert_eq!(world.server.operation().state, "succeeded");
    assert_eq!(world.journals(), 0);
    // The file itself is untouched.
    assert_eq!(fs::read(&world.file).unwrap(), world.bytes);

    // The server was asked in this order, and told what was declared.
    let calls = world.server.calls();
    assert_eq!(calls.first().map(String::as_str), Some("preflight"));
    assert_eq!(calls.get(1).map(String::as_str), Some("create"));
    assert_eq!(calls.last().map(String::as_str), Some("complete"));
    let created = world
        .server
        .state
        .lock()
        .unwrap()
        .operations
        .values()
        .next()
        .unwrap()
        .1
        .clone();
    assert_eq!(created.archive_sha256, world.sha256());
    assert_eq!(created.source_file_name, "DOS 6.22.ova");
    assert_eq!(created.description.as_deref(), Some("MS-DOS 6.22"));

    // Each step, in order.
    let started: Vec<Step> = world
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            Event::Started(step) => Some(*step),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        [
            Step::Validating,
            Step::CheckingCatalog,
            Step::Hashing,
            Step::Reserving,
            Step::Uploading,
            Step::Verifying,
            Step::Publishing,
            Step::Registering
        ]
    );
    assert!(
        world.events.lock().unwrap().iter().any(
            |event| matches!(event, Event::Bytes(Step::Uploading, done, total) if done == total)
        )
    );
}

#[test]
fn a_dry_run_reserves_uploads_and_registers_nothing() {
    let world = World::new();
    let report = runtime()
        .block_on(ova_import::run(
            &world.settings(),
            world.request(true),
            &CancelFlag::new(),
        ))
        .unwrap();
    assert_eq!(report.status, Outcome::DryRun);
    assert_eq!(report.sha256, world.sha256());
    assert_eq!(report.operation_id, None);
    assert_eq!(world.server.calls(), ["preflight"]);
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.journals(), 0);
}

#[test]
fn a_taken_name_is_refused_before_anything_is_reserved_or_uploaded() {
    let world = World::new();
    world
        .server
        .state
        .lock()
        .unwrap()
        .taken
        .insert("dos-6.22".to_owned());
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Conflict);
    assert_eq!(error.code, "vm_already_registered");
    assert_eq!(error.kind.exit_code(), 5);
    assert_eq!(world.server.calls(), ["preflight"]);
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.journals(), 0);
}

#[test]
fn a_refused_credential_is_a_configuration_problem() {
    let world = World::new();
    world.server.state.lock().unwrap().preflight_refusal = Some(ApiError::Unauthorized);
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Configuration);
    assert_eq!(error.code, "unauthorized");
    assert!(world.repository.keys().is_empty());
}

#[test]
fn an_older_server_is_reported_as_such() {
    let world = World::new();
    world.server.state.lock().unwrap().preflight_refusal = Some(ApiError::Unsupported);
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.code, "server_unsupported");
}

#[test]
fn an_unreachable_server_changes_nothing() {
    let world = World::new();
    world.server.unreachable_once("preflight");
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Unavailable);
    assert_eq!(error.kind.exit_code(), 6);
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.journals(), 0);
}

#[test]
fn a_repository_this_agent_does_not_have_is_refused_before_hashing() {
    let world = World::new();
    let mut settings = world.settings();
    settings.repositories = Arc::new(NoRepositories);
    let error = runtime()
        .block_on(ova_import::run(
            &settings,
            world.request(false),
            &CancelFlag::new(),
        ))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Configuration);
    assert_eq!(error.code, "repository_not_configured");
    assert!(
        !world
            .events
            .lock()
            .unwrap()
            .contains(&Event::Started(Step::Hashing))
    );
}

struct NoRepositories;

impl RepositoryProvider for NoRepositories {
    fn open(&self, id: Uuid) -> RepositoryResult<Arc<dyn ArchiveRepository>> {
        Err(RepositoryError::new(
            RepositoryErrorKind::NotConfigured,
            format!("This agent has no configuration for repository {id}"),
        ))
    }
    fn summary(&self, _: Uuid) -> Option<RepositoryConfigSummary> {
        None
    }
    fn upload_attempts(&self, _: Uuid) -> u32 {
        1
    }
    fn repository_ids(&self) -> Vec<Uuid> {
        Vec::new()
    }
}

#[test]
fn an_interrupted_upload_is_retried_and_then_succeeds() {
    let world = World::new();
    world
        .repository
        .state
        .lock()
        .unwrap()
        .upload_failures
        .push(RepositoryErrorKind::Interrupted);
    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert_eq!(report.status, Outcome::Completed);
    assert_eq!(world.repository.uploads(), 2);
    assert_eq!(
        world.repository.object(&world.final_key()).unwrap(),
        world.bytes
    );
}

#[test]
fn a_failed_upload_registers_nothing_and_removes_its_staging_object() {
    let world = World::new();
    world
        .repository
        .state
        .lock()
        .unwrap()
        .upload_failures
        .push(RepositoryErrorKind::PermissionDenied);
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.code, "repository_permission_denied");
    let operation = world.server.operation();
    assert_eq!(operation.state, "failed");
    assert_eq!(error.operation_id, Some(operation.id));
    assert!(
        world.repository.keys().is_empty(),
        "{:?}",
        world.repository.keys()
    );
    assert_eq!(world.journals(), 0);
}

#[test]
fn ctrl_c_during_the_upload_cancels_and_cleans_up() {
    let world = World::new();
    let cancel = CancelFlag::new();
    *world.repository.cancel_during_upload.lock().unwrap() = Some(cancel.clone());
    let error = runtime().block_on(world.run(&cancel)).unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Cancelled);
    assert_eq!(error.kind.exit_code(), 130);
    assert_eq!(error.operation_state.as_deref(), Some("cancelled"));
    assert_eq!(world.server.operation().state, "cancelled");
    assert!(world.server.calls().contains(&"fail".to_owned()));
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.journals(), 0);
}

#[test]
fn ctrl_c_before_anything_is_reserved_leaves_nothing_anywhere() {
    let world = World::new();
    let cancel = CancelFlag::new();
    cancel.cancel();
    let error = runtime().block_on(world.run(&cancel)).unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Cancelled);
    assert!(!world.server.calls().contains(&"create".to_owned()));
    assert!(world.repository.keys().is_empty());
    assert_eq!(world.journals(), 0);
}

#[test]
fn an_administrators_cancellation_stops_the_transfer() {
    let world = World::new();
    world.server.state.lock().unwrap().cancel_at_progress = true;
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Cancelled);
    assert_eq!(error.operation_state.as_deref(), Some("cancelled"));
    assert_eq!(
        world.repository.uploads(),
        0,
        "nothing is uploaded once the server said stop"
    );
    assert!(world.repository.keys().is_empty());
    assert!(!world.server.calls().contains(&"complete".to_owned()));
}

#[test]
fn a_lost_completion_is_finished_by_running_again_without_uploading_again() {
    let world = World::new();
    world.server.unreachable_once("complete");
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Unavailable);
    assert!(
        error.message.contains("Run the same command again"),
        "{}",
        error.message
    );
    // Published and verified, not registered, and remembered.
    let key = world.final_key();
    assert_eq!(world.repository.keys(), std::slice::from_ref(&key));
    assert_eq!(world.journals(), 1);
    assert_eq!(world.repository.uploads(), 1);

    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert_eq!(report.status, Outcome::Completed);
    assert!(report.resumed);
    assert_eq!(world.repository.uploads(), 1, "nothing was uploaded again");
    assert_eq!(world.repository.object(&key).unwrap(), world.bytes);
    let state = world.server.state.lock().unwrap();
    assert_eq!(state.operations.len(), 1, "no second operation");
    assert_eq!(state.commits, 1);
    drop(state);
    assert_eq!(world.journals(), 0);
}

#[test]
fn a_commit_whose_answer_was_lost_is_found_again_and_not_repeated() {
    let world = World::new();
    runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    // As if the answer had been lost after the commit: the journal says published.
    let journal_dir = world.state_dir().join("ova-imports");
    fs::create_dir_all(&journal_dir).unwrap();
    let operation = world.server.operation();
    let request_id = *world
        .server
        .state
        .lock()
        .unwrap()
        .by_request
        .keys()
        .next()
        .unwrap();
    let modified = fs::metadata(&world.file)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    fs::write(
        journal_dir.join(format!("{request_id}.json")),
        serde_json::json!({
            "requestId": request_id,
            "serverOrigin": ORIGIN,
            "vmName": "DOS-6.22",
            "vmNameKey": "dos-6.22",
            "description": null,
            "source": { "path": world.file, "sizeBytes": world.bytes.len(), "modifiedNs": modified },
            "sha256": world.sha256(),
            "phase": "published",
            "operationId": operation.id,
            "versionId": operation.version_id,
            "archiveKey": operation.archive_key,
            "repositoryId": REPOSITORY,
            "updatedAt": 1
        })
        .to_string(),
    )
    .unwrap();
    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert_eq!(report.status, Outcome::Completed);
    assert_eq!(report.operation_id, Some(operation.id));
    assert_eq!(world.repository.uploads(), 1);
    assert_eq!(world.server.state.lock().unwrap().commits, 1);
    assert_eq!(world.journals(), 0);
}

#[test]
fn a_lost_creation_is_found_again_by_its_request_id() {
    let world = World::new();
    world.server.unreachable_once("create");
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Unavailable);
    assert_eq!(world.journals(), 1, "the request ID is remembered");
    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert_eq!(report.status, Outcome::Completed);
    assert_eq!(world.server.state.lock().unwrap().operations.len(), 1);
}

#[test]
fn an_upload_already_staged_and_verified_is_not_sent_again() {
    let world = World::new();
    // The first run loses the server at its first progress report, and cannot report the failure either.
    world.server.unreachable_once("progress");
    world.server.unreachable_once("fail");
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Unavailable);
    let operation = world.server.operation();
    // It could not tell the server, so the journal stays, and so does the operation.
    assert!(operation.is_active());
    assert_eq!(world.journals(), 1);
    // As if the upload had completed before the interruption.
    world.repository.state.lock().unwrap().objects.insert(
        format!("archives/.staging/{}.part", operation.id),
        world.bytes.clone(),
    );
    world
        .server
        .state
        .lock()
        .unwrap()
        .operations
        .get_mut(&operation.id)
        .unwrap()
        .0
        .state = "uploading".to_owned();

    let report = runtime().block_on(world.run(&CancelFlag::new())).unwrap();
    assert!(report.resumed);
    assert_eq!(
        world.repository.uploads(),
        0,
        "verified where it was, not uploaded again"
    );
    assert_eq!(
        world.repository.object(&world.final_key()).unwrap(),
        world.bytes
    );
}

#[test]
fn a_different_file_does_not_resume_another_files_import() {
    let world = World::new();
    world.server.unreachable_once("progress");
    world.server.unreachable_once("fail");
    runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    // Another file under the same name, while the first import is still open on the server.
    fs::write(&world.file, virtualbox_ova("DOS-6.22", &disk(1234))).unwrap();
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::Conflict);
    assert!(world.repository.keys().is_empty());
}

#[test]
fn a_rejected_completion_removes_the_unreferenced_archive() {
    let world = World::new();
    // The server cancels between publication and the report: a cancellation beats a later result.
    let settings = world.settings();
    let server = world.server.clone();
    let rejecting = Arc::new(CancelAfterPublish(server));
    let settings = ImportSettings {
        api: rejecting,
        ..settings
    };
    let error = runtime()
        .block_on(ova_import::run(
            &settings,
            world.request(false),
            &CancelFlag::new(),
        ))
        .unwrap_err();
    assert_eq!(error.operation_state.as_deref(), Some("cancelled"));
    assert!(
        world.repository.keys().is_empty(),
        "{:?}",
        world.repository.keys()
    );
    assert!(
        world
            .repository
            .state
            .lock()
            .unwrap()
            .deletes
            .iter()
            .any(|key| key.ends_with(".ova"))
    );
    assert_eq!(world.journals(), 0);
}

/// The scripted server, except that an administrator cancels just before the completion arrives.
struct CancelAfterPublish(ScriptedServer);

impl ImportApi for CancelAfterPublish {
    fn preflight<'a>(
        &'a self,
        vm_name: &'a str,
        size: u64,
    ) -> BoxFuture<'a, Result<Preflight, ApiError>> {
        self.0.preflight(vm_name, size)
    }
    fn create<'a>(
        &'a self,
        request: &'a CreateImport,
    ) -> BoxFuture<'a, Result<ImportOperation, ApiError>> {
        self.0.create(request)
    }
    fn get(&self, id: Uuid) -> BoxFuture<'_, Result<ImportOperation, ApiError>> {
        self.0.get(id)
    }
    fn progress(
        &self,
        id: Uuid,
        stage: ImportStage,
        done: Option<u64>,
        total: Option<u64>,
    ) -> BoxFuture<'_, Result<ImportOperation, ApiError>> {
        self.0.progress(id, stage, done, total)
    }
    fn complete<'a>(
        &'a self,
        id: Uuid,
        request: &'a CompleteImport,
    ) -> BoxFuture<'a, Result<CompleteAnswer, ApiError>> {
        async move {
            {
                let mut state = self.0.state.lock().unwrap();
                let operation = &mut state.operations.get_mut(&id).unwrap().0;
                if operation.is_active() {
                    operation.state = "cancelled".to_owned();
                }
            }
            self.0.complete(id, request).await
        }
        .boxed()
    }
    fn fail<'a>(
        &'a self,
        id: Uuid,
        code: &'a str,
        message: &'a str,
    ) -> BoxFuture<'a, Result<ImportOperation, ApiError>> {
        self.0.fail(id, code, message)
    }
}

#[test]
fn a_damaged_part_is_found_before_anything_is_reserved() {
    let world = World::new();
    let mut bytes = world.bytes.clone();
    bytes[512 * 4 + 7] ^= 0x10;
    fs::write(&world.file, &bytes).unwrap();
    let error = runtime()
        .block_on(world.run(&CancelFlag::new()))
        .unwrap_err();
    assert_eq!(error.kind, ImportErrorKind::InvalidOva);
    assert!(!world.server.calls().contains(&"create".to_owned()));
    assert!(world.repository.keys().is_empty());
}

// The real command line: arguments, exit codes, output, and the server's answers over HTTP.

mod command_line {
    use super::*;
    use emucat_agent::credentials::{Secret, StoredCredential, platform_store};
    use std::io::Write;
    use std::net::TcpListener;
    use std::process::{Command, Output};

    struct Setup {
        directory: TempDir,
        config: PathBuf,
        file: PathBuf,
    }

    fn toml_string(path: &Path) -> String {
        format!("{:?}", path.to_str().unwrap())
    }

    fn setup(api_url: &str) -> Setup {
        let directory = TempDir::new().unwrap();
        let base = directory.path().join("vms");
        let executable = directory.path().join("qemu.exe");
        fs::create_dir(&base).unwrap();
        fs::write(&executable, "").unwrap();
        let config = directory.path().join("agent.toml");
        fs::write(
            &config,
            format!(
                "[server]\napi_url = \"{api_url}\"\n\
                 [emulators.qemu]\nbase_path = {}\nexecutable = {}\n\
                 [state]\ndir = {}\n",
                toml_string(&base),
                toml_string(&executable),
                toml_string(&directory.path().join("state")),
            ),
        )
        .unwrap();
        let folder = directory.path().join("Macchine virtuali — Ελληνικά");
        fs::create_dir(&folder).unwrap();
        let file = write(
            &folder,
            "DOS 6.22.ova",
            &virtualbox_ova("DOS-6.22", &disk(20_000)),
        );
        Setup {
            directory,
            config,
            file,
        }
    }

    impl Setup {
        fn pair(&self, origin: &str) {
            let state = self.directory.path().join("state");
            fs::create_dir_all(&state).unwrap();
            platform_store(&state)
                .save(&StoredCredential {
                    server_origin: origin.to_owned(),
                    agent_id: Uuid::new_v4(),
                    credential: Secret::new("emc_agent_test-credential-never-printed"),
                })
                .unwrap();
        }

        fn run(&self, extra: &[&str]) -> Output {
            let mut arguments = vec![
                "--config",
                self.config.to_str().unwrap(),
                "import-ova",
                "--file",
                self.file.to_str().unwrap(),
            ];
            arguments.extend_from_slice(extra);
            agent(&arguments)
        }
    }

    fn agent(arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_emucat-agent"))
            .args(arguments)
            .env_remove("EMUCAT_AGENT_CONFIG")
            .env_remove("EMUCAT_AGENT_API_URL")
            .output()
            .unwrap()
    }

    fn text(output: &Output) -> String {
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    fn json(output: &Output) -> serde_json::Value {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        assert_eq!(
            lines.len(),
            1,
            "one JSON object on standard output: {stdout}"
        );
        serde_json::from_str(lines[0]).unwrap()
    }

    /// A server that answers every request with the same status and body, and records the requests.
    fn server(status: u16, body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut received = Vec::new();
                let mut buffer = [0u8; 4096];
                while let Ok(count) = stream.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    received.extend_from_slice(&buffer[..count]);
                    let request = String::from_utf8_lossy(&received);
                    if let Some(end) = request.find("\r\n\r\n") {
                        let length = request[..end]
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                if name.eq_ignore_ascii_case("content-length") {
                                    value.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                        if received.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&received).into_owned());
                let response = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{address}"), requests)
    }

    #[test]
    fn the_help_describes_the_command() {
        let output = agent(&["import-ova", "--help"]);
        assert!(output.status.success());
        let help = text(&output);
        for expected in [
            "--file",
            "--name",
            "--description",
            "--dry-run",
            "--json",
            "Exit codes",
            "130",
        ] {
            assert!(help.contains(expected), "missing {expected}: {help}");
        }
        assert!(text(&agent(&["--help"])).contains("import-ova"));
    }

    #[test]
    fn missing_arguments_are_invalid_input() {
        assert_eq!(agent(&["import-ova"]).status.code(), Some(2));
        assert_eq!(
            agent(&["import-ova", "--file", "x.ova"]).status.code(),
            Some(2)
        );
    }

    #[test]
    fn a_missing_file_or_a_bad_name_is_invalid_input_and_needs_no_configuration() {
        let setup = setup("http://127.0.0.1:9");
        let missing = agent(&[
            "import-ova",
            "--file",
            "does-not-exist.ova",
            "--name",
            "DOS",
        ]);
        assert_eq!(missing.status.code(), Some(2), "{}", text(&missing));
        let bad_name = setup.run(&["--name", "../evil"]);
        assert_eq!(bad_name.status.code(), Some(2), "{}", text(&bad_name));
        let output = setup.run(&["--name", "DOS", "--description", "bad\u{7}text"]);
        assert_eq!(output.status.code(), Some(2), "{}", text(&output));
    }

    #[test]
    fn an_invalid_ova_exits_3_with_a_json_error() {
        let setup = setup("http://127.0.0.1:9");
        fs::write(&setup.file, disk(4096)).unwrap();
        let output = setup.run(&["--name", "DOS", "--json"]);
        assert_eq!(output.status.code(), Some(3), "{}", text(&output));
        let value = json(&output);
        assert_eq!(value["status"], "failed");
        assert_eq!(value["exitCode"], 3);
        assert!(value["error"]["code"].as_str().is_some(), "{value}");
    }

    #[test]
    fn an_unpaired_agent_exits_4() {
        let setup = setup("http://127.0.0.1:9");
        let output = setup.run(&["--name", "DOS", "--json"]);
        assert_eq!(output.status.code(), Some(4), "{}", text(&output));
        assert_eq!(json(&output)["error"]["code"], "not_paired");
    }

    #[test]
    fn a_credential_for_another_server_is_not_sent() {
        let (url, requests) = server(200, "{}");
        let setup = setup(&url);
        setup.pair("http://127.0.0.1:1");
        let output = setup.run(&["--name", "DOS", "--json"]);
        assert_eq!(output.status.code(), Some(4), "{}", text(&output));
        assert_eq!(json(&output)["error"]["code"], "credential_mismatch");
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unreachable_server_exits_6() {
        // A port nothing listens on.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!("http://127.0.0.1:{port}");
        let setup = setup(&url);
        setup.pair(&url);
        let output = setup.run(&["--name", "DOS"]);
        assert_eq!(output.status.code(), Some(6), "{}", text(&output));
    }

    #[test]
    fn a_refused_credential_exits_4_and_is_never_printed() {
        let (url, requests) = server(
            401,
            r#"{"error":{"code":"unauthorized","message":"Authentication required"}}"#,
        );
        let setup = setup(&url);
        setup.pair(&url);
        let output = setup.run(&["--name", "DOS"]);
        assert_eq!(output.status.code(), Some(4), "{}", text(&output));
        assert!(!text(&output).contains("test-credential-never-printed"));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = requests[0].to_lowercase();
        assert!(
            request.starts_with("post /api/v1/agent/ova-imports/preflight "),
            "{request}"
        );
        assert!(request.contains("authorization: bearer emc_agent_test-credential-never-printed"));
        assert!(request.contains("x-emucat-protocol-version: 1"));
    }

    #[test]
    fn a_taken_name_exits_5() {
        let (url, _) = server(
            409,
            r#"{"error":{"code":"vm_already_registered","message":"A VirtualBox VM with this name is already in the catalog"}}"#,
        );
        let setup = setup(&url);
        setup.pair(&url);
        let output = setup.run(&["--name", "DOS-6.22", "--json"]);
        assert_eq!(output.status.code(), Some(5), "{}", text(&output));
        let value = json(&output);
        assert_eq!(value["error"]["code"], "vm_already_registered");
        assert_eq!(value["exitCode"], 5);
    }

    #[test]
    fn a_server_without_imports_is_reported_as_unsupported() {
        let (url, _) = server(
            404,
            r#"{"error":{"code":"not_found","message":"Not found"}}"#,
        );
        let setup = setup(&url);
        setup.pair(&url);
        let output = setup.run(&["--name", "DOS", "--json"]);
        assert_eq!(
            json(&output)["error"]["code"],
            "server_unsupported",
            "{}",
            text(&output)
        );
    }
}
