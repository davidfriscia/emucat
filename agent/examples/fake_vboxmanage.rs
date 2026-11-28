//! A stand-in for `VBoxManage` in the agent's VirtualBox tests. It is never shipped, and it never runs the
//! real VBoxManage: every machine it knows is a text file.
//!
//! Everything it does comes from files in its own directory, so that tests running in parallel never
//! share anything:
//!
//! - `version.txt` is what `--version` prints. Default `7.1.10r169112`.
//! - `list.txt` is what `list vms` prints. Default nothing.
//! - `running.txt` is what `list runningvms` prints. Default nothing.
//! - `<uuid>.txt` is what `showvminfo <uuid> --machinereadable` prints. Without it, it fails as
//!   VirtualBox does for a machine that is not registered.
//! - `sleep_ms.txt` makes every command wait that long first.
//!
//! Registered machines (decision 0045):
//!
//! - `export <uuid> --output=<file> --manifest` writes `export.txt` (default `fake ova of <uuid>`) to the
//!   file. `export_fail.txt` makes it fail; `export_sleep_ms.txt` makes it slow; `export_then.txt`, if
//!   present, replaces `<uuid>.txt` once the export is written, as if someone had used the machine.
//! - `startvm <uuid> --type gui` sets `VMState` to `running`, a new `VMStateChangeTime`, and lists the
//!   machine in `running.txt`. `controlvm <uuid> poweroff` sets it to `poweroff` and unlists it, and so
//!   does `controlvm <uuid> acpipowerbutton` unless `ignore_acpi.txt` exists. `refuse_control.txt` makes
//!   every control command fail as VirtualBox does for a machine in the wrong state.
//!
//! Imports, deletions and screenshots (decision 0046):
//!
//! - `import <ova> [--dry-run] --vsys=0 --vmname=<name>` fails if the OVA does not exist, or if `list.txt` already
//!   has a machine called `<name>`. `import_dry_fail.txt` makes the dry run fail. A real import registers a new
//!   machine, powered off, with the UUID in `import_uuid.txt` (default `5b0a7f0e-91c4-4d8e-b0c2-0f5f8d0a1e11`):
//!   it is added to `list.txt` and gets its `<uuid>.txt`. `import_fail.txt` makes it fail having registered
//!   nothing; `import_fail_after.txt` makes it fail having registered the machine anyway; `import_extra.txt`
//!   holds a `"name" {uuid}` line registered alongside, as if someone else had imported meanwhile;
//!   `import_sleep_ms.txt` makes it slow.
//! - `unregistervm <uuid> --delete` removes `<uuid>.txt` and the machine's line in `list.txt`, and appends the
//!   UUID to `deleted.txt`. It refuses a running machine. `delete_fail.txt` makes it fail having removed
//!   nothing; `delete_keep.txt` makes it succeed having removed nothing.
//! - `controlvm <uuid> screenshotpng <file>` writes `screenshot.png`, or a small valid PNG, to the file, for a
//!   running machine only. `screenshot_fail.txt` makes it fail; `screenshot_garbage.txt` makes it write that
//!   file's content instead of a PNG.
//!
//! It appends its arguments, one JSON array per line, to `calls.jsonl`, so that a test can check
//! exactly what was run.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn not_found(uuid: &str) -> ! {
    eprintln!(
        "VBoxManage.exe: error: Could not find a registered machine named '{uuid}'\n\
         VBoxManage.exe: error: Details: code VBOX_E_OBJECT_NOT_FOUND (0x80bb0001)"
    );
    std::process::exit(1);
}

/// The machine's own state: the first `VMState=` line, as a description may hold another.
fn is_running(info: &[u8]) -> bool {
    String::from_utf8_lossy(info)
        .lines()
        .find(|line| line.starts_with("VMState="))
        == Some("VMState=\"running\"")
}

fn wrong_state() -> ! {
    eprintln!(
        "VBoxManage.exe: error: The machine is not in a state for this (C:\\Users\\x\\VirtualBox VMs\\m.vbox)\n\
         VBoxManage.exe: error: Details: code VBOX_E_INVALID_VM_STATE (0x80bb0002)"
    );
    std::process::exit(1);
}

