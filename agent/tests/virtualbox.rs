//! VirtualBox discovery: parsing VBoxManage's output, isolating failures, and running it safely.
//!
//! Parsing is tested against recorded output. Running is tested against `fake_vboxmanage`, which
//! `cargo test` builds next to the test executables. Nothing here runs the real VBoxManage.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use emucat_agent::config::{Config, SettingOverrides, Severity, validate};
use emucat_agent::discovery::{self, DiscoveryReport, ScanLimits};
use emucat_agent::platform::Platform;
use emucat_agent::virtualbox::{
    CommandOutput, CommandRunner, ProcessRunner, RunError, VIRTUALBOX_NAME_MAX_CHARS,
    VirtualBoxConfig, VirtualBoxLimits, VirtualBoxReport, VirtualBoxStatus, VirtualBoxVmError,
    VirtualBoxVmState, clean_text, discover, discover_with, parse_state_time, parse_version,
    parse_vm_list,
};
use serde_json::Value;
use tempfile::TempDir;

const LIST: &str = include_str!("fixtures/virtualbox/list-vms.txt");
const POWEROFF: &str = include_str!("fixtures/virtualbox/showvminfo-poweroff.txt");
const RUNNING: &str = include_str!("fixtures/virtualbox/showvminfo-running.txt");
const UNICODE: &str = include_str!("fixtures/virtualbox/showvminfo-unicode.txt");
const INACCESSIBLE: &str = include_str!("fixtures/virtualbox/showvminfo-inaccessible.txt");
const WIRE_EXAMPLES: &str = include_str!("../../packages/contracts/fixtures/wire-examples.json");

const XENIX: &str = "2acda0fc-cea6-406b-8a55-746fac380687";
const XP: &str = "97910566-2cc6-492b-9dc7-6cc6ee66ffd6";
const CITTA: &str = "14883fa7-b01e-46cc-ba51-04f36f2d7478";
const BROKEN: &str = "e725aa3d-977f-4463-918f-93d7a879f841";

/// Answers from a table, and records every call.
#[derive(Default)]
struct FakeRunner {
    answers: HashMap<Vec<String>, Result<CommandOutput, Fail>>,
    calls: Mutex<Vec<Vec<String>>>,
    delay: Duration,
}

#[derive(Clone, Copy)]
enum Fail {
    NotFound,
    Timeout,
}

fn ok(stdout: &str) -> Result<CommandOutput, Fail> {
    Ok(CommandOutput {
        success: true,
        stdout: stdout.to_owned(),
        stderr: String::new(),
    })
}

fn failed(stderr: &str) -> Result<CommandOutput, Fail> {
    Ok(CommandOutput {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_owned(),
    })
}

impl FakeRunner {
    fn standard() -> Self {
        let mut runner = Self::default();
        runner.answer(&["--version"], ok("7.1.10r169112\n"));
        runner.answer(&["list", "vms"], ok(LIST));
        runner.info(XENIX, ok(POWEROFF));
        runner.info(XP, ok(RUNNING));
        runner.info(CITTA, ok(UNICODE));
        runner.info(BROKEN, ok(INACCESSIBLE));
        runner
    }

    fn answer(&mut self, args: &[&str], answer: Result<CommandOutput, Fail>) {
        self.answers
            .insert(args.iter().map(|arg| (*arg).to_owned()).collect(), answer);
    }

    fn info(&mut self, uuid: &str, answer: Result<CommandOutput, Fail>) {
        self.answer(&["showvminfo", uuid, "--machinereadable"], answer);
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, args: &[&OsStr], _timeout: Duration) -> Result<CommandOutput, RunError> {
        let args: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        self.calls.lock().unwrap().push(args.clone());
        std::thread::sleep(self.delay);
        match self.answers.get(&args) {
            Some(Ok(output)) => Ok(output.clone()),
            Some(Err(Fail::NotFound)) => Err(RunError::NotFound),
            Some(Err(Fail::Timeout)) => Err(RunError::Timeout),
            None => Ok(CommandOutput {
                success: false,
                stdout: String::new(),
                stderr: "VBoxManage: error: unexpected".to_owned(),
            }),
        }
    }
}

