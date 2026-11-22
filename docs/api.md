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

No authentication. Only public VMs and their screenshots ever appear here, and responses never contain
filenames, hashes, storage keys, attribution, agent state or repository details. Responses may be stored but
must be revalidated (`Cache-Control: no-cache`), so making something private takes effect immediately.

| Method and path                               | Returns                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /catalog/vms`                            | `items` of `{ emulatorType, vmName, displayName, summary, mainImage, tags }` |
| `GET /catalog/vms/:emulatorType/:vmName`      | Adds `description` and `gallery`; `summary` goes                             |
| `GET /catalog/media/:mediaId/thumbnail\|full` | The JPEG                                                                     |

`mainImage` is `{ id, widthPx, heightPx }`, or `null` meaning "show the placeholder". `gallery` lists every image of the VM as `{ id, widthPx, heightPx, tags }`, in the order an administrator saved ([decision 0050](decisions/0050-media-order-deletion-and-tags.md)), which is stable; the main image is wherever that order puts it. `tags` are `{ id, name }`, the name without `#`: the VM's own on a VM, a screenshot's own on a screenshot. Versions' tags are never here.

`q` searches names, descriptions and tags. `#name` matches that tag exactly and nothing else; plain text also matches any tag containing it, after the same normalization as tag names (so `windows 95` finds `#windows-95`). A public VM matches through its own tags and its screenshots' tags. `/original` does not exist here, for anyone. `displayName` may be
`null`, in which case the title is the VM name (`vmTitle` in the contracts). `summary` is the first 240
characters of the description.

## Administration

Requires a session with the `admin` role. Responses are `Cache-Control: no-store`.

| Method and path                                                       | Purpose                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /admin/summary`                                                  | Counts of VMs, and of media by their VM's visibility                        |
| `GET /admin/vms`                                                      | Every VM. Also filters by `visibility`                                      |
| `GET /admin/vms/:emulatorType/:vmName`                                | One VM                                                                      |
| `PATCH /admin/vms/:emulatorType/:vmName`                              | `{ displayName?, description? }`, or `null` to clear                        |
| `PUT /admin/vms/:emulatorType/:vmName/visibility`                     | `{ visibility: "private" \| "public" }`                                     |
| `GET /admin/vms/:emulatorType/:vmName/media`                          | Every media item of the VM                                                  |
| `PUT /admin/vms/:emulatorType/:vmName/main-media`                     | `{ mediaId }`: selects the main image                                       |
| `DELETE /admin/vms/:emulatorType/:vmName/main-media`                  | Clears the selection                                                        |
| `DELETE /admin/vms/:emulatorType/:vmName/media/:mediaId`              | Deletes the item and its files                                              |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId`                 | One item in full, with its hash, type and agent                             |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId/thumbnail\|full` | The JPEG, whether the VM is public or not                                   |
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId/original`        | The uploaded file, as a download                                            |
| `GET /admin/vms/:emulatorType/:vmName/media-sync`                     | What each agent holding the VM last reported                                |
| `PUT /admin/vms/:emulatorType/:vmName/media-order`                    | `{ mediaIds }`: every screenshot, once, first to last                       |
| `GET\|PUT /admin/vms/:emulatorType/:vmName/tags`                      | The VM's tags. `PUT { tagIds }` replaces them                               |
| `GET\|PUT /admin/vms/:emulatorType/:vmName/media/:mediaId/tags`       | A screenshot's tags                                                         |
| `GET\|PUT /admin/vms/:emulatorType/:vmName/versions/:versionId/tags`  | A master's or snapshot's tags                                               |
| `GET /admin/tags?q=&limit=`                                           | Tags whose name contains `q` (with or without `#`)                          |
| `POST /admin/tags`                                                    | `{ name }`: 201 with `{ tag, created: true }`, or 200 with the existing tag |

Media mutations return the VM's updated media list, in the saved order. Each item has `tags`. `GET /admin/vms` matches
`q` against tags as the public catalog does, and also against the VM's live versions' tags.

**Deleting a screenshot** removes it from the catalog, with its tags and the files no other row uses, and remembers its
bytes for that VM so that the agent cannot bring it back ([decision 0050](decisions/0050-media-order-deletion-and-tags.md)).
A second delete of the same item, or of another VM's item, is `404 media_not_found`. If it was the main image, there
is none afterwards.

**Reordering** is refused with `409 media_order_conflict` when the list is not exactly the VM's current screenshots
(one arrived or was deleted since), and `400` for a duplicate. Nothing changes on a refusal. The main image does not
change with the order.

