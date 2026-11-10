# 0040: Remote modes run a temporary copy, and finish on their own

**Status:** Accepted. Milestone 7 corrections. Supersedes the manual lifecycle of
[0038](0038-remote-snapshot-working-copies.md) and implements `remote_volatile` from
[0033](0033-remote-execution-modes.md). Their safety rules (isolation, no substitution, no removal while a VM may
run) stand.

## Context

Milestone 7 shipped Remote Snapshot as a **working copy** an administrator prepares, launches, then explicitly
preserves or discards. That is not the intended product:

| Mode              | Intended semantics                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `local`           | The persistent local copy runs, and keeps its changes                                                  |
| `remote_volatile` | A chosen remote version runs from a temporary copy, and every change is thrown away when it exits      |
| `remote_snapshot` | A chosen remote version runs from a temporary copy, and when it exits its state becomes a new snapshot |

Both remote modes need the same thing: an isolated directory holding a verified extraction of an exact version,
which no persistent copy, discovery or restore can confuse with anything else. Milestone 7 already built that,
with every safety property tested: the working copy.

Separately, restoring was refused whenever the agent already held a persistent copy, which made it impossible to
switch the persistent copy between versions.

## Decision

### A remote session is a working copy with an automatic lifecycle

`vm_workspaces` gains `purpose`: `manual` (every row that existed before this migration), `remote_volatile` or
`remote_snapshot`. A **remote session** is a working copy whose purpose is a remote mode. The administrator asks
for one in a single request naming the agent, the **version** and the mode; everything after that is driven by the
server, from the database, step by step:

```
preparing ──restore committed──▶ ready ──launch──▶ running ──emulator ended──┬─ volatile ──────────────▶ discarding ─▶ discarded
    │                              │                  │                     └─ snapshot ─▶ publishing ─┤
    └─restore failed─▶ failed      └─launch refused───┴─ (never started) ──────────────▶ discarding    │
                                                      │                                   ▲            ├─ committed ─▶ discarding
                                                      └─ ended, process not accounted ─▶ held ─resume─┘            │
                                                                                                       └─ failed ──▶ publish_failed
                                                                                                                      │  retry ─▶ publishing
                                                                                                                      └─ abandon (typed name) ─▶ discarding
```

| State            | Meaning                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `preparing`      | The selected archive is being obtained (cache or SFTP), verified and extracted by a restore       |
| `ready`          | Extracted; the launch is being sent                                                               |
| `running`        | Its session is active, `unknown` included                                                         |
| `held`           | The session ended without the agent accounting for the process. Nothing proceeds until confirmed  |
| `publishing`     | Remote Snapshot only: the snapshot of the temporary copy is being archived, uploaded, committed   |
| `publish_failed` | Remote Snapshot only: publication failed. The temporary copy is kept. Retry or abandon            |
| `discarding`     | The temporary copy is being removed. Repeated until the agent confirms                            |
| `discarded`      | Removed. For Remote Snapshot this means the snapshot was committed first, or explicitly abandoned |
| `failed`         | Preparation failed. Nothing was extracted                                                         |
| `lost`           | The agent no longer has it, or was revoked                                                        |

`preparing`, `ready`, `running`, `held`, `publishing`, `publish_failed` and `discarding` are active, and the existing
unique key still allows one active working copy per VM per agent. A Remote Snapshot whose publication is pending
therefore blocks another remote session of that VM on that agent until it is published or abandoned, which is the
conservative answer.

**The steps are the existing operations, unchanged:** the restore into the working copy ([0021](0021-restore-lifecycle.md),
[0024](0024-local-archive-cache.md)) is the download, verification and extraction; the session
([0030](0030-session-durability.md)) is the run; the snapshot registration ([0037](0037-snapshots-as-registrations.md))
is the publication, with its ZIP64 archive, SHA-256 verification, no-replace publication and idempotent commit; and
`server.workspace_discard` is the cleanup. No second archive pipeline exists.

**The server advances a remote session** whenever something it depends on changes: a restore commits or fails, a
session ends, a snapshot registration ends, a discard is answered, and after every agent welcome. A periodic sweep
retries what is due. Each step is idempotent and guarded by the row's current state, so a repeated report, a lost
answer or a restart of either side advances it exactly once:

- the launch uses the working copy's request ID, so a repeated launch finds the same session;
- each publication attempt is a snapshot registration whose request ID is **derived** from the working copy and
  the attempt's number (a SHA-256 of both, in RFC 4122 version 4 layout, which MariaDB's `UUID` type accepts). It is
  recorded in `snapshot_operation_id`, and `publish_attempts` moves, in one conditional update; until then a
  repeated attempt (after a crash, or from a second trigger) asks for the same request ID, and the registration
  coordinator's idempotency returns the operation already created. A retry first moves `publish_failed →
