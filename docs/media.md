# Screenshots and media

Screenshots go from a VM's directory to the EmuCat server by themselves, whether or not the VM is running, and are public exactly
while their VM is. The reasoning is in decisions [0016](decisions/0016-screenshot-watcher.md),
[0017](decisions/0017-durable-media-queue.md), [0018](decisions/0018-agent-media-upload.md),
[0019](decisions/0019-media-processing-and-storage.md) and [0020](decisions/0020-transfer-media-preservation.md).

```
 VM directory ─► agent (watcher, queue) ─► authenticated HTTP(S) ─► API ─► media storage, MariaDB
```

Screenshots never go through the archive repository, and archives never go through the API.

## What counts as a screenshot

| Emulator | Where                                              | Which files                             |
| -------- | -------------------------------------------------- | --------------------------------------- |
| `86box`  | Anywhere in `VM_ROOT/screenshots/`, at any depth   | `.png`, `.jpg`, `.jpeg`, `.bmp`, `.ppm` |
| `qemu`   | Directly in `VM_ROOT`, and never in a subdirectory | `.ppm`                                  |

Extensions and the name `screenshots` match ignoring case. Only regular files count. A symlink, junction or other reparse point is
reported in the log and never followed, and neither is anything else that could lead outside the VM. A server never names a local
path: everything starts from a VM root the agent has validated itself.

