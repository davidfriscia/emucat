//! Runs the real executable.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use emucat_agent::platform::{Architecture, Platform, PlatformInfo};
use tempfile::TempDir;

fn agent(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_emucat-agent"))
        .args(arguments)
        .env_remove("EMUCAT_AGENT_CONFIG")
        .env_remove("EMUCAT_AGENT_API_URL")
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn toml_string(path: &Path) -> String {
    format!("{:?}", path.to_str().unwrap())
}

#[test]
fn version_prints_the_package_version() {
    let output = agent(&["--version"]);
    assert!(output.status.success());
    assert_eq!(
        stdout(&output).trim(),
        format!("emucat-agent {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn help_describes_the_commands() {
    let output = agent(&["--help"]);
    assert!(output.status.success());
    let text = stdout(&output);
    for expected in ["--config", "--log-level", "check-config", "info", "run"] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
}

#[test]
fn info_reports_the_platform() {
    let output = agent(&["info"]);
    assert!(output.status.success());
    let text = stdout(&output);
    assert!(text.contains(std::env::consts::OS));
    assert!(text.contains(std::env::consts::ARCH));
    assert!(text.contains("protocol version: 1"));
}

#[test]
fn this_platform_is_supported() {
    let info = PlatformInfo::current();
    assert!(matches!(
        info.platform(),
        Some(Platform::Windows | Platform::Macos | Platform::Linux)
    ));
    assert!(matches!(
        info.architecture(),
        Some(Architecture::X86_64 | Architecture::Aarch64)
    ));
}

#[test]
fn unknown_arguments_fail() {
    assert!(!agent(&["--no-such-flag"]).status.success());
    assert!(!agent(&["no-such-command"]).status.success());
}

#[test]
fn check_config_accepts_a_valid_file() {
    let directory = TempDir::new().unwrap();
    let base = directory.path().join("vms");
    let executable = directory.path().join("qemu.exe");
    fs::create_dir(&base).unwrap();
    fs::write(&executable, "").unwrap();
    let config = directory.path().join("agent.toml");
    fs::write(
        &config,
        format!(
            "[server]\napi_url = \"http://127.0.0.1:4000\"\n\
             [emulators.qemu]\nbase_path = {}\nexecutable = {}\n\
             [state]\ndir = {}\n",
            toml_string(&base),
            toml_string(&executable),
            toml_string(&directory.path().join("state")),
        ),
    )
    .unwrap();

    let output = agent(&["check-config", "--config", config.to_str().unwrap()]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("valid"));
    assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
}

#[test]
fn check_config_fails_on_an_invalid_machine() {
    let directory = TempDir::new().unwrap();
    let config = directory.path().join("agent.toml");
    let missing = directory.path().join("missing");
    fs::write(
        &config,
        format!(
            "[server]\napi_url = \"http://127.0.0.1:4000\"\n\
             [emulators.qemu]\nbase_path = {0}\nexecutable = {0}\n",
            toml_string(&missing),
        ),
    )
    .unwrap();

    let output = agent(&["check-config", "--config", config.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("base path is not a directory"));
}

#[test]
fn a_missing_file_is_a_clean_error() {
    let output = agent(&["check-config", "--config", "does-not-exist.toml"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("cannot read configuration file"));
}

#[test]
fn run_refuses_an_invalid_configuration() {
    let directory = TempDir::new().unwrap();
    let config = directory.path().join("agent.toml");
    fs::write(&config, "[server]\napi_url = \"http://127.0.0.1:4000\"\n").unwrap();
    let output = agent(&["run", "--config", config.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("no emulator"));
}