**Tags.** `PUT …/tags` replaces the entity's tags with exactly `tagIds` (at most 32, no duplicates) in one transaction,
and returns `{ tags }` as stored, by name. An unknown tag ID is `422 unknown_tag`, an entity of another VM `404`, and a
version that is deleted or being deleted `409 version_deleted`. An invalid name on `POST /admin/tags` is
`400 invalid_tag`. Tags are never inherited: a screenshot's tag is not its VM's.

### System and application updates

Administrators only. State-changing requests also need the same-origin checks of every browser request.
The API holds no deployment privilege: it relays these to the [deployment service](deployment.md#9-the-deployment-service)
over a Unix socket. Without one (`DEPLOYER_SOCKET` unset) the update routes answer
`503 deployment_service_not_configured`; when it does not answer, `503 deployment_service_unavailable`.

| Method and path                              | Purpose                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/system/version`                  | Environment, application version, build commit and time, deployed commit and time, status                                                                             |
| `GET /admin/system/updates`                  | Branch, deployed release, newest remote commit, availability, active and last operations                                                                              |
| `POST /admin/system/updates/check`           | Fetches the configured branch and returns the same view                                                                                                               |
| `POST /admin/system/updates`                 | `{ expectedCommit }` only: `202` with the operation. `403 updates_disabled`, `409 update_in_progress`, `409 target_changed`, `409 already_current`, `409 not_checked` |
| `GET /admin/system/updates/:operationId`     | One operation, with its stages                                                                                                                                        |
| `GET /admin/system/updates/:operationId/log` | Its log, with secrets removed                                                                                                                                         |

There is no parameter for a branch, a Git ref, a repository or a command.

**There is no route that changes `emulator_type` or `vm_name`.** A VM enters the catalog through agent discovery
followed by [an explicit registration](#registrations), an [OVA import](#agent-ova-imports), or [a clone](#clones) of a
version of an existing VM. Each new VM is private.

`GET /admin/vms/:emulatorType/:vmName` includes `clonedFrom`: `null`, or where the VM was cloned from
(`sourceEmulatorType`, `sourceVmName`, `sourceDisplayName`, `sourceVersionId`, `sourceVersionKind`,
`sourceSnapshotName`, `sourceVersionTitle`, `clonedAt`, `clonedByDisplayName`, and `sourceExists`, whether a VM of
that name is in the catalog now). It is information only ([decision 0052](decisions/0052-vm-clones.md)).

### VM notes

One Markdown document per VM, private to administrators ([decision 0053](decisions/0053-vm-notes.md)). Shapes are in
[`notes.ts`](../packages/contracts/src/notes.ts). No public route returns notes, and no other response includes them.

| Method and path                                 | Purpose                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /admin/vms/:emulatorType/:vmName/notes`    | `{ markdown, exists, etag, updatedAt, sizeBytes }`, and the `ETag` header. No file is `""` |
| `PUT /admin/vms/:emulatorType/:vmName/notes`    | `{ markdown }` with `If-Match: <etag>`: replaces the whole document. `""` removes the file |
| `DELETE /admin/vms/:emulatorType/:vmName/notes` | With `If-Match: <etag>`: removes the notes                                                 |

The `ETag` is the quoted SHA-256 of the content. A save without `If-Match` answers `428 precondition_required`; one
whose tag no longer matches, `412 notes_conflict`, and nothing changes. Notes are at most 1 MiB of UTF-8 without NUL
(`413 notes_too_large`, or `400`). `404 vm_not_found` for a VM that is not registered. `503 notes_unavailable` when the
server has no notes directory or cannot write it; `500 notes_storage_unsafe` when a link was found where the notes are
kept, and nothing is read or written through it. No response contains a filesystem path.

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
created }`, with 201 for a new item and 200 for bytes already stored for this VM. Bytes an administrator deleted from this
VM's catalog also answer 200, with `suppressed: true` and the deleted item's ID, and nothing is stored, unless the upload is
a requested capture. Acknowledgements never include such a hash: it is not stored. An agent may upload screenshots of a VM it holds, or had until a
transfer, and for 30 days after it removed its local copy of that VM, so that screenshots spooled by the removal still arrive
([decision 0051](decisions/0051-screenshots-are-not-vm-state.md)).

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

## Agent OVA imports

How `emucat-agent import-ova` reserves and registers an OVA it uploads itself. See
[decision 0049](decisions/0049-ova-repository-import.md) and [the agent guide](agent.md#importing-an-existing-ova).
Authentication is the same as for agent media: `Authorization: Bearer <agent credential>` and
`X-EmuCat-Protocol-Version: 1`; a browser session means nothing. The agent comes from the credential, and every route
sees only that agent's own imports. The OVA itself never reaches the server.

| Route                                           | What it does                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /agent/ova-imports/preflight`             | `{ vmName, archiveSizeBytes }`: whether this agent may import under this name, and which repository                                          |
| `POST /agent/ova-imports`                       | `{ requestId, vmName, description?, sourceFileName, archiveSizeBytes, archiveSha256 }`: reserves. 201, or 200 for the same `requestId` again |
| `GET /agent/ova-imports/:operationId`           | The operation, as on the Registrations page                                                                                                  |
| `POST /agent/ova-imports/:operationId/progress` | `{ stage: uploading \| verifying, doneBytes, totalBytes }`. The answer says if it was cancelled                                              |
| `POST /agent/ova-imports/:operationId/complete` | `{ versionId, archiveKey, archiveSizeBytes, archiveSha256 }`: registers, or `rejected` with `deletePublished`                                |
| `POST /agent/ova-imports/:operationId/fail`     | `{ code, message }`: ends it as failed, or cancelled with code `cancelled`                                                                   |

