//! Archive creation against real files. Everything happens in temporary directories, and every test
//! that archives something also proves that the source was not changed.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use emucat_agent::emulators::{EmulatorType, VmName};
use emucat_agent::packaging::{
    BuildRequest, BuiltArchive, MANIFEST_ENTRY_NAME, MANIFEST_VERSION, ManifestEntryType,
    SourceErrorKind, build_archive, directory_identity, hash_file, hex, read_manifest,
    resolve_vm_root, scan_tree, staging_path,
};
use emucat_agent::repository::CancelFlag;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

/// Paths, sizes and modification times of everything under a directory.
fn fingerprint(root: &Path) -> BTreeMap<PathBuf, (u64, SystemTime, Vec<u8>)> {
    let mut found = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            let contents = if metadata.is_file() {
                fs::read(entry.path()).unwrap()
            } else {
                pending.push(entry.path());
                Vec::new()
            };
            found.insert(
                entry.path(),
                (metadata.len(), metadata.modified().unwrap(), contents),
            );
        }
    }
    found
}

fn write(path: &Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

struct Fixture {
    _base: TempDir,
    staging: TempDir,
    root: PathBuf,
    name: VmName,
    emulator: EmulatorType,
}

impl Fixture {
    fn new(emulator: EmulatorType, name: &str, files: &[(&str, &[u8])]) -> Self {
        let base = TempDir::new().unwrap();
        let root = base.path().join(name);
        fs::create_dir(&root).unwrap();
        for (path, contents) in files {
            write(&root.join(path), contents);
        }
        Self {
            _base: base,
            staging: TempDir::new().unwrap(),
            root,
            name: VmName::new(name).unwrap(),
            emulator,
        }
    }

    fn build(&self) -> Result<BuiltArchive, emucat_agent::packaging::SourceError> {
        self.build_with(&CancelFlag::new(), &mut |_| {})
    }

    fn build_with(
        &self,
        cancel: &CancelFlag,
        progress: &mut dyn FnMut(emucat_agent::packaging::BuildProgress),
    ) -> Result<BuiltArchive, emucat_agent::packaging::SourceError> {
        build_archive(
            &BuildRequest {
                emulator: self.emulator,
                vm_name: &self.name,
                root: &self.root,
                staging_dir: self.staging.path(),
                operation_id: Uuid::new_v4(),
            },
            progress,
            cancel,
        )
    }

    fn staging_is_empty(&self) -> bool {
        fs::read_dir(self.staging.path()).unwrap().count() == 0
    }
}

fn zip_names(path: &Path) -> Vec<String> {
    let archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut names: Vec<String> = archive.file_names().map(str::to_owned).collect();
    names.sort();
    names
}

fn zip_file(path: &Path, name: &str) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut entry = archive.by_name(name).unwrap();
    let mut contents = Vec::new();
    entry.read_to_end(&mut contents).unwrap();
    contents
}

#[test]
fn a_86box_vm_archives_without_a_wrapper_and_without_screenshots() {
    let fixture = Fixture::new(
        EmulatorType::Box86,
        "DOS 6.22",
        &[
            ("86box.cfg", b"machine = x\n"),
            ("disk.img", &[7u8; 4096]),
            ("nvr/ibm.nvr", b"nvram"),
            ("roms/local/bios.bin", b"firmware"),
            ("screenshots/one.png", b"not archived"),
            ("Screenshots2/kept.png", b"another directory is kept"),
        ],
    );
    // An empty directory is part of the VM. Windows is not case-sensitive, so the capitalization of
    // the excluded directory is tested in another test.
    fs::create_dir_all(fixture.root.join("empty/nested")).unwrap();
    let before = fingerprint(&fixture.root);
    let built = fixture.build().unwrap();
    assert_eq!(
        fingerprint(&fixture.root),
        before,
        "the source must not change"
    );

    assert_eq!(
        zip_names(&built.path),
        [
            MANIFEST_ENTRY_NAME,
            "86box.cfg",
            "Screenshots2/",
            "Screenshots2/kept.png",
            "disk.img",
            "empty/",
            "empty/nested/",
            "nvr/",
            "nvr/ibm.nvr",
            "roms/",
            "roms/local/",
            "roms/local/bios.bin",
        ]
    );
    assert_eq!(zip_file(&built.path, "86box.cfg"), b"machine = x\n");
    assert_eq!(zip_file(&built.path, "disk.img"), vec![7u8; 4096]);
    assert_eq!(built.manifest.file_count, 5);
    assert_eq!(
        built.manifest.total_uncompressed_bytes,
        12 + 4096 + 5 + 8 + 25
    );
}

