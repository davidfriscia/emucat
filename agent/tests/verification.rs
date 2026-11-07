//! Verifying a local copy against the manifest of its master: every outcome, the exclusion of
//! screenshots, refusing links, and that nothing is ever written. Fixtures are temporary directories.

use std::fs;
use std::path::{Path, PathBuf};

use emucat_agent::emulators::{EmulatorType, VmName};
use emucat_agent::packaging::{BuildRequest, Manifest, build_archive};
use emucat_agent::repository::CancelFlag;
use emucat_agent::verification::{VerifyStatus, verify_local_copy};
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    _directory: TempDir,
    root: PathBuf,
    manifest: Manifest,
}

fn fixture() -> Fixture {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("vms").join("dos");
    fs::create_dir_all(root.join("disks")).unwrap();
    fs::write(root.join("86box.cfg"), "[General]\nmachine = ibm5150\n").unwrap();
    fs::write(root.join("disks").join("c.img"), vec![7u8; 300_000]).unwrap();
    fs::write(root.join("nvr.bin"), [1, 2, 3]).unwrap();
    let staging = directory.path().join("staging");
    fs::create_dir_all(&staging).unwrap();
    let built = build_archive(
        &BuildRequest {
            emulator: EmulatorType::Box86,
            vm_name: &VmName::new("dos").unwrap(),
            root: &root,
            staging_dir: &staging,
            operation_id: Uuid::new_v4(),
        },
        &mut |_| {},
        &CancelFlag::new(),
    )
    .unwrap();
    Fixture {
        _directory: directory,
        root,
        manifest: built.manifest,
    }
}

fn verify(fixture: &Fixture) -> emucat_agent::verification::VerifyOutcome {
    verify_local_copy(
        &fixture.root,
        EmulatorType::Box86,
        &fixture.manifest,
        &CancelFlag::new(),
    )
}

/// Every file's bytes and modification time, to prove that verifying wrote nothing.
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>, std::time::SystemTime)> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap().flatten() {
            let path = entry.path();
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                pending.push(path);
            } else {
                files.push((
                    path.clone(),
                    fs::read(&path).unwrap(),
                    metadata.modified().unwrap(),
                ));
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

#[test]
fn an_unchanged_copy_is_verified_and_left_exactly_as_it_was() {
    let fixture = fixture();
    let before = snapshot(&fixture.root);
    let outcome = verify(&fixture);
    assert_eq!(outcome.status, VerifyStatus::Verified, "{outcome:?}");
    assert_eq!(outcome.files_verified, 3);
    assert_eq!(
        outcome.bytes_hashed,
        300_000
            + 3
            + "[General]
machine = ibm5150
"
            .len() as u64
    );
    assert_eq!(
        outcome.missing.count + outcome.modified.count + outcome.unexpected.count,
        0
    );
    assert_eq!(snapshot(&fixture.root), before);
}

#[test]
fn screenshots_are_neither_expected_nor_unexpected() {
    let fixture = fixture();
    fs::create_dir_all(fixture.root.join("screenshots")).unwrap();
    fs::write(
        fixture.root.join("screenshots").join("shot.png"),
        [0x89, b'P', b'N', b'G'],
    )
    .unwrap();
    assert_eq!(verify(&fixture).status, VerifyStatus::Verified);
}

#[test]
fn a_changed_file_is_modified_even_when_its_size_is_the_same() {
    let fixture = fixture();
    let mut disk = fs::read(fixture.root.join("disks").join("c.img")).unwrap();
    disk[150_000] = 8;
    fs::write(fixture.root.join("disks").join("c.img"), disk).unwrap();
    let outcome = verify(&fixture);
    assert_eq!(outcome.status, VerifyStatus::Modified);
    assert_eq!(outcome.modified.count, 1);
    assert_eq!(outcome.modified.paths, vec!["disks/c.img".to_owned()]);
}

#[test]
fn an_extra_file_is_modified_and_named() {
    let fixture = fixture();
    fs::write(fixture.root.join("disks").join("d.img"), [0u8; 10]).unwrap();
    let outcome = verify(&fixture);
    assert_eq!(outcome.status, VerifyStatus::Modified);
    assert_eq!(outcome.unexpected.paths, vec!["disks/d.img".to_owned()]);
    assert_eq!(outcome.files_verified, 3);
}

#[test]
fn a_missing_file_outranks_a_modified_one() {
    let fixture = fixture();
    fs::remove_file(fixture.root.join("nvr.bin")).unwrap();
    fs::write(fixture.root.join("86box.cfg"), "changed").unwrap();
    let outcome = verify(&fixture);
    assert_eq!(outcome.status, VerifyStatus::Missing);
    assert_eq!(outcome.missing.paths, vec!["nvr.bin".to_owned()]);
    assert_eq!(outcome.modified.count, 1);
}

#[test]
fn counts_are_complete_when_the_lists_are_cut_short() {
    let fixture = fixture();
    for index in 0..30 {
        fs::write(fixture.root.join(format!("extra-{index:02}.txt")), "x").unwrap();
    }
    let outcome = verify(&fixture);
    assert_eq!(outcome.unexpected.count, 30);
    assert_eq!(
        outcome.unexpected.paths.len(),
        emucat_agent::verification::LISTED_PATHS_MAX
    );
}

#[test]
fn a_cancelled_verification_never_says_verified() {
    let fixture = fixture();
    let cancel = CancelFlag::new();
    cancel.cancel();
    let outcome = verify_local_copy(
        &fixture.root,
        EmulatorType::Box86,
        &fixture.manifest,
        &cancel,
    );
    assert_eq!(outcome.status, VerifyStatus::VerificationFailed);
}

#[cfg(windows)]
#[test]
fn a_link_inside_the_vm_fails_the_check_instead_of_being_followed() {
    let fixture = fixture();
    let outside = fixture
        .root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("outside");
    fs::create_dir_all(&outside).unwrap();
    // A junction needs no privilege, unlike a symbolic link.
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fixture.root.join("linked"))
        .arg(&outside)
        .output()
        .unwrap();
    assert!(status.status.success(), "{status:?}");
    let outcome = verify(&fixture);
    assert_eq!(outcome.status, VerifyStatus::VerificationFailed);
    assert!(outcome.message.unwrap().contains("verified safely"));
    fs::remove_dir(fixture.root.join("linked")).unwrap();
}
