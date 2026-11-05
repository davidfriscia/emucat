//! Finds candidate VMs in the configured base paths.
//!
//! This is strictly read-only: it lists directories and reads metadata, and never opens, executes,
//! creates or changes a file. It looks only at the immediate children of a base path and, for each,
//! at the names in that child's root. Anything that is not a plain directory is not entered, so a
//! symlink, junction or other reparse point cannot lead the scan outside the base path.
//!
//! Marker names are matched exactly, as `is_valid_vm_root` defines, which is why a child's root is
//! listed rather than probed: on a case-insensitive filesystem, probing for `86box.cfg` would also
//! find `86BOX.CFG` and so give a different answer on Windows than on Linux.

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::EmulatorConfig;
use crate::emulators::{EmulatorType, VmName, VmNameError, VmRootEntry, is_valid_vm_root};
use crate::platform::Platform;
use crate::protocol::AGENT_MAX_MESSAGE_BYTES;

pub const MAX_VMS: usize = 256;
pub const MAX_SKIPPED: usize = 64;
pub const SKIPPED_NAME_MAX_LENGTH: usize = 80;

/// Bounds on the work of one scan, whatever the disk holds.
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    /// Entries examined directly under a base path.
    pub max_base_entries: usize,
    /// Entries examined in a candidate's root.
    pub max_root_entries: usize,
    pub max_vms: usize,
    pub max_skipped: usize,
    /// When this has passed, the scan stops and reports what it has. A slow disk cannot stall it.
    pub time_budget: Duration,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_base_entries: 4096,
            max_root_entries: 4096,
            max_vms: MAX_VMS,
            max_skipped: MAX_SKIPPED,
            time_budget: Duration::from_secs(20),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmulatorStatus {
    Ok,
    NotConfigured,
    BasePathMissing,
    BasePathNotDirectory,
    BasePathInaccessible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    InvalidName,
    MissingMarker,
    MarkerWrongCase,
    ReparsePoint,
    NotAccessible,
    Vanished,
    DuplicateIdentity,
    TooManyEntries,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorReport {
    pub emulator_type: EmulatorType,
    pub status: EmulatorStatus,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredVm {
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub markers: Vec<String>,
    pub host_compatible: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub emulator_type: EmulatorType,
    pub name: String,
    pub reason: SkipReason,
    pub name_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub host_platform: Platform,
    pub emulators: Vec<EmulatorReport>,
    pub vms: Vec<DiscoveredVm>,
    pub skipped: Vec<SkippedEntry>,
}

/// The launch script a host runs. Mirrors `QEMU_HOST_LAUNCH_SCRIPTS` in `@emucat/contracts`.
pub const fn qemu_host_launch_script(host: Platform) -> &'static str {
    match host {
        Platform::Windows => "run-win.cmd",
        Platform::Macos => "run-mac.sh",
        Platform::Linux => "run-linux.sh",
    }
}

/// Whether a VM has a launch script for this host. Only QEMU has a notion of this.
pub fn host_compatibility(
    emulator: EmulatorType,
    markers: &[String],
    host: Platform,
) -> Option<bool> {
    (emulator == EmulatorType::Qemu).then(|| {
        let script = qemu_host_launch_script(host);
        markers.iter().any(|marker| marker == script)
    })
}

/// A directory's name, made safe to report whatever it contains: printable ASCII, bounded, and free
/// of characters that need escaping. For display only. It is never used to build a path.
pub fn display_name(raw: &str) -> String {
    raw.chars()
        .take(SKIPPED_NAME_MAX_LENGTH)
        .map(|character| match character {
            '"' | '\\' => '?',
            ' '..='~' => character,
            _ => '?',
        })
        .collect()
}

/// A reparse point of any kind, not only the symlinks and junctions Rust calls symlinks: OneDrive
/// placeholders and deduplicated files can also lead somewhere other than where they appear to be.
#[cfg(windows)]
fn is_link_like(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Reports `Vanished` for something that disappeared since it was listed: the disk is live.
fn access_failure(error: &io::Error) -> SkipReason {
    match error.kind() {
        io::ErrorKind::NotFound => SkipReason::Vanished,
        _ => SkipReason::NotAccessible,
    }
}

enum RootInspection {
    Candidate(Vec<String>),
    Skip(SkipReason),
}

/// Examines the names in a candidate's root. Reads metadata only, and only of a marker's name.
fn inspect_root(
    directory: &Path,
    emulator: EmulatorType,
    limits: &ScanLimits,
) -> Result<RootInspection, io::Error> {
    let markers = emulator.root_markers();
    let mut entries = Vec::new();
    let mut wrong_case = false;
    for (index, entry) in fs::read_dir(directory)?.enumerate() {
        if index >= limits.max_root_entries {
            return Ok(RootInspection::Skip(SkipReason::TooManyEntries));
        }
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if markers.contains(&name.as_str()) {
            // Not following links, so a linked marker is not a regular file. A marker that vanished
            // since listing is simply absent.
            let is_file = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata.is_file() && !is_link_like(&metadata),
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => return Err(error),
            };
            entries.push(VmRootEntry { name, is_file });
        } else if markers
            .iter()
            .any(|marker| marker.eq_ignore_ascii_case(&name))
        {
            wrong_case = true;
        }
    }
    if !is_valid_vm_root(emulator, &entries) {
        return Ok(RootInspection::Skip(if wrong_case {
            SkipReason::MarkerWrongCase
        } else {
            SkipReason::MissingMarker
        }));
    }
    // In the marker order rather than the directory's, so that a report is deterministic.
    let present = markers
        .iter()
        .filter(|marker| {
            entries
                .iter()
                .any(|entry| entry.is_file && entry.name == **marker)
        })
        .map(|marker| (*marker).to_owned())
        .collect();
    Ok(RootInspection::Candidate(present))
}

enum Examined {
    Vm(DiscoveredVm),
    Skipped(SkippedEntry),
    NotACandidate,
}

/// Decides about one child of the base path, which may have changed since it was listed.
fn examine_child(
    base_path: &Path,
    raw_name: OsString,
    emulator: EmulatorType,
    host: Platform,
    limits: &ScanLimits,
    seen: &mut HashSet<String>,
) -> Examined {
    let lossy = raw_name.to_string_lossy().into_owned();
    let skipped = |reason, name_error: Option<VmNameError>| {
        Examined::Skipped(SkippedEntry {
            emulator_type: emulator,
            name: display_name(&lossy),
            reason,
            name_error: name_error.map(|error| error.code().to_owned()),
        })
    };

    let path = base_path.join(&raw_name);
    // Not following links: this describes the child itself, not whatever it may point to.
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => return skipped(access_failure(&error), None),
    };
    if is_link_like(&metadata) {
        return skipped(SkipReason::ReparsePoint, None);
    }
    if !metadata.is_dir() {
        return Examined::NotACandidate;
    }

    // A name that is not valid is reported and left alone. It is never normalized or renamed.
    let Ok(utf8_name) = raw_name.into_string() else {
        return skipped(
            SkipReason::InvalidName,
            Some(VmNameError::InvalidCharacters),
        );
    };
    let vm_name = match VmName::new(utf8_name) {
        Ok(name) => name,
        Err(error) => return skipped(SkipReason::InvalidName, Some(error)),
    };

    let markers = match inspect_root(&path, emulator, limits) {
        Ok(RootInspection::Candidate(markers)) => markers,
        Ok(RootInspection::Skip(reason)) => return skipped(reason, None),
        Err(error) => return skipped(access_failure(&error), None),
    };
    // Possible only on a case-sensitive filesystem. One identity cannot be two directories.
    if !seen.insert(vm_name.key()) {
        return skipped(SkipReason::DuplicateIdentity, None);
    }
    let host_compatible = host_compatibility(emulator, &markers, host);
    Examined::Vm(DiscoveredVm {
        emulator_type: emulator,
        vm_name,
        markers,
        host_compatible,
    })
}

