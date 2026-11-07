# 0027: Why a public VM can have no cover, and saying so

**Status:** Accepted. Adds to [0008](0008-public-reads-and-media-lifecycle.md), whose rules are unchanged.

## What the reported defect was

A real test after Milestone 4: a VM marked public, a main screenshot selected, and a placeholder in the public catalog. The whole path was traced, against that VM's actual rows.

| Step                          | Finding                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `vm_media.is_main`            | Set. Exactly one, as the index requires                                    |
| `vm_media.visibility`         | **`private`**, on both of that VM's screenshots. This is the cause         |
| `virtual_machines.visibility` | `public`                                                                   |
| `public_catalog_card_media`   | No row, correctly: it requires a published main image                      |
| API, catalog SQL, contract    | `mainImage: null`, which is what the contract calls "show the placeholder" |
| Card, image URL, media route  | Never reached for this VM                                                  |

So nothing was broken in the sense of a query or a URL, and the privacy rule did exactly what [0004](0004-schema-invariants.md) and [0008](0008-public-reads-and-media-lifecycle.md) ask. To rule out a second defect behind this one, the rest of the path was
then exercised in a real browser with a published main image and no session: the card shows the actual decoded screenshot, with an expired cookie as well. The rest of the path worked.

**The defect was in what an administrator could learn.** Making a VM public said nothing about its media. Selecting a main image is a separate step from publishing it. The one sentence explaining this was on the media page, on the card of that image. And the administrators'
catalog showed the private cover, through the administrators' route, so everything looked finished. There was no way to tell what the public saw without being the public.

## The fix

**`publicCover` on the administrator's VM:** `shown`, `vm_private`, `no_main_image` or `main_private`. It is computed in one place, by the same rule as the view, and it is a reason rather than a boolean, because each one has a different remedy.

**The VM's page says why, with one explicit action.** `main_private` shows a warning and a button, "Publish the main screenshot". The catalog card carries a "No public cover" badge. Nothing is published on anyone's behalf: making a VM public still publishes nothing, as a test keeps proving.
Publishing automatically would have made the symptom go away, and would have made every screenshot's privacy depend on a different decision.

## Detail pages

**The URLs already existed, and stay.** `/vms/{emulator}/{name}` for the public, and `/admin/vms/{emulator}/{name}` for administrators, on the VM's identity, which cannot change. A display name can, so it is not in the URL. The identity is case-insensitive here as everywhere else, so
another capitalization shows the same VM under its stored name. Bookmarks from earlier milestones still work.

**Two routes, two queries, one set of components.** Authorization is decided by which API is asked. The public page never calls an administrator's route, so it has nothing to hide in the browser. The components it shares with the administrators' page, the viewer among them, have no idea who is looking.

**An administrator at a private VM's public URL goes to the page they may see.** For anyone else, a private VM stays indistinguishable from a missing one. That redirect happens only after the API has said 404 and the session says administrator.

**The administrators' VM page gained what it was missing,** rather than a new route. It already held the metadata and visibility, and now holds the gallery, the cover notice, the master, the local copies and Restore. A separate editor route would have
changed every existing link for no benefit.

## The gallery

**One viewer.** The public gallery and the administrators' use the same dialog, which closes what Milestone 4 left open: focus is trapped, the arrow keys move, Escape closes, and focus returns to the thumbnail of the image it ended on, rather than the one it started from.

**Derivatives only, until someone asks.** Thumbnails load lazily, and a full image loads only when opened, or for the one main image. Originals are offered to administrators as an explicit download, and never displayed. This keeps a page light, and means a viewer never handles a file the server did not make.

**Incremental, in the browser.** The list comes whole, and thumbnails appear 24 at a time. A VM with thousands of screenshots is not what this is built for, and the query stays simple. The order is `is_main DESC, COALESCE(captured_at, created_at), id`, which is stable across requests.

**Cards stay one link.** A card's title is a link stretched over the card, and nothing else in it is interactive, so a keyboard reaches it once and a screen reader hears one thing. An administrator's actions live on the VM's page.

## Consequences

- A public VM with no published main image shows a placeholder, on purpose, and its other published screenshots still appear on its page.
- `publicCover` is a second statement of the view's rule, so a test checks them together across the whole matrix.