publishing` with a conditional update, so of two retries at once one does nothing. An attempt that failed never
  committed a version: registration commits only from a verified, published archive, and one in `committing` is
  retried by the registration coordinator, not replaced. So a retry can never produce a second version for the same
  session;
- the working copy moves to cleanup only once its snapshot registration has ended committed (`succeeded` or
  `partial_success`), so the agent is never asked to remove a directory a registration still reads;
- the cleanup is requested only from states that allow it, and repeated on every welcome until the agent confirms.

### Parent and version

The version is chosen explicitly and stored as the working copy's `base_version_id`, and as the session's
`source_version_id`. The snapshot's parent is **`base_version_id`**, never the newest version and never the persistent
copy's version. The agent checks it again against the working copy's own record, as in 0037.

### When the emulator ends

- **Agent-reported end** (`stopped`, `exited`, `failed` after a process existed): proceed. A crash of the emulator is
  an ordinary end: the agent saw the process end.
- **The emulator never started** (`failed` with no process): there is nothing to preserve, and the copy is identical
  to a verified version. Volatile and snapshot sessions are both cleaned up, and the session's error is shown.
- **Ended without the agent** (`interrupted`: the agent no longer knows the session, or it was revoked): the process
  is not accounted for, so the working copy is `held`. An administrator resumes it after checking that computer,
  typing the VM's name. Dismissing an `unknown` session is already that confirmation, and resumes it directly.
- **`unknown`** stays `running`: nothing is published or removed while the agent cannot tell.

Remote Snapshot publishes **even if nothing changed**: a snapshot is a complete, immutable version, and the run is
the record. The agent's archive build denies writers on Windows, so a process still holding a disk fails the
build with `source_in_use`, which is retried automatically.

### Failure and retry

A failed publication leaves the working copy in `publish_failed`, with the error, and never removes it. Automatic
retries are bounded (3 attempts, growing delay) and skipped for errors that cannot heal on their own (lineage,
repository disabled or not authorized, working copy missing). An administrator can retry at any time, or abandon the
snapshot by typing the VM's name; abandoning is the only way a Remote Snapshot's changes are lost, and it is refused
while the session is active or its state is unknown, as every discard is.

### Agent-side checks

The agent records the purpose with the working copy (from the restore that creates it), and refuses:

- launching a working copy in a mode other than its purpose (`workspace_purpose_mismatch`);
- snapshotting a `remote_volatile` working copy;
- removing anything while a session or an operation uses the VM, exactly as before.

It advertises `remote_volatile` alongside `remote_snapshot`. An agent that does not is refused up front, and nothing
is ever substituted.

### Legacy working copies

Rows created by Milestone 7 become `purpose = 'manual'` and keep their old lifecycle: they are listed, can be
preserved, launched or discarded by hand, and are never advanced automatically, so nothing an administrator had not
decided happens to them. Their sessions keep `mode = 'remote_snapshot'`, and the interface labels them as manual
working copies; no historical session is reinterpreted. New manual working copies cannot be created.

### Replacing a persistent local copy

A restore may now replace the agent's persistent copy, as an explicit **replacement**:

- The request carries `replace: { expectedVersionId, discardLocalChanges, confirmVmName }`. The server refuses it
  while a session of the VM is active or unknown, while the agent is busy, if `expectedVersionId` is not what it
  records (a stale page), and if the copy is recorded as modified without `discardLocalChanges`.
- The agent checks again: no session or operation on the VM; the directory is a plain directory; its recorded
  lineage names the expected version and this very directory; and, unless `discardLocalChanges`, a full verification
  against that version's manifest finds no difference. An unproven lineage counts as possible changes.
- The new version is downloaded, verified and extracted into the usual staging directory, exactly like a restore.
- Publication is journaled, on one volume, with no-replace renames only:
  1. the current directory is renamed to `.emucat-replaced-{operation}` and its identity checked;
  2. the staged directory is renamed into place;
  3. the lineage record and manifest are written for the new directory;
  4. the old directory is removed.
- After a crash: if the VM directory is the staged one, it finishes; if it is missing and the old one is beside it,
  the old one is moved back and the restore fails with nothing changed; anything else is left alone and reported.

Restore therefore works between any two versions, master and snapshots alike. When the persistent copy may hold
changes, the interface offers to snapshot it first (when its lineage is proven) before replacing it.

## Consequences

- One unified run panel offers Local, Remote Volatile and Remote Snapshot. Version History only preselects a version
  and mode in it.
- A remote session uses disk space for an extraction while it runs, and for a pending publication until it is
  published or abandoned. A volatile session's files are removed when it ends, or on the agent's next connection.
- The emulator still runs on the agent's computer; "remote" means the VM comes from the repository.
- Restore history keeps every row. Replacements are marked in it.
