//! Runs discovery against real, temporary directories.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use emucat_agent::config::EmulatorConfig;
use emucat_agent::discovery::{
    DiscoveryReport, EmulatorStatus, MAX_SKIPPED, MAX_VMS, ScanLimits, SkipReason, SkippedEntry,
    scan,
};
use emucat_agent::emulators::EmulatorType;
use emucat_agent::platform::Platform;
use emucat_agent::protocol::AGENT_MAX_MESSAGE_BYTES;
use tempfile::TempDir;

fn touch(path: &Path) {
    fs::write(path, b"contents").unwrap();
}

/// A VM directory holding the given files.
fn vm(base: &Path, name: &str, files: &[&str]) -> PathBuf {
    let directory = base.join(name);
    fs::create_dir(&directory).unwrap();
    for file in files {
        touch(&directory.join(file));
    }
    directory
}

fn scan_of(emulator: EmulatorType, base: &Path, host: Platform) -> DiscoveryReport {
    scan_limited(emulator, base, host, &ScanLimits::default())
}

fn scan_limited(
    emulator: EmulatorType,
    base: &Path,
    host: Platform,
    limits: &ScanLimits,
) -> DiscoveryReport {
    let emulators = BTreeMap::from([(
        emulator,
        EmulatorConfig {
            base_path: base.to_path_buf(),
            executable: PathBuf::from("unused"),
        },
    )]);
    scan(&emulators, host, limits)
}

fn names(report: &DiscoveryReport) -> Vec<&str> {
    report.vms.iter().map(|vm| vm.vm_name.as_str()).collect()
}

fn skip_of<'a>(report: &'a DiscoveryReport, name: &str) -> &'a SkippedEntry {
    report
        .skipped
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("{name} was not skipped: {report:?}"))
}

fn status_of(report: &DiscoveryReport, emulator: EmulatorType) -> EmulatorStatus {
    report
        .emulators
        .iter()
        .find(|entry| entry.emulator_type == emulator)
        .unwrap()
        .status
}

#[test]
fn finds_a_valid_86box_vm_without_an_nvr_directory() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "DOS 6.22", &["86box.cfg"]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), ["DOS 6.22"]);
    assert_eq!(report.vms[0].markers, ["86box.cfg"]);
    assert_eq!(report.vms[0].host_compatible, None);
    assert_eq!(status_of(&report, EmulatorType::Box86), EmulatorStatus::Ok);
    assert_eq!(
        status_of(&report, EmulatorType::Qemu),
        EmulatorStatus::NotConfigured
    );
}

#[test]
fn reports_host_compatibility_for_qemu() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "OnlyWin", &["run-win.cmd"]);
    vm(base.path(), "OnlyLinux", &["run-linux.sh"]);
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
    let of = |name: &str| {
        report
            .vms
            .iter()
            .find(|vm| vm.vm_name.as_str() == name)
            .unwrap()
            .host_compatible
    };
    assert_eq!(of("OnlyWin"), Some(true));
    assert_eq!(of("OnlyLinux"), Some(false));

    let on_linux = scan_of(EmulatorType::Qemu, base.path(), Platform::Linux);
    assert_eq!(on_linux.vms[0].host_compatible, Some(true));
}

#[test]
fn reports_every_qemu_script_present_in_a_fixed_order() {
    let base = TempDir::new().unwrap();
    vm(
        base.path(),
        "All",
        &["run-linux.sh", "run-mac.sh", "run-win.cmd", "disk.qcow2"],
    );
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Macos);
    assert_eq!(
        report.vms[0].markers,
        ["run-win.cmd", "run-mac.sh", "run-linux.sh"]
    );
    assert_eq!(report.vms[0].host_compatible, Some(true));
}

#[test]
fn a_real_world_qemu_directory_with_run_bat_is_a_vm() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "garmin", &["run.bat", "run.sh", "winxp.qcow2"]);
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
    assert_eq!(report.vms[0].markers, ["run.bat"]);
    assert_eq!(report.vms[0].host_compatible, Some(true));
    let on_linux = scan_of(EmulatorType::Qemu, base.path(), Platform::Linux);
    assert_eq!(on_linux.vms[0].host_compatible, Some(false));
}