#[test]
fn a_qemu_vm_excludes_root_ppm_files_and_nothing_else() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Win98",
        &[
            ("run.bat", b"@echo never run\n"),
            ("disk.qcow2", b"QFI\xfb"),
            ("shot.ppm", b"P6"),
            ("LOUD.PPM", b"P6"),
            ("docs/deep.ppm", b"P6 ordinary content"),
            ("photo.png", b"kept"),
        ],
    );
    let before = fingerprint(&fixture.root);
    let built = fixture.build().unwrap();
    assert_eq!(fingerprint(&fixture.root), before);
    assert_eq!(
        zip_names(&built.path),
        [
            MANIFEST_ENTRY_NAME,
            "disk.qcow2",
            "docs/",
            "docs/deep.ppm",
            "photo.png",
            "run.bat"
        ]
    );
}

#[test]
fn the_exclusion_of_screenshots_ignores_capitalization_but_only_at_the_root() {
    let fixture = Fixture::new(
        EmulatorType::Box86,
        "Box",
        &[
            ("86box.cfg", b"x"),
            ("SCREENSHOTS/one.png", b"excluded"),
            ("SCREENSHOTS/nested/two.png", b"excluded"),
            ("data/screenshots/kept.png", b"kept"),
        ],
    );
    let built = fixture.build().unwrap();
    let names = zip_names(&built.path);
    assert!(!names.iter().any(|name| name.starts_with("SCREENSHOTS")));
    assert!(names.contains(&"data/screenshots/kept.png".to_owned()));
    let tree = scan_tree(&fixture.root, EmulatorType::Box86).unwrap();
    assert_eq!(
        tree.excluded_files,
        ["SCREENSHOTS/nested/two.png", "SCREENSHOTS/one.png"]
    );
}

#[test]
fn a_file_named_screenshots_is_ordinary_content() {
    let fixture = Fixture::new(
        EmulatorType::Box86,
        "Box",
        &[("86box.cfg", b"x"), ("screenshots", b"a file")],
    );
    let built = fixture.build().unwrap();
    assert!(zip_names(&built.path).contains(&"screenshots".to_owned()));
}

#[test]
fn the_manifest_is_in_the_archive_and_describes_everything_else() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Win98",
        &[("run.bat", b"x"), ("b/two.bin", b"22"), ("a.bin", b"1")],
    );
    let built = fixture.build().unwrap();
    assert_eq!(read_manifest(&built.path).unwrap(), built.manifest);
    assert_eq!(built.manifest.manifest_version, MANIFEST_VERSION);

    let paths: Vec<&str> = built
        .manifest
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    assert_eq!(paths, ["a.bin", "b", "b/two.bin", "run.bat"], "byte order");
    assert!(
        !paths.contains(&MANIFEST_ENTRY_NAME),
        "it never lists itself"
    );

    let two = &built.manifest.entries[2];
    assert_eq!(two.entry_type, ManifestEntryType::File);
    assert_eq!(two.size_bytes, Some(2));
    assert_eq!(
        two.sha256.as_deref(),
        Some(hex(&Sha256::digest(b"22")).as_str())
    );
    let directory = &built.manifest.entries[1];
    assert_eq!(directory.entry_type, ManifestEntryType::Directory);
    assert_eq!(directory.sha256, None);

    assert_eq!(
        hex(&Sha256::digest(zip_file(&built.path, MANIFEST_ENTRY_NAME))),
        built.manifest_sha256
    );
    assert_eq!(built.manifest.sha256(), built.manifest_sha256);
}

#[test]
fn the_manifest_is_deterministic_and_does_not_depend_on_when_or_where() {
    let files: &[(&str, &[u8])] = &[
        ("run.bat", b"x"),
        ("nested/z.bin", b"z"),
        ("nested/a.bin", b"a"),
        ("disk.img", &[1u8; 2048]),
    ];
    let first = Fixture::new(EmulatorType::Qemu, "Same", files)
        .build()
        .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let second = Fixture::new(EmulatorType::Qemu, "Same", files)
        .build()
        .unwrap();
    assert_eq!(first.manifest, second.manifest);
    assert_eq!(first.manifest_sha256, second.manifest_sha256);
    // A change in one byte changes the manifest's hash and identifies the file.
    let third = Fixture::new(
        EmulatorType::Qemu,
        "Same",
        &[
            ("run.bat", b"x"),
            ("nested/z.bin", b"y"),
            ("nested/a.bin", b"a"),
            ("disk.img", &[1u8; 2048]),
        ],
    )
    .build()
    .unwrap();
    assert_ne!(first.manifest_sha256, third.manifest_sha256);
}