Everything in an 86Box `screenshots` tree is left out of archives, including files that are not images. Those are never uploaded,
which matters for a [transfer](#transfers).

**Only registered VMs synchronize.** The server's list decides, and the presence of a directory means nothing. A discovered VM
uploads nothing until an administrator has registered it, and no upload can create a VM.

## How the agent finds them

The agent holds one recursive filesystem watch on each base path, and uses it only as a hint that a VM is worth scanning. Everything
is looked at again after each connection and every `reconcile_interval_seconds`, so a missed notification only costs time.

A file counts as finished once its size and modification time have stayed the same for `stability_seconds`. It is then read
completely and hashed, through a handle that keeps writers out on Windows, and its metadata is compared again afterwards. A file
that was still changing waits another full period, so a partly written screenshot is not sent.

A changed file is new content and becomes a new media item. The old version stays on the server. **Deleting a screenshot locally
never deletes anything on the server:** the agent only stops tracking the file. Deleting on the server does not touch the local file.

## The queue

`media/queue.json` in the agent's state directory, replaced atomically and durably. It holds one entry for each file, with a state
of `pending`, `uploading`, `retry_wait`, `blocked`, `completed` or `failed`. It holds no secret and no image.

| What happens                | What the agent does                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The agent restarts          | Unchanged files are skipped without being read. What was uploading goes back to pending                                     |
| The connection comes back   | Everything waiting goes at once, and the server is asked again what it holds                                                |
| The queue file is lost      | Everything is hashed once, the server says what it has, and only what it lacks is sent                                      |
| The queue file is damaged   | It is kept as `queue.damaged`, and the same applies                                                                         |
| The API is away, 5xx, 429   | `retry_wait`, doubling from `retry_initial_seconds` to `retry_ceiling_seconds` with jitter, without end                     |
| 401, the credential refused | `blocked`, and nothing is sent until a connection proves that it works                                                      |
| 403, or an unknown VM       | `blocked`, until the server lists this VM for this agent. See [decision 0026](decisions/0026-media-retry-classification.md) |
| The image is refused        | `failed`, and it is not sent again unless the file changes                                                                  |

Before sending anything the agent asks the server about the hash, so identical content under another name costs one small request.

```toml
[media]
max_concurrent_uploads = 2
max_upload_bytes = 67108864
reconcile_interval_seconds = 300
retry_initial_seconds = 5
retry_ceiling_seconds = 900
stability_seconds = 2
transfer_wait_seconds = 120
```

`emucat-agent media-status` prints what the queue holds, without connecting to anything.

## What the server does

Every upload is authenticated with the agent's credential, for a VM this agent holds. The server streams it to staging, measures it,
hashes it, compares the hash with the declared one, and works out what the file is from its bytes. File names and MIME types from the
agent are not believed. See the [API](api.md#agent-media).

| Formats accepted | PNG, JPEG, BMP (uncompressed 8, 24 and 32-bit), PPM (`P6` and `P3`, up to 16 bits a channel) |
| ---------------- | -------------------------------------------------------------------------------------------- |

| Setting                            | Default | Limits                                                    |
| ---------------------------------- | ------- | --------------------------------------------------------- |
| `MEDIA_MAX_UPLOAD_BYTES`           | 64 MiB  | One upload. Over it is refused with 413                   |
| `MEDIA_MAX_PIXELS`                 | 40 M    | Decoded pixels. Checked from the header, before decoding  |
| `MEDIA_MAX_DIMENSION`              | 16384   | Either side                                               |
| `MEDIA_MAX_CONCURRENT_UPLOADS`     | 4       | Over it, 503 with `Retry-After`, and the agent comes back |
| `MEDIA_PROCESSING_TIMEOUT_SECONDS` | 30      | Each conversion. Over it, 503, which may succeed later    |

From each image it keeps three files. **The original** is the uploaded bytes, unchanged. **The full-resolution JPEG** has the same
dimensions, at quality 92 with no chroma subsampling. **The thumbnail** has its longest side at 400 pixels, keeps its aspect ratio,
and is never enlarged. Transparency is flattened onto white, and neither JPEG carries the original's metadata.

**Deduplication** is per VM, by `(emulator_type, vm_name, original_sha256)`, enforced by a unique index. The same bytes again return
the existing item. The same bytes in another VM are a separate item, with separate files, public or private with that VM.

## Storage

Under `STORAGE_PATH`, on the server's own filesystem:

```
media/
  originals/ab/abcdef01-….png
  full/ab/abcdef01-….jpg
  thumbnails/ab/abcdef01-….jpg
  staging/
```

File names come from a new UUID for each item, never from anything an agent sent. Storage keys in the database are relative to
`STORAGE_PATH`, so the directory can move. Screenshot bytes are never stored in MariaDB. **Do not expose this directory through a web
server:** it holds private VMs' files beside public ones, and only the API knows which is which.

Files are published before their row exists, using an atomic rename within the same filesystem, so that a row never refers to a
missing file and a partly written file is never at a final path.

### Recovery and cleanup

| What happened                             | What is left                     | What happens                                                                          |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| An upload failed, or a connection dropped | Nothing                          | Staged files are removed at once. The agent tries again                               |
| A conversion or commit failed             | Nothing                          | Published files of this attempt are removed, and the agent tries again                |
| The API crashed during an upload          | Files in `media/staging/`        | Removed at the next start, once they are an hour old                                  |
| The API crashed after publishing          | Orphans in the final directories | Counted in a warning at each start. The agent's retry makes a new item with new files |

**Limitations.** Orphans are reported and never deleted automatically, since a database restored from an older backup would make good
files look like orphans. To remove them, stop the API, compare the files with `original_key`, `jpeg_key` and `thumbnail_key` in
`vm_media`, and delete what no row refers to. Nothing reclaims the space of a media item when its VM is removed, because a VM cannot
be removed yet. Back up `STORAGE_PATH` together with the database.

## Visibility

Publication is decided by the VM alone, as [decision 0036](decisions/0036-vm-level-publication.md) explains. A screenshot has no
visibility of its own. VMs are private by default, and nothing is selected as the main image automatically.

| VM      | Public catalog                                                                    |
| ------- | --------------------------------------------------------------------------------- |
| Private | The VM and its screenshots do not exist, as far as anyone without a session knows |
| Public  | The VM and every one of its screenshots are shown                                 |

The public can fetch the thumbnail and the full JPEG of a public VM's screenshots, and never an original. Administrators can
fetch all three, for any VM, through routes that check the session on each request, and originals are served as downloads.

Making a VM public publishes all of its screenshots at once, and making it private takes them all away at once. To keep one
screenshot of a public VM out of the catalog, delete it.

**The main image** is `vm_media.is_main`, with at most one per VM as [decision 0004](decisions/0004-schema-invariants.md) describes.
It decides only the cover, never who may see an image. New screenshots never change it. Clearing it shows the placeholder, and
nothing is promoted in its place.

**Legacy values.** `vm_media.visibility` once held a per-screenshot `private` or `published`. It is kept, unchanged, and ignored
since migration 0008. Before upgrading, the query in [decision 0036](decisions/0036-vm-level-publication.md) lists the screenshots of
public VMs that were hidden and become public.

## The gallery

A VM's page shows the main screenshot prominently, and thumbnails of every screenshot the viewer may see. The public sees every screenshot of a public VM, and administrators see everything, with the controls to set or clear the main image and to delete. Selecting a
thumbnail opens the full JPEG in a viewer: the arrow keys move, Escape closes, Tab stays inside, and focus returns to the thumbnail of the image it ended on. Thumbnails load lazily and 24 at a time, and originals are never displayed, only offered to administrators as a download. See
[decision 0027](decisions/0027-catalog-detail-and-public-covers.md).

The public VM page (`/vms/:emulatorType/:vmName`) reads top to bottom: the name, emulator and **Launch VM** action; general
information (the main screenshot, the emulator, the VM name, the number of screenshots and the description); then the screenshot
gallery. Only what the public catalog already returns is shown; nothing is added to the API for the page. Launching is for
administrators, and opens the same launcher as the management page in a dialog over the page. A visitor is offered to sign in,
and a signed-in user who is not an administrator is told why the button is disabled.

In the gallery the main cover is marked **Main cover**. Each viewer chooses small, medium or large cards; the choice is kept
in that browser's local storage (`emucat.gallery.cardSize`), never on the server, and falls back to medium when storage is
unavailable. Publication stays the VM's alone: the page offers no per-screenshot control.

## Decoding limits

PNG and JPEG go through `sharp`, and PPM and BMP through two small decoders in the API. Both have limits on size, dimensions and pixels, checked before any pixel is decoded or any large buffer allocated, and a deadline, `MEDIA_PROCESSING_TIMEOUT_SECONDS`. Decoding yields regularly, so a large image does not hold up other
requests. See [decision 0025](decisions/0025-bounded-image-decoders.md).

## Transfers

Screenshots are not in the archive, so before a transfer deletes a VM, the server must hold every file that would be lost. In order:

1. The master is committed. This has to come first, since an unregistered VM cannot upload anything.
2. The agent lists everything left out of the archive, and hashes it.
3. It asks the server about exactly those hashes, and waits up to `transfer_wait_seconds` for uploads to finish. **Only the server's
   answer counts,** and never the local queue's opinion.
4. It runs every check a transfer always had: the archive, the directory's identity, and each file against the manifest.
5. It renames the directory, so that nothing can reach it, and hashes the excluded files again under the new name. Anything new or
   different moves the directory back and stops here.
6. It deletes.

If any of that cannot be proved, the operation ends as a **partial success** with the code `transfer_blocked_media`. The master stays,
the local VM stays untouched, and the message names the file. That covers a pending or failed upload, a new or changed screenshot, a
file that is not an image, and a server that cannot be reached.

**To recover,** look at the VM's Media page. Once it says everything is synchronized, or the file that blocked it has been moved away,
choose **Retry removal** on the registration. Every check runs again, so a VM that has been used since then is refused and kept.

## Operations

The VM's Media page shows each agent's counts of pending, uploading, synchronized and failed screenshots, and the latest error. That
report is informational and held in memory on the server, like an agent's presence, so it is empty until the agent next reports.

Agent log entries carry the VM, the source path, the attempt, the first characters of the hash, whether a failure is `transient` or
`permanent`, and the outcome. API log entries carry the agent, the VM, the media ID, the result, the size and the duration. Neither
ever contains a credential.

Remote agents must use HTTPS. Plain HTTP is accepted only for a server on the same computer, as for everything else the agent does.

| What you see                                      | What it means                                     | What to do                                                   |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Nothing arrives                                   | The VM is not registered, or the agent is offline | Register the VM. Check the agent's log                       |
| `invalid_image`, `unsupported_image`              | The server refused the bytes                      | Replace the file. A changed file is tried again              |
| `image_too_large`, `upload_too_large`             | Over a limit                                      | Raise the limit on the server, and in `[media]` for the size |
| Pending, and `server_unreachable`                 | The API cannot be reached                         | It catches up by itself once it can                          |
| `vm_not_assigned`                                 | The server says another agent holds this VM       | Nothing to do on this agent                                  |
| Files in `queue.damaged`                          | The queue could not be read, and was rebuilt      | Safe to delete                                               |
| "Media files with no database row" in the API log | A crash after publishing, or a restored database  | See [recovery](#recovery-and-cleanup)                        |

## Requested QEMU captures

Administrators can choose **Capture screenshot** on a running QEMU session card. The action reports
capturing, uploading and publication, then refreshes the gallery and offers Open screenshot. A public
VM publishes the image publicly; capture does not replace its main cover. Capture may be unavailable
after agent restart, while offline, or while another capture is active; the interface explains why.

Requested captures use an agent-owned spool and the existing media pipeline in all three execution
modes. They survive remote workspace cleanup. Manually created remote screenshots remain unsynchronized.
Identical frames may resolve to the same image; each request still completes separately. A failed
upload preserves its image and offers a bounded retained-image retry. See
[decision 0042](decisions/0042-qemu-monitor-capture.md).
