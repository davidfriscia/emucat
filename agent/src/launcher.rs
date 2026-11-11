//! How an emulator is started for a VM: which executable, which arguments, which working directory.
//!
//! Nothing here comes from the server. The executable is the one in this agent's configuration, checked to
//! be a plain executable of the expected kind. The VM's directory is found under the configured base path
//! with the same rules as registration. The arguments are built here, for 86Box, or taken from the VM's own
//! QEMU launcher **only** after every one of them has passed an allowlist. A launcher script is never run:
//! it is read as text, and anything it does that is not one plain QEMU command line is refused. See
//! decision 0028 and `docs/launcher.md`.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::discovery::is_link_like;
use crate::emulators::{EmulatorType, VmName};
use crate::filesystem::parse_vm_relative_path;
use crate::packaging::{SourceErrorKind, resolve_vm_root};
use crate::process::SpawnRequest;

/// A structured launch profile, kept in the VM's directory so that it travels with the VM.
pub const QEMU_PROFILE_FILE: &str = "emucat-launch.json";
/// Legacy launchers that may be read, in the order they are preferred. Shell scripts for other systems are
/// never considered on Windows.
pub const QEMU_LEGACY_LAUNCHERS: [&str; 4] = ["run-win.bat", "run-win.cmd", "run.bat", "run.cmd"];
pub const BOX86_CONFIG_FILE: &str = "86box.cfg";
/// The QEMU systems this agent will start. Each needs its own `qemu-system-*` executable.
pub const QEMU_SYSTEMS: [&str; 2] = ["i386", "x86_64"];
const MAX_LAUNCHER_BYTES: u64 = 64 * 1024;
const MAX_ARGUMENTS: usize = 256;
const MAX_ARGUMENT_LENGTH: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchErrorKind {
    /// Launching is not implemented on this operating system.
    Unsupported,
    ExecutableNotConfigured,
    ExecutableInvalid,
    VmMissing,
    VmUnsafe,
    ConfigurationMissing,
    /// The VM has a launcher, but not one this agent can safely interpret.
    ConfigurationRequired,
}

impl LaunchErrorKind {
    /// Stable code, shared with `EXECUTION_ERROR_CODES` in the contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "launch_unsupported_platform",
            Self::ExecutableNotConfigured => "emulator_not_configured",
            Self::ExecutableInvalid => "executable_invalid",
            Self::VmMissing => "vm_not_available",
            Self::VmUnsafe => "vm_unsafe",
            Self::ConfigurationMissing => "vm_configuration_missing",
            Self::ConfigurationRequired => "launch_configuration_required",
        }
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct LaunchError {
    pub kind: LaunchErrorKind,
    pub message: String,
}

fn error(kind: LaunchErrorKind, message: impl Into<String>) -> LaunchError {
    LaunchError {
        kind,
        message: message.into(),
    }
}

fn required(message: impl Into<String>) -> LaunchError {
    error(LaunchErrorKind::ConfigurationRequired, message)
}

/// How a running emulator is asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GracefulStop {
    /// Its main window is asked to close, as its close button would. 86Box then exits by itself.
    CloseWindow,
    /// The guest is sent an ACPI power-button press over QMP, and QEMU exits when it powers off.
    QmpPowerdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub spawn: SpawnRequest,
    pub graceful: GracefulStop,
    /// The file the command came from, relative to the VM's directory, for messages.
    pub source: String,
}

fn has_pe_header(path: &Path) -> std::io::Result<bool> {
    let mut file = fs::File::open(path)?;
    let mut header = [0u8; 64];
    if file.read(&mut header)? < header.len() || &header[..2] != b"MZ" {
        return Ok(false);
    }
    let offset = u32::from_le_bytes([header[60], header[61], header[62], header[63]]) as u64;
    if offset > 64 * 1024 {
        return Ok(false);
    }
    let mut file = fs::File::open(path)?;
    let mut skipped = vec![0u8; offset as usize];
    if file.read_exact(&mut skipped).is_err() {
        return Ok(false);
    }
    let mut signature = [0u8; 4];
    Ok(file.read_exact(&mut signature).is_ok() && &signature == b"PE\0\0")
}

/// Whether a file name is what this emulator's executable is called.
fn expected_name(emulator: EmulatorType, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    let Some(stem) = name.strip_suffix(".exe") else {
        return false;
    };
    match emulator {
        EmulatorType::Box86 => stem.starts_with("86box"),
        EmulatorType::Qemu => stem.starts_with("qemu-system-"),
    }
}

