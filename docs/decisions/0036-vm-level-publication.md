# 0036: Publication is decided by the VM alone

**Status:** Accepted. Supersedes the per-media visibility rules of [0004](0004-schema-invariants.md),
[0008](0008-public-reads-and-media-lifecycle.md) and [0027](0027-catalog-detail-and-public-covers.md). Their other
rules, on public response shapes, file serving, deletion and the main image, are unchanged.

## Context

Until now a screenshot was public only when two separate settings agreed: its VM was `public`, and the screenshot
itself was `published`. That was safe, but it was also the defect [0027](0027-catalog-detail-and-public-covers.md)
traced: a VM made public showed a placeholder, because its screenshots were still private, and the remedy needed a
warning, a cover status and a dedicated button. In practice, an administrator decides whether a machine is in the
public catalog. Whether each of its screenshots is in it too was a second decision nobody wanted to make.

`vm_media.visibility` had no other purpose. Nothing in the agent, the synchronization protocol, ingestion,
conversion, thumbnails, restore or execution reads it. The agent had a Rust mirror of the type that nothing used.

## Decision

**A VM is public or private, and its screenshots are the same.** A public VM's thumbnails and full JPEGs are public,
in the catalog card, the detail page's gallery and the media file route. A private VM's are not, to anyone without an
administrator's session, and a private VM still answers exactly like one that does not exist.

**The main image is only the cover.** Selecting or clearing it never changes who may see an image. A public VM with
no main image shows a placeholder, and nothing is ever promoted in its place, as before.

**What stays private regardless.** Originals are never served publicly, whatever the VM's visibility: the public
route accepts only `thumbnail` and `full`. Archives, masters, repository details, agent state, filenames, hashes and
storage keys never appear in a public response. Every administrator route still requires a session, the admin role,
the same origin and, for changes, the CSRF token.

**What was removed.** `PUT /admin/vms/:emulatorType/:vmName/media/:mediaId/visibility`, the `visibility` field of
an administrator's media item, the `main_private` cover status, the per-screenshot Publish and Make private buttons,
the "Publish the main screenshot" action, and the agent's unused `MediaVisibility`. The dashboard counts media as
public or private by their VM (`media.public` replaces `media.published`).

## Existing data

Migration `0008_vm_level_publication` redefines the view `public_catalog_card_media` to require a public VM and the
main flag, and nothing else. It is forward-only and rewrites no rows.

**`vm_media.visibility` is kept, and ignored.** Its values and CHECK stay, and it gains a comment saying it is
legacy. No query reads or writes it, and new rows take its default, which means nothing. Keeping it costs one column
and preserves what administrators once chose, should anyone need to look. A later migration may drop it.

**What becomes public on upgrade.** Every screenshot of a VM that is already public, including those marked
`private` before. This is the intended behavior, but it is a change of exposure, so review it before deploying:

```sql
-- Screenshots that were hidden and become public with 0008.
SELECT vm.emulator_type, vm.vm_name, media.id, media.original_filename
FROM vm_media AS media
JOIN virtual_machines AS vm
  ON vm.emulator_type = media.emulator_type AND vm.vm_name = media.vm_name
WHERE vm.visibility = 'public' AND media.visibility = 'private';
```

To keep one of them out of the public catalog, make the VM private, or delete that screenshot. Nothing of a private
VM becomes public, whatever its screenshots were marked.

## Consequences

- One decision publishes a machine and everything shown of it. The cover warning for a private main image is gone,
  because that state cannot exist.
- An individual screenshot of a public VM can no longer be hidden; it can only be deleted.
- The public file route and the gallery check the VM's visibility on every request, so making a VM private still
  takes effect at once, under `Cache-Control: no-cache`.
- Rolling the application back after 0008 is refused by the migration runner, which does not know the newer
  migration. Restore the database backup taken before the update to go back.
