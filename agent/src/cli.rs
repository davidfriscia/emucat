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
        Connects outbound to an EmuCat server, and reports the 86Box and QEMU virtual machines in \
        its configured directories when asked. It has no listener, launches no emulators and does \
        not change VM directories. Pair it once with `pair`, then keep it running with `run`."
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
    /// Connect to the server and stay connected until stopped (default)
    Run,
    /// Pair this agent with the server. An administrator approves it in the web app
    Pair {
        /// Name shown to the administrator. Defaults to [agent] name, then the computer name
        #[arg(long, value_name = "NAME")]
        name: Option<String>,
        /// Replace an existing credential, once a new one has been issued
        #[arg(long)]
        force: bool,
    },
    /// Remove the local credential. Does not touch the server or any VM
    Unpair,
    /// Scan the configured VM directories, read-only, and print the report. Needs no server
    Discover,
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