/// Checks that a configured path is an executable this agent may start for this emulator: absolute, a
/// plain file rather than a link, named like the emulator's executable, and a Windows executable.
pub fn check_executable(emulator: EmulatorType, path: &Path) -> Result<PathBuf, LaunchError> {
    if !crate::process::supported() {
        return Err(error(
            LaunchErrorKind::Unsupported,
            "Launching emulators is only implemented on Windows",
        ));
    }
    let invalid = |message: String| error(LaunchErrorKind::ExecutableInvalid, message);
    if !path.is_absolute() {
        return Err(invalid(format!(
            "The {emulator} executable must be an absolute path: {}",
            path.display()
        )));
    }
    let metadata = fs::symlink_metadata(path).map_err(|failure| {
        invalid(format!(
            "The {emulator} executable cannot be found: {}: {failure}",
            path.display()
        ))
    })?;
    if is_link_like(&metadata) {
        return Err(invalid(format!(
            "The {emulator} executable is a link or reparse point, which is not accepted: {}",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(invalid(format!(
            "The {emulator} executable is not a regular file: {}",
            path.display()
        )));
    }
    if !expected_name(emulator, path) {
        let expected = match emulator {
            EmulatorType::Box86 => "86Box.exe",
            EmulatorType::Qemu => "qemu-system-*.exe",
        };
        return Err(invalid(format!(
            "The {emulator} executable should be named like {expected}: {}",
            path.display()
        )));
    }
    match has_pe_header(path) {
        Ok(true) => Ok(path.to_path_buf()),
        Ok(false) => Err(invalid(format!(
            "The {emulator} executable is not a Windows program: {}",
            path.display()
        ))),
        Err(failure) => Err(invalid(format!(
            "The {emulator} executable cannot be read: {}: {failure}",
            path.display()
        ))),
    }
}

fn vm_root(
    base_path: &Path,
    vm_name: &VmName,
    emulator: EmulatorType,
) -> Result<PathBuf, LaunchError> {
    resolve_vm_root(base_path, vm_name, emulator).map_err(|failure| {
        let kind = match failure.kind {
            SourceErrorKind::Missing => LaunchErrorKind::VmMissing,
            SourceErrorKind::Unsafe => LaunchErrorKind::VmUnsafe,
            _ => LaunchErrorKind::VmMissing,
        };
        error(kind, failure.message)
    })
}

/// A file directly in the VM's root, if it is a plain file.
fn root_file(root: &Path, name: &str) -> Result<Option<PathBuf>, LaunchError> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Err(_) => Ok(None),
        Ok(metadata) if is_link_like(&metadata) || !metadata.is_file() => Err(error(
            LaunchErrorKind::VmUnsafe,
            format!("{name} is not a plain file"),
        )),
        Ok(_) => Ok(Some(path)),
    }
}

/// Everything needed to start this VM, checked. Reads the disk, and changes nothing.
pub fn plan_launch(
    emulator: EmulatorType,
    executable: &Path,
    base_path: &Path,
    vm_name: &VmName,
) -> Result<LaunchPlan, LaunchError> {
    let executable = check_executable(emulator, executable)?;
    let root = vm_root(base_path, vm_name, emulator)?;
    match emulator {
        EmulatorType::Box86 => plan_box86(executable, root, vm_name),
        EmulatorType::Qemu => plan_qemu(&executable, root),
    }
}

/// `86Box --vmpath ROOT --vmname NAME --noconfirm ROOT\86box.cfg`, from the VM's own directory. The
/// configuration is named exactly, so that 86Box cannot pick up another VM's, and nothing is changed in it.
/// `--noconfirm` lets a stop request close 86Box without a dialog that nobody may be there to answer.
fn plan_box86(
    executable: PathBuf,
    root: PathBuf,
    vm_name: &VmName,
) -> Result<LaunchPlan, LaunchError> {
    let config = root_file(&root, BOX86_CONFIG_FILE)?.ok_or_else(|| {
        error(
            LaunchErrorKind::ConfigurationMissing,
            format!("The VM has no {BOX86_CONFIG_FILE}"),
        )
    })?;
    let args = vec![
        OsString::from("--vmpath"),
        root.clone().into_os_string(),
        OsString::from("--vmname"),
        OsString::from(vm_name.as_str()),
        OsString::from("--noconfirm"),
        config.into_os_string(),
    ];
    Ok(LaunchPlan {
        spawn: SpawnRequest {
            program: executable,
            args,
            working_dir: root,
            qmp_stdio: false,
        },
        graceful: GracefulStop::CloseWindow,
        source: BOX86_CONFIG_FILE.to_owned(),
    })
}

/// A launch profile: which QEMU system, and its arguments. Every argument is checked like a legacy one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QemuProfile {
    pub profile_version: u32,
    pub system: String,
    pub args: Vec<String>,
}

/// A QEMU command line, before its arguments are checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QemuCommand {
    pub system: String,
    pub args: Vec<String>,
}

fn plan_qemu(executable: &Path, root: PathBuf) -> Result<LaunchPlan, LaunchError> {
    let (command, source) = read_qemu_command(&root)?;
    check_qemu_arguments(&command.args, &root)?;
    let program = qemu_system_executable(executable, &command.system)?;
    let mut args: Vec<OsString> = command.args.iter().map(OsString::from).collect();
    // The agent's own channel to QEMU's monitor, on QEMU's standard input and output. It opens no listener.
    args.push(OsString::from("-qmp"));
    args.push(OsString::from("stdio"));
    // QEMU counts `-qmp` as a monitor, and then no longer creates the human monitor it would otherwise show
    // on Ctrl+Alt+2. It is asked for again, exactly as QEMU would have made it, unless the VM says otherwise.
    if human_monitor(&command.args) == HumanMonitor::Added {
        args.push(OsString::from("-monitor"));
        args.push(OsString::from("vc"));
    }
    Ok(LaunchPlan {
        spawn: SpawnRequest {
            program,
            args,
            working_dir: root,
            qmp_stdio: true,
        },
        graceful: GracefulStop::QmpPowerdown,
        source,
    })
}

/// What becomes of QEMU's human monitor (HMP) once the agent adds `-qmp stdio`, judged from the VM's own
/// arguments alone.
///
/// Run by itself, a graphical QEMU creates a human monitor on a virtual console, shown on Ctrl+Alt+2. It
/// does so only while no monitor is configured, and `-qmp` is one, so the agent's own channel would take
/// that console away. It is added back as `-monitor vc` only when the VM itself would have had it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanMonitor {
    /// QEMU would have made its default monitor: the agent adds `-monitor vc`.
    Added,
    /// The VM configures a monitor itself, with `-monitor` or `-mon`. Nothing is added beside it.
    Configured,
    /// The VM turns the monitor off with `-monitor none`.
    Disabled,
    /// `-nodefaults`: QEMU would make no monitor of its own either.
    DefaultsDisabled,
    /// No display, so no console to show a monitor on: `-display none`, `-nographic`, or
    /// `-machine graphics=off`.
    Headless,
}

/// QEMU options that take no value. Any other option takes the next argument as its value.
const QEMU_FLAGS: &[&str] = &[
    "usb",
    "enable-kvm",
    "no-acpi",
    "no-hpet",
    "no-reboot",
    "snapshot",
    "full-screen",
    "nodefaults",
    "no-fd-bootchk",
    "localtime",
    "win2k-hack",
    "no-user-config",
    "no-frame",
    "alt-grab",
    "ctrl-grab",
    // Refused by the allowlist, but known here so that what follows them is read correctly.
    "nographic",
    "no-shutdown",
    "daemonize",
    "s",
];

/// An option's name, from `-name` or `--name`, and a value written into it as `-name=value`.
fn split_option(raw: &str) -> Option<(&str, Option<&str>)> {
    let name = raw.strip_prefix("--").or_else(|| raw.strip_prefix('-'))?;
    if name.is_empty() {
        return None;
    }
    Some(match name.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (name, None),
    })
}

