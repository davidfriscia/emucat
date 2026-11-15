//! Finds the virtual machines registered with the local VirtualBox installation, through `VBoxManage`.
//!
//! Unlike 86Box and QEMU, VirtualBox keeps its own list of machines, so nothing here scans a directory:
//! every VM `VBoxManage list vms` shows the account running the agent is reported, and that is all the
//! access control there is. See decision 0044.
//!
//! This is strictly read-only. Only `--version`, `list vms` and `showvminfo <uuid> --machinereadable`
//! are ever run. The executable is started directly with an argument vector, never through a shell,
//! and a VM is always named by the UUID VirtualBox gave it, never by its display name. Each command has
//! a time limit and a limit on how much of its output is read, and machines are inspected one at a
//! time, so a slow or wedged VirtualBox cannot pile up processes or stall the agent.
//!
//! What is reported is deliberately small: identity, guest OS type, state and a few numbers. No path
//! VirtualBox prints, such as the settings file, disk images or shared folders, ever leaves this module.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

/// Most machines one report lists. Mirrors `VIRTUALBOX_MAX_VMS` in `@emucat/contracts`.
pub const VIRTUALBOX_MAX_VMS: usize = 128;
/// Display names are cut to this many characters. The UUID, not the name, identifies a machine.
pub const VIRTUALBOX_NAME_MAX_CHARS: usize = 128;
pub const VIRTUALBOX_OS_TYPE_MAX_CHARS: usize = 64;
pub const VIRTUALBOX_RAW_STATE_MAX_CHARS: usize = 32;
pub const VIRTUALBOX_VERSION_MAX_CHARS: usize = 64;

/// The name `VBoxManage` gives a machine whose settings it cannot read.
const INACCESSIBLE_NAME: &str = "<inaccessible>";

/// Where `VBoxManage` is. Configured, never assumed: the agent has no built-in path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualBoxConfig {
    pub vboxmanage: PathBuf,
}

/// Bounds on the work of one discovery, whatever VirtualBox does.
#[derive(Debug, Clone, Copy)]
pub struct VirtualBoxLimits {
    /// How long any one command may run before it is killed.
    pub command_timeout: Duration,
    /// When this has passed, machines not yet inspected are reported as such.
    pub time_budget: Duration,
    pub max_vms: usize,
    /// How much of a command's standard output is read. The rest is discarded.
    pub max_output_bytes: usize,
}

