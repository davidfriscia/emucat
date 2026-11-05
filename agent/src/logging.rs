//! Structured logging, written to standard error.

use thiserror::Error;
use tracing_subscriber::EnvFilter;

use crate::config::LogFormat;

#[derive(Debug, Error)]
pub enum LoggingError {
    #[error("invalid log filter: {0}")]
    Filter(String),
    #[error("cannot initialize logging: {0}")]
    Init(String),
}

/// Transport libraries that can log whole requests at their most detailed levels, and so the bearer
/// token in a request's headers. They stay at `info` whatever filter is configured.
const QUIET_TARGETS: [&str; 7] = [
    "tungstenite",
    "tokio_tungstenite",
    "reqwest",
    "hyper",
    "hyper_util",
    "h2",
    "native_tls",
];

/// The configured filter, with the transport libraries capped.
pub fn build_filter(level: &str) -> Result<EnvFilter, LoggingError> {
    let mut filter =
        EnvFilter::try_new(level).map_err(|error| LoggingError::Filter(error.to_string()))?;
    for target in QUIET_TARGETS {
        let directive = format!("{target}=info").parse().map_err(
            |error: tracing_subscriber::filter::ParseError| LoggingError::Filter(error.to_string()),
        )?;
        filter = filter.add_directive(directive);
    }
    Ok(filter)
}

pub fn init(level: &str, format: LogFormat) -> Result<(), LoggingError> {
    let builder = tracing_subscriber::fmt()
        .with_env_filter(build_filter(level)?)
        .with_writer(std::io::stderr);
    match format {
        LogFormat::Text => builder.try_init(),
        LogFormat::Json => builder.json().try_init(),
    }
    .map_err(|error| LoggingError::Init(error.to_string()))
}