Every check is made on the server and again when it commits: the agent not revoked and not busy, associated with an
enabled repository (the server chooses it), and the name free among VirtualBox VMs, ignoring case. The completion must
match the size and SHA-256 declared when reserving and the key issued then.

| Status | Code                                                                                                                                                                                            | Meaning                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 400    | `invalid_request`, `unsupported_protocol_version`                                                                                                                                               | The request is wrong                |
| 401    | `unauthorized`                                                                                                                                                                                  | Unknown or revoked credential       |
| 404    | `import_not_found`                                                                                                                                                                              | No such import of this agent        |
| 409    | `repository_not_authorized`: no enabled repository is associated with this agent. `vm_already_registered`, `registration_in_progress`, `agent_busy`, `request_conflict`, `invalid_import_state` | A conflict. Nothing changed         |
| 413    | `archive_too_large`                                                                                                                                                                             | Over the limit the preflight states |
| 503    | `temporarily_unavailable`                                                                                                                                                                       | The database is away. Retry         |

An import is an operation with `mode: "import"` in `GET /admin/registrations`. An administrator's cancel takes effect
at once, since no agent message is involved.

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
| `GET /admin/registrations`                         | A page of operations, newest first, 100 by default. Views, filters and cursors are below                                                            |
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

`POST /admin/registrations/:operationId/retry-cleanup` tries again to remove a local VM. It only applies to a transfer in
`partial_success` with the code `transfer_blocked_running`, or `transfer_blocked_media` from an agent older than
[decision 0051](decisions/0051-screenshots-are-not-vm-state.md), with the agent online, and the agent checks everything again.

`POST /admin/registrations/:operationId/acknowledge` records that an administrator has dealt with a `partial_success`, so that it leaves
the operations needing attention. It changes nothing else, and repeating it changes nothing. Anything but a partial success is refused
with 409 `registration_not_acknowledgeable`. Retrying a removal clears the acknowledgement.

### Listing registrations

Every parameter is optional, and an unknown one is refused with 400. See [decision 0043](decisions/0043-registration-history-and-discovery-page.md).

| Parameter                      | Meaning                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `view`                         | `all` (default); `attention`: running, or a partial success nobody has acknowledged; `history`: every operation that ended |
| `agentId`                      | One agent                                                                                                                  |
| `emulatorType`, `vmName`       | One emulator; one VM exactly, case-insensitive                                                                             |
| `q`                            | Part of a VM name, case-insensitive. `%` and `_` match only themselves                                                     |
| `mode`                         | `copy`, `transfer` or `snapshot`                                                                                           |
| `state`                        | One or more states, comma-separated: `state=failed,cancelled`                                                              |
| `createdFrom`, `createdBefore` | ISO 8601 instants: created at or after, and strictly before                                                                |
| `limit`                        | 1 to 100. Default 100                                                                                                      |
| `cursor`                       | The `nextCursor` of the previous page. Anything else is refused with 400                                                   |

The response is `{ operations, nextCursor }`, and for `view=attention` also `total`, the number of matching operations in all. Order is
`createdAt` descending, then `id`: a page never repeats or skips a row, even while new operations are created. Each operation also carries
`acknowledgedAt` and `acknowledgedByDisplayName`, `parentSnapshotName` (`null` when the parent is the master), and `versionDeletion`
(`deleting` or `deleted` once storage cleanup has deleted the version it created).

