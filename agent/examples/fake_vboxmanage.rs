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
    writeln!(calls, "[{}]", quoted.join(",")).unwrap();

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
        _ => {
            eprintln!("Syntax error: unexpected arguments");
            std::process::exit(2);
        }
    }
}
