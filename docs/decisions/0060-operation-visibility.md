# 0060: A VM's operations are shown from the registration record, and General follows the icon conventions

**Status:** Accepted. Builds on [0015](0015-registration-state-machine.md) (durable registrations),
[0037](0037-snapshots-as-registrations.md) (snapshots are registrations), [0040](0040-temporary-remote-sessions.md)
(Remote Snapshot), [0052](0052-vm-clones.md) and [0055](0055-server-repository-access.md) (clones, made by the server),
and the UI conventions of [0058](0058-browser-local-nested-archives.md) and
[0059](0059-version-history-icon-toolbars.md). Adds one read-only API route. No schema, migration, agent, protocol,
configuration or deployment-tooling change.

## Context

After starting a snapshot or a clone from Version History, an administrator could not tell whether it was accepted,
running, waiting for an agent, finished or failed. The assessment traced every path:

| Operation                          | Persisted as                                                                                         | Progress reported by                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Snapshot of a local copy           | `registration_operations`, `mode = 'snapshot'`, `parent_version_id` = the source version             | The agent: `agent.registration_progress` per stage, bytes, throttled to one per 2 s |
| Remote Snapshot (Run and snapshot) | `vm_workspaces` while the emulator runs; then a `mode = 'snapshot'` registration with `workspace_id` | The workspace coordinator, then the agent, as above                                 |
| Clone from a master or a snapshot  | `registration_operations`, `mode = 'clone'`, `agent_id IS NULL`, `clone_source_version_id`           | The server (`serverProgress`), the same stages and bytes                            |
| Remaster from a local copy         | `vm_remaster_operations` and a `mode = 'remaster'` registration                                      | The agent, as a snapshot                                                            |
| Direct SFTP and HTTPS relay        | The same rows: the relay sits under the agent's `ArchiveRepository`                                  | The agent reports the same stages whichever transport it uses                       |

Every state transition is already durable, guarded (`STAGE_ALLOWED_FROM`, terminal states never overwritten,
`cancel_requested_at`), survives an API restart (agents resynchronize; the server retries its clones a bounded
number of times) and is readable through `GET /admin/registrations/:id`.

The visibility gap was therefore not in the agent or the database. It had two causes:

1. **The page held the operation's identifier in React state only** (`snapshotOperation`, `clones` in
   `Versions.tsx`). Leaving the page, refreshing or closing the browser lost it, and the banner with it, although the
   server still knew everything.
2. **No route answered "what concerns this VM?"**. `GET /admin/registrations?vmName=` filters on the row's own VM, and
   a clone's row belongs to its _destination_: clones made _from_ a VM could not be found from that VM.

## Decision

### 1. One read-only route over the existing record

`GET /admin/vms/:emulatorType/:vmName/operations` returns the VM's `snapshot` and `remaster` registrations
(`relation: "this_vm"`) and the clones whose `clone_source_version_id` is one of its versions
(`relation: "clone_source"`). Each entry is the unchanged `RegistrationOperation`. No table, column, state or
migration is added; no second tracking subsystem exists.

- **Listed:** active operations; unacknowledged partial successes; ended ones for 24 hours after `finished_at`. At
  most 50, active first. Rows are never deleted because a notice was dismissed: they are the history.
- **Indexes:** this VM's rows by `ix_registration_vm_created`, clones by `ix_registration_clone_source` through the
  VM's version ids, so a version of another VM cannot match.
- **Transport:** `server` for server work; for an agent, how it reached that repository in its latest health check
  (`agent_repositories.last_transport`), labelled as such because it is not recorded per operation.
- `serverTime` lets elapsed times use the server's clock.

### 2. A normalized phase model, by recorded state only

Defined in `packages/contracts/src/vm-operations.ts`:

| Recorded state                  | Phase                    | Shown as (clone)                 |
| ------------------------------- | ------------------------ | -------------------------------- |
| `queued`                        | Queued                   | Queued on the server             |
| any active, agent offline       | Waiting for the agent    | never: the server needs no agent |
| `validating`                    | Checking the copy        | Checking the source              |
| `archiving`                     | Packaging                | Copying the source archive       |
| `uploading`                     | Transferring             | Writing the new archive          |
| `verifying`                     | Verifying                | Verifying the new archive        |
| `committing`                    | Publishing               | Registering the new VM           |
| `cleaning_local`                | Finalizing               | (not used)                       |
| `succeeded` / `partial_success` | Completed (with problem) | VM cloned                        |
| `failed` / `cancelled`          | Failed / Cancelled       | Clone failed / cancelled         |

A percentage is shown only for `archiving`, `uploading` and `verifying` when the server holds a byte count, floored,
and never at 100: a stage whose bytes are all done shows its name alone, since verification, publication and
registration follow. Nothing is derived from elapsed time. A Remote Snapshot whose emulator runs has no registration
yet, so it shows as a session (General › Now) and never with a synchronization spinner.

### 3. One shared, bounded poll

`VmOperationsProvider` sits in the VM Manage layout, so General and Version History read the same list and there is
one request loop per open VM, not one per component. It reuses `usePolledData`: no overlapping requests, aborted on
unmount, a slow answer never overwrites a newer one, nothing while the tab is hidden. Every **2 s** while any listed
operation is active, every **15 s** otherwise (an operation started elsewhere still appears). Starting an operation
shows the API's 202 answer at once (`track`), until a listing requested after it is the authority.

When an operation is seen to end, the provider announces it once in a polite live region, bumps a revision that makes
Version History read its tree again (expanded branches and focus kept), and refreshes the VM's counts.

### 4. Presentation

