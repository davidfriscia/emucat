use std::collections::HashMap;
use std::fs;
use std::path::Path;

use emucat_agent::config::{
    Config, ConfigError, LogFormat, SettingOverrides, Severity, default_config_path, validate,
};
use emucat_agent::connectivity::agent_ws_url;
use emucat_agent::emulators::EmulatorType;
use tempfile::TempDir;

const MINIMAL: &str = r#"
[server]
api_url = "http://127.0.0.1:4000"

[emulators.qemu]
base_path = "/vms/qemu"
executable = "/bin/qemu"
"#;

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    move |name| map.get(name).cloned()
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn parse(text: &str) -> Result<Config, ConfigError> {
    Config::from_toml(text, &no_env, &SettingOverrides::default())
}

/// A machine with real paths, and a configuration that points at them.
struct Machine {
    _directory: TempDir,
    config: Config,
}

fn machine() -> Machine {
    let directory = TempDir::new().unwrap();
    let base = directory.path().join("vms");
    let executable = directory.path().join("emulator.exe");
    let state = directory.path().join("state");
    fs::create_dir(&base).unwrap();
    fs::write(&executable, "").unwrap();
    let text = format!(
        r#"
        [server]
        api_url = "http://127.0.0.1:4000"
        [emulators.86box]
        base_path = {base:?}
        executable = {executable:?}
        [state]
        dir = {state:?}
        "#,
    );
    Machine {
        config: parse(&text).unwrap(),
        _directory: directory,
    }
}

fn error_messages(config: &Config) -> Vec<String> {
    validate(config)
        .into_iter()
        .filter(|issue| issue.severity == Severity::Error)
        .map(|issue| issue.message)
        .collect()
}

#[test]
fn loads_a_file_from_disk() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("agent.toml");
    fs::write(&path, MINIMAL).unwrap();
    let config = Config::load(Some(&path), &no_env, &SettingOverrides::default()).unwrap();
    assert_eq!(config.api_url.as_str(), "http://127.0.0.1:4000/");
    let qemu = &config.emulators[&EmulatorType::Qemu];
    assert_eq!(qemu.base_path, Path::new("/vms/qemu"));
    assert_eq!(config.log_level, "info");
    assert_eq!(config.log_format, LogFormat::Text);
}

#[test]
fn the_shipped_example_parses() {
    let text = include_str!("../agent.example.toml");
    let config = parse(text).unwrap();
    assert_eq!(config.emulators.len(), 2);
}

#[test]
fn a_chosen_file_must_exist() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("missing.toml");
    let error = Config::load(Some(&path), &no_env, &SettingOverrides::default()).unwrap_err();
    assert!(matches!(error, ConfigError::Read { .. }));
}

#[test]
fn the_environment_can_choose_the_file() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("agent.toml");
    fs::write(&path, MINIMAL).unwrap();
    let env = env_of(&[("EMUCAT_AGENT_CONFIG", path.to_str().unwrap())]);
    let config = Config::load(None, &env, &SettingOverrides::default()).unwrap();
    assert!(config.emulators.contains_key(&EmulatorType::Qemu));
}

#[test]
fn the_default_file_is_optional() {
    let directory = TempDir::new().unwrap();
    let home = directory.path().to_str().unwrap();
    let env = env_of(&[
        ("APPDATA", home),
        ("HOME", home),
        ("XDG_CONFIG_HOME", home),
        ("EMUCAT_AGENT_API_URL", "http://server:4000"),
    ]);
    assert!(!default_config_path(&env).unwrap().exists());
    let config = Config::load(None, &env, &SettingOverrides::default()).unwrap();
    assert_eq!(config.api_url.host_str(), Some("server"));
}

#[test]
fn environment_overrides_the_file() {
    let env = env_of(&[
        ("EMUCAT_AGENT_API_URL", "https://example.test/"),
        ("EMUCAT_AGENT_QEMU_BASE_PATH", "/other"),
        ("EMUCAT_AGENT_STATE_DIR", "/state"),
        ("EMUCAT_AGENT_LOG_LEVEL", "debug"),
        ("EMUCAT_AGENT_LOG_FORMAT", "json"),
    ]);
    let config = Config::from_toml(MINIMAL, &env, &SettingOverrides::default()).unwrap();
    assert_eq!(config.api_url.scheme(), "https");
    assert_eq!(
        config.emulators[&EmulatorType::Qemu].base_path,
        Path::new("/other")
    );
    assert_eq!(
        config.emulators[&EmulatorType::Qemu].executable,
        Path::new("/bin/qemu")
    );
    assert_eq!(config.state_dir.as_deref(), Some(Path::new("/state")));
    assert_eq!(config.log_level, "debug");
    assert_eq!(config.log_format, LogFormat::Json);
}

#[test]
fn command_line_overrides_the_environment() {
    let env = env_of(&[
        ("EMUCAT_AGENT_LOG_LEVEL", "debug"),
        ("EMUCAT_AGENT_LOG_FORMAT", "json"),
    ]);
    let overrides = SettingOverrides {
        log_level: Some("warn".to_owned()),
        log_format: Some(LogFormat::Text),
    };
    let config = Config::from_toml(MINIMAL, &env, &overrides).unwrap();
    assert_eq!(config.log_level, "warn");
    assert_eq!(config.log_format, LogFormat::Text);
}

