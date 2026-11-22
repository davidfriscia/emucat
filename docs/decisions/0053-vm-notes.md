# 0053: Per-VM notes are one Markdown file on the server, edited with Vditor

**Status:** Accepted. Extends [0008](0008-public-reads-and-media-lifecycle.md) and
[0034](0034-deployment-and-admin-updates.md).

## Context

Administrators keep knowledge about a VM that fits nowhere else: how it was installed, how its OS is configured,
what software is on it, what does not work. A version's description is about one version; the VM's description is
public catalog text. Notes are about the VM itself, can be long, and are private.

## Decision

### The file is the notes

Each VM has at most one notes file, on the server's filesystem:

```
NOTES_PATH/<emulator>/<vm name>/<vm name> - notes.md
data/notes/86box/Windows 95/Windows 95 - notes.md      (a deployed server)
```

There is no copy in MariaDB, and no row at all: a missing file is an empty document. `<emulator>` and `<vm name>` are
the catalog identity in its **registered spelling**, looked up in `virtual_machines` for every request (lookup ignores
case, as everywhere), and checked again against the VM name rules, which already exclude separators, `..`, leading
dots, control characters and Windows device names. Nothing from a request becomes a path.

### Safe by construction

- **No link is followed.** The notes root, the emulator's directory and the VM's directory must be real directories
  (checked with `lstat`), the VM directory's real path must be inside the root's, and files are opened with
  `O_NOFOLLOW`. A link anywhere is refused with `500 notes_storage_unsafe`, which never names a path.
- **Writes are atomic.** A save writes a new temporary file (`.<name>.<uuid>.tmp`, `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0640) in the VM's directory, syncs it, renames it over the notes file and syncs the directory. A reader sees the old
  notes or the new ones. Temporary files a crash leaves are removed on the next save of that VM.
- **Saves never overwrite silently.** `GET` returns an `ETag` (the SHA-256 of the content); `PUT` and `DELETE` must send
  it as `If-Match` (`428` without, `412 notes_conflict` when the notes changed since). Saves of one VM are serialized
  in the API process (there is one), and the comparison happens under that lock.
- **Limits.** 1 MiB of UTF-8, no NUL; larger bodies are refused before parsing.
- **Private.** Administrators only. No public route, catalog response or admin VM response includes notes.

### Lifecycle

Notes belong to the VM's **identity**, not to a version. Registration, snapshots, restores, remasters, transfers,
local copy removal and screenshot handling never touch them. A **clone** starts with none
([0052](0052-vm-clones.md)): notes are keyed by identity, and a clone has a new one. VM identities never change, so
there is no rename to follow. EmuCat has no catalog VM deletion yet; `NotesStorage.deleteForVm` removes a VM's notes
file and its then-empty directories, for that lifecycle to call when it exists. Clearing notes removes the file and
the empty directories, so nothing is orphaned.

### Persistence and deployment

`data/notes` sits beside `data/media` under `EMUCAT_ROOT`, owned by the application account like the media
(`EMUCAT_APP_USER`, 0750). `emucatctl install` creates it, hands over an empty one, and never changes existing notes;
`emucatctl check` verifies it; an update refuses to start without it. Compose bind-mounts it at `/data/notes`
(`NOTES_PATH`) with a required variable, so a missing directory is an error rather than one Docker creates as root.
The application files and the root filesystem stay read-only. Back `data/notes` up with `data/media`: neither is in
the database dumps.

Because the installed tooling changes only through `emucatctl install` ([0034](0034-deployment-and-admin-updates.md)),
a server upgraded to this release must run `install` from the new checkout once before `update`.

### The editor: Vditor

[Vditor](https://github.com/Vanessa219/vditor) (4.0.1, MIT, © 2019-present B3log; it bundles Lute under Mulan PSL v2,
highlight.js under BSD-3-Clause and KaTeX under MIT) is the Markdown editor, in split view with a
live preview, through one React component (`MarkdownEditor`) that creates the editor when it mounts and destroys it
when it unmounts (also when it unmounts before Vditor finished starting), so a page never holds more than one. The
read-only view (`MarkdownView`) uses `Vditor.preview`. Both are loaded lazily, only when notes are shown.

- **Self-hosted.** Vditor fetches parts of itself at run time from `options.cdn` (unpkg.com by default). EmuCat serves
  a fixed list of them from its own origin under `/vendor/vditor/<version>/` (Lute, the English strings, the icons,
  highlight.js, KaTeX, the content themes, its images), emitted by a Vite plugin, served by nginx with immutable
  caching and a 404 for anything else. Diagram renderers (Mermaid, MathJax, ECharts, Graphviz and others) are not
  published: such a block stays code.
- **Untrusted content.** Rendered HTML goes through Lute's sanitizer (`sanitize: true`) and then DOMPurify (3.4.17,
  MPL-2.0 or Apache-2.0): no script, style, form, frame or event handler, only `http(s):`, `mailto:`, fragment and
  same-site URLs, `data:` URIs removed, and links opened with `rel="noopener noreferrer nofollow"`.
- **No uploads.** No upload URL is configured and the toolbar has no upload, record or export button.
- **No browser storage.** Vditor's localStorage cache is off; the server holds the only copy, and leaving the page with
  unsaved changes asks first.
- **Themes.** The editor and the view follow Bootstrap's `data-bs-theme`, switching Vditor's theme in place.

## Consequences

- Notes are ordinary files: they can be read, backed up and restored without EmuCat, and a backup of the database
  alone does not contain them.
- One API process is assumed for the per-VM save lock, as for presence and rate limits ([0010](0010-agent-connections-and-discovery.md)).
  The ETag check still makes a lost update impossible within that process.
- The web build grows by about 7 MB of Vditor files under `/vendor`, fetched only when notes are opened.