fn limits() -> VirtualBoxLimits {
    VirtualBoxLimits::default()
}

fn vm<'a>(report: &'a VirtualBoxReport, uuid: &str) -> &'a emucat_agent::virtualbox::VirtualBoxVm {
    report
        .vms
        .iter()
        .find(|vm| vm.uuid.to_string() == uuid)
        .unwrap_or_else(|| panic!("{uuid} not reported"))
}

// Version.

#[test]
fn reads_the_version_vboxmanage_prints() {
    assert_eq!(
        parse_version("7.1.10r169112\n").as_deref(),
        Some("7.1.10r169112")
    );
    assert_eq!(
        parse_version("6.1.50_Ubuntur161033").as_deref(),
        Some("6.1.50_Ubuntur161033")
    );
    assert_eq!(
        parse_version("7.2.0_BETA1r170000\r\n").as_deref(),
        Some("7.2.0_BETA1r170000")
    );
}

#[test]
fn passes_over_warnings_printed_before_the_version() {
    let output = "WARNING: The vboxdrv kernel module is not loaded.\n         Please reinstall.\n7.0.20r163906\n";
    assert_eq!(parse_version(output).as_deref(), Some("7.0.20r163906"));
}

#[test]
fn does_not_take_anything_else_for_a_version() {
    for output in [
        "",
        "\n",
        "Oracle VM VirtualBox",
        "7",
        "x.1",
        "7.x",
        "7.1 extra words",
        &"7.1".repeat(40),
    ] {
        assert_eq!(parse_version(output), None, "{output:?}");
    }
}

// Listing.

#[test]
fn an_empty_list_is_no_machines() {
    let list = parse_vm_list("");
    assert!(list.vms.is_empty());
    assert_eq!(list.unrecognized, 0);
}

#[test]
fn lists_one_machine() {
    let list = parse_vm_list("\"Xenix 386\" {2acda0fc-cea6-406b-8a55-746fac380687}\n");
    assert_eq!(list.vms.len(), 1);
    assert_eq!(list.vms[0].name, "Xenix 386");
    assert_eq!(list.vms[0].uuid.to_string(), XENIX);
}

#[test]
fn lists_several_machines_in_order_with_any_name() {
    let list = parse_vm_list(LIST);
    let names: Vec<&str> = list.vms.iter().map(|vm| vm.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Xenix 386",
            "Windows XP ITA SP3 (x86)",
            "Città \"Ufficio\" {v2}",
            "<inaccessible>"
        ]
    );
    assert_eq!(list.unrecognized, 0);
}

#[test]
fn reads_windows_line_endings() {
    let list = parse_vm_list(
        "\"Xenix 386\" {2acda0fc-cea6-406b-8a55-746fac380687}\r\n\"Win 7\" {797c6ec2-92e3-4fe2-a1e4-2191ca0ace4e}\r\n",
    );
    assert_eq!(list.vms.len(), 2);
    assert_eq!(list.vms[1].name, "Win 7");
}

#[test]
fn two_machines_may_share_a_name() {
    let list = parse_vm_list(
        "\"Same\" {2acda0fc-cea6-406b-8a55-746fac380687}\n\"Same\" {797c6ec2-92e3-4fe2-a1e4-2191ca0ace4e}\n",
    );
    assert_eq!(list.vms.len(), 2);
}

#[test]
fn one_uuid_is_listed_once() {
    let list = parse_vm_list(
        "\"A\" {2acda0fc-cea6-406b-8a55-746fac380687}\n\"B\" {2acda0fc-cea6-406b-8a55-746fac380687}\n",
    );
    assert_eq!(list.vms.len(), 1);
}