/// Reads the VM's arguments, in either `-option value` or `-option=value` form, for what they say about
/// the human monitor. Values are never mistaken for options: `-name -monitor` names the VM `-monitor`.
pub fn human_monitor(args: &[String]) -> HumanMonitor {
    let (mut configured, mut disabled, mut no_defaults, mut headless) =
        (false, false, false, false);
    let mut index = 0;
    while index < args.len() {
        let Some((name, inline)) = split_option(&args[index]) else {
            index += 1;
            continue;
        };
        let value = if inline.is_some() || QEMU_FLAGS.contains(&name) {
            index += 1;
            inline
        } else {
            index += 2;
            args.get(index - 1).map(String::as_str)
        };
        let elements = || value.unwrap_or_default().split(',');
        match name {
            "monitor" if value == Some("none") => disabled = true,
            "monitor" | "mon" => configured = true,
            "nodefaults" => no_defaults = true,
            "nographic" => headless = true,
            "display" if elements().next() == Some("none") => headless = true,
            "machine" | "M" if elements().any(|element| element == "graphics=off") => {
                headless = true;
            }
            _ => {}
        }
    }
    if configured {
        HumanMonitor::Configured
    } else if disabled {
        HumanMonitor::Disabled
    } else if no_defaults {
        HumanMonitor::DefaultsDisabled
    } else if headless {
        HumanMonitor::Headless
    } else {
        HumanMonitor::Added
    }
}

fn read_text(path: &Path, name: &str) -> Result<String, LaunchError> {
    let size = fs::metadata(path)
        .map_err(|failure| required(format!("Cannot read {name}: {failure}")))?
        .len();
    if size > MAX_LAUNCHER_BYTES {
        return Err(required(format!("{name} is larger than a launcher can be")));
    }
    let bytes =
        fs::read(path).map_err(|failure| required(format!("Cannot read {name}: {failure}")))?;
    let text =
        String::from_utf8(bytes).map_err(|_| required(format!("{name} is not UTF-8 text")))?;
    Ok(text.trim_start_matches('\u{feff}').to_owned())
}

/// The profile if there is one, otherwise the first legacy launcher. Nothing is executed.
pub fn read_qemu_command(root: &Path) -> Result<(QemuCommand, String), LaunchError> {
    if let Some(path) = root_file(root, QEMU_PROFILE_FILE)? {
        let text = read_text(&path, QEMU_PROFILE_FILE)?;
        let profile: QemuProfile = serde_json::from_str(&text)
            .map_err(|failure| required(format!("{QEMU_PROFILE_FILE} is not valid: {failure}")))?;
        if profile.profile_version != 1 {
            return Err(required(format!(
                "{QEMU_PROFILE_FILE} has profile version {}, and only 1 is understood",
                profile.profile_version
            )));
        }
        return Ok((
            QemuCommand {
                system: profile.system,
                args: profile.args,
            },
            QEMU_PROFILE_FILE.to_owned(),
        ));
    }
    for name in QEMU_LEGACY_LAUNCHERS {
        if let Some(path) = root_file(root, name)? {
            let text = read_text(&path, name)?;
            let command = parse_batch_launcher(&text)
                .map_err(|failure| required(format!("{name}: {}", failure.message)))?;
            return Ok((command, name.to_owned()));
        }
    }
    Err(required(format!(
        "The VM has no {QEMU_PROFILE_FILE} and no Windows launcher ({})",
        QEMU_LEGACY_LAUNCHERS.join(", ")
    )))
}

/// Reads a batch file as one plain QEMU command line. It accepts comments, `@echo off`, a change to the
/// script's own directory, and one `qemu-system-*` command, possibly split with `^`. Anything else, such
/// as a variable, a redirection, a pipe, a second command or a path to another executable, is refused:
/// the agent would otherwise have to run a shell to know what the script means.
pub fn parse_batch_launcher(text: &str) -> Result<QemuCommand, LaunchError> {
    let mut logical: Vec<String> = Vec::new();
    let mut pending = String::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r').trim_end();
        if let Some(continued) = line.strip_suffix('^') {
            pending.push_str(continued);
            pending.push(' ');
            continue;
        }
        pending.push_str(line);
        logical.push(std::mem::take(&mut pending));
    }
    if !pending.trim().is_empty() {
        logical.push(pending);
    }

    let mut command: Option<QemuCommand> = None;
    for line in logical {
        let trimmed = line.trim();
        let trimmed = trimmed.strip_prefix('@').unwrap_or(trimmed).trim();
        let lower = trimmed.to_ascii_lowercase();
        let ignorable = lower.is_empty()
            || lower == "echo off"
            || lower == "rem"
            || lower.starts_with("rem ")
            || lower.starts_with("::");
        let to_own_directory = matches!(
            lower.as_str(),
            "cd /d \"%~dp0\""
                | "cd /d %~dp0"
                | "cd \"%~dp0\""
                | "cd %~dp0"
                | "pushd \"%~dp0\""
                | "pushd %~dp0"
        );
        if ignorable || (command.is_none() && to_own_directory) {
            continue;
        }
        if command.is_some() {
            if matches!(lower.as_str(), "exit" | "exit /b" | "popd") {
                continue;
            }
            return Err(required(
                "it holds more than one command, so it is not a plain QEMU command line",
            ));
        }
        command = Some(parse_command_line(trimmed)?);
    }
    command.ok_or_else(|| required("it holds no QEMU command"))
}

fn parse_command_line(line: &str) -> Result<QemuCommand, LaunchError> {
    if let Some(found) = line.chars().find(|c| {
        matches!(
            c,
            '%' | '!' | '&' | '|' | '<' | '>' | '(' | ')' | '^' | '`' | '\t'
        )
    }) {
        return Err(required(format!(
            "it uses {found:?}, which only a shell can interpret, so EmuCat will not run it"
        )));
    }
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ' ' if !quoted => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            other => {
                current.push(other);
                started = true;
            }
        }
    }
    if quoted {
        return Err(required("it has an unbalanced quotation mark"));
    }
    if started {
        tokens.push(current);
    }
    let Some(program) = tokens.first() else {
        return Err(required("it holds no QEMU command"));
    };
    if program.contains(['\\', '/', ':']) {
        return Err(required(format!(
            "it runs {program}, a path. EmuCat starts the QEMU configured on the agent instead, so a \
             launcher must name the program alone, such as qemu-system-i386"
        )));
    }
    let lower = program.to_ascii_lowercase();
    let lower = lower.strip_suffix(".exe").unwrap_or(&lower);
    let Some(system) = lower.strip_prefix("qemu-system-") else {
        return Err(required(format!(
            "it runs {program}, and only qemu-system-* can be started"
        )));
    };
    let system = if QEMU_SYSTEMS.contains(&system) {
        system
    } else {
        system.strip_suffix('w').unwrap_or(system)
    };
    Ok(QemuCommand {
        system: system.to_owned(),
        args: tokens[1..].to_vec(),
    })
}