## Restores

Administrators only, with the same-origin and CSRF rules as everything else here. None of these routes accepts or returns archive bytes, and none accepts a filesystem path. Shapes are in
[`restore.ts`](../packages/contracts/src/restore.ts).

| Method and path                                        | What it does                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/restore-options` | The master and every version, and for each paired agent whether it is eligible, what it holds and where it would restore to |
| `POST /admin/restores`                                 | Starts one: `{ agentId, emulatorType, vmName, versionId, replace? }`. 202, with the operation                               |
| `GET /admin/restores`                                  | The latest 100. Filter with `agentId`, `emulatorType` and `vmName`                                                          |
| `GET /admin/restores/:operationId`                     | One operation                                                                                                               |
| `POST /admin/restores/:operationId/cancel`             | Cancels one, until publication has begun                                                                                    |

Any version can be restored, the master or a snapshot (Milestone 7). Starting one answers 404 with `agent_not_found` or `version_not_found`, and 409 with `repository_disabled`, `agent_revoked`, `agent_offline`, `agent_cannot_restore`, `emulator_not_configured`, `repository_not_authorized`,
`repository_not_configured`, `local_copy_exists` or `operation_in_progress`. Cancelling answers 409 with `restore_too_late` or `restore_finished`.

On an agent that already holds the VM, a restore is a **replacement**, and must say so: `replace: { expectedVersionId, discardLocalChanges }`, where `expectedVersionId` is the version the page showed as installed. The object itself is the explicit intent: the page confirms it with a destructive button, and the VM's name is not typed. It answers 400 for an invalid body, and 409 with `no_local_copy` (nothing to replace), `local_copy_changed` (the copy is not the version the page showed), `local_copy_modified` (the copy is recorded as modified and `discardLocalChanges` is false), `vm_running` or `agent_cannot_restore` (an agent that cannot replace safely). The operation's `replacement` records the version replaced, and whether local changes were discarded. The agent checks everything again before it moves anything; see [decision 0040](decisions/0040-temporary-remote-sessions.md#replacing-a-persistent-local-copy).

An operation's `error` has a `code`, from `RESTORE_ERROR_CODES`, and `recovery` says what can be done about it. `verified` says what the agent reports having verified, and the server has not read the archive.

## Sessions and verification

Administrators only, with the same-origin and CSRF rules as everything else here. A launch names an agent, a VM and a mode: no route accepts a command, a path, an argument or a process. Shapes are in
[`execution.ts`](../packages/contracts/src/execution.ts), and the behavior in [the launcher guide](launcher.md).

| Method and path                                          | What it does                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/execution-options` | The modes and whether each is available, and for each paired agent what it can do, its active session and its last verification        |
| `POST /admin/sessions`                                   | Launches: `{ agentId, emulatorType, vmName, mode, requestId }`. 202, with the session. A repeated `requestId` returns the same session |
| `GET /admin/sessions`                                    | The latest sessions, newest first. Filter with `agentId`, `emulatorType`, `vmName` and `limit` (at most 100)                           |
| `GET /admin/sessions/:sessionId`                         | One session                                                                                                                            |
| `POST /admin/sessions/:sessionId/stop`                   | `{ force: false }` asks for a graceful stop; `{ force: true, confirmVmName }` forces one. 202                                          |
| `POST /admin/sessions/:sessionId/dismiss`                | `{ confirmVmName }` ends an `unknown` or never-started session on the server's side                                                    |
| `POST /admin/verifications`                              | Verifies the agent's copy against the master: `{ agentId, emulatorType, vmName }`. 202                                                 |
| `GET /admin/verifications/:verificationId`               | One verification, with its counts and the first paths of each kind                                                                     |

Launching answers 409 with `execution_mode_unavailable`, `request_id_reused`, `agent_revoked`, `agent_offline`, `agent_cannot_launch`, `emulator_not_launchable`, `vm_not_on_agent`, `session_active` or `operation_in_progress`. Stopping answers 400 with
`confirmation_mismatch`, and 409 with `session_ended`, `session_not_started`, `session_unknown` or `agent_offline`; a stop is never queued. Dismissing answers 409 with `session_not_dismissable`. Verifying answers 409 with `agent_cannot_verify`, `no_master`, `vm_not_on_agent`,
`session_active` or `operation_in_progress`. Restores also answer 409 with `vm_running` while a session of the VM is active.

The administrators' catalog cards carry `activeSessions`, for a running badge. Nothing about sessions appears in a public response.

