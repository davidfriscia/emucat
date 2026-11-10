# 0037: A snapshot is a further registration of a registered VM

**Status:** Accepted. Milestone 7.

## Context

The schema has held snapshots since the first migration: `vm_versions.kind = 'snapshot'`, a non-null parent, a
composite foreign key that keeps the parent inside the same VM, a trigger that makes rows immutable, and archive
keys derived from the version UUID ([0003](0003-version-identity.md), [0004](0004-schema-invariants.md)). What was
missing is a way to produce one.

Producing one means exactly what a **copy** registration does: read a local VM, build the standalone ZIP and its
manifest ([0014](0014-archive-and-manifest.md)), upload it to the staging key, verify it there, publish it with a
link that cannot replace anything ([0012](0012-direct-agent-repository.md)), and commit the metadata only once the
agent has reported a verified, published archive ([0015](0015-registration-state-machine.md)). The journal, the
repeated reports, the acknowledgements and the handling of lost answers are all the same.

## Decision

**A snapshot is a `registration_operations` row with `mode = 'snapshot'`.** It is not a new table and not a new
pipeline. Its states, its journal on the agent, its staging key, its publication and its recovery are a copy's,
unchanged. Only the commit and the checks before it differ.

| What              | Copy / transfer                   | Snapshot                                                                  |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------- |
| VM                | Must not be registered            | Must be registered                                                        |
| Request names     | A discovery that found the VM     | The VM, the agent, and the **parent version the administrator chose**     |
| Repository        | Chosen by the administrator       | The parent's repository, so a VM's versions never scatter                 |
| Commit inserts    | The VM and its master             | One `vm_versions` row, `kind = 'snapshot'`, with the parent and the name  |
| Local state after | Copy: verified copy of the master | Verified copy of the new snapshot (`local_source_version_id` moves to it) |
| Removes anything  | Transfer only                     | Never                                                                     |

### Lifecycle

```
queued → validating → archiving ⇄ uploading ⇄ verifying → committing → cleaning_local → succeeded
   └──────────────────────┬─────────────────────┘             │
                          └→ failed, cancelled ←──────────────┘
```

Exactly [0015](0015-registration-state-machine.md)'s, without the transfer branch: `cleaning_local` only records
the local copy as `preserved`, so `partial_success` cannot arise from a healthy agent.

### The parent is explicit, and must agree with the local copy

The administrator names the parent. The server refuses the request (`snapshot_parent_mismatch`) unless it equals
the agent's recorded `local_source_version_id` for that VM, and refuses it (`snapshot_parent_unknown`) when there
is none. The agent checks the same against its own local state file and refuses with the same code.

**Lineage is proven per directory, never taken on trust.** The agent's record of where a copy came from also holds the
volume and file ID of the directory it was made for: the one a restore published, a copy or snapshot read, or a
verification found identical to its version. A snapshot is accepted only when the record names the parent **and** the
directory under the VM's name is that same directory, before and after archiving. Otherwise it is refused with
`snapshot_lineage_unverified`, and nothing is published:

| Situation                                                        | Result                                        |
| ---------------------------------------------------------------- | --------------------------------------------- |
| No record on the agent                                           | Refused. The server's belief is not evidence  |
| A record written before Milestone 7, with no directory identity  | Refused, and the record is kept               |
| A record for another directory: the copy was replaced by another | Refused                                       |
| Discovery saw the copy disappear and come back (`unknown`)       | Refused by the server before anything is sent |
| A record for this directory, naming another version              | `snapshot_parent_mismatch`                    |

**Compatibility.** Existing registrations, masters and catalog rows are untouched. A legacy copy that is unchanged
becomes snapshottable by **verifying it**: a verified result is the copy, file for file, so the agent records its
lineage with the directory's identity, and the server marks it `idle` and `verified`. Verification checks the copy
against the version it is recorded as coming from, or the master. A legacy copy that has changed cannot be attributed
to any version, so its changes cannot become a snapshot; restore the version to change, or use Remote Snapshot. There
is deliberately no override: a wrong parent would be permanent, since versions never change.

On Windows a file ID identifies a directory for as long as it exists. On other platforms an inode can be reused once a
directory is deleted, so a replacement made after deleting the original may go unnoticed there.

So:

- a snapshot always branches from **the version the local files came from**, never silently from the newest one;
- after restoring an old version, the next snapshot is a child of that old version, which is how branches appear;
- a stale page, or a server whose database was restored, cannot record a lineage the agent's disk contradicts.

The parent's lineage is still the agent's claim: nothing can prove that a directory with the same name descends
from a version, short of comparing contents, which a modified copy would fail by definition. This is the same
trust boundary as [0012](0012-direct-agent-repository.md).

### Invalid relationships are impossible in the database

- **Cross-VM parents:** `fk_registration_parent` and `fk_vm_versions_parent` are composite foreign keys including
  `(emulator_type, vm_name)`.
- **Cycles:** a parent must exist before its child, and no version ever changes, so none can form.
- **Shape:** `ck_registration_snapshot` requires a parent and a name exactly when the mode is `snapshot`.
- **Duplicates:** the version UUID and archive key are issued when the operation is created, and `request_id` is
  unique, so a repeated click, a retried request or a lost acknowledgement finds the same operation and can never
  produce a second snapshot. A request ID reused for a different VM, agent or parent is refused.
- **Concurrency:** the existing `active_marker` keys allow one active operation per VM, across agents, and one per
  agent. Creating a snapshot takes the agent's row lock in share mode, as a registration does, so it cannot start
  alongside a restore, a verification or a launch.

### Running VMs

The server refuses while the VM has an active session on that agent, `unknown` included ([0030](0030-session-durability.md)).
The agent asks its execution manager again when the request arrives, and the archive build denies writers on
Windows, so an emulator holding a disk open fails the build with `source_in_use`. A launch is refused while the
snapshot runs, on both sides (`vm_busy`).

### When the archive is published and the commit is not

Unchanged from [0015](0015-registration-state-machine.md): the operation stays in `committing`, the agent keeps
reporting, and each report retries the commit. An administrator can retry it from the stored metadata. If it is
cancelled before the commit succeeds, the answer says `deletePublished` and the agent removes the archive, which
nothing refers to. If the database itself is lost, the archive is an **orphan**: a complete, verified object under
`archives/{emulator}/{vm}/{version_id}.zip` that no row refers to. It is never overwritten, because no new version
can have its UUID. Nothing deletes it automatically; see [Retention](#retention).

### Snapshot names

`VM_NAME_YYYYMMDDhhmm`, in UTC, from the moment the operation is created, stored with the operation and copied to
the version. Two snapshots in one minute share a name, which is why nothing uses it as a key.

### Agents that cannot snapshot

`agent.registration_sync` now says `snapshots: true`. An agent that does not say so is refused up front
(`agent_cannot_snapshot`); an older agent would refuse the unknown mode in any case.

## Retention

Nothing deletes a version. `fk_vm_versions_parent` is `RESTRICT`, so a version with children cannot be removed even
by hand without removing them first, and the master is the root of everything. A safe deletion model needs to know
which archives a running restore, a cache entry or a working copy depends on, and is deferred.

## Consequences

- Snapshots appear in the registration history, with their mode, and reuse its progress, cancellation and retry.
- `registration_operations` remains the record of what the agent verified about every archive, masters and
  snapshots alike, which is where a restore finds the manifest hash it expects.