#[test]
fn every_windows_launcher_is_recognized_and_reported_with_its_original_name() {
    let base = TempDir::new().unwrap();
    for script in ["run.bat", "run.cmd", "run-win.bat", "run-win.cmd"] {
        vm(base.path(), &format!("Only {script}"), &[script]);
        let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
        let found = report
            .vms
            .iter()
            .find(|vm| vm.vm_name.as_str() == format!("Only {script}"))
            .unwrap();
        assert_eq!(found.markers, [script]);
        assert_eq!(found.host_compatible, Some(true));
    }
}

#[test]
fn a_launcher_with_other_capitalization_or_another_name_does_not_count() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Shouting", &["RUN.BAT"]);
    vm(base.path(), "Shell only", &["run.sh"]);
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
    assert!(report.vms.is_empty());
    assert_eq!(
        skip_of(&report, "Shouting").reason,
        SkipReason::MarkerWrongCase
    );
    assert_eq!(
        skip_of(&report, "Shell only").reason,
        SkipReason::MissingMarker
    );
}

#[test]
fn a_directory_without_a_marker_is_reported() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Empty", &[]);
    vm(base.path(), "OtherEmulator", &["run-win.cmd"]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), Vec::<&str>::new());
    assert_eq!(skip_of(&report, "Empty").reason, SkipReason::MissingMarker);
    assert_eq!(
        skip_of(&report, "OtherEmulator").reason,
        SkipReason::MissingMarker
    );
}

#[test]
fn a_marker_must_be_a_regular_file() {
    let base = TempDir::new().unwrap();
    let directory = vm(base.path(), "Fake", &[]);
    fs::create_dir(directory.join("86box.cfg")).unwrap();
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), Vec::<&str>::new());
    assert_eq!(skip_of(&report, "Fake").reason, SkipReason::MissingMarker);
}

#[test]
fn a_marker_deeper_than_the_root_does_not_count() {
    let base = TempDir::new().unwrap();
    let directory = vm(base.path(), "Deep", &[]);
    fs::create_dir(directory.join("sub")).unwrap();
    touch(&directory.join("sub").join("86box.cfg"));
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), Vec::<&str>::new());
}

#[test]
fn only_immediate_children_are_candidates() {
    let base = TempDir::new().unwrap();
    let group = vm(base.path(), "Group", &[]);
    vm(&group, "Nested", &["86box.cfg"]);
    touch(&base.path().join("86box.cfg"));
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), Vec::<&str>::new());
    assert_eq!(report.skipped.len(), 1, "{report:?}");
    assert_eq!(report.skipped[0].name, "Group");
}

#[test]
fn a_loose_file_in_the_base_path_is_not_mentioned() {
    let base = TempDir::new().unwrap();
    touch(&base.path().join("notes.txt"));
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert!(report.vms.is_empty());
    assert!(report.skipped.is_empty());
}

#[test]
fn invalid_names_are_reported_and_never_normalized() {
    let base = TempDir::new().unwrap();
    for (name, code) in [
        ("Win98_202601311530", "snapshot_suffix"),
        ("-rf", "invalid_boundary"),
        ("a..b", "repeated_separator"),
        ("two  spaces", "repeated_separator"),
        ("café", "invalid_characters"),
    ] {
        vm(base.path(), name, &["86box.cfg"]);
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        let shown = name.replace('é', "?");
        let entry = skip_of(&report, &shown);
        assert_eq!(entry.reason, SkipReason::InvalidName, "{name}");
        assert_eq!(entry.name_error.as_deref(), Some(code), "{name}");
        assert!(report.vms.is_empty(), "{name}");
        assert!(base.path().join(name).is_dir(), "{name} was not left alone");
        fs::remove_dir_all(base.path().join(name)).unwrap();
    }
}