impl Default for VirtualBoxLimits {
    fn default() -> Self {
        Self {
            command_timeout: Duration::from_secs(10),
            time_budget: Duration::from_secs(20),
            max_vms: VIRTUALBOX_MAX_VMS,
            max_output_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VirtualBoxStatus {
    Ok,
    NotConfigured,
    /// The configured `VBoxManage` does not exist, is not a file, or cannot be started.
    ExecutableMissing,
    /// `--version` printed something that is not a VirtualBox version.
    UnrecognizedVersion,
    /// `list vms` printed lines, none of which describes a machine.
    UnrecognizedOutput,
    /// A command ended with an error.
    CommandFailed,
    /// A command did not finish in time, and was killed.
    Timeout,
}

/// A machine's state, grouped into what EmuCat needs to tell apart. The state VirtualBox itself
/// reported is kept beside it, so that nothing is lost when a newer VirtualBox has a state this does
/// not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VirtualBoxVmState {
    PoweredOff,
    Running,
    Paused,
    Saved,
    Starting,
    Stopping,
    Aborted,
    /// Guru meditation: the VM has stopped on an error and needs to be powered off.
    Stuck,
    /// Taking, restoring or deleting a snapshot, or another transient operation.
    Busy,
    Inaccessible,
    Unknown,
}

impl VirtualBoxVmState {
    /// Maps a `VMState` from `showvminfo --machinereadable`. Anything unknown is `Unknown`.
    pub fn from_machine_readable(value: &str) -> Self {
        match value {
            "poweroff" | "teleported" => Self::PoweredOff,
            "running"
            | "teleporting"
            | "livesnapshotting"
            | "onlinesnapshotting"
            | "deletingsnapshotlive" => Self::Running,
            "paused" | "teleportingpausedvm" | "deletingsnapshotlivepaused" => Self::Paused,
            "saved" | "aborted-saved" => Self::Saved,
            "starting" | "restoring" | "teleportingin" => Self::Starting,
            "stopping" | "saving" => Self::Stopping,
            "aborted" => Self::Aborted,
            "gurumeditation" | "stuck" => Self::Stuck,
            "settingup" | "snapshotting" | "restoringsnapshot" | "deletingsnapshot" => Self::Busy,
            _ => Self::Unknown,
        }
    }
}

/// Why a machine that was listed could not be described.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VirtualBoxVmError {
    /// `showvminfo` ended with an error.
    InspectionFailed,
    /// `showvminfo` did not finish in time.
    Timeout,
    /// Unregistered since it was listed.
    Vanished,
    /// The time budget ran out before its turn.
    NotInspected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualBoxVm {
    /// The machine's identity. Always lowercase and hyphenated.
    pub uuid: Uuid,
    /// VirtualBox's display name, free of control characters and bounded. For display only.
    pub name: String,
    /// The guest OS type as VirtualBox describes it, such as `Windows 7 (32-bit)`.
    pub os_type: Option<String>,
    pub state: VirtualBoxVmState,
    /// The `VMState` VirtualBox reported, if any.
    pub raw_state: Option<String>,
    /// When the state last changed, in UTC.
    pub state_changed_at: Option<String>,
    /// Whether VirtualBox can read the machine's settings. Unknown when it could not be inspected.
    pub accessible: Option<bool>,
    pub memory_mb: Option<u32>,
    pub cpus: Option<u32>,
    pub error: Option<VirtualBoxVmError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualBoxReport {
    pub status: VirtualBoxStatus,
    /// What `VBoxManage --version` printed, such as `7.1.10r169112`.
    pub version: Option<String>,
    /// Some machines were not listed, or not inspected, because a limit was reached.
    pub truncated: bool,
    pub vms: Vec<VirtualBoxVm>,
}

impl VirtualBoxReport {
    pub fn not_configured() -> Self {
        Self::failed(VirtualBoxStatus::NotConfigured, None)
    }

    fn failed(status: VirtualBoxStatus, version: Option<String>) -> Self {
        Self {
            status,
            version,
            truncated: false,
            vms: Vec::new(),
        }
    }
}

// Running VBoxManage.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum RunError {
    /// The program does not exist, or is not something that can be started.
    NotFound,
    Spawn(io::Error),
    Timeout,
}

/// Runs `VBoxManage` with the given arguments. Tests replace it with fixtures.
pub trait CommandRunner {
    fn run(&self, args: &[&OsStr], timeout: Duration) -> Result<CommandOutput, RunError>;
}

/// Starts a program directly, with an argument vector, a time limit and bounded output.
#[derive(Debug, Clone)]
pub struct ProcessRunner {
    pub program: PathBuf,
    pub max_output_bytes: usize,
}

/// How much of standard error is kept: enough to classify a failure, which is all it is used for.
const MAX_STDERR_BYTES: usize = 16 * 1024;
/// After the process exits, how long its pipes may stay open, held by something it started.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Reads up to `limit` bytes, then keeps draining so that the writer never blocks on a full pipe.
fn read_bounded(mut source: impl Read, limit: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match source.read(&mut buffer) {
            Ok(0) | Err(_) => return kept,
            Ok(read) => {
                let room = limit.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
}

fn spawn_reader(source: impl Read + Send + 'static, limit: usize) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(read_bounded(source, limit));
    });
    receiver
}

/// Text as `VBoxManage` wrote it. It writes UTF-8 when it can and the ANSI code page otherwise, in
/// which case a name with characters outside that code page has already lost them.
fn decode(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => decode_ansi(error.into_bytes()),
    }
}

#[cfg(windows)]
fn decode_ansi(bytes: Vec<u8>) -> String {
    use windows_sys::Win32::Globalization::{CP_ACP, MultiByteToWideChar};
    let Ok(length) = i32::try_from(bytes.len()) else {
        return String::from_utf8_lossy(&bytes).into_owned();
    };
    if length == 0 {
        return String::new();
    }
    // SAFETY: the input pointer and length describe `bytes`; the first call only measures.
    let needed =
        unsafe { MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), length, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    let mut wide = vec![0_u16; needed as usize];
    // SAFETY: `wide` has exactly the room the first call asked for.
    let written = unsafe {
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), length, wide.as_mut_ptr(), needed)
    };
    if written <= 0 {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}

