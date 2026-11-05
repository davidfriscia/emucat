//! Emulator types, VM names and VM identity. Mirrors `@emucat/contracts`; both are tested against
//! the same fixtures.

use std::fmt;
use std::hash::{Hash, Hasher};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum EmulatorType {
    #[serde(rename = "86box")]
    Box86,
    #[serde(rename = "qemu")]
    Qemu,
}

impl EmulatorType {
    pub const ALL: [Self; 2] = [Self::Box86, Self::Qemu];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Box86 => "86box",
            Self::Qemu => "qemu",
        }
    }

    /// Files that mark a directory as a VM root. Any one of them is enough.
    pub const fn root_markers(self) -> &'static [&'static str] {
        match self {
            Self::Box86 => &["86box.cfg"],
            Self::Qemu => &[
                "run.bat",
                "run.cmd",
                "run-win.bat",
                "run-win.cmd",
                "run-mac.sh",
                "run-linux.sh",
            ],
        }
    }
}

impl fmt::Display for EmulatorType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("unknown emulator type")]
pub struct UnknownEmulatorType;

impl FromStr for EmulatorType {
    type Err = UnknownEmulatorType;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|emulator| emulator.as_str() == value)
            .ok_or(UnknownEmulatorType)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmRootEntry {
    pub name: String,
    pub is_file: bool,
}

/// Whether a directory with these root entries is a valid VM for this emulator. Names are matched
/// exactly, so that the result does not depend on the host filesystem's case sensitivity.
pub fn is_valid_vm_root(emulator: EmulatorType, entries: &[VmRootEntry]) -> bool {
    let markers = emulator.root_markers();
    entries
        .iter()
        .any(|entry| entry.is_file && markers.contains(&entry.name.as_str()))
}

pub const VM_NAME_MAX_LENGTH: usize = 64;

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum VmNameError {
    #[error("VM name is empty")]
    Empty,
    #[error("VM name contains characters other than ASCII letters, digits, '.', '_', '-', space")]
    InvalidCharacters,
    #[error("VM name is longer than {VM_NAME_MAX_LENGTH} characters")]
    TooLong,
    #[error("VM name must start and end with a letter or digit")]
    InvalidBoundary,
    #[error("VM name contains '..' or consecutive spaces")]
    RepeatedSeparator,
    #[error("VM name is a reserved Windows device name")]
    ReservedName,
    #[error("VM name must not end like a snapshot name (_YYYYMMDDhhmm)")]
    SnapshotSuffix,
}

impl VmNameError {
    /// Stable code, shared with the TypeScript contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::InvalidCharacters => "invalid_characters",
            Self::TooLong => "too_long",
            Self::InvalidBoundary => "invalid_boundary",
            Self::RepeatedSeparator => "repeated_separator",
            Self::ReservedName => "reserved_name",
            Self::SnapshotSuffix => "snapshot_suffix",
        }
    }
}

fn is_windows_device_name(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    match upper.as_bytes() {
        [b'C', b'O', b'M', digit] | [b'L', b'P', b'T', digit] => digit.is_ascii_digit(),
        _ => false,
    }
}

fn has_snapshot_suffix(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 13 && {
        let (rest, digits) = bytes.split_at(bytes.len() - 12);
        rest.last() == Some(&b'_') && digits.iter().all(u8::is_ascii_digit)
    }
}

/// Validates a VM name. See `validateVmName` in `@emucat/contracts` for the reasoning behind each
/// rule. Checks run in the same order so that both report the same code.
pub fn validate_vm_name(name: &str) -> Result<(), VmNameError> {
    if name.is_empty() {
        return Err(VmNameError::Empty);
    }
    let allowed = |byte: &u8| byte.is_ascii_alphanumeric() || b"._ -".contains(byte);
    if !name.bytes().all(|byte| allowed(&byte)) {
        return Err(VmNameError::InvalidCharacters);
    }
    if name.len() > VM_NAME_MAX_LENGTH {
        return Err(VmNameError::TooLong);
    }
    let bytes = name.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return Err(VmNameError::InvalidBoundary);
    }
    if name.contains("..") || name.contains("  ") {
        return Err(VmNameError::RepeatedSeparator);
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if is_windows_device_name(stem) {
        return Err(VmNameError::ReservedName);
    }
    if has_snapshot_suffix(name) {
        return Err(VmNameError::SnapshotSuffix);
    }
    Ok(())
}

/// A validated VM name. It is the VM's directory name. The original spelling is kept, but two names
/// differing only by case are equal, because they would be one directory on Windows and macOS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct VmName(String);

impl VmName {
    pub fn new(name: impl Into<String>) -> Result<Self, VmNameError> {
        let name = name.into();
        validate_vm_name(&name)?;
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Canonical comparison key.
    pub fn key(&self) -> String {
        self.0.to_ascii_lowercase()
    }
}

impl PartialEq for VmName {
    fn eq(&self, other: &Self) -> bool {
        self.0.eq_ignore_ascii_case(&other.0)
    }
}

impl Eq for VmName {}

impl Hash for VmName {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.key().hash(state);
    }
}

impl TryFrom<String> for VmName {
    type Error = VmNameError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<VmName> for String {
    fn from(name: VmName) -> Self {
        name.0
    }
}

impl fmt::Display for VmName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmIdentity {
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
}
