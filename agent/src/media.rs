//! Media domain. Media are independent of VM archives and versions. The watcher and uploader are
//! not implemented yet.

use serde::{Deserialize, Serialize};

use crate::archives::is_root_ppm;
use crate::emulators::EmulatorType;
use crate::filesystem::parse_vm_relative_path;

/// Media are private until explicitly published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaVisibility {
    #[default]
    Private,
    Published,
}

/// Whether a VM-relative file is a media file the agent should pick up: directly inside
/// `screenshots/` for 86Box, and `.ppm` files in the VM root for QEMU.
pub fn is_watched_media_path(emulator: EmulatorType, path: &str) -> bool {
    let Ok(segments) = parse_vm_relative_path(path) else {
        return false;
    };
    match emulator {
        EmulatorType::Box86 => {
            segments.len() == 2 && segments[0].eq_ignore_ascii_case("screenshots")
        }
        EmulatorType::Qemu => is_root_ppm(&segments),
    }
}