#[test]
fn a_malformed_uuid_or_line_is_passed_over() {
    let list = parse_vm_list(concat!(
        "\"Good\" {2acda0fc-cea6-406b-8a55-746fac380687}\n",
        "\"No braces\" 2acda0fc-cea6-406b-8a55-746fac380687\n",
        "\"Short\" {2acda0fc-cea6-406b}\n",
        "\"Not hex\" {zzzzzzzz-cea6-406b-8a55-746fac380687}\n",
        "\"Unhyphenated\" {2acda0fccea6406b8a55746fac380687}\n",
        "\"Braced twice\" {{2acda0fc-cea6-406b-8a55-746fac380687}}\n",
        "Unquoted {2acda0fc-cea6-406b-8a55-746fac380687}\n",
        "garbage\n",
    ));
    assert_eq!(list.vms.len(), 1);
    assert_eq!(list.unrecognized, 7);
}

// Describing one machine.

#[test]
fn describes_a_powered_off_machine_and_reports_no_path() {
    let report = discover_with(&FakeRunner::standard(), &limits());
    let xenix = vm(&report, XENIX);
    assert_eq!(xenix.name, "Xenix 386");
    assert_eq!(xenix.os_type.as_deref(), Some("Other/Unknown"));
    assert_eq!(xenix.state, VirtualBoxVmState::PoweredOff);
    assert_eq!(xenix.raw_state.as_deref(), Some("poweroff"));
    assert_eq!(
        xenix.state_changed_at.as_deref(),
        Some("2025-07-18T05:33:15Z")
    );
    assert_eq!(xenix.accessible, Some(true));
    assert_eq!(xenix.memory_mb, Some(4));
    assert_eq!(xenix.cpus, Some(1));
    assert_eq!(xenix.error, None);

    let json = serde_json::to_string(&report).unwrap();
    for leak in [
        "someone",
        "VirtualBox VMs",
        ".vbox",
        ".vdi",
        "Shared",
        "\\\\",
        "C:",
    ] {
        assert!(!json.contains(leak), "{leak} leaked into {json}");
    }
}

#[test]
fn a_description_cannot_override_the_real_state() {
    // The fixture's multi-line description contains a VMState line of its own.
    let report = discover_with(&FakeRunner::standard(), &limits());
    assert_eq!(vm(&report, XENIX).state, VirtualBoxVmState::PoweredOff);
}

#[test]
fn describes_running_and_saved_machines() {
    let report = discover_with(&FakeRunner::standard(), &limits());
    assert_eq!(vm(&report, XP).state, VirtualBoxVmState::Running);
    assert_eq!(vm(&report, XP).cpus, Some(2));
    assert_eq!(vm(&report, CITTA).state, VirtualBoxVmState::Saved);
}

#[test]
fn keeps_a_unicode_name_with_quotes_and_braces() {
    let report = discover_with(&FakeRunner::standard(), &limits());
    assert_eq!(vm(&report, CITTA).name, "Città \"Ufficio\" {v2}");
}

#[test]
fn reports_an_inaccessible_machine_without_guessing() {
    let report = discover_with(&FakeRunner::standard(), &limits());
    let broken = vm(&report, BROKEN);
    assert_eq!(broken.state, VirtualBoxVmState::Inaccessible);
    assert_eq!(broken.accessible, Some(false));
    assert_eq!(broken.os_type, None);
    assert_eq!(broken.raw_state, None);
    assert_eq!(broken.memory_mb, None);
    assert_eq!(broken.error, None);
}

#[test]
fn maps_every_known_state_and_keeps_an_unknown_one() {
    let cases = [
        ("poweroff", VirtualBoxVmState::PoweredOff),
        ("running", VirtualBoxVmState::Running),
        ("paused", VirtualBoxVmState::Paused),
        ("saved", VirtualBoxVmState::Saved),
        ("aborted-saved", VirtualBoxVmState::Saved),
        ("starting", VirtualBoxVmState::Starting),
        ("restoring", VirtualBoxVmState::Starting),
        ("stopping", VirtualBoxVmState::Stopping),
        ("saving", VirtualBoxVmState::Stopping),
        ("aborted", VirtualBoxVmState::Aborted),
        ("gurumeditation", VirtualBoxVmState::Stuck),
        ("snapshotting", VirtualBoxVmState::Busy),
        ("livesnapshotting", VirtualBoxVmState::Running),
        ("teleported", VirtualBoxVmState::PoweredOff),
        ("hyperspace", VirtualBoxVmState::Unknown),
        ("", VirtualBoxVmState::Unknown),
    ];
    for (raw, state) in cases {
        assert_eq!(
            VirtualBoxVmState::from_machine_readable(raw),
            state,
            "{raw}"
        );
    }
}

