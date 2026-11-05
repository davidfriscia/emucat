//! Agent configuration: a TOML file, overridden by the environment and then the command line.
//!
//! Validation only reads metadata. It never creates, changes or lists anything.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use clap::ValueEnum;
use serde::Deserialize;
use thiserror::Error;
use tracing_subscriber::EnvFilter;
use url::Url;

use crate::emulators::EmulatorType;
use crate::pairing::sanitize_agent_name;

pub const CONFIG_PATH_ENV: &str = "EMUCAT_AGENT_CONFIG";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    #[default]
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmulatorConfig {
    pub base_path: PathBuf,
    pub executable: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub api_url: Url,
    /// The name to pair under. Defaults to the computer name.
    pub agent_name: Option<String>,
    pub emulators: BTreeMap<EmulatorType, EmulatorConfig>,
    pub state_dir: Option<PathBuf>,
    pub log_level: String,
    pub log_format: LogFormat,
}

#[derive(Debug, Default)]
pub struct SettingOverrides {
    pub log_level: Option<String>,
    pub log_format: Option<LogFormat>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(
        "no configuration file given and no default location is known; use --config or {CONFIG_PATH_ENV}"
    )]
    NoConfigPath,
    #[error("cannot read configuration file {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("cannot parse configuration file {path}: {source}")]
    Parse {
        path: PathBuf,
        source: Box<toml::de::Error>,
    },
    #[error("server.api_url is required")]
    MissingApiUrl,
    #[error("invalid value for {field}: {message}")]
    Invalid {
        field: &'static str,
        message: String,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    #[serde(default)]
    server: ServerSection,
    #[serde(default)]
    agent: AgentSection,
    #[serde(default)]
    emulators: EmulatorsSection,
    #[serde(default)]
    state: StateSection,
    #[serde(default)]
    logging: LoggingSection,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerSection {
    api_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentSection {
    name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmulatorsSection {
    #[serde(rename = "86box", default)]
    box86: EmulatorSection,
    #[serde(default)]
    qemu: EmulatorSection,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmulatorSection {
    base_path: Option<PathBuf>,
    executable: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StateSection {
    dir: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LoggingSection {
    level: Option<String>,
    format: Option<String>,
}

/// Reads an environment variable, treating an empty value as unset.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Default configuration file for this platform.
pub fn default_config_path(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if cfg!(windows) {
        env("APPDATA").map(|dir| Path::new(&dir).join("EmuCat").join("agent.toml"))
    } else if cfg!(target_os = "macos") {
        env("HOME")
            .map(|home| Path::new(&home).join("Library/Application Support/EmuCat/agent.toml"))
    } else {
        env("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env("HOME").map(|home| Path::new(&home).join(".config")))
            .map(|dir| dir.join("emucat").join("agent.toml"))
    }
}

/// Default state directory for this platform.
pub fn default_state_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if cfg!(windows) {
        env("LOCALAPPDATA").map(|dir| Path::new(&dir).join("EmuCat").join("agent"))
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|home| Path::new(&home).join("Library/Application Support/EmuCat/agent"))
    } else {
        env("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| env("HOME").map(|home| Path::new(&home).join(".local/state")))
            .map(|dir| dir.join("emucat").join("agent"))
    }
}

fn parse_api_url(value: &str) -> Result<Url, ConfigError> {
    let invalid = |message: &str| ConfigError::Invalid {
        field: "server.api_url",
        message: message.to_owned(),
    };
    let url = Url::parse(value).map_err(|_| invalid("not a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("must use http or https"));
    }
    if !url.has_host() {
        return Err(invalid("must include a host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("must not contain a query or fragment"));
    }
    Ok(url)
}

fn parse_log_format(value: &str, field: &'static str) -> Result<LogFormat, ConfigError> {
    match value {
        "text" => Ok(LogFormat::Text),
        "json" => Ok(LogFormat::Json),
        _ => Err(ConfigError::Invalid {
            field,
            message: "must be text or json".to_owned(),
        }),
    }
}

fn resolve_emulator(
    section: EmulatorSection,
    prefix: &str,
    field: &'static str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<EmulatorConfig>, ConfigError> {
    let base_path = env(&format!("{prefix}_BASE_PATH"))
        .map(PathBuf::from)
        .or(section.base_path);
    let executable = env(&format!("{prefix}_EXECUTABLE"))
        .map(PathBuf::from)
        .or(section.executable);
    match (base_path, executable) {
        (None, None) => Ok(None),
        (Some(base_path), Some(executable)) => Ok(Some(EmulatorConfig {
            base_path,
            executable,
        })),
        _ => Err(ConfigError::Invalid {
            field,
            message: "base_path and executable must be set together".to_owned(),
        }),
    }
}

impl Config {
    /// Loads the configuration. An explicitly chosen file must exist. The default file is
    /// optional, so that an agent can be configured through the environment alone.
    pub fn load(
        path: Option<&Path>,
        env: &dyn Fn(&str) -> Option<String>,
        overrides: &SettingOverrides,
    ) -> Result<Self, ConfigError> {
        let explicit = path
            .map(Path::to_path_buf)
            .or_else(|| env(CONFIG_PATH_ENV).map(PathBuf::from));
        let file = match &explicit {
            Some(path) => read_file(path)?,
            None => match default_config_path(env) {
                Some(path) if path.exists() => read_file(&path)?,
                _ => FileConfig::default(),
            },
        };
        Self::resolve(file, env, overrides)
    }

    /// Parses configuration text, for tests and tools. File reading is not involved.
    pub fn from_toml(
        text: &str,
        env: &dyn Fn(&str) -> Option<String>,
        overrides: &SettingOverrides,
    ) -> Result<Self, ConfigError> {
        let file = toml::from_str(text).map_err(|source| ConfigError::Parse {
            path: PathBuf::from("<text>"),
            source: Box::new(source),
        })?;
        Self::resolve(file, env, overrides)
    }

    fn resolve(
        file: FileConfig,
        env: &dyn Fn(&str) -> Option<String>,
        overrides: &SettingOverrides,
    ) -> Result<Self, ConfigError> {
        let api_url = env("EMUCAT_AGENT_API_URL")
            .or(file.server.api_url)
            .ok_or(ConfigError::MissingApiUrl)?;

        let mut emulators = BTreeMap::new();
        let sections = [
            (
                EmulatorType::Box86,
                file.emulators.box86,
                "EMUCAT_AGENT_86BOX",
                "emulators.86box",
            ),
            (
                EmulatorType::Qemu,
                file.emulators.qemu,
                "EMUCAT_AGENT_QEMU",
                "emulators.qemu",
            ),
        ];
        for (emulator, section, prefix, field) in sections {
            if let Some(config) = resolve_emulator(section, prefix, field, env)? {
                emulators.insert(emulator, config);
            }
        }

        let log_format = match (overrides.log_format, env("EMUCAT_AGENT_LOG_FORMAT")) {
            (Some(format), _) => format,
            (None, Some(value)) => parse_log_format(&value, "EMUCAT_AGENT_LOG_FORMAT")?,
            (None, None) => file
                .logging
                .format
                .as_deref()
                .map(|value| parse_log_format(value, "logging.format"))
                .transpose()?
                .unwrap_or_default(),
        };

        let log_level = overrides
            .log_level
            .clone()
            .or_else(|| env("EMUCAT_AGENT_LOG_LEVEL"))
            .or(file.logging.level)
            .unwrap_or_else(|| "info".to_owned());
        EnvFilter::try_new(&log_level).map_err(|error| ConfigError::Invalid {
            field: "logging.level",
            message: error.to_string(),
        })?;
        let agent_name = env("EMUCAT_AGENT_NAME")
            .or(file.agent.name)
            .map(|name| {
                sanitize_agent_name(&name).ok_or(ConfigError::Invalid {
                    field: "agent.name",
                    message: "must not be empty".to_owned(),
                })
            })
            .transpose()?;

        Ok(Self {
            api_url: parse_api_url(&api_url)?,
            agent_name,
            emulators,
            state_dir: env("EMUCAT_AGENT_STATE_DIR")
                .map(PathBuf::from)
                .or(file.state.dir)
                .or_else(|| default_state_dir(env)),
            log_level,
            log_format,
        })
    }
}

fn read_file(path: &Path) -> Result<FileConfig, ConfigError> {
    let text = fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    toml::from_str(&text).map_err(|source| ConfigError::Parse {
        path: path.to_path_buf(),
        source: Box::new(source),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub severity: Severity,
    pub message: String,
}

impl fmt::Display for ValidationIssue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self.severity {
            Severity::Warning => "warning",
            Severity::Error => "error",
        };
        write!(formatter, "{label}: {}", self.message)
    }
}

/// Normalizes `.` and `..` without touching the filesystem, for comparing configured paths.
fn lexically_normal(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result
}

/// Whether `path` is `base` or inside it. Windows paths compare case-insensitively.
fn is_within(path: &Path, base: &Path) -> bool {
    let (path, base) = (lexically_normal(path), lexically_normal(base));
    if cfg!(windows) {
        let lower = |value: &Path| PathBuf::from(value.to_string_lossy().to_lowercase());
        lower(&path).starts_with(lower(&base))
    } else {
        path.starts_with(base)
    }
}

/// Checks a loaded configuration against the machine. Reads metadata only.
pub fn validate(config: &Config) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let mut error = |message: String| {
        issues.push(ValidationIssue {
            severity: Severity::Error,
            message,
        });
    };

    if config.emulators.is_empty() {
        error("no emulator is configured; set a base path and executable for at least one".into());
    }

    for (emulator, paths) in &config.emulators {
        if !paths.base_path.is_absolute() {
            error(format!(
                "{emulator} base path must be absolute: {}",
                paths.base_path.display()
            ));
        } else if !paths.base_path.is_dir() {
            error(format!(
                "{emulator} base path is not a directory: {}",
                paths.base_path.display()
            ));
        }
        if !paths.executable.is_absolute() {
            error(format!(
                "{emulator} executable path must be absolute: {}",
                paths.executable.display()
            ));
        } else if !paths.executable.is_file() {
            error(format!(
                "{emulator} executable is not a file: {}",
                paths.executable.display()
            ));
        }
    }

    match &config.state_dir {
        None => error("no state directory is configured and no default is known".into()),
        Some(dir) if !dir.is_absolute() => {
            error(format!(
                "state directory must be absolute: {}",
                dir.display()
            ));
        }
        Some(dir) => {
            for (emulator, paths) in &config.emulators {
                if is_within(dir, &paths.base_path) {
                    error(format!(
                        "state directory must not be inside the {emulator} base path: {}",
                        dir.display()
                    ));
                }
            }
        }
    }

    if config.api_url.scheme() == "http" {
        let local = config
            .api_url
            .host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
        if !local {
            issues.push(ValidationIssue {
                severity: Severity::Warning,
                message: format!(
                    "server.api_url uses unencrypted http for a remote host: {}",
                    config.api_url
                ),
            });
        }
    }

    issues
}
