//! Command-line interface.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use uuid::Uuid;

use crate::config::{self, LogFormat, SettingOverrides};
use crate::platform::PlatformInfo;
use crate::protocol::PROTOCOL_VERSION;

#[derive(Debug, Parser)]
#[command(
    name = "emucat-agent",
    version,
    about = "Headless local agent for EmuCat",
    long_about = "Headless local agent for EmuCat.\n\n\
        Connects outbound to an EmuCat server, reports the 86Box and QEMU virtual machines in its \
        configured directories when asked, and registers one when an administrator asks: it builds a \
        standalone ZIP archive with a manifest, uploads it straight to an SSH/SFTP repository, and \
        verifies its SHA-256 there. It restores a registered master when an administrator asks: it \
        downloads the ZIP straight from the repository, verifies its SHA-256 and manifest, extracts it \
        safely, and publishes the VM under the configured base path, never over an existing \
        directory. It keeps verified ZIPs in a local cache. It launches a VM in 86Box or QEMU when an \
        administrator asks, from a command line it builds and checks itself, without a shell, tracks \
        the process by PID and creation time, and stops it gracefully, or forcibly only when \
        explicitly confirmed. It verifies a local VM against its master's manifest, read-only. With \
        VirtualBox configured, it also lists VirtualBox machines, exports a powered-off machine an \
        administrator registers into an OVA master, and starts, shuts down (ACPI) or powers off a \
        registered machine in place, by UUID, watching its state; it never imports, deletes or \
        modifies one. `import-ova` puts an existing OVA file into the repository, byte for byte, as \
        the master of a new VirtualBox catalog VM, without VirtualBox. It has \
        no listener. It removes a local VM only for an explicitly confirmed transfer, after the server \
        has committed a verified master, and never while it runs. Pair it once with `pair`, then keep \
        it running with `run`."
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
    /// Print what the screenshot queue holds, from the local state directory.
    MediaStatus,
    /// Print what the archive cache holds: where it is, how many ZIPs, and how much of its limit they use
    CacheStatus,
    /// Test a configured SSH repository directly: connection, host key, key, read, write, publication
    RepositoryCheck {
        /// The repository's UUID, as shown on the Repositories page
        #[arg(long, value_name = "UUID")]
        repository: Uuid,
    },
    /// Store the passphrase of a repository's SSH key, protected with DPAPI. Reads it from standard input
    RepositoryPassphrase {
        /// The repository's UUID, as shown on the Repositories page
        #[arg(long, value_name = "UUID")]
        repository: Uuid,
    },
    /// Print the command a launch of a VM would run, after every check, without running it
    LaunchCheck {
        /// 86box or qemu
        #[arg(long, value_name = "EMULATOR")]
        emulator: String,
        /// The VM's directory name under the emulator's base path
        #[arg(long, value_name = "NAME")]
        vm: String,
    },
    /// Import an existing OVA file into the EmuCat repository as the master of a new VirtualBox catalog VM.
    /// Nothing is imported into VirtualBox
    #[command(
        long_about = "Import an existing OVA file into the EmuCat repository, as the master of a new VirtualBox \
            catalog VM.\n\n\
            The file is validated (TAR structure, OVF descriptor, manifest digests) and hashed, the name is \
            reserved on the server, and the file is uploaded as it is, byte for byte, straight to the configured \
            SSH repository, verified there, published without overwriting anything, and registered. It uses this \
            agent's configuration, paired credential and repository settings; `emucat-agent run` need not be \
            running. Nothing is imported into VirtualBox, and no VirtualBox machine is created or linked: import \
            the master into VirtualBox later, from the VM's page.\n\n\
            An existing catalog VM is never replaced: a name that is taken is refused. Ctrl+C cancels before the \
            master is registered. Running the same command again after an interruption carries on where it \
            stopped, without uploading again what is already in the repository.\n\n\
            Exit codes: 0 success; 1 unexpected error; 2 invalid argument; 3 not an importable OVA; 4 agent \
            configuration or authorization; 5 catalog conflict; 6 server or repository unavailable; 130 cancelled.",
        after_help = "Examples:\n  \
            emucat-agent import-ova --file \"D:\\VMs\\DOS-6.22.ova\" --name \"DOS-6.22\"\n  \
            emucat-agent import-ova --file .\\win95.ova --name Win95 --description \"Windows 95 OSR2\" --dry-run\n  \
            emucat-agent import-ova --file \"D:\\VMs\\OS2 Warp.ova\" --name \"OS2-Warp-4\" --json"
    )]
    ImportOva {
        /// The OVA file to import. Absolute or relative
        #[arg(long, value_name = "PATH")]
        file: PathBuf,
        /// The new catalog VM's name, under the usual naming rules. It must not exist yet
        #[arg(long, value_name = "VM-NAME")]
        name: String,
        /// A description for the new catalog VM. Plain text
        #[arg(long, value_name = "TEXT")]
        description: Option<String>,
        /// Validate, hash and check the catalog, without reserving, uploading or registering anything
        #[arg(long)]
        dry_run: bool,
        /// Print the result as one JSON object on standard output. Progress goes to standard error
        #[arg(long)]
        json: bool,
    },
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