#[test]
fn an_unknown_state_is_reported_with_what_virtualbox_said() {
    let mut runner = FakeRunner::standard();
    runner.info(
        XP,
        ok("name=\"Windows XP ITA SP3 (x86)\"\nVMState=\"hyperspace\"\n"),
    );
    let report = discover_with(&runner, &limits());
    assert_eq!(vm(&report, XP).state, VirtualBoxVmState::Unknown);
    assert_eq!(vm(&report, XP).raw_state.as_deref(), Some("hyperspace"));
    assert_eq!(report.vms.len(), 4, "the other machines are still there");
}

#[test]
fn reads_state_times_and_refuses_anything_else() {
    assert_eq!(
        parse_state_time("2026-04-10T12:27:31.000000000").as_deref(),
        Some("2026-04-10T12:27:31Z")
    );
    assert_eq!(
        parse_state_time("2026-04-10T12:27:31Z").as_deref(),
        Some("2026-04-10T12:27:31Z")
    );
    for bad in [
        "",
        "yesterday",
        "2026-13-10T12:27:31",
        "2026-04-10 12:27:31",
        "2026-04-10T12:27:31+02:00",
    ] {
        assert_eq!(parse_state_time(bad), None, "{bad}");
    }
}

#[test]
fn control_characters_never_reach_a_name_and_names_are_bounded() {
    assert_eq!(clean_text("a\u{0}b\nc\u{1b}[31m", 64), "abc[31m");
    let long = "é".repeat(500);
    assert_eq!(
        clean_text(&long, VIRTUALBOX_NAME_MAX_CHARS).chars().count(),
        VIRTUALBOX_NAME_MAX_CHARS
    );
}

#[test]
fn nonsense_numbers_are_left_out() {
    let mut runner = FakeRunner::standard();
    runner.info(
        XP,
        ok("name=\"XP\"\nmemory=-5\ncpus=99999999\nVMState=\"running\"\n"),
    );
    let report = discover_with(&runner, &limits());
    assert_eq!(vm(&report, XP).memory_mb, None);
    assert_eq!(vm(&report, XP).cpus, None);
}

// Failures.

#[test]
fn a_missing_executable_is_its_own_status() {
    let mut runner = FakeRunner::default();
    runner.answer(&["--version"], Err(Fail::NotFound));
    let report = discover_with(&runner, &limits());
    assert_eq!(report.status, VirtualBoxStatus::ExecutableMissing);
    assert!(report.vms.is_empty());
}

#[test]
fn a_version_that_times_out_is_reported() {
    let mut runner = FakeRunner::default();
    runner.answer(&["--version"], Err(Fail::Timeout));
    assert_eq!(
        discover_with(&runner, &limits()).status,
        VirtualBoxStatus::Timeout
    );
}

#[test]
fn an_unrecognized_version_stops_discovery() {
    let mut runner = FakeRunner::standard();
    runner.answer(&["--version"], ok("not a version\n"));
    let report = discover_with(&runner, &limits());
    assert_eq!(report.status, VirtualBoxStatus::UnrecognizedVersion);
    assert_eq!(runner.calls().len(), 1, "nothing else was run");
}

#[test]
fn a_failing_list_is_reported_with_the_version() {
    let mut runner = FakeRunner::standard();
    runner.answer(
        &["list", "vms"],
        failed("VBoxManage: error: Failed to create the VirtualBox object!"),
    );
    let report = discover_with(&runner, &limits());
    assert_eq!(report.status, VirtualBoxStatus::CommandFailed);
    assert_eq!(report.version.as_deref(), Some("7.1.10r169112"));
}

