# Agent protocol

**Protocol version: 1.** Types live in
[`packages/contracts/src/protocol.ts`](../packages/contracts/src/protocol.ts) and
[`agent/src/protocol.rs`](../agent/src/protocol.rs). Both are tested against
[`fixtures/wire-examples.json`](../packages/contracts/fixtures/wire-examples.json).

For how to run an agent, see [the agent guide](agent.md). The reasoning behind what follows is in
[decision 0009](decisions/0009-agent-pairing-and-credentials.md),
[decision 0010](decisions/0010-agent-connections-and-discovery.md) and
[decision 0015](decisions/0015-registration-state-machine.md).

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
`Authorization: Bearer <credential>`. Only text frames holding JSON are accepted, up to 64 KiB. Archives never travel here:
agents reach a repository directly. Media will use authenticated HTTP.

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

| Type                               | From   | Payload                                                                                                                                                                                          | Response                                                 |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `agent.hello`                      | Agent  | `agentVersion`, `platform`, `architecture`                                                                                                                                                       | `server.welcome`                                         |
| `agent.heartbeat`                  | Agent  | Empty                                                                                                                                                                                            | `server.heartbeat_ack`                                   |
| `agent.discovery_result`           | Agent  | `operationId`, `hostPlatform`, `emulators`, `vms`, `skipped`                                                                                                                                     |                                                          |
| `agent.discovery_error`            | Agent  | `operationId`, `code`, `message`                                                                                                                                                                 |                                                          |
| `server.welcome`                   | Server | `agentId`, `heartbeatIntervalSeconds`                                                                                                                                                            |                                                          |
| `server.heartbeat_ack`             | Server | Empty                                                                                                                                                                                            |                                                          |
| `server.error`                     | Server | `code`, `message`                                                                                                                                                                                |                                                          |
| `server.discovery_request`         | Server | `operationId`                                                                                                                                                                                    | `agent.discovery_result`                                 |
| `server.registration_request`      | Server | `operationId`, `emulatorType`, `vmName`, `mode`, `repositoryId`, `versionId`, `archiveKey`, and for a snapshot `parentVersionId` and optionally `workspaceId`                                    | `agent.registration_progress`, then a result or an error |
| `server.registration_cancel`       | Server | `operationId`                                                                                                                                                                                    | `agent.registration_error`                               |
| `server.registration_ack`          | Server | `operationId`, `outcome`, `versionId`, `removeLocal`, `deletePublished`                                                                                                                          |                                                          |
| `server.repository_health_request` | Server | `operationId`, `repositoryId`                                                                                                                                                                    | `agent.repository_health_result`                         |
| `agent.registration_sync`          | Agent  | `operations`: `operationId`, `phase`; `snapshots`                                                                                                                                                |                                                          |
| `agent.registration_progress`      | Agent  | `operationId`, `stage`, `doneBytes`, `totalBytes`                                                                                                                                                |                                                          |
| `agent.registration_result`        | Agent  | `operationId`, `versionId`, `archiveKey`, `archiveSizeBytes`, `archiveSha256`, `manifestVersion`, `manifestSha256`, `fileCount`, `totalUncompressedBytes`                                        | `server.registration_ack`                                |
| `agent.registration_error`         | Agent  | `operationId`, `code`, `message`                                                                                                                                                                 | `server.registration_ack`                                |
| `agent.registration_cleanup`       | Agent  | `operationId`, `versionId`, `localCopy`, `code`, `message`                                                                                                                                       | `server.registration_ack`                                |
| `agent.repository_health_result`   | Agent  | `operationId`, `repositoryId`, `ok`, `code`, `message`, `configuration`, `hostKeyFingerprint`, `freeBytes`                                                                                       |                                                          |
| `server.restore_request`           | Server | `operationId`, `emulatorType`, `vmName`, `repositoryId`, `versionId`, `archiveKey`, `archiveSizeBytes`, `archiveSha256`, `manifestSha256`, `expectedUncompressedBytes`, optionally `workspaceId` | `agent.restore_progress`, then a result or an error      |
| `server.restore_cancel`            | Server | `operationId`                                                                                                                                                                                    | `agent.restore_error`                                    |
| `server.restore_ack`               | Server | `operationId`, `outcome`                                                                                                                                                                         |                                                          |
| `agent.restore_sync`               | Agent  | `operations`, `capabilities`, `localCopies`, `workspaces`                                                                                                                                        |                                                          |
| `agent.restore_progress`           | Agent  | `operationId`, `stage`, `doneBytes`, `totalBytes`, `cacheHit`                                                                                                                                    |                                                          |
| `agent.restore_result`             | Agent  | `operationId`, `versionId`, `archiveSizeBytes`, `archiveSha256`, `manifestVersion`, `manifestSha256`, `fileCount`, `totalUncompressedBytes`, `localDirectory`, `cache`                           | `server.restore_ack`                                     |
| `agent.restore_error`              | Agent  | `operationId`, `code`, `message`                                                                                                                                                                 | `server.restore_ack`                                     |
| `server.workspace_discard`         | Server | `workspaceId`, `emulatorType`, `vmName`                                                                                                                                                          | `agent.workspace_discard_result`                         |
| `agent.workspace_discard_result`   | Agent  | `workspaceId`, `removed`, `code`, `message`                                                                                                                                                      |                                                          |

