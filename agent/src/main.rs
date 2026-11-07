use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use emucat_agent::archive_cache::ArchiveCache;
use emucat_agent::cli::{Cli, Command, Overrides, print_info};
use emucat_agent::config::{Config, ConfigError, Severity, process_env, validate};
use emucat_agent::connectivity::{self, ConnectionEnd, ConnectionSettings, check_transport};
use emucat_agent::credentials::{self, CredentialStore, Secret};
use emucat_agent::discovery::{self, ScanLimits};
use emucat_agent::media::MediaScanLimits;
use emucat_agent::media_queue::MediaQueue;
use emucat_agent::media_sync::{HttpMediaApi, MediaSync, MediaSyncConfig};
use emucat_agent::pairing::{self, PairingRequest};
use emucat_agent::platform::{Architecture, Platform};
use emucat_agent::protocol::AgentHello;
use emucat_agent::registration::{AgentOperations, OperationsConfig, RepositoryProvider};
use emucat_agent::repository::CancelFlag;
use emucat_agent::sftp::ConfiguredRepositories;
use emucat_agent::{logging, platform, protocol, shutdown};
use uuid::Uuid;

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command.as_ref().unwrap_or(&Command::Run) {
        Command::Info => {
            print_info();
            Ok(())
        }
        Command::CheckConfig => check_config(&cli),
        Command::LaunchCheck { emulator, vm } => launch_check(&cli, emulator, vm),
        Command::Run => run(&cli),
        Command::Pair { name, force } => pair(&cli, name.as_deref(), *force),
        Command::Unpair => unpair(&cli),
        Command::Discover => discover(&cli),
        Command::MediaStatus => media_status(&cli),
        Command::CacheStatus => cache_status(&cli),
        Command::RepositoryCheck { repository } => repository_check(&cli, *repository),
        Command::RepositoryPassphrase { repository } => repository_passphrase(&cli, *repository),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

fn load(cli: &Cli) -> Result<Config, ConfigError> {
    let overrides = Overrides::from(cli);
    Config::load(
        overrides.config_path.as_deref(),
        &process_env,
        &overrides.settings,
    )
}

/// Prints every problem found, and fails if any of them is an error.
fn report_validation(config: &Config) -> Result<(), String> {
    let issues = validate(config);
    for issue in &issues {
        eprintln!("{issue}");
    }
    let errors = issues
        .iter()
        .filter(|issue| issue.severity == Severity::Error)
        .count();
    if errors > 0 {
        return Err(format!("configuration has {errors} error(s)"));
    }
    Ok(())
}

fn check_config(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    report_validation(&config)?;
    println!("Configuration is valid.");
    Ok(())
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("cannot start the runtime: {error}"))
}

fn credential_store(config: &Config) -> Result<Box<dyn CredentialStore>, String> {
    let state_dir = config
        .state_dir
        .as_deref()
        .ok_or("no state directory is configured and no default is known")?;
    Ok(credentials::platform_store(state_dir))
}

fn identity() -> Result<(Platform, Architecture), String> {
    let info = platform::PlatformInfo::current();
    let platform = info
        .platform()
        .ok_or_else(|| format!("unsupported operating system: {}", info.os))?;
    let architecture = info
        .architecture()
        .ok_or_else(|| format!("unsupported architecture: {}", info.arch))?;
    Ok((platform, architecture))
}

/// Resolves when the operating system asks the agent to stop.
async fn stop_requested() {
    match shutdown::wait_for_signal().await {
        Ok(signal) => tracing::info!(signal, "Stop requested"),
        Err(error) => tracing::error!(%error, "Cannot listen for shutdown signals; stopping"),
    }
}

