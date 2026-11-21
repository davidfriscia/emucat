# 0050: Screenshots keep an administrator's order, stay deleted, and everything can be tagged

**Status:** Accepted. Extends [0019](0019-media-processing-and-storage.md),
[0027](0027-catalog-detail-and-public-covers.md), [0036](0036-vm-level-publication.md) and
[0039](0039-version-history-is-administrative.md). Migration `0019_media_order_and_tags`.

## Context

Administrators could already delete a screenshot, but the agent still has the file. Deleting from EmuCat never
touches it, by design ([the media guide](../media.md)), so the next time the agent's queue was rebuilt, or the file was
found again under another name, the same bytes were uploaded and the screenshot came back.

Galleries were ordered by the main image first, then by capture time. Administrators want to choose the order.

There was no way to label VMs, versions or screenshots, or to find a VM by such a label.

## Decision

### A deletion is remembered, by content, per VM

Deleting a screenshot writes a row to `vm_media_suppressions` keyed by `(emulator_type, vm_name, original_sha256)`, in
the same transaction that deletes the `vm_media` row and its files (shared files are kept while another row refers to
them, as before). While that row exists:

- An agent upload of exactly those bytes to that VM answers **200** with `created: false, suppressed: true` and the
  deleted item's ID, and stores nothing. The agent treats any 2xx as done and marks the file completed, so it is not
  sent again unless it changes. No agent change was needed, so agents already in the field benefit at once.
- Acknowledgements **do not** include the hash: they name only what the server stores. (A transfer once relied on
  them; since [0051](0051-screenshots-are-not-vm-state.md) nothing in a VM's lifecycle does.)
- An **explicitly requested capture** (QEMU or VirtualBox) of identical bytes is an administrator asking for that image
  now: it lifts the suppression and creates the screenshot again.

A changed file has a different hash and is a new screenshot. The same bytes in another VM are that VM's screenshot.
There is no interface for lifting a suppression yet: deleting the row, with the API stopped, is the manual way.

Alternatives: deleting local files from the server was refused (a server never names a local path, and the
distinction between catalog and disk is deliberate); a per-agent ignore list would need an agent update and would be
lost with the agent's state directory; a soft-deleted `vm_media` row would keep private files and complicate every
query.

### Order is a column, and the whole order is saved at once

`vm_media.sort_order` holds a position within the VM, compared only within it, with the ID as tie-breaker so the
order is always total. The migration gives existing screenshots the order galleries already showed (main image first,
then capture or upload time), without touching `updated_at`. New uploads take the largest position plus one under the
VM's row lock, so they come last. Deleting leaves gaps, which change nothing.

`PUT /admin/vms/:emulatorType/:vmName/media-order` takes every screenshot ID, once each, first to last, and writes the
positions in one transaction under the same VM lock every media change takes. A list that is not exactly the VM's
current screenshots, because one arrived or was deleted since, is refused with `409 media_order_conflict` rather
than guessed at; duplicates are a `400`. Concurrent saves run one at a time, and the last wins. The browser sends
nothing while arranging, only the final order.

The main image is no longer moved to the front: it is the cover, decided separately, and the order is the
administrator's. A main image that was first before the upgrade stays first until someone reorders.

### Tags: one catalog, one association table per kind of entity

`tags` holds the display name, without `#`, and a `normalized_name` (lower case) that is unique. Names are normalized
by the rules in `@emucat/contracts` (`normalizeTagInput`): Unicode NFKC, surrounding whitespace and leading `#` removed,
inner whitespace turned into `-`, at most 48 characters, a letter or digit first and only letters, digits, marks and
`. _ + -` after it. `#Windows 95`, `windows-95` and `WINDOWS-95` are the same tag. Creating an existing tag returns it.

Associations are `vm_tags`, `vm_version_tags` (masters and snapshots are both `vm_versions` rows; a promoted snapshot
keeps its tags) and `vm_media_tags`, each with real foreign keys, rather than a single table with a loosely typed
entity reference that nothing could check. A screenshot's tags go with it; tags are never inherited in either
direction. Assignment replaces an entity's whole set in one transaction (`PUT …/tags { tagIds }`), so the interface
shows only what the server confirmed. Unused tags stay in the catalog; there is deliberately no rename or delete yet.

### Search

The existing catalog search gains tag matches, in SQL, with `EXISTS` subqueries so that each VM appears once however
many of its children match, and pagination stays deterministic. `#retro` matches that tag exactly and nothing else;
plain text also matches any tag containing it. A VM matches through its own tags and its screenshots' tags, and, for
administrators only, through its masters' and snapshots' tags, excluding versions that are deleted or being deleted.

### Visibility

Public responses carry a public VM's own tags and its screenshots' tags, which are as public as the VM. Version tags
are never in a public response or a public search, because version history is administrative
([0039](0039-version-history-is-administrative.md)). There is no public tag listing: `/admin/tags` is administrators
only, since a tag's existence can say something about private VMs.

## Consequences

- Deleted screenshots no longer come back, without an agent update.
- Since [0051](0051-screenshots-are-not-vm-state.md), screenshots, deleted or not, never block a transfer or removal at all.
- Galleries everywhere follow one stored order. The main image may now appear anywhere in the gallery.
- Tags add four tables and three indexed joins to searches with text; with the existing `LIKE` search on names and
  descriptions this stays a scan of the VM table, as before.