#[test]
fn the_reported_hash_and_size_are_those_of_the_finished_file() {
    let fixture = Fixture::new(EmulatorType::Qemu, "Win98", &[("run.bat", b"x")]);
    let built = fixture.build().unwrap();
    let bytes = fs::read(&built.path).unwrap();
    assert_eq!(built.size_bytes, bytes.len() as u64);
    assert_eq!(built.sha256, hex(&Sha256::digest(&bytes)));
    assert_eq!(
        hash_file(&built.path, &CancelFlag::new()).unwrap(),
        (built.size_bytes, built.sha256.clone())
    );
}

#[test]
fn nothing_is_created_inside_the_source() {
    let fixture = Fixture::new(EmulatorType::Qemu, "Win98", &[("run.bat", b"x")]);
    let built = fixture.build().unwrap();
    assert!(built.path.starts_with(fixture.staging.path()));
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
    let partial_left = fs::read_dir(fixture.staging.path())
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".partial"));
    assert!(!partial_left);
}

#[test]
fn a_staging_directory_inside_the_source_is_refused() {
    let fixture = Fixture::new(EmulatorType::Qemu, "Win98", &[("run.bat", b"x")]);
    let before = fingerprint(&fixture.root);
    fs::create_dir(fixture.root.join("staging")).unwrap();
    let error = build_archive(
        &BuildRequest {
            emulator: fixture.emulator,
            vm_name: &fixture.name,
            root: &fixture.root,
            staging_dir: &fixture.root.join("staging"),
            operation_id: Uuid::new_v4(),
        },
        &mut |_| {},
        &CancelFlag::new(),
    )
    .unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Staging);
    fs::remove_dir(fixture.root.join("staging")).unwrap();
    assert_eq!(fingerprint(&fixture.root).len(), before.len());
}

#[test]
fn already_compressed_images_are_stored_and_raw_disks_are_deflated() {
    let zeros = vec![0u8; 1024 * 1024];
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Mixed",
        &[
            ("run.bat", b"x"),
            ("compressed.qcow2", &zeros),
            ("IMAGE.VMDK", &zeros),
            ("raw.img", &zeros),
        ],
    );
    let built = fixture.build().unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&built.path).unwrap()).unwrap();
    let method = |archive: &mut zip::ZipArchive<fs::File>, name: &str| {
        let entry = archive.by_name(name).unwrap();
        (entry.compression(), entry.compressed_size())
    };
    assert_eq!(
        method(&mut archive, "compressed.qcow2").0,
        zip::CompressionMethod::Stored
    );
    assert_eq!(
        method(&mut archive, "IMAGE.VMDK").0,
        zip::CompressionMethod::Stored
    );
    let (raw_method, raw_size) = method(&mut archive, "raw.img");
    assert_eq!(raw_method, zip::CompressionMethod::Deflated);
    assert!(raw_size < 64 * 1024, "a raw empty disk shrinks: {raw_size}");
}

#[test]
fn progress_is_real_and_finishes_at_the_total() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Win98",
        &[
            ("run.bat", b"x"),
            ("disk.img", &vec![1u8; 40 * 1024 * 1024]),
        ],
    );
    let mut seen = Vec::new();
    fixture
        .build_with(&CancelFlag::new(), &mut |progress| seen.push(progress))
        .unwrap();
    let total = 40 * 1024 * 1024 + 1;
    assert_eq!(seen.first().unwrap().done_bytes, 0);
    assert!(seen.iter().all(|progress| progress.total_bytes == total));
    assert!(
        seen.windows(2)
            .all(|pair| pair[0].done_bytes <= pair[1].done_bytes)
    );
    assert_eq!(seen.last().unwrap().done_bytes, total);
}