/// The `qemu-system-SYSTEM` executable next to the configured one. The configured one is used if it is that
/// system already; otherwise its sibling must exist and pass the same checks. Nothing else is searched.
pub fn qemu_system_executable(configured: &Path, system: &str) -> Result<PathBuf, LaunchError> {
    if !QEMU_SYSTEMS.contains(&system) {
        return Err(required(format!(
            "it asks for qemu-system-{system}, and only {} are supported",
            QEMU_SYSTEMS.join(" and ")
        )));
    }
    let wanted = format!("qemu-system-{system}");
    let stem = configured
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if stem == wanted || stem == format!("{wanted}w") {
        return Ok(configured.to_path_buf());
    }
    let sibling = configured
        .parent()
        .map(|directory| directory.join(format!("{wanted}.exe")))
        .ok_or_else(|| {
            error(
                LaunchErrorKind::ExecutableInvalid,
                "The QEMU executable has no directory",
            )
        })?;
    check_executable(EmulatorType::Qemu, &sibling).map_err(|failure| {
        error(
            LaunchErrorKind::ExecutableInvalid,
            format!(
                "This VM needs {wanted}.exe, next to the configured QEMU executable: {}",
                failure.message
            ),
        )
    })
}

// Checking arguments.

fn charset(value: &str, extra: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ARGUMENT_LENGTH
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

type OptionList<'a> = (Option<&'a str>, Vec<(&'a str, &'a str)>);

/// `type,key=value,...`, without QEMU's `,,` escape. The first element may be bare.
fn options(value: &str) -> Result<OptionList<'_>, String> {
    if value.contains(",,") || value.is_empty() {
        return Err(format!("{value:?} is not a simple option list"));
    }
    let mut bare = None;
    let mut pairs = Vec::new();
    for (index, part) in value.split(',').enumerate() {
        match part.split_once('=') {
            Some((key, item)) => pairs.push((key, item)),
            None if index == 0 => bare = Some(part),
            None => pairs.push((part, "")),
        }
    }
    Ok((bare, pairs))
}

/// A file inside the VM's directory, named relatively, that exists, is a plain file, and is reached
/// without passing through a link.
pub fn check_vm_file(root: &Path, relative: &str) -> Result<(), String> {
    let segments = parse_vm_relative_path(relative)
        .map_err(|_| format!("{relative:?} is not a path inside the VM's directory"))?;
    let mut path = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        path.push(segment);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| format!("{relative} does not exist in the VM's directory"))?;
        if is_link_like(&metadata) {
            return Err(format!("{relative} goes through a link or reparse point"));
        }
        let last = index + 1 == segments.len();
        if (last && !metadata.is_file()) || (!last && !metadata.is_dir()) {
            return Err(format!("{relative} is not a plain file"));
        }
    }
    Ok(())
}

/// Options that would let a launcher reach outside its VM: other files, listeners, scripts, host
/// devices, or the agent's own monitor channel. Named so that a refusal can say why. A human monitor on
/// QEMU's own window is allowed, and checked by [`check_monitor`], [`check_chardev`] and [`check_mon`].
const REFUSED: &[(&str, &str)] = &[
    (
        "qmp",
        "it opens a QMP monitor, which EmuCat reserves for itself",
    ),
    (
        "qmp-pretty",
        "it opens a QMP monitor, which EmuCat reserves for itself",
    ),
    ("serial", "a serial port can reach files, sockets and pipes"),
    ("parallel", "a parallel port can reach files and devices"),
    (
        "nographic",
        "it uses standard input and output, which EmuCat reserves for itself",
    ),
    (
        "no-shutdown",
        "QEMU would stay running after the guest powers off, so it could not be stopped",
    ),
    (
        "daemonize",
        "QEMU would detach from the process EmuCat tracks",
    ),
    ("virtfs", "it shares a host directory"),
    ("fsdev", "it shares a host directory"),
    ("object", "objects can read host files and open sockets"),
    ("plugin", "plugins are host code"),
    ("readconfig", "it reads another file of options"),
    ("writeconfig", "it writes a file"),
    ("loadvm", "it restores saved state"),
    ("incoming", "it listens for a migration"),
    ("s", "it opens a debugger listener"),
    ("gdb", "it opens a debugger listener"),
    ("vnc", "it opens a listener"),
    ("spice", "it opens a listener"),
    ("pidfile", "it writes a file"),
    ("D", "it writes a log file"),
    ("L", "it names a host directory"),
    ("run-with", "it changes how QEMU runs"),
    ("sandbox", "it changes how QEMU runs"),
    ("add-fd", "it uses host file descriptors"),
];

const DEVICE_KEYS_REFUSED: &[&str] = &[
    "romfile", "file", "path", "chardev", "fd", "filename", "logfile", "host", "hostbus",
    "hostaddr", "hostport", "sysfsdev",
];

const DEVICES_REFUSED: &[&str] = &[
    "loader",
    "usb-host",
    "usb-redir",
    "ivshmem",
    "ivshmem-plain",
    "ivshmem-doorbell",
    "vfio-pci",
    "virtio-9p-pci",
    "vhost-user-fs-pci",
    "u2f-passthru",
];

const NET_USER_KEYS: &[&str] = &[
    "id",
    "net",
    "host",
    "dhcpstart",
    "dns",
    "restrict",
    "ipv4",
    "ipv6",
    "hostname",
    "domainname",
    "dnssearch",
    "hostfwd",
    "name",
    "vlan",
];

fn check_device(value: &str) -> Result<(), String> {
    let (driver, pairs) = options(value)?;
    let driver = driver.ok_or_else(|| format!("{value:?} does not name a device"))?;
    if !charset(driver, "_-.")
        || DEVICES_REFUSED.contains(&driver)
        || driver.starts_with("vfio")
        || driver.starts_with("vhost")
    {
        return Err(format!("the device {driver} is not allowed"));
    }
    for (key, item) in pairs {
        if DEVICE_KEYS_REFUSED.contains(&key) || !charset(key, "_-.") || !charset(item, "_-.:") {
            return Err(format!("the device property {key}={item} is not allowed"));
        }
    }
    Ok(())
}

