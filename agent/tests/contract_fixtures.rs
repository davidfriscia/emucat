//! Runs the Rust domain code against the fixtures shared with the TypeScript contracts, so the two
//! implementations cannot drift apart silently.

use emucat_agent::archives::{
    SnapshotTimestamp, VersionError, VersionId, VmVersion, archive_object_key,
    format_snapshot_name, is_excluded_from_archive, parse_snapshot_name,
};
use emucat_agent::emulators::{
    EmulatorType, VmIdentity, VmName, VmRootEntry, is_valid_vm_root, validate_vm_name,
};
use emucat_agent::filesystem::{parse_vm_relative_path, vm_directory};
use emucat_agent::media::{MediaVisibility, is_watched_media_path};
use emucat_agent::protocol::{Decoded, Envelope, Message, PROTOCOL_VERSION, decode};
use emucat_agent::state::{AgentVmState, ContentStatus};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

const VM_NAMES: &str = include_str!("../../packages/contracts/fixtures/vm-names.json");
const SNAPSHOT_NAMES: &str = include_str!("../../packages/contracts/fixtures/snapshot-names.json");
const ARCHIVE_PATHS: &str = include_str!("../../packages/contracts/fixtures/archive-paths.json");
const VM_ROOTS: &str = include_str!("../../packages/contracts/fixtures/vm-roots.json");
const WIRE_EXAMPLES: &str = include_str!("../../packages/contracts/fixtures/wire-examples.json");

fn wire(name: &str) -> Value {
    let all: Value = serde_json::from_str(WIRE_EXAMPLES).unwrap();
    all[name].clone()
}

fn time(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &Rfc3339).unwrap()
}

#[test]
fn vm_names_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    struct Invalid {
        name: String,
        code: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        valid: Vec<String>,
        invalid: Vec<Invalid>,
        same_identity: Vec<(String, String)>,
    }
    let fixture: Fixture = serde_json::from_str(VM_NAMES).unwrap();

    for name in &fixture.valid {
        assert_eq!(validate_vm_name(name), Ok(()), "{name:?} should be valid");
    }
    assert!(!fixture.invalid.is_empty());
    for Invalid { name, code } in &fixture.invalid {
        let error = validate_vm_name(name).expect_err(name);
        assert_eq!(error.code(), code, "wrong code for {name:?}");
    }
    for (a, b) in &fixture.same_identity {
        assert_eq!(VmName::new(a.clone()), VmName::new(b.clone()));
    }
}

#[test]
fn vm_name_keeps_its_spelling_and_refuses_invalid_json() {
    let name: VmName = serde_json::from_str("\"Win98\"").unwrap();
    assert_eq!(name.as_str(), "Win98");
    assert_eq!(name.key(), "win98");
    assert_eq!(serde_json::to_string(&name).unwrap(), "\"Win98\"");
    assert!(serde_json::from_str::<VmName>("\"../evil\"").is_err());
}

#[test]
fn identity_includes_the_emulator() {
    let identity = |emulator_type, name: &str| VmIdentity {
        emulator_type,
        vm_name: VmName::new(name).unwrap(),
    };
    assert_ne!(
        identity(EmulatorType::Qemu, "a"),
        identity(EmulatorType::Box86, "a")
    );
    assert_eq!(
        identity(EmulatorType::Qemu, "a"),
        identity(EmulatorType::Qemu, "A")
    );
}

#[test]
fn vm_directory_is_directly_under_the_base_path() {
    let base = Path::new("base");
    let name = VmName::new("Win98").unwrap();
    assert_eq!(vm_directory(base, &name), base.join("Win98"));
}

#[test]
fn emulator_types_serialize_as_in_the_contracts() {
    assert_eq!(
        serde_json::to_value(EmulatorType::Box86).unwrap(),
        Value::from("86box")
    );
    assert_eq!(
        serde_json::to_value(EmulatorType::Qemu).unwrap(),
        Value::from("qemu")
    );
    for invalid in ["86Box", "QEMU", "vmware", ""] {
        assert!(invalid.parse::<EmulatorType>().is_err(), "{invalid}");
        assert!(serde_json::from_value::<EmulatorType>(Value::from(invalid)).is_err());
    }
}

