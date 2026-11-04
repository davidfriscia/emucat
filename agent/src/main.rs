use std::process::ExitCode;

use clap::Parser;
use emucat_agent::cli::{Cli, Command, Overrides, print_info};
use emucat_agent::config::{Config, ConfigError, Severity, process_env, validate};
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

fn run(cli: &Cli) -> Result<(), String> {
    let config = load(cli).map_err(|error| error.to_string())?;
    logging::init(&config.log_level, config.log_format).map_err(|error| error.to_string())?;
    report_validation(&config)?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("cannot start the runtime: {error}"))?;

    let info = platform::PlatformInfo::current();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        protocol = protocol::PROTOCOL_VERSION,
        os = info.os,
        arch = info.arch,
        api_url = %config.api_url,
        emulators = config.emulators.len(),
        "Agent started"
    );

    let signal = runtime
        .block_on(shutdown::wait_for_signal())
        .map_err(|error| format!("cannot listen for shutdown signals: {error}"))?;
    tracing::info!(signal, "Agent stopped");
    Ok(())
}