/// A host forward only on the loopback address: `tcp:127.0.0.1:8888-:8080`. Forwarding from every
/// interface would expose the guest to the network.
fn check_hostfwd(value: &str) -> Result<(), String> {
    let refuse = || {
        format!(
            "hostfwd={value} would listen on every interface. Name 127.0.0.1 explicitly, as in \
             hostfwd=tcp:127.0.0.1:8888-:8080"
        )
    };
    let (host_side, guest_side) = value.split_once('-').ok_or_else(refuse)?;
    let mut parts = host_side.split(':');
    let (Some(protocol), Some(address), Some(port), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(refuse());
    };
    if !matches!(protocol, "tcp" | "udp")
        || !matches!(address, "127.0.0.1" | "localhost")
        || port.parse::<u16>().is_err()
        || !charset(guest_side, ".:")
    {
        return Err(refuse());
    }
    Ok(())
}

fn check_net_user(pairs: &[(&str, &str)]) -> Result<(), String> {
    for (key, item) in pairs {
        if !NET_USER_KEYS.contains(key) {
            return Err(format!("the network option {key} is not allowed"));
        }
        if *key == "hostfwd" {
            check_hostfwd(item)?;
        } else if !charset(item, "._-/:") {
            return Err(format!("the network option {key}={item} is not allowed"));
        }
    }
    Ok(())
}

fn simple(value: &str, extra: &str) -> Result<(), String> {
    if charset(value, extra) {
        Ok(())
    } else {
        Err("the value holds characters that are not allowed".to_owned())
    }
}

fn check_pairs(pairs: &[(&str, &str)], keys: &[&str], extra: &str) -> Result<(), String> {
    for (key, item) in pairs {
        if !keys.contains(key) || !charset(item, extra) {
            return Err(format!("{key}={item} is not allowed here"));
        }
    }
    Ok(())
}

fn check_keys(value: &str, bare: &[&str], keys: &[&str], extra: &str) -> Result<(), String> {
    let (head, pairs) = options(value)?;
    if let Some(head) = head
        && !(bare.is_empty() && charset(head, extra) || bare.contains(&head))
    {
        return Err(format!("{head} is not allowed here"));
    }
    check_pairs(&pairs, keys, extra)
}

fn check_drive(value: &str, root: &Path) -> Result<(), String> {
    let (head, pairs) = options(value)?;
    if head.is_some() {
        return Err(format!("{value:?} must name its file with file="));
    }
    let mut has_file = false;
    for (key, item) in pairs {
        match key {
            "file" => {
                check_vm_file(root, item)?;
                has_file = true;
            }
            "format"
                if matches!(
                    item,
                    "raw" | "qcow2" | "qcow" | "vmdk" | "vdi" | "vpc" | "vhdx"
                ) => {}
            "if" if matches!(item, "ide" | "floppy" | "scsi" | "virtio" | "none" | "sd") => {}
            "media" if matches!(item, "disk" | "cdrom") => {}
            "cache"
                if matches!(
                    item,
                    "writeback" | "writethrough" | "none" | "unsafe" | "directsync"
                ) => {}
            "snapshot" | "readonly" if matches!(item, "on" | "off") => {}
            "index" | "bus" | "unit" if item.parse::<u32>().is_ok() => {}
            "id" if charset(item, "_-") => {}
            _ => return Err(format!("the drive option {key}={item} is not allowed")),
        }
    }
    if !has_file {
        return Err(format!(
            "{value:?} does not name a file in the VM's directory"
        ));
    }
    Ok(())
}

/// `WxH` or `COLSCxROWSC`, the size of a virtual console.
fn console_size(value: &str) -> bool {
    let number = |part: &str| {
        let digits = part.strip_suffix('C').unwrap_or(part);
        !digits.is_empty() && digits.len() <= 5 && digits.chars().all(|c| c.is_ascii_digit())
    };
    matches!(value.split_once('x'), Some((width, height)) if number(width) && number(height))
}

/// `-monitor vc`, the human monitor on QEMU's own window, or `-monitor none`. Every other monitor reaches
/// a file, a socket, a pipe or the console, and `stdio` is the agent's own channel.
fn check_monitor(value: &str) -> Result<(), String> {
    let on_window = value == "vc" || value.strip_prefix("vc:").is_some_and(console_size);
    match value {
        _ if on_window || value == "none" => Ok(()),
        "stdio" => Err(
            "EmuCat uses QEMU's standard input and output for its own QMP monitor. Use -monitor vc, \
             which QEMU shows on Ctrl+Alt+2"
                .to_owned(),
        ),
        _ => Err(
            "only -monitor vc and -monitor none are allowed: other monitors reach files, sockets, \
             pipes or the host console"
                .to_owned(),
        ),
    }
}

/// `-chardev vc,id=ID[,width=,height=,cols=,rows=]` or `-chardev null,id=ID`: the only character devices that
/// reach nothing outside QEMU's window. Returns the device's ID. QEMU names the monitors it makes for
/// `-qmp` and `-monitor` `compat_monitorN`, so those IDs are left to it.
fn check_chardev(value: &str) -> Result<&str, String> {
    let (backend, pairs) = options(value)?;
    let sizes: &[&str] = match backend {
        Some("vc") => &["width", "height", "cols", "rows"],
        Some("null") => &[],
        _ => {
            return Err(
                "only vc and null character devices are allowed: others reach files, sockets and pipes"
                    .to_owned(),
            );
        }
    };
    let mut id = None;
    for (key, item) in pairs {
        match key {
            "id" if charset(item, "_-.") => id = Some(item),
            _ if sizes.contains(&key)
                && item.len() <= 5
                && item.parse::<u32>().is_ok_and(|n| n > 0) => {}
            _ => {
                return Err(format!(
                    "the character device option {key}={item} is not allowed"
                ));
            }
        }
    }
    let id = id.ok_or_else(|| "a character device needs an id".to_owned())?;
    if id.to_ascii_lowercase().starts_with("compat_monitor") {
        return Err(format!(
            "{id} is a name QEMU gives its own monitors, and would clash with EmuCat's"
        ));
    }
    Ok(id)
}