#[test]
fn a_list_of_nothing_but_garbage_is_unrecognized() {
    let mut runner = FakeRunner::standard();
    runner.answer(&["list", "vms"], ok("<html>error</html>\n"));
    assert_eq!(
        discover_with(&runner, &limits()).status,
        VirtualBoxStatus::UnrecognizedOutput
    );
}

#[test]
fn an_empty_installation_is_ok() {
    let mut runner = FakeRunner::standard();
    runner.answer(&["list", "vms"], ok(""));
    let report = discover_with(&runner, &limits());
    assert_eq!(report.status, VirtualBoxStatus::Ok);
    assert!(report.vms.is_empty());
}

#[test]
fn one_machine_that_cannot_be_inspected_does_not_cost_the_others() {
    let mut runner = FakeRunner::standard();
    runner.info(XP, failed("VBoxManage: error: Code E_ACCESSDENIED"));
    runner.info(CITTA, Err(Fail::Timeout));
    runner.info(
        BROKEN,
        failed("error: Details: code VBOX_E_OBJECT_NOT_FOUND (0x80bb0001)"),
    );
    let report = discover_with(&runner, &limits());
    assert_eq!(report.status, VirtualBoxStatus::Ok);
    assert_eq!(report.vms.len(), 4);
    assert_eq!(vm(&report, XENIX).error, None);

    let xp = vm(&report, XP);
    assert_eq!(xp.error, Some(VirtualBoxVmError::InspectionFailed));
    assert_eq!(
        xp.name, "Windows XP ITA SP3 (x86)",
        "the listed name is kept"
    );
    assert_eq!(xp.state, VirtualBoxVmState::Unknown);
    assert_eq!(xp.accessible, None);
    assert_eq!(vm(&report, CITTA).error, Some(VirtualBoxVmError::Timeout));
    assert_eq!(vm(&report, BROKEN).error, Some(VirtualBoxVmError::Vanished));
}

#[test]
fn the_time_budget_leaves_the_rest_uninspected() {
    let mut runner = FakeRunner::standard();
    runner.delay = Duration::from_millis(30);
    let report = discover_with(
        &runner,
        &VirtualBoxLimits {
            time_budget: Duration::from_millis(50),
            ..limits()
        },
    );
    assert!(report.truncated);
    assert_eq!(
        report.vms.len(),
        4,
        "every listed machine is still reported"
    );
    assert!(
        report
            .vms
            .iter()
            .any(|vm| vm.error == Some(VirtualBoxVmError::NotInspected))
    );
}

#[test]
fn the_machine_limit_truncates_the_list() {
    let report = discover_with(
        &FakeRunner::standard(),
        &VirtualBoxLimits {
            max_vms: 2,
            ..limits()
        },
    );
    assert!(report.truncated);
    assert_eq!(report.vms.len(), 2);
}

#[test]
fn only_read_only_commands_are_run_and_always_by_uuid() {
    let runner = FakeRunner::standard();
    discover_with(&runner, &limits());
    let calls = runner.calls();
    assert_eq!(calls[0], ["--version"]);
    assert_eq!(calls[1], ["list", "vms"]);
    for call in &calls[2..] {
        assert_eq!(call.len(), 3);
        assert_eq!(call[0], "showvminfo");
        assert_eq!(call[2], "--machinereadable");
        assert_eq!(call[1].len(), 36, "a UUID, never a name: {call:?}");
    }
    assert_eq!(calls.len(), 6);
}

// Configuration.

const BASE: &str = "[server]\napi_url = \"http://127.0.0.1:4000\"\n";

fn config(text: &str, env: &[(&str, &str)]) -> Result<Config, String> {
    let env: HashMap<String, String> = env
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    Config::from_toml(
        &format!("{BASE}{text}"),
        &|name| env.get(name).cloned(),
        &SettingOverrides::default(),
    )
    .map_err(|error| error.to_string())
}