#[test]
fn cancelling_leaves_nothing_behind_and_the_source_unchanged() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Win98",
        &[("run.bat", b"x"), ("disk.img", &vec![1u8; 8 * 1024 * 1024])],
    );
    let before = fingerprint(&fixture.root);
    let cancel = CancelFlag::new();
    cancel.cancel();
    let error = fixture.build_with(&cancel, &mut |_| {}).unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Cancelled);
    assert!(fixture.staging_is_empty());
    assert_eq!(fingerprint(&fixture.root), before);
}

#[test]
fn cancelling_while_running_stops_at_the_next_read() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Win98",
        &[
            ("run.bat", b"x"),
            ("disk.img", &vec![1u8; 64 * 1024 * 1024]),
        ],
    );
    let cancel = CancelFlag::new();
    let trigger = cancel.clone();
    let error = fixture
        .build_with(&cancel, &mut |progress| {
            if progress.done_bytes > 0 {
                trigger.cancel();
            }
        })
        .unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Cancelled);
    assert!(fixture.staging_is_empty());
}

/// Changes the source partway through, from the progress callback, as a running VM would.
fn change_during_build(
    fixture: &Fixture,
    change: impl Fn(&Path),
) -> emucat_agent::packaging::SourceError {
    let root = fixture.root.clone();
    let mut changed = false;
    let error = fixture
        .build_with(&CancelFlag::new(), &mut |progress| {
            if !changed && progress.done_bytes > 0 {
                changed = true;
                change(&root);
            }
        })
        .unwrap_err();
    assert!(fixture.staging_is_empty(), "a failure leaves no archive");
    error
}

fn large_fixture() -> Fixture {
    Fixture::new(
        EmulatorType::Qemu,
        "Busy",
        &[
            ("a-early.bin", &vec![1u8; 40 * 1024 * 1024]),
            ("run.bat", b"x"),
            ("z-late.bin", b"late"),
        ],
    )
}

#[test]
fn a_file_growing_after_it_was_listed_fails_the_archive() {
    let fixture = large_fixture();
    let error = change_during_build(&fixture, |root| {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(root.join("z-late.bin"))
            .unwrap();
        file.write_all(b"more").unwrap();
    });
    assert_eq!(error.kind, SourceErrorKind::Changed);
    assert!(error.message.contains("z-late.bin"), "{}", error.message);
}

#[test]
fn a_file_rewritten_with_the_same_size_fails_the_archive_when_its_time_changes() {
    let fixture = large_fixture();
    let error = change_during_build(&fixture, |root| {
        std::thread::sleep(Duration::from_millis(20));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(root.join("z-late.bin"))
            .unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(b"LATE").unwrap();
    });
    assert_eq!(error.kind, SourceErrorKind::Changed);
}

#[test]
fn a_file_appearing_or_disappearing_fails_the_archive() {
    let appeared = change_during_build(&large_fixture(), |root| {
        fs::write(root.join("new.bin"), b"new").unwrap();
    });
    assert_eq!(appeared.kind, SourceErrorKind::Changed);
    assert!(appeared.message.contains("new.bin"));

    let vanished = change_during_build(&large_fixture(), |root| {
        fs::remove_file(root.join("z-late.bin")).unwrap();
    });
    assert_eq!(vanished.kind, SourceErrorKind::Changed);
}

#[test]
fn a_replaced_marker_fails_the_archive() {
    let fixture = large_fixture();
    let error = change_during_build(&fixture, |root| {
        fs::remove_file(root.join("run.bat")).unwrap();
    });
    assert_eq!(error.kind, SourceErrorKind::Changed);
}

#[cfg(windows)]
#[test]
fn a_file_open_for_writing_elsewhere_is_reported_as_in_use() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Running",
        &[("run.bat", b"x"), ("disk.qcow2", b"disk")],
    );
    // What a running emulator does.
    let _held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.root.join("disk.qcow2"))
        .unwrap();
    let error = fixture.build().unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::InUse);
    assert!(fixture.staging_is_empty());
}

#[test]
fn a_reserved_name_cannot_be_archived_rather_than_being_overwritten() {
    let fixture = Fixture::new(
        EmulatorType::Qemu,
        "Odd",
        &[("run.bat", b"x"), (MANIFEST_ENTRY_NAME, b"mine")],
    );
    assert_eq!(fixture.build().unwrap_err().kind, SourceErrorKind::Invalid);
}