#[test]
fn a_name_that_is_too_long_is_reported_in_a_bounded_form() {
    let base = TempDir::new().unwrap();
    let name = "x".repeat(70);
    vm(base.path(), &name, &["86box.cfg"]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(report.skipped[0].name, name);
    assert_eq!(report.skipped[0].name_error.as_deref(), Some("too_long"));
}

#[test]
fn marker_matching_is_exact_whatever_the_filesystem_does() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Shouting", &["86BOX.CFG"]);
    vm(base.path(), "Exact", &["86box.cfg"]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    assert_eq!(names(&report), ["Exact"]);
    assert_eq!(
        skip_of(&report, "Shouting").reason,
        SkipReason::MarkerWrongCase
    );
}

/// Directories differing only by case exist only on a case-sensitive filesystem.
#[cfg(target_os = "linux")]
#[test]
fn one_identity_cannot_be_two_directories() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Win98", &["86box.cfg"]);
    vm(base.path(), "win98", &["86box.cfg"]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Linux);
    assert_eq!(names(&report), ["Win98"]);
    assert_eq!(
        skip_of(&report, "win98").reason,
        SkipReason::DuplicateIdentity
    );
}

#[test]
fn an_empty_base_path_is_an_empty_report() {
    let base = TempDir::new().unwrap();
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
    assert_eq!(status_of(&report, EmulatorType::Qemu), EmulatorStatus::Ok);
    assert!(report.vms.is_empty());
    assert!(report.skipped.is_empty());
}

#[test]
fn a_missing_base_path_is_reported_and_not_created() {
    let parent = TempDir::new().unwrap();
    let missing = parent.path().join("missing");
    let report = scan_of(EmulatorType::Qemu, &missing, Platform::Windows);
    assert_eq!(
        status_of(&report, EmulatorType::Qemu),
        EmulatorStatus::BasePathMissing
    );
    assert!(!missing.exists());
}

#[test]
fn a_file_as_a_base_path_is_reported() {
    let parent = TempDir::new().unwrap();
    let file = parent.path().join("file");
    touch(&file);
    let report = scan_of(EmulatorType::Qemu, &file, Platform::Windows);
    assert_eq!(
        status_of(&report, EmulatorType::Qemu),
        EmulatorStatus::BasePathNotDirectory
    );
}

#[cfg(windows)]
mod windows_links {
    use std::process::Command;

    use super::*;

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "cannot create a junction");
    }

    #[test]
    fn a_junction_is_never_entered() {
        let outside = TempDir::new().unwrap();
        vm(outside.path(), "Secret", &["86box.cfg"]);
        touch(&outside.path().join("86box.cfg"));

        let base = TempDir::new().unwrap();
        junction(&base.path().join("Linked"), outside.path());

        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        assert_eq!(names(&report), Vec::<&str>::new());
        assert_eq!(skip_of(&report, "Linked").reason, SkipReason::ReparsePoint);
    }

    /// Creating a symbolic link needs Developer Mode or elevation, so this skips itself without it.
    #[test]
    fn a_directory_symlink_is_never_entered() {
        let outside = TempDir::new().unwrap();
        touch(&outside.path().join("86box.cfg"));
        let base = TempDir::new().unwrap();
        let link = base.path().join("Linked");
        if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
            eprintln!("skipped: this account cannot create symbolic links");
            return;
        }
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        assert_eq!(names(&report), Vec::<&str>::new());
        assert_eq!(skip_of(&report, "Linked").reason, SkipReason::ReparsePoint);
    }

    #[test]
    fn a_symlinked_marker_is_not_a_regular_file() {
        let outside = TempDir::new().unwrap();
        let target = outside.path().join("real.cfg");
        touch(&target);
        let base = TempDir::new().unwrap();
        let directory = vm(base.path(), "LinkedMarker", &[]);
        if std::os::windows::fs::symlink_file(&target, directory.join("86box.cfg")).is_err() {
            eprintln!("skipped: this account cannot create symbolic links");
            return;
        }
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        assert_eq!(names(&report), Vec::<&str>::new());
        assert_eq!(
            skip_of(&report, "LinkedMarker").reason,
            SkipReason::MissingMarker
        );
    }

    /// Denies this user access with an ACL, and always restores it so the directory can be removed.
    #[test]
    fn an_inaccessible_directory_is_reported_and_the_rest_continue() {
        struct Restore(PathBuf, String);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = Command::new("icacls")
                    .arg(&self.0)
                    .args(["/remove:d", &self.1])
                    .output();
            }
        }

        let base = TempDir::new().unwrap();
        let locked = vm(base.path(), "Locked", &["86box.cfg"]);
        vm(base.path(), "Open", &["86box.cfg"]);
        let user = std::env::var("USERNAME").unwrap();
        let denied = Command::new("icacls")
            .arg(&locked)
            .args(["/deny", &format!("{user}:(OI)(CI)F")])
            .output()
            .unwrap();
        assert!(denied.status.success());
        let _restore = Restore(locked, user);

        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        assert_eq!(names(&report), ["Open"]);
        assert_eq!(skip_of(&report, "Locked").reason, SkipReason::NotAccessible);
    }
}