#[cfg(not(windows))]
fn decode_ansi(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

impl CommandRunner for ProcessRunner {
    fn run(&self, args: &[&OsStr], timeout: Duration) -> Result<CommandOutput, RunError> {
        if !self.program.is_file() {
            return Err(RunError::NotFound);
        }
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window flashes up for a command the agent runs in the background.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => RunError::NotFound,
            _ => RunError::Spawn(error),
        })?;
        let stdout = child
            .stdout
            .take()
            .map(|pipe| spawn_reader(pipe, self.max_output_bytes));
        let stderr = child
            .stderr
            .take()
            .map(|pipe| spawn_reader(pipe, MAX_STDERR_BYTES));

        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Timeout);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::Spawn(error));
                }
            }
        };
        let collect = |receiver: Option<mpsc::Receiver<Vec<u8>>>| {
            receiver
                .and_then(|receiver| receiver.recv_timeout(PIPE_GRACE).ok())
                .map(decode)
                .unwrap_or_default()
        };
        Ok(CommandOutput {
            success: status.success(),
            stdout: collect(stdout),
            stderr: collect(stderr),
        })
    }
}

// Reading what VBoxManage prints.

/// A display value made safe to report: no control characters, and at most `max` characters.
pub fn clean_text(raw: &str, max: usize) -> String {
    raw.chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect()
}

/// The version from `VBoxManage --version`, such as `7.1.10r169112`. Warnings printed before it, as
/// VBoxManage does when a kernel driver is missing, are passed over.
pub fn parse_version(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| is_version(line))
        .map(str::to_owned)
}

fn is_version(line: &str) -> bool {
    if line.is_empty() || line.chars().count() > VIRTUALBOX_VERSION_MAX_CHARS {
        return false;
    }
    if !line
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return false;
    }
    // A numeric major version, a dot, and a minor version that starts with a digit.
    let mut parts = line.split('.');
    let major = parts
        .next()
        .is_some_and(|major| !major.is_empty() && major.bytes().all(|byte| byte.is_ascii_digit()));
    let minor = parts.next().is_some_and(|minor| {
        minor
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_digit())
    });
    major && minor
}

/// A UUID only in the form VirtualBox prints, with hyphens.
fn parse_uuid(text: &str) -> Option<Uuid> {
    (text.len() == 36)
        .then(|| Uuid::try_parse(text).ok())
        .flatten()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedVm {
    pub uuid: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VmList {
    pub vms: Vec<ListedVm>,
    /// Lines that did not describe a machine.
    pub unrecognized: usize,
}

/// Reads `VBoxManage list vms`: one `"name" {uuid}` per line. A name may itself hold quotes or braces,
/// so the UUID is read from the end of the line and the name is whatever lies between the outer quotes.
pub fn parse_vm_list(output: &str) -> VmList {
    let mut list = VmList::default();
    let mut seen = HashSet::new();
    for line in output.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let Some(vm) = parse_vm_line(line) else {
            list.unrecognized += 1;
            continue;
        };
        if seen.insert(vm.uuid) {
            list.vms.push(vm);
        }
    }
    list
}

fn parse_vm_line(line: &str) -> Option<ListedVm> {
    let rest = line.strip_prefix('"')?;
    let rest = rest.strip_suffix('}')?;
    let (name, uuid) = rest.rsplit_once(" {")?;
    let name = name.strip_suffix('"')?;
    Some(ListedVm {
        uuid: parse_uuid(uuid)?,
        name: name.to_owned(),
    })
}

/// Undoes the escaping of `showvminfo --machinereadable`, which writes `\"`, `\\` and `\n`.
fn unescape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        match characters.next() {
            Some('n') => result.push('\n'),
            Some(other) => result.push(other),
            None => result.push('\\'),
        }
    }
    result
}

/// `key="value"` or `key=value` lines. The first occurrence of a key wins: a key only ever appears
/// once, and an older VirtualBox that printed a multi-line description cannot override one with it.
pub fn parse_machine_readable(output: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        let Some((key, value)) = split_key_value(line) else {
            continue;
        };
        values.entry(key).or_insert(value);
    }
    values
}