#[test]
fn a_directory_without_a_marker_is_not_a_vm() {
    let base = TempDir::new().unwrap();
    let name = VmName::new("Plain").unwrap();
    fs::create_dir(base.path().join("Plain")).unwrap();
    let error = resolve_vm_root(base.path(), &name, EmulatorType::Qemu).unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Invalid);
}

#[test]
fn the_spelling_of_a_vm_must_match_exactly() {
    let base = TempDir::new().unwrap();
    write(&base.path().join("Win98").join("run.bat"), b"x");
    let wrong = VmName::new("WIN98").unwrap();
    let error = resolve_vm_root(base.path(), &wrong, EmulatorType::Qemu).unwrap_err();
    assert_eq!(error.kind, SourceErrorKind::Missing);
    let right = VmName::new("Win98").unwrap();
    assert!(resolve_vm_root(base.path(), &right, EmulatorType::Qemu).is_ok());
}

#[test]
fn a_directory_identity_survives_a_rename_and_differs_from_another_directory() {
    let base = TempDir::new().unwrap();
    let first = base.path().join("first");
    let second = base.path().join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let identity = directory_identity(&first).unwrap();
    assert_ne!(identity, directory_identity(&second).unwrap());
    let moved = base.path().join("moved");
    fs::rename(&first, &moved).unwrap();
    assert_eq!(identity, directory_identity(&moved).unwrap());
}

/// ZIP64 needs more than 4 GiB of data, which is sparse here, and fast only with an optimized `sha2`.
#[test]
#[ignore = "reads more than 4 GiB. Run by pnpm test:sftp"]
fn a_file_larger_than_4_gib_uses_zip64_and_reads_back() {
    let fixture = Fixture::new(EmulatorType::Qemu, "Big", &[("run.bat", b"x")]);
    let path = fixture.root.join("big.img");
    let size = 4 * 1024 * 1024 * 1024 + 1024 * 1024u64;
    {
        let file = fs::File::create(&path).unwrap();
        file.set_len(size).unwrap();
    }
    let built = fixture.build().unwrap();
    assert_eq!(built.manifest.total_uncompressed_bytes, size + 1);

    let mut archive = zip::ZipArchive::new(fs::File::open(&built.path).unwrap()).unwrap();
    let mut entry = archive.by_name("big.img").unwrap();
    assert_eq!(entry.size(), size);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut read = 0u64;
    loop {
        let count = entry.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        read += count as u64;
    }
    assert_eq!(read, size);
    let expected = built
        .manifest
        .entries
        .iter()
        .find(|entry| entry.path == "big.img")
        .unwrap();
    assert_eq!(
        expected.sha256.as_deref(),
        Some(hex(&hasher.finalize()).as_str())
    );
}

#[test]
fn staging_path_is_unique_per_operation_and_outside_the_source() {
    let directory = Path::new("staging");
    let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
    assert_ne!(
        staging_path(directory, first),
        staging_path(directory, second)
    );
}

#[cfg(windows)]
mod links {
    use std::process::Command;

    use super::*;

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
    }

    #[test]
    fn a_junction_inside_a_vm_fails_the_archive_and_is_not_followed() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), b"outside the VM").unwrap();
        let fixture = Fixture::new(EmulatorType::Qemu, "Linked", &[("run.bat", b"x")]);
        junction(&fixture.root.join("data"), outside.path());
        let error = fixture.build().unwrap_err();
        assert_eq!(error.kind, SourceErrorKind::Unsafe);
        assert!(fixture.staging_is_empty());
    }

    #[test]
    fn a_junction_as_the_vm_itself_is_refused() {
        let base = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("run.bat"), b"x").unwrap();
        junction(&base.path().join("Linked"), outside.path());
        let name = VmName::new("Linked").unwrap();
        let error = resolve_vm_root(base.path(), &name, EmulatorType::Qemu).unwrap_err();
        assert_eq!(error.kind, SourceErrorKind::Unsafe);
    }

    #[test]
    fn a_junction_inside_the_screenshots_directory_is_refused_too() {
        let outside = TempDir::new().unwrap();
        let fixture = Fixture::new(
            EmulatorType::Box86,
            "Box",
            &[("86box.cfg", b"x"), ("screenshots/one.png", b"s")],
        );
        junction(
            &fixture.root.join("screenshots").join("more"),
            outside.path(),
        );
        assert_eq!(fixture.build().unwrap_err().kind, SourceErrorKind::Unsafe);
    }
}
