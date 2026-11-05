//! Pairing and discovery rules against the fixtures shared with the TypeScript contracts.

use emucat_agent::discovery::{display_name, host_compatibility};
use emucat_agent::emulators::EmulatorType;
use emucat_agent::pairing::{format_pairing_code, normalize_pairing_code};
use emucat_agent::platform::Platform;
use emucat_agent::protocol::{Decoded, Envelope, Message, decode};
use serde::Deserialize;
use serde_json::Value;

const PAIRING_CODES: &str = include_str!("../../packages/contracts/fixtures/pairing-codes.json");
const DISCOVERY_RULES: &str =
    include_str!("../../packages/contracts/fixtures/discovery-rules.json");
const WIRE_EXAMPLES: &str = include_str!("../../packages/contracts/fixtures/wire-examples.json");

fn wire(name: &str) -> Value {
    let all: Value = serde_json::from_str(WIRE_EXAMPLES).unwrap();
    all[name].clone()
}

#[test]
fn pairing_codes_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    struct Valid {
        input: String,
        canonical: String,
        formatted: String,
    }
    #[derive(Deserialize)]
    struct Fixture {
        valid: Vec<Valid>,
        invalid: Vec<String>,
    }
    let fixture: Fixture = serde_json::from_str(PAIRING_CODES).unwrap();
    assert!(!fixture.valid.is_empty() && !fixture.invalid.is_empty());
    for case in &fixture.valid {
        assert_eq!(
            normalize_pairing_code(&case.input).as_deref(),
            Some(case.canonical.as_str()),
            "{:?}",
            case.input
        );
        assert_eq!(format_pairing_code(&case.canonical), case.formatted);
    }
    for input in &fixture.invalid {
        assert_eq!(normalize_pairing_code(input), None, "{input:?}");
    }
}

#[test]
fn discovery_rules_match_the_shared_fixtures() {
    #[derive(Deserialize)]
    struct Compatibility {
        emulator: EmulatorType,
        markers: Vec<String>,
        host: Platform,
        compatible: Option<bool>,
    }
    #[derive(Deserialize)]
    struct SkippedName {
        raw: String,
        display: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        host_compatibility: Vec<Compatibility>,
        skipped_names: Vec<SkippedName>,
    }
    let fixture: Fixture = serde_json::from_str(DISCOVERY_RULES).unwrap();
    assert!(!fixture.host_compatibility.is_empty());
    for case in &fixture.host_compatibility {
        assert_eq!(
            host_compatibility(case.emulator, &case.markers, case.host),
            case.compatible,
            "{:?} on {:?}",
            case.markers,
            case.host
        );
    }
    assert!(!fixture.skipped_names.is_empty());
    for case in &fixture.skipped_names {
        assert_eq!(display_name(&case.raw), case.display, "{:?}", case.raw);
    }
}

#[test]
fn new_protocol_messages_round_trip() {
    for name in [
        "serverHeartbeatAck",
        "serverDiscoveryRequest",
        "agentDiscoveryResult",
        "agentDiscoveryError",
    ] {
        let value = wire(name);
        let message: Envelope = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&message).unwrap(), value, "{name}");
    }
}

#[test]
fn the_decoder_reads_the_shared_examples() {
    let text = wire("serverDiscoveryRequest").to_string();
    let Decoded::Message(envelope) = decode(&text) else {
        panic!("not decoded");
    };
    assert!(matches!(
        envelope.message,
        Message::ServerDiscoveryRequest(_)
    ));
}

#[test]
fn a_discovery_request_with_anything_extra_is_invalid() {
    let mut value = wire("serverDiscoveryRequest");
    value["payload"]["basePath"] = Value::from("C:\\Windows");
    let decoded = decode(&value.to_string());
    let Decoded::InvalidPayload {
        message_type,
        operation_id,
    } = decoded
    else {
        panic!("{decoded:?}");
    };
    assert_eq!(message_type, "server.discovery_request");
    assert!(operation_id.is_some());
}

#[test]
fn an_invalid_vm_name_cannot_be_decoded_from_a_report() {
    let mut value = wire("agentDiscoveryResult");
    value["payload"]["vms"][0]["vmName"] = Value::from("../evil");
    assert!(serde_json::from_value::<Envelope>(value).is_err());
}
