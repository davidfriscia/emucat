//! Version domain: full, standalone archives forming a branching tree from an immutable master.
//! Creating archives is in `packaging`, and storing them in `repository`.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::emulators::{EmulatorType, VmIdentity, VmName};
use crate::filesystem::{UnsafePath, parse_vm_relative_path};

/// Internal, collision-safe version identifier. Never derived from the snapshot name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VersionId(pub Uuid);

impl VersionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for VersionId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionKind {
    Master,
    Snapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmVersion {
    pub id: VersionId,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub kind: VersionKind,
    pub parent_version_id: Option<VersionId>,
    pub snapshot_name: Option<String>,
    pub archive_sha256: String,
    pub archive_size_bytes: u64,
    pub repository_id: Uuid,
    pub archive_key: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum VersionError {
    #[error("a master has no parent and no snapshot name")]
    InvalidMaster,
    #[error("a snapshot needs a parent and a snapshot name")]
    InvalidSnapshot,
    #[error("a snapshot cannot be its own parent")]
    OwnParent,
    #[error("snapshot name does not match the VM")]
    SnapshotNameMismatch,
    #[error("archive hash is not lowercase SHA-256 hex")]
    InvalidHash,
}

impl VmVersion {
    /// Checks the rules a single version must satisfy. Deserialization alone does not.
    pub fn validate(&self) -> Result<(), VersionError> {
        let valid_hash = self.archive_sha256.len() == 64
            && self
                .archive_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !valid_hash {
            return Err(VersionError::InvalidHash);
        }
        match (
            self.kind,
            self.parent_version_id,
            self.snapshot_name.as_deref(),
        ) {
            (VersionKind::Master, None, None) => Ok(()),
            (VersionKind::Master, _, _) => Err(VersionError::InvalidMaster),
            (VersionKind::Snapshot, Some(parent), Some(name)) => {
                if parent == self.id {
                    return Err(VersionError::OwnParent);
                }
                match parse_snapshot_name(name) {
                    Some(parsed) if parsed.vm_name == self.vm_name => Ok(()),
                    _ => Err(VersionError::SnapshotNameMismatch),
                }
            }
            (VersionKind::Snapshot, _, _) => Err(VersionError::InvalidSnapshot),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct SnapshotTimestamp {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}

const MIN_SNAPSHOT_YEAR: u16 = 1970;
const SNAPSHOT_SUFFIX_LENGTH: usize = 13;

impl SnapshotTimestamp {
    fn is_valid(self) -> bool {
        let leap = (self.year % 4 == 0 && self.year % 100 != 0) || self.year % 400 == 0;
        let days = match self.month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        (MIN_SNAPSHOT_YEAR..=9999).contains(&self.year)
            && (1..=12).contains(&self.month)
            && (1..=days).contains(&self.day)
            && self.hour <= 23
            && self.minute <= 59
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSnapshotName {
    pub vm_name: VmName,
    pub timestamp: SnapshotTimestamp,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[error("snapshot time is out of range")]
pub struct SnapshotTimeOutOfRange;

/// Formats the human-readable name `VM_NAME_YYYYMMDDhhmm` in UTC. The name is a label, not an
/// identifier: two snapshots taken within the same minute have the same name.
pub fn format_snapshot_name(
    vm_name: &VmName,
    at: OffsetDateTime,
) -> Result<String, SnapshotTimeOutOfRange> {
    let at = at.to_offset(UtcOffset::UTC);
    let timestamp = SnapshotTimestamp {
        year: u16::try_from(at.year()).map_err(|_| SnapshotTimeOutOfRange)?,
        month: u8::from(at.month()),
        day: at.day(),
        hour: at.hour(),
        minute: at.minute(),
    };
    if !timestamp.is_valid() {
        return Err(SnapshotTimeOutOfRange);
    }
    let SnapshotTimestamp {
        year,
        month,
        day,
        hour,
        minute,
    } = timestamp;
    Ok(format!(
        "{vm_name}_{year:04}{month:02}{day:02}{hour:02}{minute:02}"
    ))
}

/// Returns the parts of a snapshot name, or `None` if it does not follow the convention.
pub fn parse_snapshot_name(name: &str) -> Option<ParsedSnapshotName> {
    let split = name.len().checked_sub(SNAPSHOT_SUFFIX_LENGTH)?;
    if !name.is_char_boundary(split) {
        return None;
    }
    let (vm_part, suffix) = name.split_at(split);
    let digits = suffix.strip_prefix('_')?;
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let timestamp = SnapshotTimestamp {
        year: digits[0..4].parse().ok()?,
        month: digits[4..6].parse().ok()?,
        day: digits[6..8].parse().ok()?,
        hour: digits[8..10].parse().ok()?,
        minute: digits[10..12].parse().ok()?,
    };
    if !timestamp.is_valid() {
        return None;
    }
    Some(ParsedSnapshotName {
        vm_name: VmName::new(vm_part).ok()?,
        timestamp,
    })
}

/// Object key of a version archive. It is based on the ID, so two snapshots with the same name can
/// never overwrite each other.
pub fn archive_object_key(identity: &VmIdentity, version: VersionId) -> String {
    format!(
        "archives/{}/{}/{}.zip",
        identity.emulator_type,
        identity.vm_name.key(),
        version.0
    )
}

/// Whether a VM-relative file must be left out of master and snapshot archives. Media are
/// independent of versions. Matching ignores case so that a media file can never leak into an
/// archive because of how a host spelled the name.
pub fn is_excluded_from_archive(emulator: EmulatorType, path: &str) -> Result<bool, UnsafePath> {
    let segments = parse_vm_relative_path(path)?;
    Ok(match emulator {
        EmulatorType::Box86 => {
            segments.len() > 1 && segments[0].eq_ignore_ascii_case("screenshots")
        }
        EmulatorType::Qemu => is_root_ppm(&segments),
    })
}

pub(crate) fn is_root_ppm(segments: &[&str]) -> bool {
    let [name] = segments else {
        return false;
    };
    name.to_ascii_lowercase().ends_with(".ppm")
}