#[cfg(unix)]
mod unix_links {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    #[test]
    fn a_symlink_is_never_entered() {
        let outside = TempDir::new().unwrap();
        touch(&outside.path().join("86box.cfg"));
        let base = TempDir::new().unwrap();
        symlink(outside.path(), base.path().join("Linked")).unwrap();
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Linux);
        assert_eq!(names(&report), Vec::<&str>::new());
        assert_eq!(skip_of(&report, "Linked").reason, SkipReason::ReparsePoint);
    }

    #[test]
    fn a_symlinked_marker_is_not_a_regular_file() {
        let outside = TempDir::new().unwrap();
        touch(&outside.path().join("real"));
        let base = TempDir::new().unwrap();
        let directory = vm(base.path(), "LinkedMarker", &[]);
        symlink(outside.path().join("real"), directory.join("86box.cfg")).unwrap();
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Linux);
        assert_eq!(names(&report), Vec::<&str>::new());
    }

    #[test]
    fn an_inaccessible_directory_is_reported() {
        let base = TempDir::new().unwrap();
        let locked = vm(base.path(), "Locked", &["86box.cfg"]);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0)).unwrap();
        let readable = fs::read_dir(&locked).is_ok();
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Linux);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if readable {
            eprintln!("skipped: running as a user that ignores permissions");
            return;
        }
        assert_eq!(skip_of(&report, "Locked").reason, SkipReason::NotAccessible);
    }
}

#[test]
fn limits_bound_a_scan_and_are_reported() {
    let base = TempDir::new().unwrap();
    for index in 0..6 {
        vm(base.path(), &format!("Vm{index}"), &["86box.cfg"]);
        vm(base.path(), &format!("Empty{index}"), &[]);
    }
    let limits = ScanLimits {
        max_vms: 2,
        max_skipped: 3,
        ..ScanLimits::default()
    };
    let report = scan_limited(EmulatorType::Box86, base.path(), Platform::Windows, &limits);
    assert_eq!(report.vms.len(), 2);
    assert_eq!(report.skipped.len(), 3);
    assert!(report.emulators[0].truncated);

    let limits = ScanLimits {
        max_base_entries: 1,
        ..ScanLimits::default()
    };
    let report = scan_limited(EmulatorType::Box86, base.path(), Platform::Windows, &limits);
    assert_eq!(report.vms.len() + report.skipped.len(), 1);
    assert!(report.emulators[0].truncated);
}

#[test]
fn a_root_with_too_many_entries_is_not_examined_further() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Crowded", &["a", "b", "c", "86box.cfg"]);
    let limits = ScanLimits {
        max_root_entries: 2,
        ..ScanLimits::default()
    };
    let report = scan_limited(EmulatorType::Box86, base.path(), Platform::Windows, &limits);
    assert_eq!(
        skip_of(&report, "Crowded").reason,
        SkipReason::TooManyEntries
    );
}