Commands say which identities are involved, and never where anything is. They have no path, host or option, and the agent
refuses one with any extra field, so a server cannot aim a scan or a transfer at anything but what the agent's own
configuration names.

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

## Registration

```
 Administrator            Server                       Agent                      Repository
   │ POST /admin/registrations │                          │                            │
   │ ────────────────────────▶ │ creates the operation    │                            │
   │                           │ and issues its version   │                            │
   │                           │ ── registration_request ▶│ checks the VM              │
   │                           │ ◀─ registration_progress │ builds ZIP and manifest    │
   │                           │                          │ ── upload to staging ────▶ │
   │                           │                          │ ◀─ read back and hash ──── │
   │                           │                          │ ── publish, no overwrite ▶ │
   │                           │ ◀── registration_result  │                            │
   │                           │ commits VM and master,   │                            │
   │                           │ in one transaction       │                            │
   │                           │ ── registration_ack ───▶ │ copy: keeps the VM         │
   │                           │    committed             │ transfer: checks, removes  │
   │                           │ ◀─ registration_cleanup  │                            │
   │                           │ ── registration_ack ───▶ │ forgets the operation      │
   │                           │    closed                │                            │
```

**The server creates an operation only if** an administrator asked, with the session and CSRF token; the agent is online and
not revoked; the agent can register; it may use the repository, which is enabled; the VM is not in the catalog; nothing else is
running for this VM or on this agent; and the VM is in that agent's latest discovery, from its current connection, less than 15
minutes old, spelled exactly as discovered.

