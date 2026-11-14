# 0043: The agent page is for discovery; registrations are a paginated history

**Status:** Accepted. Amends how [0015](0015-registration-state-machine.md) operations are listed and shown. Nothing about
how a registration or a snapshot ([0037](0037-snapshots-as-registrations.md)) runs, recovers or commits changes.

## Context

An agent's page loaded the newest 100 `registration_operations` of that agent, in every state, and showed each as a full
card above the discovery report. Operations are durable history that is never deleted (their foreign keys are
`RESTRICT`), and snapshots are registrations too, so one VM gathers several: its master, each snapshot, and every failed
attempt. After a few weeks of use the page was mostly history, and its purpose, finding the VMs on an agent that are not
in the catalog yet, was below it.

The page also used that history for something else: it marked a discovered VM as registered when a committed operation
for it was in the list, because the report was not read again after it completed. Removing history from the page without
replacing this would have offered a just-registered VM again until the next scan. The server always refused the second
registration (`vm_already_registered`), but the page should never offer what the server refuses.

On one server, the history of `86box/486-dos622ita` read as two masters. It was one master (a Copy) and one snapshot,
whose card said "Master version", next to a failed snapshot whose card said "No master was created". The schema allows
only one master per VM (`uq_vm_versions_one_master`), and that was never in question; the words were wrong.

## Decision

**The agent page shows, in order: what needs attention, discovery, recent history.** Discovery is the page's purpose.
Unregistered VMs come first. Registered ones are behind a "Show N already registered VMs" toggle, each linking to its
catalog page. A compact table of the eight most recent ended operations follows, with a link to the full history.

**"Needs attention" follows the lifecycle, not chronology.** An operation needs attention while it runs (`active_marker`
is set: queued up to cleaning up locally, `committing` included), and when it ended as a `partial_success` that nobody
has acknowledged. A partial success means the version is committed and the local copy was left in a state only a person
can deal with: kept after a failed removal, or unknown after the agent lost track of it. A `failed` or `cancelled`
operation committed nothing and left the local VM as it was (0015), so it is history only, however recent. Whether a
later operation succeeded is never used: that would hide a problem the later operation did not solve.

**A partial success is acknowledged explicitly.** Some partial successes can be retried (a removal blocked by a
screenshot or a running VM); others need someone to act on the agent's disk, which the server cannot observe. Without a
way to say "dealt with", they would stay on the page forever. `POST /admin/registrations/:id/acknowledge` records who and
when, and changes nothing else. Retrying a removal clears it, since the cleanup starts again. The schema refuses an
acknowledgement on anything but a partial success.

**The rule is one column.** Migration 0013 adds `attention_marker`, a stored generated column that is 1 exactly when
`registrationNeedsAttention()` in `@emucat/contracts` holds. The listing filters on it, an index serves it, and nothing
else can disagree with it.

**One endpoint, additive.** `GET /admin/registrations` keeps its default (the newest 100 of everything, newest first) and
gains a `view` (`all`, `attention`, `history`), filters (agent, emulator, exact VM, part of a name, mode, states, date
range), `limit` up to 100, and a `cursor`. Responses add `nextCursor`, and for the attention view `total`, so a page
size never hides an operation that needs someone: the page says how many there are and links to all of them.

**Keyset pagination, by `created_at` then `id`.** The cursor is the last row's pair, base64url-encoded, validated on the
way in, and opaque to clients. Rows created while someone pages through are newer than every cursor, so they never shift
or repeat a later page. Indexes `(agent_id, created_at, id)`, `(emulator_type, vm_name, created_at, id)` and
`(attention_marker, agent_id, created_at, id)` let each listing read along an index in its own order; the second replaces
`ix_registration_vm`, its prefix. A state filter has no index of its own: states are few, and the filter is applied while
reading along the agent, VM or creation-time index.

**Registration status on the page comes from the server.** The discovery report already says, when read, whether each
VM is in the catalog. The page reads it again whenever an operation on the agent moves on, when the agent reconnects,
and every 15 seconds; this is a read of the server's copy and a catalog lookup, never another scan. While an operation is
committed but not finished, the page treats its VM as registered, since the master exists. The report now also carries
`expiresAt` and `fromCurrentConnection`, from the same policy the registration check uses, and the page offers no Copy or
Transfer from a report the server would refuse as stale.

**A snapshot reads as one.** "Snapshot created", "Snapshot version", the snapshot's name and its parent, and "No snapshot
was created". A master reads as before. The version links to its place in the VM's version history; a version deleted
since by storage cleanup ([0041](0041-storage-cleanup.md)) says so, and is not linked. Each operation names its parent's
snapshot name, and whether its version has a tombstone.

**The full history is `/admin/registrations`.** Every registration and snapshot of every agent, newest first, one server
page at a time, with Newer and Older following the cursors already returned. Filters live in the URL. From an agent's page
it opens filtered to that agent.

## Consequences

- An agent with thousands of registrations has the same page as one with none: at most five attention cards with a count,
  and eight history rows. No request returns more than 100 operations, and idle polling reads two small pages.
- Nothing is deleted to achieve this, and no retention period is introduced: the history stays complete.
- No agent or protocol change was needed. The server already had everything the page uses.
- Acknowledgement is a new administrative fact with its own audit fields. It is not a resolution of the local copy, and
  the page does not claim one.

## Alternatives considered

- **Hide failures that a later success "resolved".** Rejected: whether a later operation succeeded says nothing about
  whether an earlier one left something behind, and a plain failure left nothing behind anyway.
- **Offset pagination with page numbers**, as the catalog does. Rejected for history, which grows at the front while
  someone reads it: offsets would shift and repeat rows, and counting a long history on every page costs more than it
  helps.
- **A tab on the agent page for history.** Rejected: the history is useful across agents (the same VM is often handled by
  several), and a route can be linked to with its filters.