#[test]
fn emulators_have_independent_paths() {
    let config = parse(
        r#"
        [server]
        api_url = "http://localhost:4000"
        [emulators.86box]
        base_path = "/a"
        executable = "/a/86Box"
        [emulators.qemu]
        base_path = "/b"
        executable = "/b/qemu"
        "#,
    )
    .unwrap();
    assert_eq!(
        config.emulators[&EmulatorType::Box86].base_path,
        Path::new("/a")
    );
    assert_eq!(
        config.emulators[&EmulatorType::Qemu].base_path,
        Path::new("/b")
    );
}

#[test]
fn rejects_a_missing_url() {
    assert!(matches!(parse(""), Err(ConfigError::MissingApiUrl)));
}

#[test]
fn rejects_unsuitable_urls() {
    for url in [
        "not a url",
        "ftp://example.test",
        "file:///etc/passwd",
        "http://user:secret@example.test",
        "http://example.test?token=abc",
        "http://example.test#fragment",
    ] {
        let text = format!("[server]\napi_url = {url:?}");
        assert!(
            matches!(parse(&text), Err(ConfigError::Invalid { .. })),
            "{url}"
        );
    }
}

#[test]
fn does_not_echo_credentials_from_a_url() {
    let text = "[server]\napi_url = \"http://user:secret@example.test\"";
    let message = parse(text).unwrap_err().to_string();
    assert!(!message.contains("secret"), "{message}");
}

#[test]
fn rejects_unknown_settings() {
    for text in [
        "unknown = 1",
        "[server]\napi_url = \"http://a\"\ntoken = \"x\"",
        "[emulators.vmware]\nbase_path = \"/a\"",
    ] {
        assert!(
            matches!(parse(text), Err(ConfigError::Parse { .. })),
            "{text}"
        );
    }
}

#[test]
fn rejects_an_emulator_with_only_one_path() {
    let text = "[server]\napi_url = \"http://a\"\n[emulators.qemu]\nbase_path = \"/a\"";
    assert!(matches!(parse(text), Err(ConfigError::Invalid { .. })));
}

#[test]
fn rejects_invalid_logging_settings() {
    for logging in ["level = \"not=a=filter\"", "format = \"xml\""] {
        let text = format!("[server]\napi_url = \"http://a\"\n[logging]\n{logging}");
        assert!(
            matches!(parse(&text), Err(ConfigError::Invalid { .. })),
            "{logging}"
        );
    }
}

#[test]
fn accepts_real_paths() {
    let machine = machine();
    assert_eq!(error_messages(&machine.config), Vec::<String>::new());
}

#[test]
fn validation_does_not_create_anything() {
    let machine = machine();
    let state = machine.config.state_dir.clone().unwrap();
    validate(&machine.config);
    assert!(!state.exists());
}

#[test]
fn requires_at_least_one_emulator() {
    let mut machine = machine();
    machine.config.emulators.clear();
    assert!(error_messages(&machine.config)[0].contains("no emulator"));
}

#[test]
fn reports_missing_paths() {
    let mut machine = machine();
    let paths = machine
        .config
        .emulators
        .get_mut(&EmulatorType::Box86)
        .unwrap();
    paths.base_path = paths.base_path.join("missing");
    paths.executable = paths.executable.with_file_name("missing.exe");
    let errors = error_messages(&machine.config);
    assert!(errors.iter().any(|error| error.contains("base path")));
    assert!(errors.iter().any(|error| error.contains("executable")));
}

#[test]
fn requires_absolute_paths() {
    let mut machine = machine();
    let paths = machine
        .config
        .emulators
        .get_mut(&EmulatorType::Box86)
        .unwrap();
    paths.base_path = "relative/vms".into();
    paths.executable = "relative/86Box".into();
    machine.config.state_dir = Some("relative/state".into());
    let errors = error_messages(&machine.config);
    assert_eq!(errors.len(), 3, "{errors:?}");
    assert!(errors.iter().all(|error| error.contains("absolute")));
}

#[test]
fn keeps_agent_state_out_of_vm_directories() {
    let mut machine = machine();
    let base = machine.config.emulators[&EmulatorType::Box86]
        .base_path
        .clone();
    machine.config.state_dir = Some(base.join("state"));
    assert!(error_messages(&machine.config)[0].contains("state directory"));
    machine.config.state_dir = Some(base.join("a").join("..").join("state"));
    assert!(error_messages(&machine.config)[0].contains("state directory"));
}

#[test]
fn warns_about_unencrypted_remote_servers() {
    let mut machine = machine();
    machine.config.api_url = "http://server.example:4000".parse().unwrap();
    let issues = validate(&machine.config);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].severity, Severity::Warning);
}

#[test]
fn derives_the_websocket_address() {
    for (api_url, expected) in [
        (
            "http://127.0.0.1:4000",
            "ws://127.0.0.1:4000/api/v1/agent/ws",
        ),
        ("https://example.test", "wss://example.test/api/v1/agent/ws"),
        (
            "https://example.test/emucat/",
            "wss://example.test/emucat/api/v1/agent/ws",
        ),
    ] {
        let url = api_url.parse().unwrap();
        assert_eq!(agent_ws_url(&url).as_str(), expected);
    }
}
