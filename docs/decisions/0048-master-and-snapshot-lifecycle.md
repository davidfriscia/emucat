# 0048: A snapshot can become the master, a local copy can replace the history, and versions carry a title

**Status:** Accepted. M6. Extends [0037](0037-snapshots-as-registrations.md),
[0039](0039-version-history-is-administrative.md), [0041](0041-storage-cleanup.md) and
[0046](0046-virtualbox-management.md). Revises 0041 on one point: a master can now be deleted, but only once it is
retired by a remaster, and never the current one. Revises the immutability of `vm_versions` on two narrow points:
a lineage changes when a snapshot is promoted, and a master is retired.

## Context

A VM's history only ever grew. After years of snapshots, an administrator who wants "this snapshot is the VM now"
could only keep everything, or delete leaves one by one, and could never remove the master. Nor could a local copy
that had drifted far from every version be made the new starting point without registering a second VM. Versions
also had only generated names, so nobody could say what a snapshot was for.

Three things had to hold whatever the new operations did: an archive is never re-uploaded or changed in place; nothing
is deleted that is still needed, or before what replaces it is safe; and a decision made in a browser is applied only
to the history the browser showed.

## Decision

### Promoting a snapshot to master

`POST …/versions/:versionId/promotion` makes a snapshot the master, in one transaction:

- **What is kept is decided by lineage only**: the promoted snapshot and every version descended from it
  (`remasterPlan` in [`remaster.ts`](../../packages/contracts/src/remaster.ts)). Creation times are never consulted, so
  a clock that was wrong when something was made cannot change the answer. Everything else (the old master, the
  promoted snapshot's ancestors and every unrelated branch) is removed.
- The promoted row **keeps its id, archive key, SHA-256, size, manifest, title, description and creation time**. Its
  `kind` becomes `master`, its parent becomes `NULL`, and the promotion is recorded beside them in `promoted_at` and
  `promoted_from_parent_version_id`. Its archive is reused as it is: nothing is uploaded, copied or renamed.
- The old master is **retired** (`retired_at`), and every removed version is tombstoned in `vm_version_deletions` with
  the remaster's id. Those rows are the remaster's **deletion manifest**: they name each archive exactly, by the key
  recorded for it, and survive any restart.
- The master is never promoted (there is no button for it, and the server answers `version_is_master`), nor a version
  being deleted (`version_deleted`).

### Remastering from a local copy

`POST …/remaster/local` exports one agent's local copy as a **new master that replaces the whole history**. It is a
staged replacement, never a deletion followed by an upload:

1. **Exporting, Uploading, Verifying.** A `registration_operations` row with `mode = 'remaster'` is created, and the
   agent is sent an ordinary copy (`mode: "copy"`; for VirtualBox, the ordinary OVA export of the linked machine by
   UUID). Agents need no change and never see the word "remaster". While it runs nothing in the history changes,
   and new uses of any version of the VM are refused with `remaster_in_progress`.
2. **Committing new master.** Only when the agent reports the archive uploaded and verified does the registration's
   commit transaction call the remaster: it re-reads the history under lock, retires the old master, inserts the new
   one, tombstones every other version into the manifest, and records that the copy now comes from the new master.
   If the export fails, is cancelled or never commits, the remaster ends `failed` and **the history is exactly as it
   was**.
3. **Cleaning obsolete archives**, then **Completed** (below).

The administrator must type the VM's name exactly. The copy must be idle: no session of the VM on that agent
(`vm_running`), nothing else working on it, and for a directory emulator a copy the agent holds. For VirtualBox it must
be the **linked** machine, present, accessible and powered off; the link and its UUID are kept, now pointing at the
new master. Nothing is ever stopped, and no local copy is ever deleted.

### Cleanup, idempotent and exact

A remaster is `cleaning` from its commit until every archive in its manifest is confirmed gone, then `completed`.
Cleanup reuses [0041](0041-storage-cleanup.md)'s archive deletion as it is: `server.archive_delete` names a version,
and the agent derives the key itself, refuses any other, never deletes an object of another size, and answers
`deleted` or `absent` only after looking again. Every attempt can be repeated; a failure is retried automatically
with a growing delay, and `POST /admin/remasters/:id/cleanup/retry` asks again now. Nothing is ever deleted by
prefix, directory or listing. Versions being cleaned up leave the drawn tree at once, so the history shows a single
root.

VirtualBox OVAs could not be deleted before. An agent now says `deleteVirtualBoxArchives: true` in
`agent.restore_sync` when it derives `archives/virtualbox/<key>/<id>.ova` keys; the server sends an OVA deletion to no
other agent, so older agents are never asked for one they would refuse.

### Optimistic concurrency

Every preview carries a `revision`: a SHA-256 over every version's id, kind, parent, retirement and deletion state.
Titles are not part of it, so editing one does not invalidate a preview. A promotion or local remaster names the
revision it was confirmed against, and a history that changed since is refused with `version_history_stale`,
changing nothing. The same check runs under the VM's row locks, so two remasters cannot both pass it. A repeated
`requestId` returns the same remaster.

A remaster is refused while anything else works on the VM or uses a version that would be removed: an active
registration, VirtualBox operation, restore, remote session, verification or local copy removal
(`operation_in_progress`, `version_in_use`), or another remaster (`remaster_in_progress`).

### Lineage of copies that are left behind

A copy on another agent that comes from a removed version is **kept exactly as it is**: its
`local_source_version_id` still names that version. The preview lists such copies; the administrator must
acknowledge them (`acknowledgeLineageConflicts`), or the request is refused with `source_lineage_conflict`. Such a copy
can still run, be restored over or be removed. It cannot be snapshotted, because its parent is gone, until it is
restored (for VirtualBox, imported and relinked).

### Titles and descriptions

Every version has an optional **title** (at most 120 characters, trimmed, one line) and **description** (at most 2000
characters, multiline). Both are plain text: control characters other than tab and line breaks are refused, nothing
is ever interpreted as HTML, and the page shows them as text. Lengths are counted in characters, not UTF-16 units.
Both can be given when a snapshot is created and edited later with `PATCH …/versions/:versionId`. That changes nothing
else: not the archive, the SHA-256, the lineage or the creation time. A title is never generated: a version without
one shows its generated label, as before.

### Enforced by the database

Migration `0017_master_lifecycle` keeps `vm_versions` immutable except for title and description and the two
transitions above, each allowed only in its exact shape (a snapshot becoming a parentless master with
`promoted_at` set; a current master gaining `retired_at`, once). A deleted version cannot be promoted. The single-master
index now counts only masters that are not retired, so the old and new masters can coexist for the instant between
retirement and promotion within one transaction. Tombstones may name snapshots and retired masters, never the current
master.

## Consequences

- An administrator can shorten or restart a history without registering a new VM, and without ever losing a version
  before its replacement is safe.
- A remaster cannot be undone. The page says so, lists what will be deleted and how much, and requires an explicit
  confirmation; a local remaster requires the VM's name.
- A remaster in progress blocks other work on the VM, briefly for a promotion and for the length of an export for a
  local remaster.
- A remaster whose archives cannot be deleted yet stays `cleaning`, visibly, and finishes on its own once an agent
  that can delete them comes back.