A remote mode needs `workspaceId`, and is refused without one (400), for a working copy of another purpose (409 `workspace_purpose_mismatch`), or on an agent that does not run the mode (409 `execution_mode_unavailable`); it is never replaced by a local launch. Remote sessions are started, launched and ended by the server, through the routes below. `execution-options` says for each agent whether each remote mode can start now (`remote`), and why not.

## Versions, snapshots and remote sessions

Administrators only, with the same-origin and CSRF rules as everything else here: nothing about versions appears in a public response, whatever the VM's visibility ([decision 0039](decisions/0039-version-history-is-administrative.md)). No route accepts a path, a repository or an archive key. Shapes are in [`versions.ts`](../packages/contracts/src/versions.ts); the lifecycles are in decisions [0037](decisions/0037-snapshots-as-registrations.md) and [0040](decisions/0040-temporary-remote-sessions.md).

| Method and path                                              | What it does                                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/versions`              | The version tree: every version with its parent, children, name, creation time, archive size and hash, what the agent verified, and who holds a copy             |
| `POST /admin/vms/:emulatorType/:vmName/snapshots`            | Snapshots an agent's persistent copy: `{ agentId, parentVersionId, requestId, title?, description? }`. 202, with the registration operation (`mode: "snapshot"`) |
| `PATCH /admin/vms/:emulatorType/:vmName/versions/:versionId` | Edits a version's `{ title, description }`, both required and nullable. Nothing else about the version changes                                                   |
| `GET /admin/vms/:emulatorType/:vmName/workspaces`            | The VM's remote sessions and manual working copies, active ones first, each with its restore, session and publication                                            |
| `POST /admin/vms/:emulatorType/:vmName/workspaces`           | Starts a remote session of exactly one version: `{ agentId, versionId, mode, requestId }`, `mode` being `remote_volatile` or `remote_snapshot`. 202              |
| `GET /admin/workspaces/:workspaceId`                         | One remote session or working copy                                                                                                                               |
| `POST /admin/workspaces/:workspaceId/retry-publication`      | Retries a Remote Snapshot whose publication failed: `{}`. 202. Never publishes twice                                                                             |
| `POST /admin/workspaces/:workspaceId/resume`                 | Lets a held session go on once its emulator is known not to run: `{ confirmVmName }`. 202                                                                        |
| `POST /admin/workspaces/:workspaceId/discard`                | Discards a working copy, or abandons an unpublished Remote Snapshot: `{ confirmVmName }` when changes would be lost                                              |
| `POST /admin/workspaces/:workspaceId/launch`                 | Manual working copies only (Milestone 7): launches one that is ready, `{ requestId }`                                                                            |
| `POST /admin/workspaces/:workspaceId/snapshot`               | Manual working copies only: preserves one as a snapshot of its current source version, `{ requestId }`                                                           |

A snapshot's parent must be the version the agent's copy came from. Creating one answers 404 with `version_not_found` (also for a version of another VM), and 409 with `agent_offline`, `agent_cannot_snapshot`, `agent_revoked`, `local_copy_missing`, `local_copy_unsafe`, `snapshot_parent_unknown`, `snapshot_parent_mismatch`, `repository_disabled`, `repository_not_authorized`, `vm_running` (any active session, `unknown` included), `operation_in_progress` or `request_id_reused`. A repeated `requestId` returns the same operation. Its progress, cancellation and reconciliation are the registration routes'.

Starting a remote session answers 404 `version_not_found`, and 409 with `request_id_reused`, `execution_mode_unavailable` (the agent does not run the mode), `remote_session_pending` (one is still active for this VM on that agent, a failed publication included), `session_active`, or the reasons `execution-options` lists. A repeated `requestId` returns the same session. Everything after that is driven by the server ([decision 0040](decisions/0040-temporary-remote-sessions.md)): the restore into a temporary copy, the launch, then on exit the cleanup, or for Remote Snapshot the publication and then the cleanup. Retrying answers 409 `workspace_unavailable` unless the publication failed. Resuming answers 400 `confirmation_mismatch`, and 409 `workspace_unavailable` unless it is held, or `vm_running` if the agent says it runs again. Launching or preserving a remote session answers 409 `workspace_purpose_mismatch`. Discarding answers 400 `confirmation_required` (a held session, a failed publication, or a manual copy that may hold changes), and 409 with `vm_running` (any active session of the VM on that agent, `unknown` included), `operation_in_progress` (any operation on that agent) or `workspace_unavailable`. Snapshots also answer 409 `snapshot_lineage_unverified` for a copy discovery saw disappear and come back, until a verification proves what it is.

### Clones

Decisions [0052](decisions/0052-vm-clones.md) and [0055](decisions/0055-server-repository-access.md). Shapes are in
[`clone.ts`](../packages/contracts/src/clone.ts). The server makes the clone itself, over its own repository
connection; no agent takes part.

| Method and path                                                          | What it does                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/versions/:versionId/clone-options` | The source version and `refusal` (`version_deleted`, `repository_disabled`, `remaster_in_progress`, `server_repository_unavailable`, or `null`)                                                                               |
| `POST /admin/vms/:emulatorType/:vmName/versions/:versionId/clone`        | `{ vmName, requestId }`: clones the version into a new VM `vmName` of the same type. 202, with the registration operation (`mode: "clone"`, `performedBy: "server"`, no agent). An `agentId` from an older browser is ignored |