#[test]
fn without_a_section_virtualbox_is_not_configured() {
    assert_eq!(config("", &[]).unwrap().virtualbox, None);
}

#[test]
fn the_section_names_vboxmanage() {
    let parsed = config(
        "[platforms.virtualbox]\nvboxmanage = 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe'\n",
        &[],
    )
    .unwrap();
    assert_eq!(
        parsed.virtualbox,
        Some(VirtualBoxConfig {
            vboxmanage: PathBuf::from(r"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe")
        })
    );
}

#[test]
fn the_environment_overrides_the_file() {
    let parsed = config(
        "[platforms.virtualbox]\nvboxmanage = 'C:\\a.exe'\n",
        &[("EMUCAT_AGENT_VIRTUALBOX_VBOXMANAGE", r"D:\b.exe")],
    )
    .unwrap();
    assert_eq!(
        parsed.virtualbox.unwrap().vboxmanage,
        PathBuf::from(r"D:\b.exe")
    );
}

#[test]
fn an_empty_section_or_an_unknown_setting_is_an_error() {
    assert!(config("[platforms.virtualbox]\n", &[]).is_err());
    assert!(
        config(
            "[platforms.virtualbox]\nvboxmanage = 'C:\\a.exe'\nbase_path = 'C:\\vms'\n",
            &[]
        )
        .is_err()
    );
    assert!(config("[platforms.vmware]\n", &[]).is_err());
}

#[test]
fn a_missing_vboxmanage_is_a_warning_and_virtualbox_alone_is_enough() {
    let state = TempDir::new().unwrap();
    let parsed = config(
        &format!(
            "[platforms.virtualbox]\nvboxmanage = '{}'\n[state]\ndir = '{}'\n",
            state.path().join("missing.exe").display(),
            state.path().display()
        ),
        &[],
    )
    .unwrap();
    let issues = validate(&parsed);
    assert!(
        issues
            .iter()
            .all(|issue| issue.severity == Severity::Warning),
        "{issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.message.contains("VirtualBox"))
    );
}

// The real runner, against the fake VBoxManage.

fn fake_vboxmanage() -> PathBuf {
    let path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples")
        .join(if cfg!(windows) {
            "fake_vboxmanage.exe"
        } else {
            "fake_vboxmanage"
        });
    assert!(
        path.is_file(),
        "build the example first: {}",
        path.display()
    );
    path
}

/// A private copy of the fake, with its own answers.
fn installation(files: &[(&str, &str)]) -> (TempDir, PathBuf) {
    let directory = TempDir::new().unwrap();
    let executable = directory.path().join(if cfg!(windows) {
        "VBoxManage.exe"
    } else {
        "VBoxManage"
    });
    fs::copy(fake_vboxmanage(), &executable).unwrap();
    for (name, content) in files {
        fs::write(directory.path().join(name), content).unwrap();
    }
    (directory, executable)
}

