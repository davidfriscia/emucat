//! A stand-in for `VBoxManage` in the agent's VirtualBox discovery tests. It is never shipped.
//!
//! Everything it does comes from files in its own directory, so that tests running in parallel never
//! share anything:
//!
//! - `version.txt` is what `--version` prints. Default `7.1.10r169112`.
//! - `list.txt` is what `list vms` prints. Default nothing.
//! - `<uuid>.txt` is what `showvminfo <uuid> --machinereadable` prints. Without it, it fails as
//!   VirtualBox does for a machine that is not registered.
//! - `sleep_ms.txt` makes every command wait that long first.
//!
//! It appends its arguments, one JSON array per line, to `calls.jsonl`, so that a test can check
//! exactly what was run.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

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

    if let Some(milliseconds) = fs::read_to_string(directory.join("sleep_ms.txt"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        std::thread::sleep(Duration::from_millis(milliseconds));
    }

    let read = |name: &str| fs::read(directory.join(name)).ok();
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
        ["showvminfo", uuid, "--machinereadable"] => match read(&format!("{uuid}.txt")) {
            Some(info) => stdout.write_all(&info).unwrap(),
            None => {
                eprintln!(
                    "VBoxManage.exe: error: Could not find a registered machine named '{uuid}'\n\
                     VBoxManage.exe: error: Details: code VBOX_E_OBJECT_NOT_FOUND (0x80bb0001)"
                );
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("Syntax error: unexpected arguments");
            std::process::exit(2);
        }
    }
}