The new name follows the [VM name rules](domain-model.md#vm-names) (`400` otherwise) and must be free among VMs of
that type, ignoring case: `409 vm_already_registered` for an existing VM (the message names its spelling), or
`409 registration_in_progress` while another operation is creating it. Also `404 version_not_found` (also for a
version of another VM), and 409 with `repository_disabled`, `version_deleted`, `remaster_in_progress`,
`server_repository_unavailable` (the server has no key or `known_hosts` of its own) or `request_id_reused`. A
repeated `requestId` returns the same clone. Progress, cancellation and history are the
registration routes' (`GET /admin/registrations/:operationId`, whose `cloneSource` names the source). The clone is
committed with its master, and ends `succeeded`; the source is never changed. While a clone runs, its source version
cannot be deleted (`snapshot_in_use`) or removed by a remaster (`version_in_use`).

### Remasters

[Decision 0048](decisions/0048-master-and-snapshot-lifecycle.md). Shapes are in [`remaster.ts`](../packages/contracts/src/remaster.ts) and [`version-details.ts`](../packages/contracts/src/version-details.ts).

| Method and path                                                       | What it does                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/versions/:versionId/promotion`  | Preview of promoting a snapshot: kept, removed, bytes, copies whose lineage would be lost, `revision`, and `refusal` |
| `POST /admin/vms/:emulatorType/:vmName/versions/:versionId/promotion` | Promotes it: `{ requestId, expectedRevision, acknowledgeLineageConflicts? }`. 202, with the remaster                 |
| `GET /admin/vms/:emulatorType/:vmName/remaster/local?agentId=`        | Preview of replacing the history with that agent's local copy                                                        |
| `POST /admin/vms/:emulatorType/:vmName/remaster/local`                | Starts it: `{ agentId, requestId, expectedRevision, confirmVmName, acknowledgeLineageConflicts? }`. 202              |
| `GET /admin/vms/:emulatorType/:vmName/remasters`                      | The VM's latest remasters, newest first                                                                              |
| `GET /admin/remasters/:remasterId`                                    | One remaster: its `phase`, progress and cleanup manifest                                                             |
| `POST /admin/remasters/:remasterId/cleanup/retry`                     | Sends another attempt for each archive still being deleted. 202                                                      |

The tree response carries the same `revision` as the previews, and each version its `title`, `description` and `promotedAt`. Versions removed by a remaster leave the tree at once.

A promotion or local remaster answers 404 `version_not_found`, 400 `confirmation_mismatch` (the name must be typed exactly), and 409 with a code from `REMASTER_REFUSALS`: `version_is_master`, `version_deleted`, `version_history_stale` (the history changed since the preview), `version_history_inconsistent`, `archive_integrity_invalid`, `remaster_in_progress`, `operation_in_progress`, `version_in_use`, `source_lineage_conflict` (not acknowledged), `agent_offline`, `agent_cannot_remaster`, `local_source_missing`, `source_not_exportable`, `vm_running` or `repository_unavailable`; or `request_id_reused`. A repeated `requestId` returns the same remaster. A remaster's `phase` is `exporting`, `uploading`, `verifying`, `committing`, `cleaning`, `completed` or `failed`. While a local remaster exports, every route that would start something from a version of that VM answers 409 `remaster_in_progress`. Editing details answers 400 for a title over 120 characters, a description over 2000, a line break in a title or a control character, 404 `version_not_found`, and 409 `version_deleted`.

## Storage cleanup

Administrators only, with the same-origin and CSRF rules as everything else here ([decision 0041](decisions/0041-storage-cleanup.md)). No route accepts a path, a directory, a repository or an archive key: a removal names an agent and a VM, and a deletion names a version. What the page shows is advice only; the server checks everything again under its locks, and the agent again on its disk. Shapes are in [`cleanup.ts`](../packages/contracts/src/cleanup.ts).

| Method and path                                                            | What it does                                                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/local-copy-removals`                                          | Removes one agent's persistent copy: `{ agentId, emulatorType, vmName, expectedVersionId, discardLocalChanges, requestId }`. 202       |
| `GET /admin/local-copy-removals`                                           | The latest removals, newest first. Filter with `agentId`, `emulatorType` and `vmName`                                                  |
| `GET /admin/local-copy-removals/:operationId`                              | One removal                                                                                                                            |
| `POST /admin/vms/:emulatorType/:vmName/versions/:versionId/deletion`       | Permanently deletes a leaf snapshot: `{ versionId, requestId }`, where `versionId` must be the one in the path. 202, with the deletion |
| `POST /admin/vms/:emulatorType/:vmName/versions/:versionId/deletion/retry` | Sends another attempt to delete the archive of a snapshot that is still being deleted. 202                                             |
| `GET /admin/vms/:emulatorType/:vmName/version-deletions`                   | The VM's deletions, being deleted and deleted, with their attempts, last error and outcome                                             |

`restore-options` says for each agent whether its copy can be removed now (`remove`), and whether the VM runs there (`running`); the version tree says for each version whether it can be deleted now (`deletable`, never for the master) and, while it is being deleted, `deletion`. A version being deleted is `available: false` and offered for nothing; a deleted one is no longer listed.

A removal answers 404 with `agent_not_found` or `vm_not_found`, 400 for an invalid body, and 409 with `agent_revoked`, `agent_offline`, `agent_cannot_remove`, `no_local_copy`, `local_copy_changed` (the copy is not the version the page showed), `local_copy_modified` (recorded as modified, and `discardLocalChanges` is false), `vm_running` (any active session, `unknown` included), `operation_in_progress` or `request_id_reused`. A repeated `requestId` returns the same operation. It ends `succeeded`, possibly with `cleanupPending` while the agent finishes deleting leftovers it moved aside, or `failed` with an `error` from `LOCAL_REMOVAL_ERROR_CODES` and a `recovery`. On success the server records no copy for that agent: Local mode is unavailable there until a version is restored again, and remote modes are not affected.

A deletion answers 400 with `version_mismatch`, 404 with `version_not_found`, and 409 with `master_cannot_be_deleted`, `snapshot_has_descendants`, `snapshot_in_use`, `snapshot_installed`, `repository_unavailable` or `request_id_reused`. Asking again for a snapshot that is being deleted, or was, returns the same deletion, with 202. From the moment it is recorded, every route that would start something from the version answers 409 `version_deleted`. It ends `deleted` with `archiveOutcome` `deleted`, or `already_absent` when the repository had nothing at that key; until then a failed attempt is retried automatically, with a growing delay. Retrying answers 404 `deletion_not_found`, or 409 with `deletion_finished` or `repository_unavailable`. Nothing cascades, nothing is reparented, and history keeps naming the deleted version.

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
| `POST /admin/repositories/:repositoryId/agents/:agentId/health-check` | Asks the agent to test it. 202. The result appears in the list, with the `transport` it used    |
| `POST /admin/repositories/:repositoryId/server-test`                  | Test Server Connection: the server tests its own connection, step by step, and records it       |

`POST` and `PUT` also take optional `serverHost` and `serverPort`: where the server reaches the same SSH server, if
not at `host` and `port`. Each repository in the list has `serverAccess` (the last Test Server Connection), and each
agent its last `transport` (`sftp`, `relay` or `null`).

### Archive contents

[Decision 0055](decisions/0055-server-repository-access.md), administrators only, read through the server's own
repository connection. Nothing is downloaded to the browser.

| Route                                                                      | What it does                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/vms/:emulatorType/:vmName/versions/:versionId/archive`         | Summary: format, size, SHA-256, entry and file counts, whether the manifest is the registered one                               |
| `GET /admin/vms/:emulatorType/:vmName/versions/:versionId/archive/entries` | One directory: `view` (`logical` or `physical`), `path`, optional `q` (search below it), `offset`, `limit` (at most 500). Paged |

Refusals: `404 version_not_found`, `409 server_repository_unavailable`, `409 version_deleted`, and
`404 archive_path_not_found`, `409 archive_view_unavailable` (no manifest for the VM files view, as in an OVA), and
`422 archive_malformed` / `archive_too_large` for an archive the server will not read.

## Agent repository relay

[Decision 0055](decisions/0055-server-repository-access.md). Under `/agent/repositories/:repositoryId`, with the
agent's bearer credential and `x-emucat-protocol-version`; never from a browser. Every key is checked against the
agent's own active operations and the catalog: there is no listing, and no route takes a server path.

| Route                                     | What it does                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET …/relay`                             | Whether the relay is available here, and its `chunkBytes`                                                 |
| `POST …/stat`, `…/free-space`, `…/health` | As the agent's own SFTP operations, done by the server                                                    |
| `POST …/verify`                           | `{ key, sizeBytes, sha256 }`: the server hashes the repository object; repeat until done                  |
| `POST …/publish`                          | `{ stagingKey, finalKey }`: hard link, never overwriting. 204                                             |
| `POST …/delete`                           | Only the agent's own staging object or its own operation's archive                                        |
| `POST …/uploads`                          | `{ key, sizeBytes, sha256 }`: starts, or resumes, an upload to a staging key. Status with `missingChunks` |
| `GET …/uploads/:transferId`               | The upload's status                                                                                       |
| `PUT …/uploads/:transferId/chunks/:index` | One chunk, with `x-emucat-chunk-sha256`. Exactly `chunkBytes`, but the last                               |
| `POST …/uploads/:transferId/complete`     | Checks the whole file, then publishes it to the repository's staging key                                  |
| `DELETE …/uploads/:transferId`            | Cancels it, and removes its staged bytes                                                                  |
| `POST …/downloads`                        | `{ key }`: stages a version archive or the agent's own operation's object                                 |
| `GET …/downloads/:transferId`             | Status; `ready` with `sizeBytes` and `sha256`                                                             |
| `GET …/downloads/:transferId/content`     | The bytes, with `Range: bytes=n-` support (206) and `x-emucat-sha256`                                     |

Refusals besides the usual: `relay_disabled`, `server_repository_unavailable`, `transfer_staging_full`,
`transfer_busy` (retryable), `chunk_conflict`, `hash_mismatch`, `transfer_not_found`, `transfer_expired`,
`transfer_too_large`, and `403 repository_not_authorized` for a key outside the agent’s own operations.

## Browser pages

| Route                              | Audience      | Page                                                                  |
| ---------------------------------- | ------------- | --------------------------------------------------------------------- |
| `/`                                | Public        | Catalog; every registered VM for an administrator                     |
| `/vms/:emulatorType/:vmName`       | Public        | VM detail: launch, general information, gallery                       |
| `/login`, `/setup`                 | Public        | Sign in, first-run setup                                              |
| `/account`, `/settings`            | Signed in     | Password, sessions; theme (administrators: Admin › Appearance)        |
| `/admin`                           | Administrator | Leads to Agents                                                       |
| `/admin/agents`                    | Administrator | Agents, pairing                                                       |
| `/admin/agents/:agentId`           | Administrator | One agent, discovery, registration                                    |
| `/admin/registrations`             | Administrator | Registration history                                                  |
| `/admin/repositories`              | Administrator | Repositories, connectivity tests                                      |
| `/admin/appearance`                | Administrator | Theme                                                                 |
| `/admin/updates`                   | Administrator | Application updates, server facts                                     |
| `/admin/vms/:emulatorType/:vmName` | Administrator | Manage › General: visibility, metadata, tags, details, run and verify |
| `…/versions`                       | Administrator | Manage › Version History, restore of a version, clone                 |
| `…/copies`                         | Administrator | Manage › Local copies and restore                                     |
| `…/notes`                          | Administrator | Manage › Notes                                                        |
| `…/screenshots`                    | Administrator | Manage › Screenshots                                                  |

Earlier routes are kept as redirects: `/admin/catalog` to `/` (with its query), `…/media` to `…/screenshots`, and
`/settings` to `/admin/appearance` for an administrator. See [architecture](architecture.md#navigation).

## QEMU screenshot capture

Administrator session and CSRF protected, under `/api/v1/admin`:

- `GET /sessions/:sessionId/screenshots`: availability, explanation and latest operation.
- `POST /sessions/:sessionId/screenshots`: strict `{ requestId: UUID }`; returns 202 and the durable operation.
- `GET /sessions/:sessionId/screenshots/:operationId`: durable status, hash and committed media ID.
- `POST /sessions/:sessionId/screenshots/:operationId/retry`: strict `{}`; at most three retained-image retries.

No commands or paths are accepted. Completion requires committed media for the correct VM. A recovered
QEMU session without its original stdio channel cannot capture. See [decision 0042](decisions/0042-qemu-monitor-capture.md).
