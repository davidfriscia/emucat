# 0041: Removing a local copy, and deleting a leaf snapshot

**Status:** Accepted. Milestone 7, storage cleanup. Amends the [Retention](0037-snapshots-as-registrations.md#retention)
section of 0037, which said nothing deletes a version. Everything else in 0021 to 0040 stands.

## Context

Two things could not be undone by the product, only by hand: a persistent local copy on an agent, and a snapshot in the
repository. Both are destructive, both touch state that several durable operations depend on, and neither is "delete a
row" or "delete a directory":

- An agent's persistent copy is described in three places: the directory under the base path, the agent's lineage record
  and local manifest, and `agent_vm_state` on the server. A launch, a snapshot, a restore, a verification and a
  replacement each read some of them. Remote sessions run **working copies**, which are not persistent copies and must
  never be taken for one ([0038](0038-remote-snapshot-working-copies.md), [0040](0040-temporary-remote-sessions.md)).
- A version is an immutable `vm_versions` row (a trigger refuses every `UPDATE`) that restore, session, verification,
  registration and working-copy history reference with `RESTRICT` foreign keys. Its archive is an object the **server
  cannot reach**: archives travel only between agents and the repository, and the server holds no repository credential
  ([0012](0012-direct-agent-repository.md)).

What the assessment established, and what this record relies on:

| Question                                        | Answer in the code                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Is an archive shared between versions?          | No. `uq_vm_versions_archive` is unique, and the key is `archives/{emulator}/{vm}/{version_id}.zip`     |
| Can identical bytes be cached for two versions? | Yes: the agent's archive cache is content-addressed. Deleting one version's object leaves the cache    |
| Can a version row be updated or deleted?        | No update (trigger). A delete would be refused by history's foreign keys, which must stay              |
| Who can delete an archive?                      | Only an agent, through `ArchiveRepository::delete`, which already exists and treats "missing" as done  |
| What removes a directory safely on the agent?   | The transfer cleanup's quarantine rename (`.emucat-removing-{operation}`) and identity-checked removal |
| What says a VM is in use on the agent?          | The execution manager (sessions, `unknown` included) and the shared operation slot                     |

## Decision 1: removing a persistent local copy is a durable operation

### On the server

A new table `local_copy_removals`, one row per request, kept after it ends:

```
requested ──agent removed it──▶ succeeded            (cleanup_pending while leftovers are still being deleted)
    └──────agent refused, or the operation was lost──▶ failed
```

- The request names the agent, the VM, the **version the page showed as installed** (`expectedVersionId`, `null` when
  none was recorded), `discardLocalChanges` and a browser-chosen `requestId`. Never a path.
- The server refuses (`409`, with the reason) unless: the agent is paired, online and says it can remove copies
  (`removeLocal`); `agent_vm_state` records a present copy; that record names `expectedVersionId` (otherwise
  `local_copy_changed`: the page is stale); it is not recorded as `modified`, unless `discardLocalChanges`
  (`local_copy_modified`); no session of the VM on that agent is active, `unknown` included (`vm_running`); and the agent
  has no active restore, registration, verification, working copy operation or other removal (`operation_in_progress`).
- It is decided in one transaction that takes the agent's row lock **exclusively**, as a restore does, so no restore,
  snapshot, registration, launch or verification can be created alongside it. `active_marker` allows one active removal
  per agent, and every other operation now counts an active removal as "busy".
- A repeated `requestId` finds the same operation; reused for anything else, it is refused.
- The command goes out when created and again after each welcome, **only until the agent has acknowledged receiving
  it** (`accepted_at`: it listed the operation in `agent.restore_sync`, or reported on it). An accepted operation that a
  later sync no longer lists, and that has no report, is `failed` with `agent_lost_operation`, and is never sent again.
  So a lost state directory can never turn an old request into a new deletion.
- On `removed`, one transaction marks the operation `succeeded` and **deletes the `agent_vm_state` row**, if it still
  names the expected version. The agent then holds no copy: Local launch is unavailable on it, remote modes are not
  affected, and stale discovery or sync reports cannot bring the row back (they only update existing rows).
- Restore, session and verification history is untouched: those rows never referenced `agent_vm_state`.

### On the agent

A journal per operation under `local-removals/`, written before anything moves:

| Phase      | What has happened                                                                  | After a restart                                                                                     |
| ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `checking` | Nothing                                                                            | Reported as `agent_restarted`: nothing was removed                                                  |
| `moving`   | The directory's path and volume/file ID are recorded; the rename may have happened | The disk decides: moved aside with that identity → `removing`; still in place → nothing was removed |
| `removing` | Moved aside, lineage and manifest forgotten                                        | Deleting resumes                                                                                    |
| `reported` | The answer is recorded and repeated until the server closes it                     | Repeated                                                                                            |

1. The operation claims the agent's single operation slot (`agent_busy` otherwise) and marks the VM busy, so nothing can
   launch, restore, snapshot, verify or discard it until it has finished, whatever the server sends.
2. It refuses while the execution manager says the VM runs or may run (`vm_running`), and while any operation works on
   it (`operation_in_progress`).
3. The VM's directory is found exactly as a replacement finds it: the one entry of the configured base path with the
   VM's name, in any capitalization, which must be a plain directory, not a link or junction, under a base path that is
   not one either. Nothing the server sends is a path. Working copies live under the state directory, so they cannot be
   found this way.
4. Lineage is checked as for a replacement ([0040](0040-temporary-remote-sessions.md#replacing-a-persistent-local-copy)):
   a record naming another version is `local_copy_changed`. **Stricter than a replacement:** a record made for another
   directory is also `local_copy_changed`, even with `discardLocalChanges`, because nothing the administrator saw
   describes that directory. Without `discardLocalChanges`, an unproven lineage is `local_copy_unverified`, a full
   verification that finds differences is `local_copy_modified`, and a screenshot that the server does not hold is
   `local_copy_unsynced_media` (screenshots are not in archives, so removing the directory would lose them).
5. The directory is renamed, with a rename that refuses to replace anything, to `.emucat-removing-{operation}` in the
   same base path: one atomic step on one volume. On Windows it fails if a file inside is open (`local_copy_in_use`).
   A leading dot is not a valid VM name, so discovery never reports the quarantined directory.
6. The lineage record and local manifest are forgotten, so the agent no longer reports a copy.
7. The quarantined directory is deleted only after checking that it is a plain directory with the recorded identity.
   `remove_dir_all` removes links and junctions inside without following them. A deletion that stops partway (a file
   held by a scanner, say) is retried a few times; if it still cannot finish, the result is `removed` with
   `cleanupPending`, and the agent retries at each start and connection until it is gone. The copy is already removed
   in every sense that matters: it cannot be found, launched, discovered or reported.

A retry or a repeated command can only ever touch `.emucat-removing-{operation}` with the recorded identity, never the
VM's path again, so it can never delete a newly restored copy or another directory that took the name.

## Decision 2: deleting a snapshot is a tombstone, then an agent deletes the archive

### Policy

**Leaf only.** A snapshot can be deleted if, at the moment its deletion is recorded, and under the locks below:

| Rule                                                                                            | Refusal                    |
| ----------------------------------------------------------------------------------------------- | -------------------------- |
| It is a snapshot. The master is the root of the tree and is never deleted                       | `master_cannot_be_deleted` |
| It has no child that is not deleted (a child being deleted still counts)                        | `snapshot_has_descendants` |
| No active restore restores it or replaces a copy of it                                          | `snapshot_in_use`          |
| No active registration has it as its parent (a snapshot or a Remote Snapshot publication)       | `snapshot_in_use`          |
| No active working copy has it as its base or source (remote sessions and manual working copies) | `snapshot_in_use`          |
| No active session runs it, and no active verification compares with it                          | `snapshot_in_use`          |
| No agent records a present persistent copy of it                                                | `snapshot_installed`       |
| An online agent is authorized and configured for its repository                                 | `repository_unavailable`   |

There is deliberately no cascade, no reparenting, no branch deletion, no automatic replacement of installed copies and
no garbage collection. An installed copy has to be replaced or removed first, explicitly.

### Tombstone

`vm_versions` rows stay, untouched: they are immutable, and history references them. A new table
`vm_version_deletions` holds one row per deleted version: `deleting` or `deleted`, who asked and when, the archive's
key, size and hash copied for the audit, the attempts, the last error, and how the archive went (`deleted`, or
`already_absent`). Every query that offers a version for anything (the tree, restore options, restores, remote sessions,
snapshot parents, verifications, launches) now leaves out versions with a deletion row. History keeps its rows and its
foreign keys, and names a deleted version by its ID and label.

Because only leaves are deleted, and a deleted version's children would have had to be deleted first, no surviving
version ever has a deleted parent, and the tree the client builds stays a tree.

### Concurrency

The deletion is recorded in one transaction that starts with `SELECT … FROM vm_versions WHERE id = ? FOR UPDATE`, then
checks every rule above with locking reads, then inserts the tombstone. Everything that creates a new reference to a
version (a restore, a remote session, a snapshot with it as parent, a verification against it) now takes that row's lock
in share mode, then checks the tombstone **with a locking read**, before inserting anything. So one of two things
happens, whatever the timing:

- the creator locked first: the deletion waits for it to commit, and then sees its active reference and refuses; or
- the deletion locked first: the creator waits, then sees the tombstone, and is refused with `version_deleted`.

From the moment the tombstone exists the version is invisible to every selection and refused by every creator, so it
can no longer gain a reference while its archive is being deleted.

### Deleting the archive

The server sends `server.archive_delete` to one online agent that is authorized and configured for the repository,
naming the version, its VM, the repository, its archive key, size and hash. The agent:

1. derives the key from the VM and version ID itself and refuses if it differs from what was sent: no key the server
   sends is ever used as such, so no retry can name another object;
2. looks at the object: absent is reported as `absent`; present with another size is **not** deleted
   (`archive_mismatch`);
3. deletes it through `ArchiveRepository::delete`, then looks again, and reports `deleted` only once it is gone.

It holds no journal and no operation slot: every step is idempotent, and it reads nothing local.

On `deleted` or `absent`, one transaction moves the tombstone to `deleted` and records the outcome: `deleted`, or
`already_absent` when no earlier attempt had been sent, which is how a missing archive is told apart from one a lost
answer had already deleted. A failure leaves the tombstone in `deleting` with the error; the server retries by itself
(growing delay, any eligible agent), after each welcome of an eligible agent, and when an administrator asks. Nothing
removes the catalog's knowledge of the version before the repository has confirmed, and nothing makes it selectable
again: once deletion has begun, the archive may already be gone.

| Failure                                        | What happens                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Repository unreachable before deleting         | `deleting`, with the error. Retried                                                             |
| Connection lost during the delete              | The agent's second look decides. Otherwise a failure, retried; the next attempt finds it absent |
| Archive deleted, then the API crashed          | The tombstone is still `deleting`; the next attempt finds it absent and finishes                |
| The transaction recording the tombstone failed | Nothing was recorded and nothing was sent: the version is unchanged                             |
| Repeated delete requests                       | They find the same tombstone                                                                    |
| A restore, session or snapshot racing it       | One of the two is refused, as above                                                             |
| An agent that reconnects with stale versions   | Only existing rows are updated, and a tombstoned version is never offered or accepted again     |

An agent that comes back holding a persistent copy of a deleted snapshot (recorded `absent` at the time) keeps it, can
launch it, replace it or remove it, and cannot snapshot from it, since its parent no longer exists.

## Consequences

- An administrator can free an agent's disk, and the repository's, without touching any other version, agent or
  record.
- The archive cache of an agent is not purged: it is content-addressed, small, and evicts by itself.
- A version whose deletion cannot reach the repository stays `deleting`, hidden and unusable, until an agent can.
  There is no "undelete": the archive may already be gone.
- Repository-wide garbage collection, retention policies and bulk deletion remain out of scope.