fn calls(directory: &Path) -> Vec<Vec<String>> {
    fs::read_to_string(directory.join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn discovers_through_a_real_process() {
    let (directory, executable) = installation(&[
        ("list.txt", LIST),
        (&format!("{XENIX}.txt"), POWEROFF),
        (&format!("{CITTA}.txt"), UNICODE),
    ]);
    let report = discover(
        Some(&VirtualBoxConfig {
            vboxmanage: executable,
        }),
        &limits(),
    );
    assert_eq!(report.status, VirtualBoxStatus::Ok);
    assert_eq!(report.version.as_deref(), Some("7.1.10r169112"));
    assert_eq!(report.vms.len(), 4);
    assert_eq!(vm(&report, CITTA).name, "Città \"Ufficio\" {v2}");
    assert_eq!(vm(&report, XP).error, Some(VirtualBoxVmError::Vanished));

    // Each argument arrived whole: nothing was split or interpreted by a shell.
    let calls = calls(directory.path());
    assert_eq!(calls.len(), 6);
    assert!(calls.contains(&vec![
        "showvminfo".to_owned(),
        CITTA.to_owned(),
        "--machinereadable".to_owned()
    ]));
    assert!(
        calls
            .iter()
            .flatten()
            .all(|argument| !argument.contains("Città"))
    );
}

#[test]
fn a_missing_executable_is_reported_without_running_anything() {
    let directory = TempDir::new().unwrap();
    let report = discover(
        Some(&VirtualBoxConfig {
            vboxmanage: directory.path().join("VBoxManage.exe"),
        }),
        &limits(),
    );
    assert_eq!(report.status, VirtualBoxStatus::ExecutableMissing);
}

#[test]
fn a_directory_is_not_an_executable() {
    let directory = TempDir::new().unwrap();
    let report = discover(
        Some(&VirtualBoxConfig {
            vboxmanage: directory.path().to_path_buf(),
        }),
        &limits(),
    );
    assert_eq!(report.status, VirtualBoxStatus::ExecutableMissing);
}

#[test]
fn a_command_that_hangs_is_killed_at_its_timeout() {
    let (_directory, executable) = installation(&[("sleep_ms.txt", "30000")]);
    let started = Instant::now();
    let report = discover(
        Some(&VirtualBoxConfig {
            vboxmanage: executable,
        }),
        &VirtualBoxLimits {
            command_timeout: Duration::from_millis(500),
            ..limits()
        },
    );
    assert_eq!(report.status, VirtualBoxStatus::Timeout);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn output_beyond_the_limit_is_not_read() {
    let mut list = String::new();
    for index in 0..2000 {
        list.push_str(&format!(
            "\"VM {index}\" {{2acda0fc-cea6-406b-8a55-{index:012}}}\n"
        ));
    }
    let (_directory, executable) = installation(&[("list.txt", &list)]);
    let runner = ProcessRunner {
        program: executable,
        max_output_bytes: 4096,
    };
    let output = runner
        .run(
            &[OsStr::new("list"), OsStr::new("vms")],
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(output.success);
    assert!(output.stdout.len() <= 4096);
}

#[test]
fn not_configured_runs_nothing() {
    let report = discover(None, &limits());
    assert_eq!(report.status, VirtualBoxStatus::NotConfigured);
    assert!(report.vms.is_empty());
}

// The report as a whole.

#[test]
fn virtualbox_never_costs_the_filesystem_scan_its_result() {
    let base = TempDir::new().unwrap();
    let vm_dir = base.path().join("DOS");
    fs::create_dir(&vm_dir).unwrap();
    fs::write(vm_dir.join("86box.cfg"), "").unwrap();
    let mut emulators = BTreeMap::new();
    emulators.insert(
        emucat_agent::emulators::EmulatorType::Box86,
        emucat_agent::config::EmulatorConfig {
            base_path: base.path().to_path_buf(),
            executable: base.path().join("86Box.exe"),
        },
    );
    let missing = VirtualBoxConfig {
        vboxmanage: base.path().join("nowhere.exe"),
    };
    let report = discovery::scan_all(
        &emulators,
        Some(&missing),
        Platform::Windows,
        &ScanLimits::default(),
        &limits(),
    );
    assert_eq!(report.vms.len(), 1);
    assert_eq!(
        report.virtualbox.as_ref().unwrap().status,
        VirtualBoxStatus::ExecutableMissing
    );
}

#[test]
fn a_filesystem_only_report_has_no_virtualbox_part() {
    let report = discovery::scan(&BTreeMap::new(), Platform::Windows, &ScanLimits::default());
    let value = serde_json::to_value(&report).unwrap();
    assert!(value.get("virtualbox").is_none());
}

#[test]
fn the_shared_example_round_trips() {
    let wire: Value = serde_json::from_str(WIRE_EXAMPLES).unwrap();
    let payload = wire["agentDiscoveryResultWithVirtualBox"]["payload"].clone();
    let mut report = payload.clone();
    report.as_object_mut().unwrap().remove("operationId");
    let parsed: DiscoveryReport = serde_json::from_value(report.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), report);
}
