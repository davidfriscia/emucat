# Agent protocol

**Protocol version: 1.** Types live in
[`packages/contracts/src/protocol.ts`](../packages/contracts/src/protocol.ts) and
[`agent/src/protocol.rs`](../agent/src/protocol.rs). Both are tested against
[`fixtures/wire-examples.json`](../packages/contracts/fixtures/wire-examples.json).

Milestone 0 has the server side of this endpoint. The agent defines the message types and the address,
but does not connect yet.

## Transport

The agent opens an outbound WebSocket to `GET /api/v1/agent/ws`, with
`Authorization: Bearer <token>`. Only text frames holding JSON are accepted, up to 64 KiB. Large
transfers such as media use authenticated HTTP instead.

A token is never placed in a URL, so it cannot end up in access logs.

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

| Type                   | From   | Payload                                    | Response               |
| ---------------------- | ------ | ------------------------------------------ | ---------------------- |
| `agent.hello`          | Agent  | `agentVersion`, `platform`, `architecture` | `server.welcome`       |
| `agent.heartbeat`      | Agent  | Empty                                      | `server.heartbeat_ack` |
| `server.welcome`       | Server | `agentId`, `heartbeatIntervalSeconds`      |                        |
| `server.heartbeat_ack` | Server | Empty                                      |                        |
| `server.error`         | Server | `code`, `message`                          |                        |

There are deliberately **no control commands** in this version.

## Errors

| Situation                            | Result                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| Missing, malformed or unknown token  | HTTP 401 before the handshake. No socket opens.                    |
| Not JSON, or not a valid envelope    | `server.error` (`invalid_message`), close 4400                     |
| Binary frame                         | `server.error` (`invalid_message`), close 4400                     |
| Different `protocolVersion`          | `server.error` (`unsupported_protocol_version`), close 4406        |
| Unknown type, or a malformed payload | `server.error` (`unsupported_message`). The connection stays open. |
| Larger than 64 KiB                   | Close 1009                                                         |

## Versioning

A breaking change increments `PROTOCOL_VERSION`. The agent can read the server's version from
`GET /api/v1/info` before connecting. Additive changes that older peers can ignore may be made without
a version change, but note that a server refuses unknown message types.

## Authentication: current state

The endpoint is authenticated, and fails closed. A bearer token is hashed with SHA-256 and looked up in
`agents.credential_hash`, excluding revoked agents. Since pairing does not exist, no agent has a
credential, so **every connection is currently rejected**. The tests exercise the authenticated path
with an injected authenticator and with rows inserted directly into a test database.

## Planned: user authentication

Not implemented. The login page is a placeholder and there are no users or default credentials.

1. A first administrator is created by an explicit setup step, not by a seeded account.
2. Passwords are stored in `users.password_hash` using a memory-hard algorithm (Argon2id).
3. Logging in creates a random session token. The browser receives it in a `Secure`, `HttpOnly`,
   `SameSite` cookie. The database stores only its SHA-256 digest in `user_sessions.token_hash`.
4. Sessions expire, can be revoked, and are checked on every request. State-changing requests are
   protected against CSRF.

## Planned: agent pairing

Not implemented. A device-style flow fits an agent that has no inbound listener and no GUI:

1. The agent starts unpaired and calls an unauthenticated pairing endpoint over HTTPS with its name,
   platform and architecture.
2. The server creates a pending request, which has a high-entropy secret known only to the agent and a
   short, human-readable code. It expires within minutes and is rate limited.
3. The agent displays the code. A signed-in user enters it in the web app, reviews the agent's details
   and approves it. Approval sets `agents.owner_user_id` and `paired_at`.
4. The agent polls with its secret, and on approval receives a long, random credential exactly once.
   The server stores only the digest in `agents.credential_hash`.
5. The agent stores the credential with the operating system's protection (DPAPI on Windows, Keychain
   on macOS, Secret Service or a restricted file on Linux), never in the configuration file.

Afterwards:

- Revoking sets `agents.revoked_at`. The server rejects the credential and closes any open connection.
- Rotation issues a new credential over the authenticated channel.
- Non-local servers must use `https`/`wss`. The agent already warns about remote `http` URLs.
- Control commands will be added only after this exists. The agent will accept commands solely over its
  authenticated connection to its configured server, and will validate each against local rules, such
  as `VmName`, regardless of what the server sends.