**The agent checks for itself** that the repository is in its own configuration, that the archive key is the one that follows
from the VM and version, that the VM's directory is an exact immediate child of the base path, not a link, and has a marker, and
that a transfer of a VM with screenshots is something it can prove safe. See [the media guide](media.md#transfers).

**A report authorizes nothing.** It counts only from the operation's own agent, on its active connection, with the identities the
server issued. Stages only move forward, and an agent's report can never set a state the server decides.

**Every report is repeated until it is answered,** on each heartbeat and after each welcome, and the server handles a repeat
idempotently. When the server cannot record something it does not answer, which is how a failed commit recovers.

| `server.registration_ack` | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `committed`               | The master exists. `removeLocal` is true only for a transfer that is still in its cleanup step |
| `rejected`                | There is no master. `deletePublished` says that nothing refers to the published archive        |
| `closed`                  | The server has everything. The agent removes its journal                                       |

**After each welcome, the agent sends `agent.registration_sync`,** listing its journals. See
[decision 0015](decisions/0015-registration-state-machine.md#reports-repeat-until-answered). Being able to send it also says
that the agent can register, so a server does not send registration requests to an older agent.

Progress reports are thinned out to one per two seconds, and carry only what was measured: no total, no percentage.

### Retrying a blocked removal

A transfer whose removal a screenshot blocked ends as `partial_success`. The agent keeps its journal, in the phase `media_blocked`, which
it lists in `agent.registration_sync`. If an administrator asks, the server moves the operation back to `cleaning_local` and sends
`server.registration_retry_cleanup`, which holds the operation and version IDs. The agent then runs every check again, and reports as usual.
If the message is lost, the next sync that lists the operation as blocked while the server has it in `cleaning_local` brings it again.

### Repository health

The agent runs the check described in [the repository guide](repositories.md#7-test-the-connection), and reports its settings for
that repository, without anything secret. The server compares them with its own record, and reports a difference. An answer
counts only for the check in progress, from the agent it was asked of. A check that gets no answer in two minutes fails.

## Restore

A command that restores a master. As with every other command, it names identities and never a place: there is no field for a path or a host, the agent refuses a request with any extra field, it recomputes the key from the VM and the version,
and it decides where the VM goes from its own base path. The full lifecycle is in [decision 0021](decisions/0021-restore-lifecycle.md).

1. After each welcome, the agent sends `agent.restore_sync`. Its `capabilities` say which emulators have a base path, which repositories have local settings, and how the cache is doing. An agent that never sends it cannot restore. Its `operations` are its journals,
   which the server compares with its own view, as for registration. Its `localCopies` say `unverified`, `modified` or `absent` about each local copy it knows of.
2. The server sends `server.restore_request`, and the agent answers with `agent.restore_progress` for each stage: `validating`, `downloading`, `verifying`, `extracting`, `publishing_local`. Only real measurements are sent, and without a known total there is no total.
3. It ends with `agent.restore_result` or `agent.restore_error`, repeated on each heartbeat and after each welcome, until `server.restore_ack` answers it. `closed` means that the server has recorded everything. `rejected` means it does not recognize the operation.
   **Neither ever asks the agent to delete a VM,** and no message can.
4. `server.restore_cancel` asks it to stop. It has no effect once publication has begun, and a result that arrives after a cancellation is still recorded, since the directory exists.

## Execution and verification

Running a VM, and verifying a local copy. Commands name identities only; the agent builds every command line itself, refuses unknown fields, and checks conflicts again before acting. See [the launcher guide](launcher.md) and decisions 0028 to 0033.

1. After each welcome, the agent sends `agent.execution_sync`: every session it has a journal for, what it can launch (`capabilities.emulators`, each `launchable` or with its `problem`, and `capabilities.modes`), and the verifications it has not closed. An agent that never sends it cannot launch or verify.
2. `server.vm_launch` names a session, a VM and a mode. A repeated launch for a known session is answered with its state. The agent answers with `agent.vm_execution_status`: `starting`, `running`, `stopping`, and in the end `stopped`, `exited` or `failed`, or `unknown` when it cannot tell. Each carries the PID and the process's creation time once known.
3. `server.vm_stop` asks for a stop. `force` is only ever set after an administrator typed the VM's name.
4. A terminal status is repeated on each heartbeat until `server.vm_execution_ack`. The same acknowledgement for an `unknown` session is an administrator's dismissal.
5. `server.vm_verify` names a master: version, repository, archive key, size and SHA-256, and the manifest's SHA-256. The agent answers with `agent.vm_verify_result`, repeated until `server.vm_verify_ack`.

Remote launches carry `workspaceId` and run only that working copy, and only in the mode its purpose names: anything else is refused (`workspace_purpose_mismatch`, or `execution_mode_unavailable` for a mode the agent does not run), and never started locally. An agent advertises `remote_volatile` and `remote_snapshot` in `capabilities.modes`.

## Snapshots and working copies

Milestone 7, decisions [0037](decisions/0037-snapshots-as-registrations.md), [0038](decisions/0038-remote-snapshot-working-copies.md) and [0040](decisions/0040-temporary-remote-sessions.md). Nothing here is a new pipeline: a snapshot is a registration with `mode: "snapshot"`, and a working copy is prepared by a restore and run by a session.

1. `agent.registration_sync` says `snapshots: true` on an agent that can create them; the server sends snapshot requests to no other. `agent.restore_sync` lists the working copies the agent holds as `workspaces`; saying so is also what marks it as able to keep them.
2. A snapshot request names its `parentVersionId`, and only a snapshot does: a request whose mode and parent disagree fails to decode, and is answered as invalid. The agent refuses a parent its own record of the local copy contradicts, with `snapshot_parent_mismatch`. Everything after that is a copy registration's, and the answer to its result never has `removeLocal` for a snapshot. Even if it did, the agent would not remove anything.
3. A `workspaceId` on a restore puts the VM under `{state_dir}/workspaces/{workspaceId}`, with the `workspacePurpose` the agent records beside it, and on a snapshot reads it from there. Neither touches the persistent copy or its state. The agent refuses to snapshot a `remote_volatile` working copy.
4. `server.workspace_discard` asks for a working copy's removal. The agent refuses while anything runs or works on the VM, and answers once; a lost request or answer is reconciled from the next `agent.restore_sync`.
5. A restore with `replace` replaces the persistent copy: the agent advertises `replaceLocal` in its restore capabilities, checks that nothing runs, that the directory is the one its lineage record names and is that `expectedVersionId`, and, unless `discardLocalChanges`, that it matches that version's manifest. It then publishes with a journaled, no-replace swap (`.emucat-replaced-{operation}` beside the VM) that a restart completes or rolls back.

## Screenshots

Screenshot bytes never travel over this connection, and only a status does: see [the REST routes](api.md#agent-media).

`agent.media_sync_status` is sent after each welcome and at most every 5 seconds after a change. It holds up to 100 VMs, each with counts
of `pending`, `uploading`, `synchronized` and `failed`, and the latest error, and it says `truncated` if they did not all fit. The server only
shows it. Nothing decides anything on it, and only the HTTP acknowledgement route can prove that a screenshot is stored.

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

Adding a message that older peers can ignore is not breaking. **Milestones 2 and 3 added discovery and registration
under version 1 for this reason:** an agent ignores message types it does not know. A server refuses unknown types from an
agent, so adding a message an agent sends requires a server that knows it first. A server only registers through an agent that
has shown it can, with `agent.registration_sync`. **Milestone 5 added restoring the same way:** a server only restores through an agent that has sent `agent.restore_sync`.

## User authentication

Browser sessions are not part of this protocol. They are described in [authentication](authentication.md) and
the [REST API](api.md). Agent credentials and browser sessions are entirely separate: an agent never holds a
session cookie, and a user's session cannot open this endpoint.

## Planned

- Credential rotation over the authenticated channel.
- More control commands, each validated by the agent against local rules, such as `VmName`, whatever the server
  sends: deleting versions.
