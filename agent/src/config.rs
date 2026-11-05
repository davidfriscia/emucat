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
use uuid::Uuid;

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

/// How this agent reaches a repository. It is keyed by the repository's UUID in the server's database,
/// and is the only source of a host, a port or a path: nothing a server or a browser sends can change
/// them. It names where a private key is, and never holds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_root: String,
    pub private_key_path: PathBuf,
    pub host_key_fingerprints: Vec<String>,
    pub known_hosts_path: Option<PathBuf>,
    pub connect_timeout_seconds: u64,
    pub transfer_timeout_seconds: u64,
    pub connect_retries: u32,
    pub upload_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub api_url: Url,
    /// The name to pair under. Defaults to the computer name.
    pub agent_name: Option<String>,
    pub emulators: BTreeMap<EmulatorType, EmulatorConfig>,
    pub state_dir: Option<PathBuf>,
    /// Where archives are built. Defaults to `staging` in the state directory.
    pub staging_dir: Option<PathBuf>,
    pub repositories: BTreeMap<Uuid, RepositoryConfig>,
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
    #[serde(default)]
    storage: StorageSection,
    #[serde(default)]
    repositories: BTreeMap<String, RepositorySection>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StorageSection {
    staging_dir: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositorySection {
    kind: String,
    host: String,
    #[serde(default = "default_ssh_port")]
    port: u16,
    username: String,
    remote_root: String,
    private_key_path: PathBuf,
    #[serde(default)]
    host_key_fingerprints: Vec<String>,
    known_hosts_path: Option<PathBuf>,
    #[serde(default = "default_connect_timeout")]
    connect_timeout_seconds: u64,
    #[serde(default = "default_transfer_timeout")]
    transfer_timeout_seconds: u64,
    #[serde(default = "default_connect_retries")]
    connect_retries: u32,
    #[serde(default = "default_upload_attempts")]
    upload_attempts: u32,
}

const fn default_ssh_port() -> u16 {
    22
}
const fn default_connect_timeout() -> u64 {
    20
}
const fn default_transfer_timeout() -> u64 {
    60
}
const fn default_connect_retries() -> u32 {
    2
}
const fn default_upload_attempts() -> u32 {
    2
}

fn resolve_repositories(
    sections: BTreeMap<String, RepositorySection>,
) -> Result<BTreeMap<Uuid, RepositoryConfig>, ConfigError> {
    let invalid = |message: String| ConfigError::Invalid {
        field: "repositories",
        message,
    };
    let mut repositories = BTreeMap::new();
    for (id, section) in sections {
        let uuid =
            Uuid::parse_str(&id).map_err(|_| invalid(format!("{id} is not a repository UUID")))?;
        if section.kind != "sftp" {
            return Err(invalid(format!(
                "{id}: \"{}\" is not a supported kind. Use \"sftp\"",
                section.kind
            )));
        }
        if section.host.is_empty() || section.username.is_empty() {
            return Err(invalid(format!("{id}: host and username are required")));
        }
        if section.remote_root.is_empty()
            || section.remote_root.contains('\\')
            || section
                .remote_root
                .split('/')
                .any(|segment| segment == "..")
        {
            return Err(invalid(format!(
                "{id}: remote_root must be a path on the server, with no \"..\""
            )));
        }
        if section.host_key_fingerprints.is_empty() && section.known_hosts_path.is_none() {
            return Err(invalid(format!(
                "{id}: host_key_fingerprints or known_hosts_path is required. Host keys are always \
                 verified"
            )));
        }
        if section
            .host_key_fingerprints
            .iter()
            .any(|fingerprint| !fingerprint.starts_with("SHA256:"))
        {
            return Err(invalid(format!(
                "{id}: host_key_fingerprints must look like SHA256:…, as ssh-keygen -lf prints them"
            )));
        }
        if section.upload_attempts == 0 || section.transfer_timeout_seconds == 0 {
            return Err(invalid(format!(
                "{id}: upload_attempts and transfer_timeout_seconds must be at least 1"
            )));
        }
        repositories.insert(
            uuid,
            RepositoryConfig {
                host: section.host,
                port: section.port,
                username: section.username,
                remote_root: section.remote_root,
                private_key_path: section.private_key_path,
                host_key_fingerprints: section.host_key_fingerprints,
                known_hosts_path: section.known_hosts_path,
                connect_timeout_seconds: section.connect_timeout_seconds,
                transfer_timeout_seconds: section.transfer_timeout_seconds,
                connect_retries: section.connect_retries,
                upload_attempts: section.upload_attempts,
            },
        );
    }
    Ok(repositories)
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
    /// Where archives are built, if that is known.
    pub fn effective_staging_dir(&self) -> Option<PathBuf> {
        self.staging_dir
            .clone()
            .or_else(|| self.state_dir.as_ref().map(|dir| dir.join("staging")))
    }

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
            staging_dir: env("EMUCAT_AGENT_STAGING_DIR")
                .map(PathBuf::from)
                .or(file.storage.staging_dir),
            repositories: resolve_repositories(file.repositories)?,
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

    if let Some(staging) = &config.staging_dir {
        if !staging.is_absolute() {
            error(format!(
                "staging directory must be absolute: {}",
                staging.display()
            ));
        }
        for (emulator, paths) in &config.emulators {
            if is_within(staging, &paths.base_path) {
                error(format!(
                    "staging directory must not be inside the {emulator} base path: {}",
                    staging.display()
                ));
            }
        }
    }

    for (id, repository) in &config.repositories {
        if !repository.private_key_path.is_absolute() {
            error(format!(
                "repository {id}: private_key_path must be absolute"
            ));
        } else if !repository.private_key_path.is_file() {
            error(format!(
                "repository {id}: private key not found: {}",
                repository.private_key_path.display()
            ));
        }
        for (emulator, paths) in &config.emulators {
            if is_within(&repository.private_key_path, &paths.base_path) {
                error(format!(
                    "repository {id}: the private key must not be inside the {emulator} base path, \
                     or it could end up in an archive"
                ));
            }
        }
        if let Some(known_hosts) = &repository.known_hosts_path
            && !known_hosts.is_file()
        {
            error(format!(
                "repository {id}: known_hosts file not found: {}",
                known_hosts.display()
            ));
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