fn base_path_problem(base_path: &Path) -> Option<EmulatorStatus> {
    // The configured base path itself may be a link: the user chose it. So this one follows links.
    match fs::metadata(base_path) {
        Ok(metadata) if metadata.is_dir() => None,
        Ok(_) => Some(EmulatorStatus::BasePathNotDirectory),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Some(EmulatorStatus::BasePathMissing)
        }
        Err(_) => Some(EmulatorStatus::BasePathInaccessible),
    }
}

/// What one base path holds, within the limits it is given.
#[allow(clippy::too_many_arguments)]
fn scan_base(
    base_path: &Path,
    emulator: EmulatorType,
    host: Platform,
    limits: &ScanLimits,
    deadline: Instant,
    vms: &mut Vec<DiscoveredVm>,
    skipped: &mut Vec<SkippedEntry>,
) -> EmulatorReport {
    let report = |status, truncated| EmulatorReport {
        emulator_type: emulator,
        status,
        truncated,
    };
    if let Some(problem) = base_path_problem(base_path) {
        return report(problem, false);
    }
    let listing = match fs::read_dir(base_path) {
        Ok(listing) => listing,
        Err(_) => return report(EmulatorStatus::BasePathInaccessible, false),
    };

    let mut truncated = false;
    let mut names = Vec::new();
    for entry in listing {
        if names.len() >= limits.max_base_entries {
            truncated = true;
            break;
        }
        // An entry that cannot be read says nothing about the others.
        if let Ok(entry) = entry {
            names.push(entry.file_name());
        }
    }
    // Sorted, so that which entries a limit cuts off does not depend on the directory's order.
    names.sort();

    let mut seen = HashSet::new();
    for raw_name in names {
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        match examine_child(base_path, raw_name, emulator, host, limits, &mut seen) {
            Examined::Vm(vm) if vms.len() < limits.max_vms => vms.push(vm),
            Examined::Skipped(entry) if skipped.len() < limits.max_skipped => skipped.push(entry),
            Examined::NotACandidate => {}
            Examined::Vm(_) | Examined::Skipped(_) => truncated = true,
        }
    }
    report(EmulatorStatus::Ok, truncated)
}