/// `-mon [chardev=]ID[,mode=readline][,pretty=on|off]`: a human monitor on a character device that the same
/// arguments define. Returns the device's ID. A QMP monitor (`mode=control`) is the agent's own.
fn check_mon(value: &str) -> Result<&str, String> {
    let (head, pairs) = options(value)?;
    let mut chardev = head;
    for (key, item) in pairs {
        match key {
            "chardev" if chardev.is_none() => chardev = Some(item),
            "mode" if item == "readline" => {}
            "mode" => {
                return Err(
                    "only mode=readline is allowed: a QMP monitor is EmuCat's own".to_owned(),
                );
            }
            "pretty" if matches!(item, "" | "on" | "off") => {}
            "id" if charset(item, "_-.") => {}
            _ => return Err(format!("the monitor option {key}={item} is not allowed")),
        }
    }
    chardev
        .filter(|id| charset(id, "_-."))
        .ok_or_else(|| "a monitor must name its character device with chardev=".to_owned())
}

/// Checks a QEMU argument vector against the allowlist. File arguments must be inside the VM's directory.
pub fn check_qemu_arguments(args: &[String], root: &Path) -> Result<(), LaunchError> {
    if args.len() > MAX_ARGUMENTS {
        return Err(required("it has too many arguments"));
    }
    // Character devices that `-chardev` defines, and those `-mon` puts a monitor on, which must be among them.
    let mut chardevs: Vec<&str> = Vec::new();
    let mut monitored: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let raw = &args[index];
        let Some(name) = raw.strip_prefix("--").or_else(|| raw.strip_prefix('-')) else {
            return Err(required(format!(
                "{raw:?} is not an option. Disk images must be given with an option such as -hda"
            )));
        };
        if let Some((_, why)) = REFUSED.iter().find(|(refused, _)| *refused == name) {
            return Err(required(format!("-{name} is not allowed: {why}")));
        }
        if QEMU_FLAGS.contains(&name) {
            index += 1;
            continue;
        }
        let Some(value) = args.get(index + 1) else {
            return Err(required(format!("-{name} needs a value")));
        };
        let checked = match name {
            "machine" | "M" => check_keys(
                value,
                &[],
                &[
                    "type",
                    "accel",
                    "usb",
                    "vmport",
                    "acpi",
                    "smm",
                    "hpet",
                    "graphics",
                    "kernel-irqchip",
                    "kernel_irqchip",
                    "pcspk-audiodev",
                    "i8042",
                    "sata",
                    "pic",
                    "pit",
                    "mem-merge",
                ],
                "_-.",
            ),
            "cpu" => simple(value, "_-.,=+"),
            "accel" => check_keys(
                value,
                &["tcg", "whpx", "kvm", "hax"],
                &["thread", "tb-size", "kernel-irqchip", "split-wx"],
                "_-",
            ),
            "m" => simple(value, ".,="),
            "smp" => simple(value, ",="),
            "vga" => simple(value, "_-"),
            "boot" => check_keys(
                value,
                &[],
                &[
                    "order",
                    "once",
                    "menu",
                    "strict",
                    "reboot-timeout",
                    "splash-time",
                ],
                "",
            ),
            "rtc" => check_keys(value, &[], &["base", "clock", "driftfix"], "_-:."),
            "k" => simple(value, "-"),
            "name" => simple(value, "_-.,="),
            "usbdevice" if matches!(value.as_str(), "tablet" | "mouse" | "keyboard") => Ok(()),
            "usbdevice" => Err("only tablet, mouse and keyboard are allowed".to_owned()),
            "device" => check_device(value),
            "global" => match value.split_once('=') {
                Some((property, item))
                    if charset(property, "_-.")
                        && charset(item, "_-.:")
                        && !DEVICE_KEYS_REFUSED
                            .iter()
                            .any(|key| property.ends_with(&format!(".{key}"))) =>
                {
                    Ok(())
                }
                _ => Err(format!("-global {value} is not allowed")),
            },
            "drive" => check_drive(value, root),
            "hda" | "hdb" | "hdc" | "hdd" | "cdrom" | "fda" | "fdb" | "bios" | "kernel"
            | "initrd" | "option-rom" => check_vm_file(root, value),
            "netdev" => match options(value)? {
                (Some("user"), pairs) => check_net_user(&pairs),
                (other, _) => Err(format!(
                    "-netdev {} is not allowed. Only user networking is",
                    other.unwrap_or(value)
                )),
            },
            "net" => match options(value)? {
                (Some("nic"), pairs) => check_pairs(
                    &pairs,
                    &["model", "macaddr", "vlan", "netdev", "name", "id"],
                    "_-.:",
                ),
                (Some("user"), pairs) => check_net_user(&pairs),
                (Some("none"), pairs) if pairs.is_empty() => Ok(()),
                (other, _) => Err(format!(
                    "-net {} is not allowed. Only nic, user and none are",
                    other.unwrap_or(value)
                )),
            },
            "display" => check_keys(
                value,
                &["sdl", "gtk", "none", "default"],
                &[
                    "window-close",
                    "full-screen",
                    "zoom-to-fit",
                    "grab-on-hover",
                    "show-cursor",
                    "gl",
                ],
                "_-",
            ),
            "audiodev" => match options(value)? {
                (Some(kind), pairs)
                    if matches!(kind, "dsound" | "sdl" | "none" | "wasapi")
                        && pairs.iter().all(|(key, item)| {
                            !key.contains("path") && charset(key, "_-.") && charset(item, "_-.")
                        }) =>
                {
                    Ok(())
                }
                _ => Err(format!("-audiodev {value} is not allowed")),
            },
            "soundhw" => simple(value, "_-,"),
            "monitor" => check_monitor(value),
            "chardev" => check_chardev(value).map(|id| chardevs.push(id)),
            "mon" => check_mon(value).map(|id| monitored.push(id)),
            _ => Err(format!(
                "-{name} is not an option EmuCat can check. Remove it, or describe the VM in {QEMU_PROFILE_FILE} \
                 with options it can check"
            )),
        };
        checked.map_err(|why| required(format!("-{name} {value}: {why}")))?;
        index += 2;
    }
    if let Some(missing) = monitored.iter().find(|id| !chardevs.contains(id)) {
        return Err(required(format!(
            "-mon chardev={missing}: no -chardev vc or -chardev null has that id"
        )));
    }
    Ok(())
}