/// Rewrites the machine's state and state change time, as VirtualBox would.
fn set_state(directory: &Path, uuid: &str, state: &str) {
    let path = directory.join(format!("{uuid}.txt"));
    let Ok(info) = fs::read_to_string(&path) else {
        not_found(uuid);
    };
    let counter = directory.join("clock.txt");
    let tick: u32 = fs::read_to_string(&counter)
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
        + 1;
    fs::write(&counter, tick.to_string()).unwrap();
    let mut lines: Vec<String> = info
        .lines()
        .filter(|line| !line.starts_with("VMState=") && !line.starts_with("VMStateChangeTime="))
        .map(str::to_owned)
        .collect();
    lines.push(format!("VMState=\"{state}\""));
    lines.push(format!(
        "VMStateChangeTime=\"2030-01-01T00:{:02}:{:02}.000000000\"",
        tick / 60 % 60,
        tick % 60
    ));
    fs::write(&path, lines.join("\n") + "\n").unwrap();

    let running = directory.join("running.txt");
    let mut listed: Vec<String> = fs::read_to_string(&running)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.contains(uuid))
        .map(str::to_owned)
        .collect();
    if state == "running" {
        listed.push(format!("\"machine\" {{{uuid}}}"));
    }
    fs::write(&running, listed.join("\n") + "\n").unwrap();
}

/// A 1 x 1 PNG, which is all a screenshot needs to be here.
const TINY_PNG: [u8; 69] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// Registers a machine as an import does: in `list.txt`, and with its own `<uuid>.txt`, powered off.
fn register(directory: &Path, uuid: &str, name: &str) {
    let list = directory.join("list.txt");
    let mut listed = fs::read_to_string(&list).unwrap_or_default();
    if !listed.is_empty() && !listed.ends_with('\n') {
        listed.push('\n');
    }
    listed.push_str(&format!("\"{name}\" {{{uuid}}}\n"));
    fs::write(&list, listed).unwrap();
    fs::write(
        directory.join(format!("{uuid}.txt")),
        format!(
            "name=\"{name}\"\nUUID=\"{uuid}\"\nVMState=\"poweroff\"\n\
             VMStateChangeTime=\"2030-02-01T00:00:00.000000000\"\n"
        ),
    )
    .unwrap();
}

fn listed_names(directory: &Path) -> Vec<String> {
    fs::read_to_string(directory.join("list.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix('"')?;
            let (name, _) = rest.rsplit_once("\" {")?;
            Some(name.to_owned())
        })
        .collect()
}