fn split_key_value(line: &str) -> Option<(String, String)> {
    let (key, rest) = if let Some(quoted) = line.strip_prefix('"') {
        let end = quoted.find('"')?;
        (
            quoted[..end].to_owned(),
            quoted[end + 1..].strip_prefix('=')?,
        )
    } else {
        let (key, rest) = line.split_once('=')?;
        (key.to_owned(), rest)
    };
    if key.is_empty() {
        return None;
    }
    let value = match rest
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
    {
        Some(inner) => unescape(inner),
        None => rest.to_owned(),
    };
    Some((key, value))
}

/// `VMStateChangeTime`, which VirtualBox prints in UTC without saying so: `2025-07-18T05:33:15.000000000`.
pub fn parse_state_time(value: &str) -> Option<String> {
    let seconds = value.get(..19)?;
    if seconds.as_bytes()[10] != b'T' {
        return None;
    }
    let rest = &value[19..];
    let fraction_ok = rest.is_empty()
        || rest == "Z"
        || rest.strip_prefix('.').is_some_and(|digits| {
            let digits = digits.strip_suffix('Z').unwrap_or(digits);
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !fraction_ok {
        return None;
    }
    // Whole seconds only: the fraction VirtualBox prints is always zero.
    let utc = OffsetDateTime::parse(&format!("{seconds}Z"), &Rfc3339).ok()?;
    utc.format(&Rfc3339).ok()
}

fn bounded_number(value: Option<&String>, max: u32) -> Option<u32> {
    value
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|number| *number <= max)
}

/// What `showvminfo --machinereadable` says about the machine it was asked about.
pub fn describe(listed: &ListedVm, output: &str) -> VirtualBoxVm {
    let values = parse_machine_readable(output);
    let name = values
        .get("name")
        .cloned()
        .unwrap_or_else(|| listed.name.clone());
    let raw_state = values
        .get("VMState")
        .map(|state| clean_text(state, VIRTUALBOX_RAW_STATE_MAX_CHARS));
    // For a machine it cannot read, VirtualBox prints only this name and the UUID.
    let accessible = !(raw_state.is_none() && name == INACCESSIBLE_NAME);
    let state = match &raw_state {
        _ if !accessible => VirtualBoxVmState::Inaccessible,
        Some(state) => VirtualBoxVmState::from_machine_readable(state),
        None => VirtualBoxVmState::Unknown,
    };
    VirtualBoxVm {
        uuid: listed.uuid,
        name: clean_text(&name, VIRTUALBOX_NAME_MAX_CHARS),
        os_type: values
            .get("ostype")
            .map(|os| clean_text(os, VIRTUALBOX_OS_TYPE_MAX_CHARS))
            .filter(|os| !os.is_empty()),
        state,
        raw_state,
        state_changed_at: values
            .get("VMStateChangeTime")
            .and_then(|time| parse_state_time(time)),
        accessible: Some(accessible),
        memory_mb: bounded_number(values.get("memory"), 16 * 1024 * 1024),
        cpus: bounded_number(values.get("cpus"), 1024),
        error: None,
    }
}

/// A listed machine that could not be described. Nothing about it is guessed.
fn undescribed(listed: &ListedVm, error: VirtualBoxVmError) -> VirtualBoxVm {
    let inaccessible = listed.name == INACCESSIBLE_NAME;
    VirtualBoxVm {
        uuid: listed.uuid,
        name: clean_text(&listed.name, VIRTUALBOX_NAME_MAX_CHARS),
        os_type: None,
        state: if inaccessible {
            VirtualBoxVmState::Inaccessible
        } else {
            VirtualBoxVmState::Unknown
        },
        raw_state: None,
        state_changed_at: None,
        accessible: inaccessible.then_some(false),
        memory_mb: None,
        cpus: None,
        error: Some(error),
    }
}

/// Whether `showvminfo` failed because the machine is no longer registered.
fn is_not_found(stderr: &str) -> bool {
    stderr.contains("VBOX_E_OBJECT_NOT_FOUND")
}

fn status_for(error: &RunError) -> VirtualBoxStatus {
    match error {
        RunError::NotFound => VirtualBoxStatus::ExecutableMissing,
        RunError::Spawn(_) => VirtualBoxStatus::CommandFailed,
        RunError::Timeout => VirtualBoxStatus::Timeout,
    }
}

/// Discovers with the configured executable. This blocks; call it from a blocking thread.
pub fn discover(config: Option<&VirtualBoxConfig>, limits: &VirtualBoxLimits) -> VirtualBoxReport {
    let Some(config) = config else {
        return VirtualBoxReport::not_configured();
    };
    let runner = ProcessRunner {
        program: config.vboxmanage.clone(),
        max_output_bytes: limits.max_output_bytes,
    };
    discover_with(&runner, limits)
}

/// Discovers with any runner. Every failure is reported in the result, never raised.
pub fn discover_with(runner: &dyn CommandRunner, limits: &VirtualBoxLimits) -> VirtualBoxReport {
    let deadline = Instant::now() + limits.time_budget;
    let run = |args: &[&str]| {
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        runner.run(&args, limits.command_timeout)
    };

    let version = match run(&["--version"]) {
        Err(error) => {
            tracing::warn!(?error, "VBoxManage --version failed");
            return VirtualBoxReport::failed(status_for(&error), None);
        }
        Ok(output) if !output.success => {
            return VirtualBoxReport::failed(VirtualBoxStatus::CommandFailed, None);
        }
        Ok(output) => match parse_version(&output.stdout) {
            Some(version) => version,
            None => return VirtualBoxReport::failed(VirtualBoxStatus::UnrecognizedVersion, None),
        },
    };

    let listing = match run(&["list", "vms"]) {
        Err(error) => {
            tracing::warn!(?error, "VBoxManage list vms failed");
            return VirtualBoxReport::failed(status_for(&error), Some(version));
        }
        Ok(output) if !output.success => {
            return VirtualBoxReport::failed(VirtualBoxStatus::CommandFailed, Some(version));
        }
        Ok(output) => parse_vm_list(&output.stdout),
    };
    if listing.vms.is_empty() && listing.unrecognized > 0 {
        return VirtualBoxReport::failed(VirtualBoxStatus::UnrecognizedOutput, Some(version));
    }
    if listing.unrecognized > 0 {
        tracing::warn!(
            lines = listing.unrecognized,
            "Ignored lines of VBoxManage list vms that describe no machine"
        );
    }

    let mut truncated = listing.vms.len() > limits.max_vms;
    let mut vms = Vec::new();
    // One at a time: VirtualBox serializes much of this anyway, and it bounds the processes started.
    for listed in listing.vms.iter().take(limits.max_vms) {
        if Instant::now() >= deadline {
            truncated = true;
            vms.push(undescribed(listed, VirtualBoxVmError::NotInspected));
            continue;
        }
        let uuid = listed.uuid.hyphenated().to_string();
        let vm = match run(&["showvminfo", &uuid, "--machinereadable"]) {
            Ok(output) if output.success => describe(listed, &output.stdout),
            Ok(output) if is_not_found(&output.stderr) => {
                undescribed(listed, VirtualBoxVmError::Vanished)
            }
            Ok(_) | Err(RunError::NotFound | RunError::Spawn(_)) => {
                undescribed(listed, VirtualBoxVmError::InspectionFailed)
            }
            Err(RunError::Timeout) => undescribed(listed, VirtualBoxVmError::Timeout),
        };
        vms.push(vm);
    }
    VirtualBoxReport {
        status: VirtualBoxStatus::Ok,
        version: Some(version),
        truncated,
        vms,
    }
}

/// Whether a configured executable looks usable, for `check-config`. Only metadata is read.
pub fn executable_problem(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        Some(format!(
            "VBoxManage path must be absolute: {}",
            path.display()
        ))
    } else if !path.is_file() {
        Some(format!("VBoxManage not found: {}", path.display()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_escaped_value_is_read_back() {
        assert_eq!(unescape(r#"a \"b\" c\\d\ne"#), "a \"b\" c\\d\ne");
    }

    #[test]
    fn a_quoted_key_is_read() {
        let values = parse_machine_readable("\"SATA-0-0\"=\"x\"\nmemory=4\n");
        assert_eq!(values["SATA-0-0"], "x");
        assert_eq!(values["memory"], "4");
    }
}