impl From<String> for LaunchError {
    fn from(message: String) -> Self {
        required(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plain_launcher_split_over_lines() {
        let text = "@echo off\r\nrem A VM\r\nqemu-system-i386 -machine pc  ^\r\n   -m 128 ^\r\n   -hda disk.img\r\n";
        let command = parse_batch_launcher(text).unwrap();
        assert_eq!(command.system, "i386");
        assert_eq!(
            command.args,
            ["-machine", "pc", "-m", "128", "-hda", "disk.img"]
        );
    }

    #[test]
    fn refuses_anything_a_shell_would_interpret() {
        for text in [
            "qemu-system-i386 -m 128 & calc.exe",
            "qemu-system-i386 -hda %DISK%",
            "qemu-system-i386 -m 128 > log.txt",
            "qemu-system-i386 -m 128\ncalc.exe",
            "start qemu-system-i386 -m 128",
            "C:\\qemu\\qemu-system-i386.exe -m 128",
            "set X=1\nqemu-system-i386 -m 128",
            "qemu-system-i386 -m \"128",
        ] {
            assert!(parse_batch_launcher(text).is_err(), "{text}");
        }
    }

    #[test]
    fn quotes_group_and_are_removed() {
        let command =
            parse_batch_launcher("qemu-system-x86_64 -name \"a\" -hda \"my disk.img\"").unwrap();
        assert_eq!(command.args, ["-name", "a", "-hda", "my disk.img"]);
    }

    #[test]
    fn refuses_options_that_reach_outside_the_vm() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("disk.img"), b"x").unwrap();
        let ok = |args: &[&str]| {
            check_qemu_arguments(
                &args.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
                root.path(),
            )
        };
        assert!(
            ok(&[
                "-m",
                "128",
                "-hda",
                "disk.img",
                "-drive",
                "file=disk.img,format=raw,index=1,media=disk"
            ])
            .is_ok()
        );
        assert!(
            ok(&[
                "-netdev",
                "user,id=n0,hostfwd=tcp:127.0.0.1:8888-:80",
                "-device",
                "ne2k_pci,netdev=n0"
            ])
            .is_ok()
        );
        for refused in [
            vec!["-hda", "..\\other\\disk.img"],
            vec!["-hda", "C:\\disk.img"],
            vec!["-hda", "missing.img"],
            vec![
                "-drive",
                "file=disk.img,format=raw,snapshot=on,file.driver=nbd",
            ],
            vec!["-drive", "file=fat:rw:."],
            vec!["-netdev", "user,id=n0,hostfwd=tcp::8888-:80"],
            vec!["-netdev", "tap,id=n0,script=evil.bat"],
            vec!["-netdev", "user,id=n0,guestfwd=tcp:10.0.2.100:1-cmd:calc"],
            vec!["-netdev", "user,id=n0,smb=C:\\"],
            vec!["-monitor", "stdio"],
            vec!["-serial", "file:C:\\x"],
            vec!["-chardev", "socket,id=a,port=1"],
            vec!["-device", "loader,file=disk.img"],
            vec!["-device", "isa-serial,chardev=a"],
            vec!["-no-shutdown"],
            vec!["-nographic"],
            vec!["-object", "memory-backend-file,id=m,mem-path=C:\\x"],
            vec!["disk.img"],
            vec!["-unknown-option", "x"],
            vec!["-machine", "pc,dumpdtb=out.dtb"],
        ] {
            assert!(ok(&refused).is_err(), "{refused:?}");
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn a_graphical_vm_gets_back_the_human_monitor_qemu_would_have_shown() {
        // The VM this was found with: QEMU's default monitor, on Ctrl+Alt+2.
        let nt40 = [
            "-machine",
            "pc",
            "-cpu",
            "pentium",
            "-vga",
            "cirrus",
            "-boot",
            "once=a",
            "-m",
            "128",
            "-drive",
            "file=nt40.qcow2.img,format=qcow2,index=0,media=disk",
            "-net",
            "nic,model=ne2k_pci",
            "-net",
            "user",
        ];
        assert_eq!(human_monitor(&strings(&nt40)), HumanMonitor::Added);
        assert_eq!(human_monitor(&[]), HumanMonitor::Added);
        for graphical in [
            &["-display", "sdl"][..],
            &["-display", "gtk,zoom-to-fit=on"],
            &["-machine", "pc,graphics=on"],
            // Values are not options, whatever they look like.
            &["-name", "-monitor"],
            &["-name", "-nographic", "-m", "64"],
        ] {
            assert_eq!(
                human_monitor(&strings(graphical)),
                HumanMonitor::Added,
                "{graphical:?}"
            );
        }
    }

    #[test]
    fn a_monitor_the_vm_configures_or_disables_is_respected() {
        for (args, expected) in [
            (&["-monitor", "vc"][..], HumanMonitor::Configured),
            (&["-monitor", "vc:800x600"], HumanMonitor::Configured),
            (
                &["-chardev", "vc,id=hmp", "-mon", "chardev=hmp,mode=readline"],
                HumanMonitor::Configured,
            ),
            (&["-monitor", "none"], HumanMonitor::Disabled),
            (&["-nodefaults", "-m", "64"], HumanMonitor::DefaultsDisabled),
            // A monitor of its own wins over defaults switched off.
            (&["-nodefaults", "-monitor", "vc"], HumanMonitor::Configured),
            // A character device alone is not a monitor.
            (&["-chardev", "vc,id=spare"], HumanMonitor::Added),
            // `--option` and `-option=value` forms, which QEMU itself may not take, are read all the same.
            (&["--monitor", "vc"], HumanMonitor::Configured),
            (&["-monitor=vc"], HumanMonitor::Configured),
            (&["--monitor=none"], HumanMonitor::Disabled),
            (&["-mon=chardev=hmp"], HumanMonitor::Configured),
            (&["--nodefaults"], HumanMonitor::DefaultsDisabled),
        ] {
            assert_eq!(human_monitor(&strings(args)), expected, "{args:?}");
        }
    }

    #[test]
    fn a_headless_vm_gets_no_window_monitor() {
        for args in [
            &["-display", "none"][..],
            &["-display", "none,gl=off"],
            &["-display=none"],
            &["--display", "none"],
            &["-nographic"],
            &["--nographic", "-m", "64"],
            &["-machine", "pc,graphics=off"],
            &["-M=pc,graphics=off"],
        ] {
            assert_eq!(
                human_monitor(&strings(args)),
                HumanMonitor::Headless,
                "{args:?}"
            );
        }
        // A monitor the VM asks for is its own, display or not.
        assert_eq!(
            human_monitor(&strings(&["-display", "none", "-monitor", "vc"])),
            HumanMonitor::Configured
        );
    }

    fn qemu_root(launcher: &str) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("run.bat"), launcher).unwrap();
        fs::write(root.path().join("disk.img"), b"x").unwrap();
        root
    }

