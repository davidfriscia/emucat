# Agent protocol

**Protocol version: 1.** Types live in
[`packages/contracts/src/protocol.ts`](../packages/contracts/src/protocol.ts) and
[`agent/src/protocol.rs`](../agent/src/protocol.rs). Both are tested against
[`fixtures/wire-examples.json`](../packages/contracts/fixtures/wire-examples.json).

For how to run an agent, see [the agent guide](agent.md). The reasoning behind what follows is in
[decision 0009](decisions/0009-agent-pairing-and-credentials.md) and
[decision 0010](decisions/0010-agent-connections-and-discovery.md).

## Pairing

A device-style flow, for an agent with no inbound listener and no GUI. Requests travel over HTTPS. Plain
HTTP is accepted by the agent only for a server on this computer (`localhost`, `127.0.0.0/8`, `::1`). There
is no setting to widen that, and the agent follows no redirects.

```
 Agent                              Server                         Administrator
   │ POST /agent/pairing/requests     │                                  │
   │ ───────────────────────────────▶ │  stores digests of both          │
   │ ◀─── pairingCode, pollingSecret  │                                  │
   │                                  │                                  │
   │ shows the code ──────────────────┼───── read by a person ─────────▶ │
   │                                  │ ◀── POST …/lookup { code } ───── │
   │                                  │ ─── who is asking ─────────────▶ │
   │                                  │ ◀── POST …/approve { code } ──── │  session + CSRF
   │ POST /agent/pairing/poll         │                                  │
   │ Authorization: Bearer <secret>   │                                  │
   │ ───────────────────────────────▶ │  creates the agent, in one       │
   │ ◀─── agentId, credential ─────── │  transaction, exactly once       │
   │ stores it with DPAPI             │                                  │
```

| Value          | Form                                             | Who knows it                | Stored as |
| -------------- | ------------------------------------------------ | --------------------------- | --------- |
| Pairing code   | `ABCD-2345`: 8 symbols of Crockford base32       | Agent, then a person        | SHA-256   |
| Polling secret | `emucat_pairing_` and 256 random bits, base64url | Only the agent              | SHA-256   |
| Credential     | `emucat_agent_` and 256 random bits, base64url   | Only the agent, once issued | SHA-256   |

Rules:

- **A code does not authorize anything by itself.** Approval needs a signed-in administrator, the CSRF token,
  and the code. Knowing a request's ID, or seeing it in the list, is not enough to approve it. Rejecting needs no
  code, because refusing grants nothing.
- **Expiry is checked, not swept.** A request lasts 10 minutes. Every decision compares `expires_at` with the
  database's clock, so an expired row grants nothing whether or not it has been cleaned up. Approval extends a
  request to at least 2 minutes from then, so that the agent has time to collect. Dead rows are removed after 24
  hours.
- **One outcome, one credential.** Approving, rejecting and polling all hold the request's row lock. The agent
  row and credential are created together in the transaction that closes the request, and a unique key allows one
  agent per request. An approved request that is never collected leaves no agent behind.
- **Exactly once.** Later polls answer `consumed`. If the response carrying the credential is lost, the agent
  reports this and must pair again, and the unused agent can be revoked.