#[test]
fn vm_roots_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        name: String,
        is_file: bool,
    }
    #[derive(Deserialize)]
    struct Case {
        emulator: EmulatorType,
        entries: Vec<Entry>,
        valid: bool,
    }
    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }
    let fixture: Fixture = serde_json::from_str(VM_ROOTS).unwrap();
    assert!(!fixture.cases.is_empty());
    for case in fixture.cases {
        let entries: Vec<VmRootEntry> = case
            .entries
            .into_iter()
            .map(|entry| VmRootEntry {
                name: entry.name,
                is_file: entry.is_file,
            })
            .collect();
        assert_eq!(
            is_valid_vm_root(case.emulator, &entries),
            case.valid,
            "{:?} {entries:?}",
            case.emulator
        );
    }
}

#[test]
fn snapshot_names_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Valid {
        name: String,
        vm_name: String,
        timestamp: SnapshotTimestamp,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Formatted {
        vm_name: String,
        at: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct Fixture {
        valid: Vec<Valid>,
        invalid: Vec<String>,
        formatted: Vec<Formatted>,
    }
    let fixture: Fixture = serde_json::from_str(SNAPSHOT_NAMES).unwrap();

    for case in &fixture.valid {
        let parsed = parse_snapshot_name(&case.name).expect(&case.name);
        assert_eq!(parsed.vm_name.as_str(), case.vm_name);
        assert_eq!(parsed.timestamp, case.timestamp);
    }
    for name in &fixture.invalid {
        assert_eq!(
            parse_snapshot_name(name),
            None,
            "{name:?} should be invalid"
        );
    }
    for case in &fixture.formatted {
        let vm_name = VmName::new(case.vm_name.clone()).unwrap();
        assert_eq!(
            format_snapshot_name(&vm_name, time(&case.at)).unwrap(),
            case.name
        );
    }
}

#[test]
fn snapshot_name_refuses_times_before_1970() {
    let vm_name = VmName::new("a").unwrap();
    assert!(format_snapshot_name(&vm_name, time("1969-12-31T23:59:00Z")).is_err());
}

#[test]
fn archive_paths_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    struct Case {
        emulator: EmulatorType,
        path: String,
        excluded: bool,
        watched: bool,
    }
    #[derive(Deserialize)]
    struct Fixture {
        unsafe_paths: Vec<String>,
        cases: Vec<Case>,
    }
    let mut value: Value = serde_json::from_str(ARCHIVE_PATHS).unwrap();
    value["unsafe_paths"] = value["unsafe"].take();
    let fixture: Fixture = serde_json::from_value(value).unwrap();

    assert!(!fixture.unsafe_paths.is_empty());
    for path in &fixture.unsafe_paths {
        assert!(parse_vm_relative_path(path).is_err(), "{path:?}");
        assert!(is_excluded_from_archive(EmulatorType::Qemu, path).is_err());
        assert!(!is_watched_media_path(EmulatorType::Qemu, path));
    }
    for case in &fixture.cases {
        assert_eq!(
            is_excluded_from_archive(case.emulator, &case.path).unwrap(),
            case.excluded,
            "excluded: {} {}",
            case.emulator,
            case.path
        );
        assert_eq!(
            is_watched_media_path(case.emulator, &case.path),
            case.watched,
            "watched: {} {}",
            case.emulator,
            case.path
        );
    }
}

#[test]
fn media_is_private_by_default() {
    assert_eq!(MediaVisibility::default(), MediaVisibility::Private);
    assert_eq!(
        serde_json::to_value(MediaVisibility::Published).unwrap(),
        Value::from("published")
    );
}

#[test]
fn versions_round_trip_and_validate() {
    for name in ["masterVersion", "snapshotVersion"] {
        let value = wire(name);
        let version: VmVersion = serde_json::from_value(value.clone()).unwrap();
        version.validate().unwrap();
        assert_eq!(serde_json::to_value(&version).unwrap(), value, "{name}");
    }
}

