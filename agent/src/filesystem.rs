//! Safe path handling. Nothing in this module reads or writes the disk.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::emulators::VmName;

/// The local directory of a VM: `BASE_PATH/VM_NAME`. `VmName` validation guarantees that the result
/// stays directly under the base path.
pub fn vm_directory(base_path: &Path, name: &VmName) -> PathBuf {
    base_path.join(name.as_str())
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[error("path could escape the VM directory")]
pub struct UnsafePath;

/// Splits a VM-relative path into segments, rejecting anything that could escape the VM directory.
/// Both separators are accepted because archives can move between operating systems.
pub fn parse_vm_relative_path(path: &str) -> Result<Vec<&str>, UnsafePath> {
    if path.is_empty() || path.contains('\0') || path.contains(':') {
        return Err(UnsafePath);
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(UnsafePath);
    }
    let segments: Vec<&str> = path.split(['/', '\\']).collect();
    if segments
        .iter()
        .any(|segment| matches!(*segment, "" | "." | ".."))
    {
        return Err(UnsafePath);
    }
    Ok(segments)
}