#[test]
fn a_spent_time_budget_ends_the_scan_with_what_it_has() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Vm", &["86box.cfg"]);
    let limits = ScanLimits {
        time_budget: Duration::ZERO,
        ..ScanLimits::default()
    };
    let report = scan_limited(EmulatorType::Box86, base.path(), Platform::Windows, &limits);
    assert!(report.vms.is_empty());
    assert!(report.emulators[0].truncated);
}

#[test]
fn the_largest_possible_report_fits_in_one_message() {
    let base = TempDir::new().unwrap();
    // The longest allowed names, with every marker, up to every limit.
    for index in 0..(MAX_VMS + 8) {
        vm(
            base.path(),
            &format!("{index:0>64}"),
            &[
                "run.bat",
                "run.cmd",
                "run-win.bat",
                "run-win.cmd",
                "run-mac.sh",
                "run-linux.sh",
            ],
        );
    }
    for index in 0..(MAX_SKIPPED + 8) {
        vm(base.path(), &format!("z{index:0>90}"), &[]);
    }
    let report = scan_of(EmulatorType::Qemu, base.path(), Platform::Windows);
    assert_eq!(report.vms.len(), MAX_VMS);
    assert_eq!(report.skipped.len(), MAX_SKIPPED);
    assert!(report.emulators[1].truncated);
    assert!(serde_json::to_vec(&report).unwrap().len() < AGENT_MAX_MESSAGE_BYTES - 512);
}

#[test]
fn a_disk_changing_during_the_scan_causes_no_failure() {
    let base = TempDir::new().unwrap();
    for index in 0..40 {
        vm(base.path(), &format!("Stable{index}"), &["86box.cfg"]);
    }
    let path = base.path().to_path_buf();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let churn = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut round = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let directory = path.join(format!("Churn{}", round % 16));
                let _ = fs::create_dir(&directory);
                let _ = fs::write(directory.join("86box.cfg"), b"x");
                let _ = fs::remove_dir_all(&directory);
                round += 1;
            }
        })
    };
    for _ in 0..50 {
        let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
        for index in 0..40 {
            let name = format!("Stable{index}");
            assert!(
                names(&report).contains(&name.as_str()),
                "{name} disappeared"
            );
        }
        for entry in &report.skipped {
            assert!(entry.name.starts_with("Churn"), "{entry:?}");
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    churn.join().unwrap();
}

/// Everything that could show a change: every name, type, size, content and modification time.
fn fingerprint(root: &Path) -> Vec<(PathBuf, bool, Vec<u8>, SystemTime)> {
    let mut all = Vec::new();
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
            all.push((
                entry.path(),
                metadata.is_dir(),
                contents,
                metadata.modified().unwrap(),
            ));
        }
    }
    all.sort_by(|a, b| a.0.cmp(&b.0));
    all
}

#[test]
fn a_scan_changes_nothing() {
    let base = TempDir::new().unwrap();
    let directory = vm(base.path(), "Keep", &["86box.cfg", "disk.img"]);
    fs::create_dir(directory.join("nvr")).unwrap();
    touch(&directory.join("nvr").join("machine.nvr"));
    vm(base.path(), "bad.", &["86box.cfg"]);
    vm(base.path(), "Empty", &[]);
    let before = fingerprint(base.path());
    for _ in 0..3 {
        scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    }
    assert_eq!(fingerprint(base.path()), before);
}

#[test]
fn a_report_contains_no_filesystem_path() {
    let base = TempDir::new().unwrap();
    vm(base.path(), "Vm", &["86box.cfg"]);
    vm(base.path(), "bad.", &[]);
    let report = scan_of(EmulatorType::Box86, base.path(), Platform::Windows);
    let json = serde_json::to_string(&report).unwrap();
    let base_name = base.path().file_name().unwrap().to_str().unwrap();
    assert!(!json.contains(base_name), "{json}");
    assert!(!json.contains(":\\\\"), "{json}");
}
