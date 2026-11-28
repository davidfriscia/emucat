# Archive Explorer in the web application

How Archive Explorer is built in the browser: its interface primitives, its file panel, and the archive worker that
opens archives inside a version's archive. The decisions are [0056](decisions/0056-archive-explorer.md) (the server
side, previews, downloads) and [0058](decisions/0058-browser-local-nested-archives.md) (this layout and nested
archives).

## Icons and toolbars

`lucide-react` is the application's icon library. Import each icon by name (`import { Info } from 'lucide-react'`),
never the whole set, and never load icons from a CDN. Do not add a second icon library, or use emoji or Unicode
symbols as icons.

| Component                                           | Use                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `IconButton`                                        | An action. `label` is its accessible name and tooltip; `loading` shows a spinner and `aria-busy` |
| `IconToggleButton`                                  | A state: `pressed`, `onPressedChange`; announces `aria-pressed`                                  |
| `Toolbar`                                           | `role="toolbar"`; Left/Right/Home/End move between its controls; text fields keep their arrows   |
| `ToolbarGroup`, `ToolbarSeparator`, `ToolbarSpacer` | Grouping (`role="group"` with a label), a vertical rule, a push to the end                       |
| `InfoPopover`                                       | A button that opens a non-modal dialog over the content; Escape and outside clicks close it      |
| `FileTypeIcon`, `fileIconKind`                      | The one place file icons are decided (below)                                                     |

All are in `apps/web/src/components/ui/`, with styles under "Icon buttons, toolbars and information popovers" in
`styles.css`. Keep words where an icon would be ambiguous: the VM files / Stored entries switch, the encoding, offsets,
page numbers, zoom percentages, ASCII/CP437.

### File icons

| Kind                      | Icon                    | Decided by                                             |
| ------------------------- | ----------------------- | ------------------------------------------------------ |
| Directory (closed / open) | `Folder` / `FolderOpen` | Entry type                                             |
| Archive                   | `FileArchive`           | An archive node, or an archive extension               |
| Text / document           | `FileText`              | `.txt`, `.md`, `.nfo`, …; detected text; `.pdf`        |
| Configuration             | `FileCog`               | `.cfg`, `.ini`, `.ovf`, `.nvr`, `CONFIG.SYS`, …        |
| Source code               | `FileCode`              | `.c`, `.asm`, `.bas`, `.html`, …                       |
| Image                     | `FileImage`             | Image extensions; detected image                       |
| Binary                    | `Binary`                | `.bin`, `.rom`, `.dat`; detected binary                |
| Disk image / optical      | `HardDrive` / `Disc`    | `.img`, `.vhd`, `.vmdk`, … / `.iso`, `.cue`, `.chd`, … |
| Executable                | `FileTerminal`          | `.exe`, `.com`, `.bat`, `.sys`, …                      |
| Link                      | `Link2`                 | A link inside a nested archive                         |
| Unknown                   | `File`                  |                                                        |

The icon only suggests. What a file is for previews always comes from its bytes.

## The file panel

```text
[←] [icon] name                                     (← only below 768 px)
     VM files › utilities.zip › docs › manual.pdf   (breadcrumb, buttons reveal in the tree)
[modes] | [viewer controls …]        [Browse][Download][Info]
┌───────────────────────────────────────────────────────────┐
│ preview: fills the remaining height, scrolls once, inside │
└───────────────────────────────────────────────────────────┘
status: encoding · image size · page · bytes · integrity · warnings
```

A viewer (`viewers.tsx`, `PdfViewer.tsx`) renders its controls inside `<ViewerTools>` and its status inside
`<ViewerStatus>` (`chrome.tsx`). Those are portals into the panel's toolbar and status bar. File details are under
**File information**, archive details under **Archive information**.

## Where a file comes from

`FileSource` (`archive-explorer/source.ts`) hides whether a file is read by the server (`remoteSource`) or by the
browser from a nested archive (`nestedSource`). Both yield `ArchiveEntryDetails` and `ArchivePreviewBytes`, so every
viewer works with both. `integrityScope` says what a check means: `server`, `nested-crc` (the nested archive's
CRC-32), or `nested-none` (TAR).

## The archive worker

```text
apps/web/src/archive-local/
  limits.ts        every browser-side limit, with its default
  errors.ts        error codes and their words
  bytes.ts         readers, CRC-32
  zip.ts tar.ts gzip.ts   format readers (0056's checks, 0057's TAR endings)
  inflate.ts       bounded streaming inflate (fflate)
  detect.ts        names and signatures; disk images are never archives
  images.ts        header dimensions; PPM, PCX, TGA decoders
  engine.ts        one opened archive: index, reads, details
  host.ts          the archives held, the cache, eviction
  worker-handler.ts archive.worker.ts protocol.ts   the worker
  client.ts        the page's side: requests, abort, slots, dispose
```

`ArchiveExplorerDialog` creates one `LocalArchiveClient` and disposes it when it closes. `dispose()` is not final:
React's StrictMode cleans up effects once on mount, and a later request starts a new, empty worker. The tree
(`Tree.tsx`) holds what it shows of each nested archive (its index and directories), and the worker holds the
bytes. When the worker releases an archive, the tree collapses that branch.

### Browser memory

What can be released explicitly, and what is left to garbage collection:

| Resource                                  | Released by                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| The worker, every payload and index in it | `client.dispose()` (dialog closed) → `Worker.terminate()`: immediate                   |
| One archive and everything inside it      | Eviction (`host.release`): its references dropped, memory reclaimed by the worker's GC |
| An API download in flight                 | Its `AbortController`, on collapse or close                                            |
| A worker operation in flight              | `cancel` message, checked between slices; termination as the last resort               |
| Image `blob:` URLs                        | Revoked when the image is no longer shown                                              |
| Download `blob:` URLs                     | Revoked 10 s after the save starts                                                     |
| PDF documents                             | `destroy()` with their PDF.js worker when the file changes or the dialog closes        |
| Preview bytes on the page                 | Dropped with the file panel; reclaimed by garbage collection                           |

The 128 MiB cache budget counts payloads owned and an estimate of the indexes. It is not a measurement of the tab:
see decision 0058 §6 for the transient buffers outside it.

## Testing

- `test/archive-local/*.test.ts`: the readers, limits, bombs, cache and client, in Node.
  `test/archive-local/zip64.test.ts` holds the ZIP64 cases of decision 0061, mirroring the server's.
- `test/archive-nested.test.tsx`, `test/archive-explorer.test.tsx`: the interface in jsdom, with the real worker
  handler run in the same thread, under StrictMode.
- `e2e/archive-explorer.browser.test.ts`: the production bundle in Edge, Chrome or Chromium, served with nginx's MIME
  types, against a stand-in for the archive routes. See [testing](testing.md#browser-tests-of-the-web-application).