#[test]
fn version_rules_are_enforced() {
    let master: VmVersion = serde_json::from_value(wire("masterVersion")).unwrap();
    let snapshot: VmVersion = serde_json::from_value(wire("snapshotVersion")).unwrap();

    let mut version = master.clone();
    version.parent_version_id = Some(snapshot.id);
    assert_eq!(version.validate(), Err(VersionError::InvalidMaster));

    let mut version = snapshot.clone();
    version.parent_version_id = None;
    assert_eq!(version.validate(), Err(VersionError::InvalidSnapshot));

    let mut version = snapshot.clone();
    version.parent_version_id = Some(version.id);
    assert_eq!(version.validate(), Err(VersionError::OwnParent));

    let mut version = snapshot.clone();
    version.snapshot_name = Some("Other_202601311530".to_owned());
    assert_eq!(version.validate(), Err(VersionError::SnapshotNameMismatch));

    let mut version = master;
    version.archive_sha256 = "ABC".to_owned();
    assert_eq!(version.validate(), Err(VersionError::InvalidHash));
}

#[test]
fn version_ids_are_collision_safe_and_independent_of_names() {
    let identity = VmIdentity {
        emulator_type: EmulatorType::Qemu,
        vm_name: VmName::new("Win98").unwrap(),
    };
    let (a, b) = (VersionId::new(), VersionId::new());
    assert_ne!(a, b);
    assert_ne!(
        archive_object_key(&identity, a),
        archive_object_key(&identity, b)
    );
    let id = VersionId(Uuid::parse_str("018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60").unwrap());
    assert_eq!(
        archive_object_key(&identity, id),
        "archives/qemu/win98/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60.zip"
    );
    assert_eq!(
        wire("masterVersion")["archiveKey"],
        Value::from(archive_object_key(&identity, id))
    );
}

#[test]
fn agent_state_round_trips() {
    let value = wire("agentVmState");
    let state: AgentVmState = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(state.content_status, ContentStatus::Unverified);
    assert_eq!(serde_json::to_value(&state).unwrap(), value);
}

#[test]
fn offline_changes_invalidate_a_verification() {
    let mut state: AgentVmState = serde_json::from_value(wire("agentVmState")).unwrap();
    let connected = time("2026-02-01T00:00:00Z");
    assert!(!state.is_content_trusted(connected));

    state.content_status = ContentStatus::Verified;
    state.last_verified_at = Some(time("2026-01-31T00:00:00Z"));
    assert!(!state.is_content_trusted(connected));

    state.last_verified_at = Some(time("2026-02-01T00:00:01Z"));
    assert!(state.is_content_trusted(connected));

    state.content_status = ContentStatus::Modified;
    assert!(!state.is_content_trusted(connected));
}

#[test]
fn protocol_messages_round_trip() {
    for name in [
        "agentHello",
        "agentHeartbeat",
        "serverWelcome",
        "serverError",
    ] {
        let value = wire(name);
        let envelope: Envelope = serde_json::from_value(value.clone()).expect(name);
        assert_eq!(envelope.protocol_version, PROTOCOL_VERSION);
        assert_eq!(serde_json::to_value(&envelope).unwrap(), value, "{name}");
    }
    let hello: Envelope = serde_json::from_value(wire("agentHello")).unwrap();
    assert!(matches!(hello.message, Message::AgentHello(_)));
}

#[test]
fn protocol_refuses_unknown_messages() {
    let mut value = wire("agentHello");
    value["type"] = Value::from("vm.launch");
    assert!(serde_json::from_value::<Envelope>(value).is_err());

    let mut value = wire("agentHeartbeat");
    value["payload"] = serde_json::json!({ "unexpected": true });
    assert!(serde_json::from_value::<Envelope>(value).is_err());
}

#[test]
fn registration_messages_match_the_shared_fixtures() {
    let wire: serde_json::Value = serde_json::from_str(WIRE_EXAMPLES).unwrap();
    for key in ["registrationServerMessages", "registrationAgentMessages"] {
        for example in wire[key].as_array().unwrap() {
            let text = example.to_string();
            let Decoded::Message(envelope) = decode(&text) else {
                panic!("{key}: {text} should decode");
            };
            // It reads back with the same meaning, whichever optional fields were left out.
            let again = serde_json::to_value(&*envelope).unwrap();
            assert_eq!(again["type"], example["type"]);
            assert_eq!(
                again["payload"]["operationId"],
                example["payload"]["operationId"]
            );
        }
    }
    for example in wire["registrationRefusedByTheAgent"].as_array().unwrap() {
        let text = example.to_string();
        assert!(
            matches!(decode(&text), Decoded::InvalidPayload { .. }),
            "{text} must be refused"
        );
    }
}