fn main() {
    let directory: PathBuf = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut calls = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("calls.jsonl"))
        .unwrap();
    let quoted: Vec<String> = arguments
        .iter()
        .map(|argument| format!("{argument:?}"))
        .collect();
    // One write per line: the agent runs several VBoxManage commands at once, and `writeln!` would write the
    // brackets, the arguments and the newline separately, so that two calls could interleave into one line. A
    // single append of a short line is not split.
    calls
        .write_all(format!("[{}]\n", quoted.join(",")).as_bytes())
        .unwrap();

    let sleep = |name: &str| {
        if let Some(milliseconds) = fs::read_to_string(directory.join(name))
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            std::thread::sleep(Duration::from_millis(milliseconds));
        }
    };
    sleep("sleep_ms.txt");

    let read = |name: &str| fs::read(directory.join(name)).ok();
    let exists = |name: &str| directory.join(name).exists();
    let mut stdout = std::io::stdout();
    match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--version"] => {
            let version = read("version.txt").unwrap_or_else(|| b"7.1.10r169112\n".to_vec());
            stdout.write_all(&version).unwrap();
        }
        ["list", "vms"] => stdout
            .write_all(&read("list.txt").unwrap_or_default())
            .unwrap(),
        ["list", "runningvms"] => stdout
            .write_all(&read("running.txt").unwrap_or_default())
            .unwrap(),
        ["showvminfo", uuid, "--machinereadable"] => match read(&format!("{uuid}.txt")) {
            Some(info) => stdout.write_all(&info).unwrap(),
            None => not_found(uuid),
        },
        ["export", uuid, output, "--manifest"] => {
            let Some(output) = output.strip_prefix("--output=") else {
                eprintln!("Syntax error: --output expected");
                std::process::exit(2);
            };
            if !exists(&format!("{uuid}.txt")) {
                not_found(uuid);
            }
            if exists("export_fail.txt") {
                eprintln!(
                    "0%...\nProgress state: VBOX_E_FILE_ERROR\n\
                     VBoxManage.exe: error: Appliance write failed (C:\\Users\\x\\disk.vdi)"
                );
                std::process::exit(1);
            }
            sleep("export_sleep_ms.txt");
            let content =
                read("export.txt").unwrap_or_else(|| format!("fake ova of {uuid}").into_bytes());
            fs::write(output, content).unwrap();
            if let Some(then) = read("export_then.txt") {
                fs::write(directory.join(format!("{uuid}.txt")), then).unwrap();
            }
            println!("0%...10%...20%...30%...40%...50%...60%...70%...80%...90%...100%");
            println!("Successfully exported 1 machine(s).");
        }
        ["startvm", uuid, "--type", "gui"] => {
            if !exists(&format!("{uuid}.txt")) {
                not_found(uuid);
            }
            if exists("refuse_control.txt") {
                wrong_state();
            }
            set_state(&directory, uuid, "running");
            println!("VM \"machine\" has been successfully started.");
        }
        ["controlvm", uuid, action @ ("poweroff" | "acpipowerbutton")] => {
            if !exists(&format!("{uuid}.txt")) {
                not_found(uuid);
            }
            if exists("refuse_control.txt") {
                wrong_state();
            }
            if *action == "poweroff" || !exists("ignore_acpi.txt") {
                set_state(&directory, uuid, "poweroff");
            }
        }
        ["import", ova, rest @ ..] => {
            let (dry_run, rest) = match rest {
                ["--dry-run", rest @ ..] => (true, rest),
                rest => (false, rest),
            };
            let ["--vsys=0", name] = rest else {
                eprintln!("Syntax error: unexpected import options");
                std::process::exit(2);
            };
            let Some(name) = name.strip_prefix("--vmname=") else {
                eprintln!("Syntax error: --vmname expected");
                std::process::exit(2);
            };
            if !Path::new(ova).is_file() {
                eprintln!("VBoxManage.exe: error: Could not find file (VERR_FILE_NOT_FOUND)");
                std::process::exit(1);
            }
            if listed_names(&directory)
                .iter()
                .any(|listed| listed.eq_ignore_ascii_case(name))
            {
                eprintln!(
                    "VBoxManage.exe: error: Machine settings file already exists\n\
                     VBoxManage.exe: error: Details: code VBOX_E_FILE_ERROR (0x80bb0004)"
                );
                std::process::exit(1);
            }
            if dry_run {
                if exists("import_dry_fail.txt") {
                    eprintln!("VBoxManage.exe: error: Appliance read failed (VBOX_E_FILE_ERROR)");
                    std::process::exit(1);
                }
                println!("Interpreting {ova}...\nOK.\nDisk Image: ...\n(dry run)");
                return;
            }
            sleep("import_sleep_ms.txt");
            if exists("import_fail.txt") {
                eprintln!("VBoxManage.exe: error: Appliance import failed (VBOX_E_IPRT_ERROR)");
                std::process::exit(1);
            }
            let uuid = read("import_uuid.txt")
                .map(|bytes| String::from_utf8(bytes).unwrap().trim().to_owned())
                .unwrap_or_else(|| "5b0a7f0e-91c4-4d8e-b0c2-0f5f8d0a1e11".to_owned());
            register(&directory, &uuid, name);
            if let Some(extra) = read("import_extra.txt") {
                let line = String::from_utf8(extra).unwrap();
                let line = line.trim();
                let (extra_name, extra_uuid) = line
                    .strip_prefix('"')
                    .and_then(|rest| rest.strip_suffix('}'))
                    .and_then(|rest| rest.rsplit_once("\" {"))
                    .unwrap();
                register(&directory, extra_uuid, extra_name);
            }
            if exists("import_fail_after.txt") {
                eprintln!("VBoxManage.exe: error: Appliance import failed (VBOX_E_IPRT_ERROR)");
                std::process::exit(1);
            }
            println!("0%...100%\nSuccessfully imported the appliance.");
        }
        ["unregistervm", uuid, "--delete"] => {
            let Some(info) = read(&format!("{uuid}.txt")) else {
                not_found(uuid);
            };
            if is_running(&info) {
                wrong_state();
            }
            if exists("delete_fail.txt") {
                eprintln!(
                    "VBoxManage.exe: error: Cannot unregister the machine (VBOX_E_INVALID_OBJECT_STATE)"
                );
                std::process::exit(1);
            }
            if exists("delete_keep.txt") {
                return;
            }
            fs::remove_file(directory.join(format!("{uuid}.txt"))).unwrap();
            let list = directory.join("list.txt");
            let kept: Vec<String> = fs::read_to_string(&list)
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.contains(uuid))
                .map(str::to_owned)
                .collect();
            fs::write(&list, kept.join("\n") + "\n").unwrap();
            let mut deleted = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join("deleted.txt"))
                .unwrap();
            // One write per line, as for `calls.jsonl`.
            deleted.write_all(format!("{uuid}\n").as_bytes()).unwrap();
            println!("0%...100%");
        }
        ["controlvm", uuid, "screenshotpng", output] => {
            let Some(info) = read(&format!("{uuid}.txt")) else {
                not_found(uuid);
            };
            if !is_running(&info) || exists("screenshot_fail.txt") {
                wrong_state();
            }
            let content = read("screenshot_garbage.txt")
                .or_else(|| read("screenshot.png"))
                .unwrap_or_else(|| TINY_PNG.to_vec());
            fs::write(output, content).unwrap();
        }
        _ => {
            eprintln!("Syntax error: unexpected arguments");
            std::process::exit(2);
        }
    }
}