fn run(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    logging::init(&config.log_level, config.log_format).map_err(|error| error.to_string())?;
    report_validation(&config)?;
    check_transport(&config.api_url).map_err(|error| error.to_string())?;

    let stored = credential_store(&config)?
        .load()
        .map_err(|error| error.to_string())?
        .ok_or("this agent is not paired. Run `emucat-agent pair` first")?;
    if !stored.belongs_to(&config.api_url) {
        return Err(format!(
            "the stored credential belongs to {}, not to {}. It is not sent to another server. \
             Run `emucat-agent pair --force` to pair with this one",
            stored.server_origin, config.api_url
        ));
    }

    let (host, architecture) = identity()?;
    let info = platform::PlatformInfo::current();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = protocol::PROTOCOL_VERSION,
        os = info.os,
        arch = info.arch,
        api_url = %config.api_url,
        agent_id = %stored.agent_id,
        emulators = config.emulators.len(),
        "Agent started"
    );

    let media_api = HttpMediaApi::new(&config.api_url, stored.credential.clone())?;
    let mut settings = ConnectionSettings::new(
        &config.api_url,
        stored.credential,
        AgentHello {
            agent_version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: host,
            architecture,
        },
        host,
        config.emulators.clone(),
    );
    let agent_id = stored.agent_id;
    let runtime = runtime()?;
    let end = runtime.block_on(async {
        let media = MediaSync::new(MediaSyncConfig {
            agent_id,
            state_dir: config
                .state_dir
                .clone()
                .ok_or("no state directory is configured and no default is known")?,
            emulators: Arc::clone(&settings.emulators),
            settings: config.media.clone(),
            api: Arc::new(media_api),
            scan_limits: MediaScanLimits::default(),
        })?;
        settings.media = Some(Arc::clone(&media));
        // Loading resumes interrupted work, which needs the runtime.
        settings.operations = Some(operations(
            &config,
            agent_id,
            &settings,
            Arc::clone(&media),
        )?);
        let watcher = tokio::spawn(Arc::clone(&media).run());
        let end = connectivity::run(settings, stop_requested()).await;
        media.shutdown();
        let _ = watcher.await;
        Ok::<_, String>(end)
    })?;
    // Blocking work has been told to stop, and notices within one read.
    runtime.shutdown_timeout(Duration::from_secs(10));
    tracing::info!(reason = %end, "Agent stopped");
    match end {
        ConnectionEnd::Shutdown => Ok(()),
        other => Err(other.to_string()),
    }
}

fn operations(
    config: &Config,
    agent_id: Uuid,
    settings: &ConnectionSettings,
    media: Arc<MediaSync>,
) -> Result<Arc<AgentOperations>, String> {
    let state_dir = config
        .state_dir
        .clone()
        .ok_or("no state directory is configured and no default is known")?;
    let staging_dir = config
        .effective_staging_dir()
        .ok_or("no staging directory is configured and no default is known")?;
    let restore = config
        .restore_settings()
        .ok_or("no state directory is configured and no default is known")?;
    AgentOperations::load(OperationsConfig {
        agent_id,
        restore,
        repositories: Arc::new(ConfiguredRepositories::new(
            config.repositories.clone(),
            state_dir.clone(),
        )),
        state_dir,
        staging_dir,
        emulators: Arc::clone(&settings.emulators),
        retry_delay: Duration::from_secs(5),
        media: Some(media),
        execution: config.execution,
    })
}

/// What the queue holds, without connecting to anything. Which server has what is the server's to say.
fn media_status(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    let state_dir = config
        .state_dir
        .clone()
        .ok_or("no state directory is configured and no default is known")?;
    let stored = credential_store(&config)?
        .load()
        .map_err(|error| error.to_string())?
        .ok_or("this agent is not paired, so it has no screenshot queue")?;
    let queue = MediaQueue::load(&state_dir, stored.agent_id).map_err(|error| error.to_string())?;
    let status = queue.status(std::iter::empty());
    let json = serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

/// What the cache holds, without connecting to anything. Opening it also tidies what a crash left behind.
fn cache_status(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    let directory = config
        .effective_cache_dir()
        .ok_or("no cache directory is configured and no default is known")?;
    let cache = ArchiveCache::open(directory, config.cache_max_bytes);
    let usage = cache.usage();
    println!("Cache directory: {}", cache.directory().display());
    println!("Limit: {} bytes", cache.max_bytes());
    println!("Archives: {}", usage.entries);
    println!("In use: {} bytes", usage.total_bytes);
    Ok(())
}

fn repository_check(cli: &Cli, repository_id: Uuid) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    let state_dir = config
        .state_dir
        .clone()
        .ok_or("no state directory is configured and no default is known")?;
    let repositories = ConfiguredRepositories::new(config.repositories.clone(), state_dir);
    let summary = repositories
        .summary(repository_id)
        .ok_or_else(|| format!("this agent has no configuration for repository {repository_id}"))?;
    println!(
        "Testing {}@{}:{} with remote root {}",
        summary.username, summary.host, summary.port, summary.remote_root
    );
    let repository = repositories
        .open(repository_id)
        .map_err(|error| error.message)?;
    let report = runtime()?
        .block_on(repository.health_check(&CancelFlag::new()))
        .map_err(|error| format!("{}: {}", error.kind.code(), error.message))?;
    println!("Connection and authentication: ok");
    println!(
        "Host key: trusted ({})",
        report.host_key_fingerprint.as_deref().unwrap_or("unknown")
    );
    println!("Remote root readable: {}", report.root_readable);
    println!("Remote root writable: {}", report.root_writable);
    println!(
        "Publication that cannot overwrite: {}",
        report.no_overwrite_publication
    );
    match report.free_bytes {
        Some(free) => println!("Free space: {free} bytes"),
        None => println!("Free space: not reported by this server"),
    }
    Ok(())
}

