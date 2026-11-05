# REST API

Everything is under `/api/v1` and speaks JSON, apart from image files. Request and response shapes are
Zod schemas in [`packages/contracts`](../packages/contracts): [`auth.ts`](../packages/contracts/src/auth.ts)
and [`catalog.ts`](../packages/contracts/src/catalog.ts). The agent's WebSocket is described in the
[protocol](protocol.md).

## Conventions

**Errors** all have one shape, with a stable `code` for programs and a `requestId` for the logs:

```json
{
  "error": { "code": "validation_failed", "message": "Request validation failed", "requestId": "…" }
}
```

| Status | Code                                                   | Meaning                                        |
| ------ | ------------------------------------------------------ | ---------------------------------------------- |
| 400    | `validation_failed`                                    | Bad body, query or path. `details` says what.  |
| 401    | `unauthenticated`                                      | No live session                                |
| 401    | `invalid_credentials`                                  | Wrong sign-in, always with the same message    |
| 403    | `csrf_rejected`, `cross_origin_rejected`               | See [authentication](authentication.md#csrf)   |
| 403    | `forbidden`                                            | Signed in, but not an administrator            |
| 403    | `invalid_setup_token`, `invalid_current_password`      |                                                |
| 404    | `vm_not_found`, `media_not_found`, `session_not_found` | A private item looks the same as a missing one |
| 404    | `not_found`                                            | No such route                                  |
| 409    | `setup_completed`                                      | Setup has already happened                     |
| 429    | `rate_limited`                                         | See the `Retry-After` header                   |
| 500    | `internal_error`                                       | Details are in the server log only             |

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
| `GET /admin/vms/:emulatorType/:vmName/media/:mediaId/thumbnail\|full` | The JPEG, published or not                           |

Media mutations return the VM's updated media list.

**There is no route that creates a VM**, and none that changes `emulator_type` or `vm_name`. A VM enters the
catalog only through agent discovery followed by user confirmation, which a later milestone adds.

## Browser pages

| Route                              | Audience      | Page                      |
| ---------------------------------- | ------------- | ------------------------- |
| `/`                                | Public        | Catalog                   |
| `/vms/:emulatorType/:vmName`       | Public        | VM detail                 |
| `/login`, `/setup`                 | Public        | Sign in, first-run setup  |
| `/admin`                           | Administrator | Dashboard                 |
| `/admin/catalog`                   | Administrator | Catalog management        |
| `/admin/vms/:emulatorType/:vmName` | Administrator | VM metadata editor        |
| `…/media`                          | Administrator | Media management          |
| `/account`, `/settings`            | Signed in     | Password, sessions, theme |
