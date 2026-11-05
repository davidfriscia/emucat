//! Runs the real executable for the commands that involve a server or a credential.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

fn agent(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_emucat-agent"))
        .args(arguments)
        .env_remove("EMUCAT_AGENT_CONFIG")
        .env_remove("EMUCAT_AGENT_API_URL")
        .env_remove("EMUCAT_AGENT_NAME")
        .env_remove("EMUCAT_AGENT_STATE_DIR")
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

/// A valid configuration file, for a server at this URL.
fn config_for(directory: &TempDir, api_url: &str) -> String {
    let base = directory.path().join("vms");
    let executable = directory.path().join("86Box.exe");
    fs::create_dir_all(&base).unwrap();
    fs::write(&executable, "").unwrap();
    let config = directory.path().join("agent.toml");
    fs::write(
        &config,
        format!(
            "[server]\napi_url = {api_url:?}\n\
             [emulators.86box]\nbase_path = {}\nexecutable = {}\n\
             [state]\ndir = {}\n",
            toml_string(&base),
            toml_string(&executable),
            toml_string(&directory.path().join("state")),
        ),
    )
    .unwrap();
    config.to_str().unwrap().to_owned()
}

#[test]
fn help_lists_the_connectivity_commands() {
    let text = stdout(&agent(&["--help"]));
    for expected in ["pair", "unpair", "discover", "run"] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    let pair = stdout(&agent(&["pair", "--help"]));
    assert!(
        pair.contains("--force") && pair.contains("--name"),
        "{pair}"
    );
    // A credential has no command-line option, on any command.
    for help in [&text, &pair, &stdout(&agent(&["run", "--help"]))] {
        assert!(!help.to_lowercase().contains("--token"), "{help}");
        assert!(!help.to_lowercase().contains("--credential"), "{help}");
    }
}

#[test]
fn run_refuses_to_start_unpaired_and_explains_what_to_do() {
    let directory = TempDir::new().unwrap();
    let config = config_for(&directory, "http://127.0.0.1:1");
    let output = agent(&["run", "--config", &config]);
    assert_eq!(output.status.code(), Some(1));
    let text = stderr(&output);
    // Windows has a store; other platforms say that they do not yet.
    assert!(
        text.contains("not paired") || text.contains("no secure credential store"),
        "{text}"
    );
}

#[test]
fn run_and_pair_refuse_a_remote_server_over_plain_http() {
    let directory = TempDir::new().unwrap();
    let config = config_for(&directory, "http://emucat.invalid:4000");
    for command in ["run", "pair"] {
        let output = agent(&[command, "--config", &config]);
        assert_eq!(output.status.code(), Some(1), "{command}");
        assert!(stderr(&output).contains("unencrypted http"), "{command}");
    }
}

#[test]
fn a_secret_cannot_be_put_in_the_configuration_file() {
    let directory = TempDir::new().unwrap();
    let config = directory.path().join("agent.toml");
    fs::write(
        &config,
        "[server]\napi_url = \"http://127.0.0.1:4000\"\ncredential = \"secret\"\n",
    )
    .unwrap();
    let output = agent(&["check-config", "--config", config.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("credential"));
}

#[test]
fn discover_prints_a_report_and_needs_no_server_or_credential() {
    let directory = TempDir::new().unwrap();
    let config = config_for(&directory, "http://127.0.0.1:1");
    let base = directory.path().join("vms");
    fs::create_dir(base.join("Win98")).unwrap();
    fs::write(base.join("Win98").join("86box.cfg"), "").unwrap();
    fs::create_dir(base.join("bad.")).unwrap_or(());

    let output = agent(&["discover", "--config", &config]);
    assert!(output.status.success(), "{}", stderr(&output));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["vms"][0]["vmName"], "Win98");
    assert_eq!(report["vms"][0]["emulatorType"], "86box");
    assert_eq!(report["emulators"][0]["status"], "ok");
    assert_eq!(report["emulators"][1]["status"], "not_configured");
    assert!(
        !directory.path().join("state").exists(),
        "discovery writes nothing"
    );
}

#[cfg(windows)]
#[test]
fn unpair_removes_only_the_local_credential_file() {
    let directory = TempDir::new().unwrap();
    let config = config_for(&directory, "http://127.0.0.1:1");
    let state = directory.path().join("state");
    fs::create_dir(&state).unwrap();
    let credential = state.join("credential.dpapi");
    fs::write(&credential, b"anything").unwrap();
    fs::write(state.join("other"), b"kept").unwrap();

    let output = agent(&["unpair", "--config", &config]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(!credential.exists());
    assert!(state.join("other").exists());
}

#[cfg(windows)]
#[test]
fn an_unreadable_credential_is_reported_and_kept() {
    let directory = TempDir::new().unwrap();
    let config = config_for(&directory, "http://127.0.0.1:1");
    let state = directory.path().join("state");
    fs::create_dir(&state).unwrap();
    let credential = state.join("credential.dpapi");
    fs::write(&credential, [7u8; 128]).unwrap();

    let output = agent(&["run", "--config", &config]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("pair --force"),
        "{}",
        stderr(&output)
    );
    assert!(credential.exists(), "nothing is deleted");
}
