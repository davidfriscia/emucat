//! Command-line interface.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::config::{self, LogFormat, SettingOverrides};
use crate::platform::PlatformInfo;
use crate::protocol::PROTOCOL_VERSION;

#[derive(Debug, Parser)]
#[command(
    name = "emucat-agent",
    version,
    about = "Headless local agent for EmuCat",
    long_about = "Headless local agent for EmuCat.\n\n\
        Connects outbound to an EmuCat server and manages local 86Box and QEMU virtual machines. \
        In this version it validates its configuration and waits for a shutdown signal: it opens \
        no connections, launches no emulators and does not change VM directories."
)]
pub struct Cli {
    /// Configuration file [env: EMUCAT_AGENT_CONFIG]
    #[arg(short, long, global = true, value_name = "FILE")]
    pub config: Option<PathBuf>,

    /// Log filter, such as info or debug [env: EMUCAT_AGENT_LOG_LEVEL]
    #[arg(long, global = true, value_name = "LEVEL")]
    pub log_level: Option<String>,

    /// Log output format [env: EMUCAT_AGENT_LOG_FORMAT]
    #[arg(long, global = true, value_enum, value_name = "FORMAT")]
    pub log_format: Option<LogFormat>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Validate the configuration, then run until stopped (default)
    Run,
    /// Validate the configuration and exit
    CheckConfig,
    /// Print version, protocol, platform and default paths
    Info,
}

/// Values given on the command line, which take precedence over everything else.
pub struct Overrides {
    pub config_path: Option<PathBuf>,
    pub settings: SettingOverrides,
}

impl From<&Cli> for Overrides {
    fn from(cli: &Cli) -> Self {
        Self {
            config_path: cli.config.clone(),
            settings: SettingOverrides {
                log_level: cli.log_level.clone(),
                log_format: cli.log_format,
            },
        }
    }
}

pub fn print_info() {
    let info = PlatformInfo::current();
    println!("emucat-agent {}", env!("CARGO_PKG_VERSION"));
    println!("protocol version: {PROTOCOL_VERSION}");
    println!("os: {}", info.os);
    println!("architecture: {}", info.arch);
    if let Some(path) = config::default_config_path(&config::process_env) {
        println!("default configuration file: {}", path.display());
    }
    if let Some(path) = config::default_state_dir(&config::process_env) {
        println!("default state directory: {}", path.display());
    }
}
