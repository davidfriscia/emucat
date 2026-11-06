# REST API

Everything is under `/api/v1` and speaks JSON, apart from image files. Request and response shapes are
Zod schemas in [`packages/contracts`](../packages/contracts): [`auth.ts`](../packages/contracts/src/auth.ts),
[`catalog.ts`](../packages/contracts/src/catalog.ts) and [`registration.ts`](../packages/contracts/src/registration.ts). The agent's WebSocket is described in the
[protocol](protocol.md).

## Conventions

**Errors** all have one shape, with a stable `code` for programs and a `requestId` for the logs:

```json
{
  "error": { "code": "validation_failed", "message": "Request validation failed", "requestId": "…" }
}
```

| Status | Code                                                        | Meaning                                        |
| ------ | ----------------------------------------------------------- | ---------------------------------------------- |
| 400    | `validation_failed`                                         | Bad body, query or path. `details` says what.  |
| 401    | `unauthenticated`                                           | No live session                                |
| 401    | `invalid_credentials`                                       | Wrong sign-in, always with the same message    |
| 403    | `csrf_rejected`, `cross_origin_rejected`                    | See [authentication](authentication.md#csrf)   |
| 403    | `forbidden`                                                 | Signed in, but not an administrator            |
| 403    | `invalid_setup_token`, `invalid_current_password`           |                                                |
| 401    | `invalid_pairing_secret`                                    | Polling with an unknown secret                 |
| 404    | `vm_not_found`, `media_not_found`, `session_not_found`      | A private item looks the same as a missing one |
| 404    | `agent_not_found`, `pairing_not_found`                      |                                                |
| 404    | `pairing_code_invalid`                                      | Wrong, malformed and unknown codes alike       |
| 409    | `pairing_already_decided`, `agent_offline`, `agent_revoked` |                                                |
| 410    | `pairing_expired`                                           |                                                |
| 404    | `not_found`                                                 | No such route                                  |
| 409    | `setup_completed`                                           | Setup has already happened                     |
| 429    | `rate_limited`, `pairing_capacity`                          | See the `Retry-After` header                   |
| 500    | `internal_error`                                            | Details are in the server log only             |

**Unknown fields are rejected** in every request body and query string.

**State-changing requests** on session routes need the `X-CSRF-Token` header, and every state-changing
request must come from the same origin if it comes from a browser.

**VM paths** use the identity: `:emulatorType` is `86box` or `qemu`, and `:vmName` follows the
[VM name rules](domain-model.md#vm-names), URL-encoded. Lookup ignores case, and responses always carry the
registered spelling.

**Listings** take `page` (from 1), `pageSize` (1 to 100, default 24), `q` (up to 100 characters, plain text
matched against display name, VM name and description) and `emulatorType`. They return `items` and
`pagination` (`page`, `pageSize`, `total`, `totalPages`), sorted by title.

## Setup and authentication

| Method and path                        | Auth    | Purpose                                                |
| -------------------------------------- | ------- | ------------------------------------------------------ |
| `GET /setup/status`                    | None    | `{ setupRequired }`                                    |
| `POST /setup`                          | Token   | Creates the first administrator and signs them in. 201 |
| `POST /auth/login`                     | None    | `{ username, password }`. Sets the session cookie      |
| `GET /auth/session`                    | None    | `{ session }`, which is `null` when not signed in      |
| `GET /auth/me`                         | Session | The current user, CSRF token and session expiry        |
| `POST /auth/logout`                    | Session | Revokes this session and clears the cookie. 204        |
| `GET /account/sessions`                | Session | This user's active sessions                            |
| `DELETE /account/sessions/:sessionId`  | Session | Revokes one of them. 204                               |
| `POST /account/sessions/revoke-others` | Session | Revokes all but this one                               |
| `POST /account/password`               | Session | `{ currentPassword, newPassword }`. Revokes the others |

## Public catalog

No authentication. Only public VMs and published media ever appear here, and responses never contain
filenames, hashes, storage keys, attribution, agent state or repository details. Responses may be stored but
must be revalidated (`Cache-Control: no-cache`), so making something private takes effect immediately.

| Method and path                               | Returns                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /catalog/vms`                            | `items` of `{ emulatorType, vmName, displayName, summary, mainImage }` |
| `GET /catalog/vms/:emulatorType/:vmName`      | Adds `description` and `gallery`; `summary` goes                       |
| `GET /catalog/media/:mediaId/thumbnail\|full` | The JPEG                                                               |

`mainImage` is `{ id, widthPx, heightPx }`, or `null` meaning "show the placeholder". `displayName` may be
`null`, in which case the title is the VM name (`vmTitle` in the contracts). `summary` is the first 240
characters of the description.

## Administration

Requires a session with the `admin` role. Responses are `Cache-Control: no-store`.

| Method and path                                                       | Purpose                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `GET /admin/summary`                                                  | Counts of VMs and media by visibility                |
| `GET /admin/vms`                                                      | Every VM. Also filters by `visibility`               |
| `GET /admin/vms/:emulatorType/:vmName`                                | One VM                                               |
| `PATCH /admin/vms/:emulatorType/:vmName`                              | `{ displayName?, description? }`, or `null` to clear |
| `PUT /admin/vms/:emulatorType/:vmName/visibility`                     | `{ visibility: "private" \| "public" }`              |
| `GET /admin/vms/:emulatorType/:vmName/media`                          | Every media item of the VM                           |
| `PUT /admin/vms/:emulatorType/:vmName/main-media`                     | `{ mediaId }`: selects the main image                |
| `DELETE /admin/vms/:emulatorType/:vmName/main-media`                  | Clears the selection                                 |
| `PUT /admin/vms/:emulatorType/:vmName/media/:mediaId/visibility`      | `{ visibility: "private" \| "published" }`           |
| `DELETE /admin/vms/:emulatorType/:vmName/media/:mediaId`              | Deletes the item and its files                       |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId`                 | One item in full, with its hash, type and agent      |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId/thumbnail\|full` | The JPEG, published or not                           |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId/original`        | The uploaded file, as a download                     |
| `GET /admin/vms/:emulatorType/:vmName/media-sync`                     | What each agent holding the VM last reported         |

Media mutations return the VM's updated media list.

**There is no route that creates a VM**, and none that changes `emulator_type` or `vm_name`. A VM enters the
catalog only through agent discovery followed by [an explicit registration](#registrations), which keeps it private.

## Agent media

How screenshots reach the server. See [the media guide](media.md) and
[decision 0018](decisions/0018-agent-media-upload.md). Each route needs `Authorization: Bearer <agent credential>` and
`X-EmuCat-Protocol-Version: 1`, and a browser session means nothing here. The agent comes from the credential, and only a VM that this
agent holds can be used.

| Route                                                            | What it does                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /agent/media/vms`                                           | The VMs this agent should synchronize, and the size limit |
| `POST /agent/media/vms/:emulatorType/:vmName/acknowledgements`   | `{ sha256: [...] }`: which of up to 256 hashes are stored |
| `PUT /agent/media/vms/:emulatorType/:vmName/screenshots/:sha256` | The file, as `application/octet-stream`                   |

An upload also takes `X-EmuCat-Source-Path`, percent-encoded, and optionally `X-EmuCat-Captured-At`. The answer is `{ mediaId, sha256,
created }`, with 201 for a new item and 200 for bytes already stored for this VM.

| Status | Code                                                                         | Meaning, and what an agent does                         |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| 400    | `invalid_source_path`, `unsupported_protocol_version`, `invalid_captured_at` | The request is wrong. Not retried                       |
| 401    | `unauthorized`                                                               | Unknown or revoked. Retried, since connectivity decides |
| 403    | `vm_not_assigned`                                                            | Another agent's VM. Retried until the list changes      |
| 404    | `vm_not_registered`                                                          | Retried until the list changes                          |
| 408    | `upload_timeout`                                                             | The body stopped arriving. Retried                      |
| 413    | `upload_too_large`                                                           | Not retried                                             |
| 415    | `unsupported_image`, `unsupported_media_type`                                | Not retried                                             |
| 422    | `invalid_image`, `image_too_large`                                           | Not retried                                             |
| 422    | `hash_mismatch`                                                              | Retried, and a scan notices if the file changed         |
| 503    | `media_busy`, `processing_timeout`, `temporarily_unavailable`                | Retried                                                 |

## Agent pairing

Used by an agent with no credential yet. See the [protocol](protocol.md#pairing) for the flow. Responses are
`Cache-Control: no-store`.

| Method and path                | Auth           | Purpose                                                                                                                                      |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /agent/pairing/requests` | None           | `{ name, platform, architecture, agentVersion, protocolVersion }`. 201 with `{ pairingCode, pollingSecret, expiresAt, pollIntervalSeconds }` |
| `POST /agent/pairing/poll`     | Polling secret | `{ status }`, plus `agentId` and `credential` once, on approval                                                                              |

## Agents

Requires a session with the `admin` role, and the CSRF token on `POST`. Responses are `Cache-Control: no-store`,
and contain no credential, polling secret, code or digest.

| Method and path                                         | Purpose                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /admin/agents`                                     | Every agent: details, `online`, `pairingStatus`, `lastSeenAt`             |
| `GET /admin/agents/:agentId`                            | One agent                                                                 |
| `POST /admin/agents/:agentId/revoke`                    | Revokes and disconnects it. Safe to repeat                                |
| `POST /admin/agents/:agentId/discovery`                 | Starts a scan, or returns the running one. 202. 409 if offline or revoked |
| `GET /admin/agents/:agentId/discovery`                  | `{ operation }`: the latest scan since the API started, or `null`         |
| `GET /admin/agent-pairing/requests`                     | Requests waiting for a decision                                           |
| `GET /admin/agent-pairing/requests/:requestId`          | One request, in any state, to follow its progress                         |
| `POST /admin/agent-pairing/lookup`                      | `{ code }`: finds a request, for review                                   |
| `POST /admin/agent-pairing/requests/:requestId/approve` | `{ code }`: approves it. The code is required                             |
| `POST /admin/agent-pairing/requests/:requestId/reject`  | Rejects it. No code needed: this grants nothing                           |

A code is sent in a body so that it never appears in a URL. An `operation` has `status` (`running`, `completed` or
`failed`), `failure`, `hostPlatform`, `emulators`, `skipped`, and `vms` of `{ emulatorType, vmName, markers,
hostCompatible, registered }`. See [the agent guide](agent.md#discovery).

**Limits**, in the API process. Successes do not count, except for new requests and polls per request.

| Attempt                   | Limit                                            |
| ------------------------- | ------------------------------------------------ |
| New pairing requests      | 20 per address per 15 minutes                    |
| Requests waiting at once  | 100 in total                                     |
| Wrong polling secrets     | 30 per address per 15 minutes                    |
| Polls of one request      | 120 per minute                                   |
| Wrong codes, on any route | 10 per session and 30 per address per 15 minutes |

**Discovery creates nothing.** No route here writes to `virtual_machines` or `vm_versions`.

## Registrations

Administrators only, with the session and CSRF token. Nothing here accepts or returns archive bytes, a filesystem path or a
private key: archives go directly between agent and repository. See the [protocol](protocol.md#registration). Shapes are in
[`registration.ts`](../packages/contracts/src/registration.ts).

| Route                                              | What it does                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/registrations`                        | Starts one: `agentId`, `repositoryId`, `emulatorType`, `vmName`, `mode`, `discoveryOperationId`, and `confirmDestructive: true` for a transfer. 202 |
| `GET /admin/registrations`                         | The latest 100, newest first. `?agentId=` narrows it                                                                                                |
| `GET /admin/registrations/:operationId`            | One operation: its state, progress, archive, local copy, error and recovery guidance                                                                |
| `POST /admin/registrations/:operationId/cancel`    | Until the master exists. Otherwise 409 `registration_committed`                                                                                     |
| `POST /admin/registrations/:operationId/reconcile` | Tries a failed commit again, from the metadata the agent already reported. Safe to repeat                                                           |

`archive` in a response is what the **agent** verified, and says so with `verifiedBy: "agent"`. The server has not read the archive.

| Status | Code                                                                               | Meaning                                                                  |
| ------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 400    | `validation_failed`                                                                | Includes any extra field, an unsafe VM name, and an unconfirmed transfer |
| 409    | `agent_offline`, `agent_revoked`, `agent_cannot_register`                          |                                                                          |
| 409    | `discovery_stale`                                                                  | Run discovery again, and choose the VM from the new report               |
| 409    | `vm_already_registered`, `registration_in_progress`                                |                                                                          |
| 409    | `repository_not_authorized`, `repository_disabled`                                 |                                                                          |
| 409    | `registration_committed`, `registration_finished`, `registration_not_reconcilable` |                                                                          |
| 404    | `registration_not_found`, `repository_not_found`                                   |                                                                          |

`POST /admin/registrations/:operationId/retry-cleanup` tries again to remove a local VM, after a screenshot blocked it. It only applies to
a transfer in `partial_success` with the code `transfer_blocked_media`, with the agent online, and the agent checks everything again.

## Repositories

Administrators only, with the session and CSRF token. No response holds a credential, and no request can send one. See the
[repository guide](repositories.md).

| Route                                                                 | What it does                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /admin/repositories`                                             | Each with its address, status, last successful check, agents, errors                            |
| `POST /admin/repositories`                                            | `name`, `host`, `port`, `username`, `remoteRoot`. 201. 409 `repository_exists` if one is active |
| `PUT /admin/repositories/:repositoryId`                               | Replaces those details, and forgets earlier checks                                              |
| `PUT /admin/repositories/:repositoryId/agents/:agentId`               | Allows an agent to use it                                                                       |
| `DELETE /admin/repositories/:repositoryId/agents/:agentId`            | Stops allowing it. A running registration then fails at its commit                              |
| `POST /admin/repositories/:repositoryId/agents/:agentId/health-check` | Asks the agent to test it. 202. The result appears in the list                                  |

## Browser pages

| Route                              | Audience      | Page                               |
| ---------------------------------- | ------------- | ---------------------------------- |
| `/`                                | Public        | Catalog                            |
| `/vms/:emulatorType/:vmName`       | Public        | VM detail                          |
| `/login`, `/setup`                 | Public        | Sign in, first-run setup           |
| `/admin`                           | Administrator | Dashboard                          |
| `/admin/catalog`                   | Administrator | Catalog management                 |
| `/admin/agents`                    | Administrator | Agents, pairing                    |
| `/admin/agents/:agentId`           | Administrator | One agent, discovery, registration |
| `/admin/repositories`              | Administrator | Repositories, connectivity tests   |
| `/admin/vms/:emulatorType/:vmName` | Administrator | VM metadata editor                 |
| `…/media`                          | Administrator | Media management                   |
| `/account`, `/settings`            | Signed in     | Password, sessions, theme          |