fn repository_passphrase(cli: &Cli, repository_id: Uuid) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    let state_dir = config
        .state_dir
        .clone()
        .ok_or("no state directory is configured and no default is known")?;
    if !config.repositories.contains_key(&repository_id) {
        return Err(format!(
            "this agent has no configuration for repository {repository_id}"
        ));
    }
    eprintln!("Enter the passphrase. It is not shown, and is stored protected with DPAPI:");
    let passphrase = shutdown::read_secret_line().map_err(|error| error.to_string())?;
    if passphrase.is_empty() {
        return Err("the passphrase is empty, so nothing was stored".to_owned());
    }
    credentials::save_repository_passphrase(&state_dir, repository_id, &Secret::new(passphrase))
        .map_err(|error| error.to_string())?;
    println!("Stored the passphrase for repository {repository_id}.");
    Ok(())
}

fn pair(cli: &Cli, name: Option<&str>, force: bool) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    logging::init(&config.log_level, config.log_format).map_err(|error| error.to_string())?;
    check_transport(&config.api_url).map_err(|error| error.to_string())?;
    let store = credential_store(&config)?;

    if !force {
        // Re-pairing replaces this agent's identity, so it has to be asked for.
        match store.load() {
            Ok(None) => {}
            Ok(Some(existing)) => {
                return Err(format!(
                    "this agent is already paired with {} as {}. Use `pair --force` to replace it",
                    existing.server_origin, existing.agent_id
                ));
            }
            Err(error) => return Err(format!("{error}. `pair --force` replaces it")),
        }
    }

    let (platform, architecture) = identity()?;
    let name = name
        .and_then(pairing::sanitize_agent_name)
        .or_else(|| config.agent_name.clone())
        .unwrap_or_else(|| pairing::default_agent_name(&process_env));
    let request = PairingRequest {
        name: name.clone(),
        platform,
        architecture,
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_version: protocol::PROTOCOL_VERSION,
    };

    let stored = runtime()?
        .block_on(pairing::pair(
            &config.api_url,
            &request,
            store.as_ref(),
            |code, expires_at| {
                println!("Pairing with {} as \"{name}\".", config.api_url);
                println!();
                println!("    Pairing code: {code}");
                println!();
                println!("Enter this code on the Agents page of the EmuCat web app.");
                println!("It expires at {expires_at}. Waiting for approval...");
            },
            stop_requested(),
        ))
        .map_err(|error| error.to_string())?;
    println!(
        "Paired as agent {}. Start it with `emucat-agent run`.",
        stored.agent_id
    );
    Ok(())
}

fn unpair(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    credential_store(&config)?
        .delete()
        .map_err(|error| error.to_string())?;
    println!(
        "Removed the local credential. The server still lists this agent: revoke it in the web app."
    );
    Ok(())
}

fn discover(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    let (host, _) = identity()?;
    let report = discovery::scan(&config.emulators, host, &ScanLimits::default());
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    println!("{json}");
    Ok(())
}

/// Everything a launch checks, and the command it would run. Starts nothing.
fn launch_check(cli: &Cli, emulator: &str, vm: &str) -> Result<(), String> {
    use emucat_agent::emulators::{EmulatorType, VmName};
    let config = load(cli).map_err(|error| error.to_string())?;
    let emulator: EmulatorType = emulator
        .parse()
        .map_err(|_| format!("unknown emulator {emulator:?}; use 86box or qemu"))?;
    let vm_name = VmName::new(vm).map_err(|error| format!("invalid VM name: {error}"))?;
    let paths = config
        .emulators
        .get(&emulator)
        .ok_or_else(|| format!("{emulator} is not configured"))?;
    let plan = emucat_agent::launcher::plan_launch(
        emulator,
        &paths.executable,
        &paths.base_path,
        &vm_name,
    )
    .map_err(|error| format!("{}: {}", error.kind.code(), error.message))?;
    println!("program: {}", plan.spawn.program.display());
    println!("working directory: {}", plan.spawn.working_dir.display());
    println!("from: {}", plan.source);
    println!("arguments:");
    for argument in &plan.spawn.args {
        println!("  {}", argument.to_string_lossy());
    }
    println!("graceful stop: {:?}", plan.graceful);
    Ok(())
}