- **On the version** it concerns (a snapshot on its parent, a clone on the version it copies, never by name), at the
  end of the card's toolbar before Info: `LoaderCircle` with the local `icon-spin` animation, title and phase. Several
  on one card become one "N of M operations running" control. Details open in an Info-style panel.
- **In the header**: "N operations running" (or "N recent operations"), the way to find operations on collapsed
  branches or on no single version (a remaster).
- **States without a spinner:** an offline agent (`Unplug`, "Waiting for the agent"); an unreadable listing
  (`CloudOff`, "status unavailable", the last known state and when it was received). Neither is reported as a
  failure; both recover by themselves.
- **Endings:** a dismissible notice (`CircleCheck`/`CircleX`) with the error and the recovery text the server already
  gives, and for a clone a link to the new VM (no automatic navigation). Successes are shown for 30 minutes,
  failures until dismissed or until the server stops listing them. Dismissal is kept in the browser's local storage.
- **Cancellation:** not added here. Agent operations can still be cancelled from Admin › Registrations, which the
  details panel says.

### 5. General

The page follows the conventions of 0058/0059: one "VM actions" toolbar (status chip, Make public/private with
`Eye`/`EyeOff`, View public page as an `IconLink`, the operations summary, VM information); the permanent Details
panel moved into VM information, every fact preserved; the metadata editor stays visible, at the content's full width like Run and verify (display name and description side by side from 992 px), with explicit Save in its
section toolbar and an "Unsaved changes" status; tags still save as they change. Run and verify keeps its three
labelled modes with icons (`HardDrive`, `Play`, `Camera`), its visible explanation of the selected mode, an Info panel
for all of them, labelled icon actions, and Now lists archive operations apart from emulator sessions.

## Sequence diagrams

Existing behaviour is unmarked; **[new]** marks what this decision adds.

### Snapshot of a local copy

```
Browser                 API                          MariaDB                  Agent
  │ POST …/snapshots      │                             │                        │
  │──────────────────────▶│ INSERT op (queued)           │                        │
  │◀── 202 operation ─────│────────────────────────────▶│                        │
  │ [new] track(op)       │ server.registration_request ─────────────────────────▶│
  │                       │◀──────────── agent.registration_progress (2 s) ───────│ validate, archive,
  │                       │ UPDATE state, bytes ────────▶│                        │ upload (SFTP or relay),
  │ [new] GET …/operations│                             │                        │ verify
  │──────────────────────▶│ SELECT ─────────────────────▶│                        │
  │◀── listing ───────────│                             │                        │
  │                       │◀──────────── agent.registration_result ───────────────│
  │                       │ commit version (committing→cleaning_local) ─▶│        │
  │                       │──────────── server.registration_ack committed ───────▶│
  │                       │◀──────────── agent.registration_cleanup ──────────────│
  │                       │ succeeded, finished_at ────▶│                        │
  │ [new] listing: ended → notice, live region, tree and VM read again          │
```

### Remote Snapshot followed by publication

```
Browser             API (workspace coordinator)               Agent
  │ POST …/workspaces │                                          │
  │──────────────────▶│ vm_workspaces: preparing → restore ──────▶│
  │                   │ ready → launch session ──────────────────▶│ emulator runs
  │ General › Now: remote session card (no operation, no spinner)│
  │                   │◀──────── session ended, accounted for ────│
  │                   │ publishing: INSERT snapshot op (workspace_id, parent = chosen version)
  │                   │ server.registration_request ─────────────▶│ archive, upload, verify
  │ [new] listing: "Publishing Remote Snapshot" on the chosen version, then the ending
  │                   │ succeeded → discard working copy ─────────▶│
```

### Server-side clone

```
Browser               API (clone coordinator, server runner)        Repository (server's SFTP)
  │ POST …/clone        │                                             │
  │────────────────────▶│ INSERT op (mode clone, agent NULL, queued)   │
  │◀── 202 ─────────────│                                             │
  │ [new] track(op)     │ validating → archiving (read source, rewrite) ────▶│
  │                     │ uploading (write new archive) → verifying ─────────▶│
  │ [new] listing on the SOURCE VM, drawn on the source version      │
  │                     │ commitServerClone: VM + master + provenance, succeeded
  │ [new] notice "VM cloned: <name>", link to the new VM             │
```

### Recovery after a refresh

```
Browser (new page load)            API                     MariaDB
  │ GET /admin/vms/…                 │                         │
  │ [new] GET …/operations ─────────▶│ SELECT active + recent ─▶│
  │◀── the same operations ─────────│                         │
  │ indicators drawn again; nothing was kept in the browser except dismissed notices
```

### Agent disconnection and reconnection

```
Agent ── WebSocket closed ──▶ API: agent offline; op row unchanged (still active)
Browser [new]: "Waiting for the agent", no spinner
Agent ── reconnects, agent.registration_sync (journals) ──▶ API
  journal running   → the agent resumes or reports; progress resumes; spinner returns
  journal missing   → failed (agent_lost_operation / agent_restarted); notice with recovery
  finished meanwhile → the server tells the agent to stop
```

## Consequences

- One extra `GET` per open VM page: every 2 s while an operation runs, every 15 s otherwise; nothing while hidden.
- Operations survive navigation, refresh, browser restart and API restart, because the server always had them.
- Restore is not listed: it is a different record (`restore_operations`) shown on Local copies and restore, and
  adding it was outside the mandatory scope. Promote to master is committed when recorded; snapshot deletion already
  shows on its card.
- The transport of an agent operation is its latest health check's, not per operation.
- An older API (rollback) has no route: the web build of this release then shows "Operation status unavailable";
  rolling back the web image with the API removes it.
