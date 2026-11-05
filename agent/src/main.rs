use std::process::ExitCode;

use clap::Parser;
use emucat_agent::cli::{Cli, Command, Overrides, print_info};
use emucat_agent::config::{Config, ConfigError, Severity, process_env, validate};
use emucat_agent::connectivity::{self, ConnectionEnd, ConnectionSettings, check_transport};
use emucat_agent::credentials::{self, CredentialStore};
use emucat_agent::discovery::{self, ScanLimits};
use emucat_agent::pairing::{self, PairingRequest};
use emucat_agent::platform::{Architecture, Platform};
use emucat_agent::protocol::AgentHello;
use emucat_agent::{logging, platform, protocol, shutdown};

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command.as_ref().unwrap_or(&Command::Run) {
        Command::Info => {
            print_info();
            Ok(())
        }
        Command::CheckConfig => check_config(&cli),
        Command::Run => run(&cli),
        Command::Pair { name, force } => pair(&cli, name.as_deref(), *force),
        Command::Unpair => unpair(&cli),
        Command::Discover => discover(&cli),
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

    let settings = ConnectionSettings::new(
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
    let end = runtime()?.block_on(connectivity::run(settings, stop_requested()));
    tracing::info!(reason = %end, "Agent stopped");
    match end {
        ConnectionEnd::Shutdown => Ok(()),
        other => Err(other.to_string()),
    }
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
