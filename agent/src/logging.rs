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

pub fn init(level: &str, format: LogFormat) -> Result<(), LoggingError> {
    let filter =
        EnvFilter::try_new(level).map_err(|error| LoggingError::Filter(error.to_string()))?;
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr);
    match format {
        LogFormat::Text => builder.try_init(),
        LogFormat::Json => builder.json().try_init(),
    }
    .map_err(|error| LoggingError::Init(error.to_string()))
}