    fn planned(root: &Path) -> Vec<String> {
        // The configured executable is the system the launcher asks for, so it is used as it is.
        let plan = plan_qemu(
            Path::new("C:\\qemu\\qemu-system-i386.exe"),
            root.to_path_buf(),
        )
        .unwrap();
        assert_eq!(plan.spawn.working_dir, root, "the VM's own directory");
        assert!(plan.spawn.qmp_stdio);
        assert_eq!(plan.graceful, GracefulStop::QmpPowerdown);
        plan.spawn
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_launch_keeps_the_vm_arguments_and_adds_qmp_then_the_human_monitor() {
        let root = qemu_root("qemu-system-i386 -m 128 -vga cirrus -hda disk.img\r\n");
        assert_eq!(
            planned(root.path()),
            [
                "-m", "128", "-vga", "cirrus", "-hda", "disk.img", "-qmp", "stdio", "-monitor",
                "vc"
            ]
        );
        // A launch profile, which takes precedence, gets the same.
        fs::write(
            root.path().join(QEMU_PROFILE_FILE),
            r#"{"profileVersion":1,"system":"i386","args":["-m","64","-hda","disk.img"]}"#,
        )
        .unwrap();
        assert_eq!(
            planned(root.path()),
            [
                "-m", "64", "-hda", "disk.img", "-qmp", "stdio", "-monitor", "vc"
            ]
        );
        assert!(root.path().join("run.bat").is_file());
    }

    #[test]
    fn the_launch_adds_no_monitor_beside_one_the_vm_has_or_turns_off() {
        for (launcher, tail) in [
            (
                "qemu-system-i386 -hda disk.img -monitor vc",
                &["-monitor", "vc", "-qmp", "stdio"][..],
            ),
            (
                "qemu-system-i386 -hda disk.img -monitor none",
                &["-monitor", "none", "-qmp", "stdio"],
            ),
            (
                "qemu-system-i386 -hda disk.img -chardev vc,id=hmp,cols=80,rows=25 -mon chardev=hmp",
                &[
                    "-chardev",
                    "vc,id=hmp,cols=80,rows=25",
                    "-mon",
                    "chardev=hmp",
                    "-qmp",
                    "stdio",
                ],
            ),
            (
                "qemu-system-i386 -hda disk.img -display none",
                &["-display", "none", "-qmp", "stdio"],
            ),
            (
                "qemu-system-i386 -hda disk.img -nodefaults",
                &["-nodefaults", "-qmp", "stdio"],
            ),
        ] {
            let root = qemu_root(launcher);
            let args = planned(root.path());
            assert_eq!(&args[2..], tail, "{launcher}");
            let monitors = args
                .iter()
                .filter(|a| matches!(a.as_str(), "-monitor" | "-mon"))
                .count();
            assert!(monitors <= 1, "{launcher}: {args:?}");
        }
    }

    #[test]
    fn only_monitors_on_qemus_own_window_are_allowed() {
        let root = tempfile::tempdir().unwrap();
        let check = |args: &[&str]| check_qemu_arguments(&strings(args), root.path());
        for allowed in [
            &["-monitor", "vc"][..],
            &["-monitor", "vc:1024x768"],
            &["-monitor", "vc:80Cx24C"],
            &["-monitor", "none"],
            &["-chardev", "vc,id=hmp", "-mon", "chardev=hmp"],
            &[
                "-mon",
                "hmp,mode=readline",
                "-chardev",
                "vc,id=hmp,width=640,height=480",
            ],
            &[
                "-chardev",
                "null,id=nowhere",
                "-mon",
                "chardev=nowhere,pretty=off",
            ],
            &["-chardev", "vc,id=spare"],
        ] {
            assert!(check(allowed).is_ok(), "{allowed:?}: {:?}", check(allowed));
        }
        for refused in [
            &["-monitor", "stdio"][..],
            &["-monitor", "tcp:127.0.0.1:4444,server,nowait"],
            &["-monitor", "telnet::4444,server"],
            &["-monitor", "file:C:\\x"],
            &["-monitor", "pipe:x"],
            &["-monitor", "chardev:hmp"],
            &["-monitor", "vc:big"],
            &["-monitor=vc"],
            &["-monitor"],
            &["-mon", "chardev=hmp"],
            &["-chardev", "vc,id=hmp", "-mon", "chardev=hmp,mode=control"],
            &["-chardev", "vc,id=hmp", "-mon", "chardev=other"],
            &["-chardev", "stdio,id=hmp", "-mon", "chardev=hmp"],
            &["-chardev", "socket,id=a,port=1"],
            &["-chardev", "file,id=a,path=C:\\x"],
            &["-chardev", "vc,id=a,logfile=C:\\x"],
            &["-chardev", "vc"],
            &["-chardev", "vc,id=compat_monitor1"],
            &["-qmp", "stdio"],
            &["-qmp-pretty", "stdio"],
            &["-nographic"],
        ] {
            assert!(check(refused).is_err(), "{refused:?}");
        }
        let stdio = check(&["-monitor", "stdio"]).unwrap_err();
        assert!(stdio.message.contains("-monitor vc"), "{}", stdio.message);
    }

    #[test]
    fn executable_names_are_checked() {
        assert!(expected_name(
            EmulatorType::Box86,
            Path::new("C:\\e\\86Box.exe")
        ));
        assert!(expected_name(
            EmulatorType::Qemu,
            Path::new("C:\\q\\qemu-system-x86_64.exe")
        ));
        assert!(!expected_name(
            EmulatorType::Qemu,
            Path::new("C:\\q\\cmd.exe")
        ));
        assert!(!expected_name(
            EmulatorType::Box86,
            Path::new("C:\\e\\86Box.bat")
        ));
    }
}