Polling answers `pending`, `approved` (with `agentId` and `credential`), `rejected`, `expired` or `consumed`.
An unknown secret gets 401 `invalid_pairing_secret`. For limits, see the [REST API](api.md#agent-pairing).

Re-pairing is always explicit, and creates a **new agent identity**. A revoked identity never returns.

## Transport

The agent opens an outbound WebSocket to `GET /api/v1/agent/ws`, with
`Authorization: Bearer <credential>`. Only text frames holding JSON are accepted, up to 64 KiB. Large
transfers such as media will use authenticated HTTP instead.

A token is never placed in a URL, so it cannot end up in access logs. The server checks the credential before the
handshake, so a client without a valid one gets a plain 401 and never has an open socket.

## Envelope

```json
{
  "protocolVersion": 1,
  "id": "018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65",
  "correlationId": "018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60",
  "sentAt": "2026-01-31T15:30:00Z",
  "type": "agent.hello",
  "payload": {}
}
```

| Field             | Required | Meaning                              |
| ----------------- | -------- | ------------------------------------ |
| `protocolVersion` | Yes      | Version of this protocol             |
| `id`              | Yes      | UUID of this message                 |
| `correlationId`   | No       | `id` of the message this one answers |
| `sentAt`          | Yes      | RFC 3339 timestamp                   |
| `type`            | Yes      | Message type                         |
| `payload`         | Yes      | Depends on `type`                    |

## Messages

| Type                       | From   | Payload                                                      | Response                 |
| -------------------------- | ------ | ------------------------------------------------------------ | ------------------------ |
| `agent.hello`              | Agent  | `agentVersion`, `platform`, `architecture`                   | `server.welcome`         |
| `agent.heartbeat`          | Agent  | Empty                                                        | `server.heartbeat_ack`   |
| `agent.discovery_result`   | Agent  | `operationId`, `hostPlatform`, `emulators`, `vms`, `skipped` |                          |
| `agent.discovery_error`    | Agent  | `operationId`, `code`, `message`                             |                          |
| `server.welcome`           | Server | `agentId`, `heartbeatIntervalSeconds`                        |                          |
| `server.heartbeat_ack`     | Server | Empty                                                        |                          |
| `server.error`             | Server | `code`, `message`                                            |                          |
| `server.discovery_request` | Server | `operationId`                                                | `agent.discovery_result` |

`server.discovery_request` is **the only command** in this version, and it is read-only. It says only which
operation this is: it has no path or option, and the agent refuses one with any extra field, so a server cannot
aim a scan at anything but the configured directories.

## Connections

### Life of a connection

1. The agent connects, with its credential. The identity comes from the credential and nowhere else.
2. The agent sends `agent.hello` within 10 seconds, or is closed with 4408. The server records the version and
   platform, and answers `server.welcome`. **Only now is the agent online.**
3. The agent sends a heartbeat at the interval given in the welcome (30 seconds). Each one moves `last_seen_at`
   and re-checks that the agent has not been revoked.
4. Either side treats silence as a dead connection. The server closes after 75 seconds without traffic. The agent
   reconnects after two intervals and 5 seconds without an acknowledgement.

### Presence

"Online" means this API process holds a live connection on which the agent has said hello. It is held in memory
and **never stored**, so a restart or a crash cannot leave a stale "online" behind: everyone is offline until they
reconnect. `last_connected_at` and `last_seen_at` are stored.

### Duplicate connections

**The newest connection wins**, at the moment its hello is accepted. The older one gets `server.error`
(`superseded`) and close 4409, and any scan on it fails.

Everything keyed by agent checks that the connection concerned is still the active one, so a stale socket that
closes later cannot mark the agent offline. A connection that has not said hello cannot disturb the active one.

An agent that is superseded **stops instead of reconnecting**. Otherwise two running copies with one credential
would take turns replacing each other forever.

### Reconnection

The agent connects out and never listens. After losing a connection it waits, then tries again, indefinitely:

- The delay starts at 1 second, doubles each time, and is capped at 60 seconds.
- Half of each delay is random, so that agents do not all return at the same instant after a server restart.
- A connection that lasted 60 seconds counts as healthy, and the delay starts over.

It stops for good only in these cases, where trying again could not help:

| Reason                                   | Seen as                       |
| ---------------------------------------- | ----------------------------- |
| The credential is revoked or unknown     | 401 at the handshake, or 4401 |
| A newer connection took over             | 4409                          |
| A different protocol version             | 4406                          |
| Asked to stop (Ctrl+C, logoff, shutdown) | Sends close 1000              |

A server error at the handshake (5xx) is not a rejection, so an agent keeps trying through a database outage.

### Revocation

Revoking removes the credential's digest and sets `revoked_at`, then closes every connection of that agent with
`server.error` (`agent_revoked`) and close 4401. A running scan fails. New connections get 401. A revocation made
elsewhere, such as directly in the database, is noticed at the next hello or heartbeat.

The agent's row stays, because catalog history refers to it. Nothing on the agent's computer is deleted: not its
VM files, and not its now-useless credential, which `pair --force` or `unpair` replaces or removes.

## Discovery

1. An administrator asks, and the server sends `server.discovery_request` with a new `operationId`. Concurrent
   requests for one agent share the running operation.
2. The agent scans on its blocking pool, so heartbeats continue, and answers with `agent.discovery_result` or
   `agent.discovery_error`, using the request's `id` as `correlationId`.
3. The administrator reads the result. It is held in memory, for the latest operation per agent only.

An answer counts only if it is for the running operation **and** arrives on the connection that was asked.
Everything else changes nothing:

| Situation                                           | Result                                           |
| --------------------------------------------------- | ------------------------------------------------ |
| No answer in 30 seconds                             | Fails with `timeout`                             |
| Agent disconnects, restarts or is replaced          | Fails with `agent_disconnected`                  |
| Agent is revoked                                    | Fails with `agent_revoked`                       |
| A report fails validation                           | Fails with `malformed_result`; connection stays  |
| A report over 64 KiB                                | Connection closed; fails with `result_too_large` |
| Agent is already scanning                           | Fails with `agent_busy`                          |
| A duplicate or late result, or an unknown operation | Logged and ignored                               |
| A repeated request (agent side)                     | Ignored                                          |

**A report says nothing about which agent sent it,** and any such claim is dropped. Every VM name is checked
against the shared rules and every marker against its emulator. `hostCompatible` is recomputed from the markers
and the platform declared in the connection's hello, rather than believed.

Results never touch `virtual_machines` or `vm_versions`. See [what discovery does](agent.md#discovery).

## Errors

| Situation                            | Result                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Missing, malformed or unknown token  | HTTP 401 before the handshake. No socket opens.                           |
| Not JSON, or not a valid envelope    | `server.error` (`invalid_message`), close 4400                            |
| Binary frame                         | `server.error` (`invalid_message`), close 4400                            |
| Different `protocolVersion`          | `server.error` (`unsupported_protocol_version`), close 4406               |
| Unknown type, or a malformed payload | `server.error` (`unsupported_message`). The connection stays open.        |
| A second `agent.hello`               | `server.error` (`already_greeted`). The connection stays open.            |
| More than 120 messages in a minute   | `server.error` (`too_many_messages`), close 4429                          |
| Larger than 64 KiB                   | Close 1009. The peer may see 1006, since unread data can reset the socket |

An agent ignores anything it cannot use from a server: malformed text, unknown types, and messages only an agent
can send. It never crashes on input, and never acts on it.

## Versioning

A breaking change increments `PROTOCOL_VERSION`, in TypeScript and Rust, along with the fixtures and this
document. The agent can read the server's version from `GET /api/v1/info`, and an unpaired agent with another
version is refused at the pairing request.

Adding a message that older peers can ignore is not breaking. **Milestone 2 added discovery under version 1 for
this reason:** an agent ignores message types it does not know, and no agent had ever connected before. A server
refuses unknown types from an agent, so adding a message an agent sends requires a server that knows it first.

## User authentication

Browser sessions are not part of this protocol. They are described in [authentication](authentication.md) and
the [REST API](api.md). Agent credentials and browser sessions are entirely separate: an agent never holds a
session cookie, and a user's session cannot open this endpoint.

## Planned

- Credential rotation over the authenticated channel.
- More control commands, each validated by the agent against local rules, such as `VmName`, whatever the server
  sends.