/// Scans every configured emulator. This blocks; call it from `spawn_blocking`.
pub fn scan(
    emulators: &BTreeMap<EmulatorType, EmulatorConfig>,
    host: Platform,
    limits: &ScanLimits,
) -> DiscoveryReport {
    let deadline = Instant::now() + limits.time_budget;
    let mut vms = Vec::new();
    let mut skipped = Vec::new();
    let reports = EmulatorType::ALL
        .into_iter()
        .map(|emulator| match emulators.get(&emulator) {
            None => EmulatorReport {
                emulator_type: emulator,
                status: EmulatorStatus::NotConfigured,
                truncated: false,
            },
            Some(config) => scan_base(
                &config.base_path,
                emulator,
                host,
                limits,
                deadline,
                &mut vms,
                &mut skipped,
            ),
        })
        .collect();
    let mut report = DiscoveryReport {
        host_platform: host,
        emulators: reports,
        vms,
        skipped,
    };
    fit_to_message(&mut report);
    report
}

/// Most of a message may be report. The rest is left for the envelope.
const REPORT_MAX_BYTES: usize = AGENT_MAX_MESSAGE_BYTES - 1024;

/// A last guarantee that the report fits in one message. The limits on counts and names already make
/// this true, so this should never have anything to do.
fn fit_to_message(report: &mut DiscoveryReport) {
    let size =
        |report: &DiscoveryReport| serde_json::to_vec(report).map_or(usize::MAX, |b| b.len());
    while size(report) > REPORT_MAX_BYTES {
        if report.skipped.pop().is_none() && report.vms.pop().is_none() {
            return;
        }
        for emulator in &mut report.emulators {
            emulator.truncated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_that_vanished_since_it_was_listed_is_reported() {
        let base = tempfile::tempdir().unwrap();
        let mut seen = HashSet::new();
        let examined = examine_child(
            base.path(),
            OsString::from("Gone"),
            EmulatorType::Qemu,
            Platform::Windows,
            &ScanLimits::default(),
            &mut seen,
        );
        let Examined::Skipped(entry) = examined else {
            panic!("expected a skipped entry");
        };
        assert_eq!(entry.reason, SkipReason::Vanished);
    }

    #[test]
    fn the_size_guard_trims_an_oversized_report() {
        let mut report = DiscoveryReport {
            host_platform: Platform::Windows,
            emulators: vec![EmulatorReport {
                emulator_type: EmulatorType::Qemu,
                status: EmulatorStatus::Ok,
                truncated: false,
            }],
            vms: Vec::new(),
            skipped: vec![
                SkippedEntry {
                    emulator_type: EmulatorType::Qemu,
                    name: "x".repeat(SKIPPED_NAME_MAX_LENGTH),
                    reason: SkipReason::InvalidName,
                    name_error: Some("too_long".to_owned()),
                };
                1000
            ],
        };
        fit_to_message(&mut report);
        assert!(serde_json::to_vec(&report).unwrap().len() <= REPORT_MAX_BYTES);
        assert!(report.emulators[0].truncated);
        assert!(!report.skipped.is_empty());
    }
}
