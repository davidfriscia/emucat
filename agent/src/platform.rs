//! Platform and architecture reporting. Platform-specific code should stay behind small modules
//! like this one, so that macOS and Linux support only has to fill them in.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Architecture {
    X86_64,
    Aarch64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
}

impl PlatformInfo {
    pub fn current() -> Self {
        Self {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }

    /// The platform as the protocol names it, or `None` on an unsupported OS.
    pub fn platform(self) -> Option<Platform> {
        match self.os {
            "windows" => Some(Platform::Windows),
            "macos" => Some(Platform::Macos),
            "linux" => Some(Platform::Linux),
            _ => None,
        }
    }

    /// The architecture as the protocol names it, or `None` on an unsupported CPU.
    pub fn architecture(self) -> Option<Architecture> {
        match self.arch {
            "x86_64" => Some(Architecture::X86_64),
            "aarch64" => Some(Architecture::Aarch64),
            _ => None,
        }
    }
}
