# EmuCat — Archive Explorer & File Preview: implementation report

Repository `davidfriscia/emucat`, branch `develop`. Decision record: [0056](../decisions/0056-archive-explorer.md).
Runbook: [runbook-0056-mars.md](../runbook-0056-mars.md) (reproduced in full in sections 24–28).

## 1. Executive summary

The archive contents modal is now **Archive Explorer**: a two-panel, file-explorer-style dialog (lazy directory tree
beside the selected file's details and preview) for masters and snapshots, in the logical (manifest) and physical
(stored entries) views, OVA physical-only as before. Any file can be previewed (text in six encodings with syntax
highlighting, inert Markdown, standard and legacy images, PDF, bounded hex) and downloaded individually up to a
configurable limit. Everything runs through the EmuCat server's existing SFTP connection, reading only the selected
entry's own bytes, **without writing anything to disk**, without staging, read-only, and with no agent involved.

The assessment findings R1–R10 are all resolved or explicitly bounded (section 15). Measured in automated tests: on a
25,166,537-byte archive, the listing read 66,127 bytes from the repository, a text preview 61 bytes, a single-file
download 61 bytes, and a 64 KiB hex window of a 24 MiB disk 65,580 bytes. A ZIP64 archive larger than 5 GiB with an
entry beyond 4 GiB was read through a 64 KiB window touching less than 64 KiB + 200 bytes.

All automated suites pass: contracts 448, API 1,202, web 556, deployer 51 tests; type checks and production builds of
every workspace succeed. A real-browser walk-through (Chromium, real API, real SFTP repository, real PDF.js, Lute and
highlight.js) made **no external network request** and logged **no console error**. Deployment needs **no tooling
refresh, no migration, no Compose, nginx, proxy, Cloudflare, SSH or agent change, and no new environment variable**
(all new variables are optional with safe defaults), provided MARS already runs the decision-0055 release with its
tooling, which the runbook checks with exact commands.

One limitation of this environment: `pnpm test:deploy` (the deployment-tooling integration suite) and a full Docker
image build could not run here (Docker Hub rate limit and package downloads inside containers blocked). No file
under `deploy/` except comments in `app.env.example` changed; the web build was instead validated by serving the
production bundle through the production nginx image and configuration (section 21).

## 2. Starting branch and commit

- Branch `develop`, `origin/develop` = `a2e898856b3d81b5f8a1a443254b3266adfdeb53` ("docs: server repository access,
  relay and clones (decision 0055), MARS runbook"), the assessed commit. Working tree clean. Every finding of the
  assessment was re-verified against this source before implementation.

## 3. Final commit and push confirmation

| Commit    | Content                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `90fc83d` | API: inspection hardening (R1–R8, R10), locators, selective extraction, previews, download, tests |
| `066538e` | Web: Archive Explorer UI and viewers, PDF.js, contracts detection, preview slot queue, tests      |
| `9314883` | Docs: decision 0056, API, deployment, runbook                                                     |
| (next)    | This report (`docs/reports/emucat-archive-explorer-implementation-report.md`)                     |

All pushed to `origin/develop` with author and committer `david <davidfriscia@gmail.com>`. `main` was not touched;
nothing was deployed to MARS or MOON; no feature branch or pull request was created.

## 4. Architecture before and after

**Before (a2e8988).** `ArchiveInspection` opened an SFTP reader, parsed the ZIP central directory and manifest (or the
OVA's TAR headers), and kept an in-memory index per version (count- and TTL-bounded). Only listings were possible; no
entry bytes were ever read except the manifest (`readSmallEntry`, synchronous inflate).

**After.**

```
Browser ──GET …/archive/entry[/preview|/download]──▶ API (admin session, same-origin, same-site fetch)
                                                     │  version row re-read (identity)            ─▶ MariaDB
                                                     │  ArchiveInspection: index cache (LRU, TTL, byte budget,
                                                     │    coalesced loads, per-requester cancellation, deadline)
                                                     │  path → server-side locator (exact match, binary search)
                                                     │  ArchiveExplorer: slots + queue, deadline, request abort
                                                     ▼
                                    RepositoryAccess → RepositorySession → ObjectReader.read(offset, len, signal)
                                                     │  fstat: size + mtime must equal the indexed ones
                                                     ▼
                                    extract.ts: local header re-check → stored read / streaming inflate (thread pool)
                                                     │  CRC-32 + manifest SHA-256 for whole files
                                                     ▼
                           memory only: preview bytes ≤ limit, or streamed download (last chunk held back)
```

New API modules: `archives/extract.ts` (locators, bounded streaming extraction, verifier), `archives/explorer.ts`
(details, previews, download, slots), `archives/preview-image.ts` (image validation and conversion),
`archives/legacy-images.ts` (PCX, TGA), `archives/policy.ts` (resource policy). Shared: `contracts/archive-preview.ts`
(detection, encodings, code pages). Web: `components/ArchiveExplorer.tsx` and `components/archive-explorer/*`.

## 5. Implemented Archive Explorer user experience

- **Entry point** unchanged: Version History › **View contents…** on masters and snapshots; dialog title
  **Archive Explorer**, with version, date, format, size and repository in the header; warnings (manifest mismatch,
  missing manifest) kept; archive identity, SHA-256 and manifest verification under **Archive details**.
- **Left panel:** expandable tree (WAI-ARIA tree; folder and file icons; sizes and item counts), lazily listed one
  directory and one 200-entry page at a time (**Show more**), search across all paths (flat results; a folder result
  opens in the tree), logical/physical switch keeping each view's expanded state, keyboard (Up/Down/Left/Right,
  Home/End, Enter/Space).
- **Right panel:** placeholder with the archive summary until a file is selected; then name, path, size, stored size,
  compression, modification time, detected type (from content), CRC-32, SHA-256 (from the manifest), download, preview
  modes, preview. Directories never trigger extraction.
- **Interaction:** selecting another file replaces the preview and aborts the previous file's requests; late answers
  can never replace a newer file; the dialog stays open; a resizable splitter (pointer and keyboard, remembered);
  under 768 px one panel at a time with **Back to files**; light and dark themes; loading, error and unsupported
  states; contextual toolbars only (encoding, wrap, highlight and copy for text; zoom for images; pages and zoom for
  PDF; offsets, navigation and character set for hex).

Screenshots from the real-browser run (light, dark, phone, PDF, Markdown, hex) were produced during validation and
are provided with this session; the UI is described in decision 0056 and the runbook's checklist.

## 6. ZIP/ZIP64 extraction implementation

- Locator per file: stored name, local header offset, compressed/uncompressed sizes, method, CRC-32, flags and the
  central directory offset (`limit`). Built only from the validated central directory; never from a request.
- Before reading: locator sanity (safe integers, method 0/8, no encryption flags, stored sizes equal, deflate ratio
  ≤ 1032:1 + 4 KiB).
- Local header re-check: signature, exact name bytes, method, encryption flags, and — without a data descriptor — CRC
  and sizes (ZIP64 markers allowed); data must end before the central directory and inside the object.
- Stored: direct reads at any offset in ≤ 1 MiB chunks. Deflated: `createInflateRaw` streaming on zlib's thread pool,
  output capped at the recorded size, start offsets allowed only up to `ARCHIVE_PREVIEW_SEEK_BYTES`.
- Whole reads verify size, CRC-32 and the manifest SHA-256 (when the manifest is the registered one).
- `readSmallEntry` (manifest) now inflates asynchronously.
- Tests: stored, deflated, ZIP64 (> 4 GiB offsets and a 5 GiB entry over a sparse virtual source), prefix reads,
  invalid local headers, invalid offsets and limits, unsupported compression, encryption, bombs and impossible ratios,
  CRC and SHA-256 mismatches, damaged deflate data, cancellation mid-read, bounded chunks; duplicate/ambiguous names
  and traversal are refused at indexing (existing `inspectZip` checks, covered by existing tests) and by exact lookup.

## 7. TAR/OVA extraction implementation

- Existing `readTar` (ustar/GNU, PAX `path`/`size`, GNU long names, checksums, flat names, duplicate refusal) supplies
  each regular file's data offset and size; links, devices, directories and other types make the archive refused, so
  nothing but regular files can ever be located.
- Extraction re-checks `dataOffset + size ≤ object size`; any offset can be read directly. Whole reads are reported as
  `complete` (TAR records no checksum); the archive's own SHA-256 was verified at registration.
- Tests: offset-exact reads (first read at the data offset; bytes read equal the file's size), windows at arbitrary
  offsets, entries past the end, PAX long names, refusal of types 1, 2, 3, 4 and 6, and an end-to-end OVA test.

## 8. Preview format support matrix

| Format                         | Detection                                   | Rendering                                      | Variants supported / limits                                                                |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PNG, JPEG, GIF, WebP           | Signature; sharp header metadata must agree | Browser, original bytes                        | ≤ 20 MiB, ≤ 16.7 MP, ≤ 1000 frames; malformed → `image_invalid`                            |
| BMP                            | `BM` + known header size                    | Browser, original bytes                        | Dimensions from the header checked; browser decodes variants                               |
| ICO                            | Icon directory consistent with file         | Browser, original bytes                        | Each image inside the file; ≤ 256 × 256                                                    |
| PPM                            | `P6`/`P3` signature                         | Existing EmuCat decoder → PNG (sharp)          | P6 and P3, 8 and 16 bit; not P1/P2/P4/P5                                                   |
| TIFF                           | `II*\0` / `MM\0*`                           | sharp/libvips → PNG                            | First page only                                                                            |
| PCX                            | Extension + valid ZSoft header              | New decoder → PNG                              | RLE; 8-bit + palette (or grey), 24-bit (3 planes), mono, 16-colour EGA; nothing else       |
| TGA                            | Extension + valid header                    | New decoder → PNG                              | Types 1, 2, 3, 9, 10, 11; 8/15/16/24/32 bpp; top/bottom origin; right-to-left not mirrored |
| SVG                            | Text                                        | **Inert XML source** only                      | Never drawn                                                                                |
| Text (any name)                | No NUL, ≤ 1 % controls, legacy heuristics   | Monospace, wrap, copy, encodings, highlighting | First 256 KiB; truncation stated                                                           |
| HTML, XML, OVF, INI, CFG, BAT… | Text + name → language                      | Highlighted source (Vditor's highlight.js)     | ~40 language mappings; unknown → plain                                                     |
| Markdown                       | Text + `.md`                                | Rendered (Lute + strict DOMPurify) and source  | Images/scripts/HTML embeds removed, links inert                                            |
| PDF                            | `%PDF-` in the first 1 KiB                  | PDF.js canvas                                  | ≤ 25 MiB; no scripting, annotations layer, forms or XFA                                    |
| Anything                       | —                                           | Hex (ASCII or CP437)                           | 64 KiB windows; any offset for stored/TAR, first 16 MiB of deflated                        |

Detection never trusts extensions for type; tests include a PNG named `.jpg`, a binary named `.txt`, an extensionless
README, an unknown text extension, a ROM padded with `0xFF` (binary) and a DOS menu drawn with box characters (text).

## 9. Text encoding support

UTF-8, UTF-16 LE, UTF-16 BE, Windows-1252, CP437 and CP850, decoded in the browser from the bytes received once
(`TextDecoder` for the first four, tables for the DOS code pages, verified to have 128 entries and spot values).
Detection order: byte-order mark → UTF-16 by zero pattern → strict UTF-8 (one cut sequence at the very end tolerated,
nothing else) → heuristic Windows-1252 vs CP437 (curly quotes and dashes vs box drawing, unassigned 1252 bytes, DOS
EOF, `.nfo`/`.diz` names). The UI states the confidence ("from the byte-order mark", "valid throughout", "a guess
from the bytes") and offers manual selection; CP850 is manual only. Changing the encoding makes no request.

## 10. PDF implementation

`pdfjs-dist` 6.5.438 (Apache-2.0, no transitive dependencies), legacy build for broader browser support, lazy-loaded
in its own 503 KB chunk (the main bundle grew 57 KB, 21 KB gzipped, for the whole explorer). Worker bundled by Vite
and emitted as `.js` (the web container's nginx maps only `.js` to JavaScript; a `.mjs` worker would have failed in
production — found and fixed during validation). CMaps, standard fonts, ICC profile and JBIG2/OpenJPEG/QCMS wasm are
published under `/vendor/pdfjs/6.5.438/` by a Vite plugin modelled on Vditor's; QuickJS (scripting) is excluded and
returns 404. Rendering: canvas only, no annotation or text layer, `enableXfa: false`, `disableAutoFetch`,
`disableStream`, image size and canvas area limits (16.7 MP); fit-to-width, zoom, page navigation, page count; the
loading task is destroyed when the file changes or the dialog closes. Global framing protections are unchanged
(`X-Frame-Options: DENY`; nothing is framed). Verified in real Chromium: text drawn on the canvas, page 2 navigated,
no external request.

## 11. Individual file download implementation

`GET …/archive/entry/download` resolves the entry through the authorized index, refuses sizes above
`ARCHIVE_DOWNLOAD_MAX_BYTES` (100 MiB; `0` disables), takes a download slot (2, with a queue of 2 for up to 10 s), and
streams the entry from the repository through a 1 MiB `PassThrough`, with `Content-Length`, `Content-Type:
application/octet-stream`, a sanitized `Content-Disposition` (ASCII `filename`, UTF-8 `filename*`; control
characters, quotes, separators, semicolons removed), `no-store`, `nosniff`, a sandboxing CSP. The response is
returned only once the first bytes are ready, so early failures are ordinary JSON errors. The **last chunk is held
back until CRC-32 and SHA-256 match**: a corrupted file never arrives complete (tested: the client sees a short body
and an error), and the server logs the failure. Client disconnect aborts the read and closes the SSH connection
(tested: zero further bytes read). The browser saves the file only after receiving all bytes. No staging is used.

## 12. Security controls

- **Authorization:** every route runs session, administrator and same-origin hooks, plus a same-site fetch check
  (`Sec-Fetch-Site` from another site → 403 even for GET) on file routes; identity (emulator, VM, version) is re-read
  on every request. Tests: anonymous 401, `user` role 403, cross-site 403, wrong VM/emulator 404, coalesced wrong-VM 404.
- **Archive safety:** traversal, absolute paths, `..` (schema), exact-match lookup (no normalization; `docs//x`,
  case variants 404), duplicates/ambiguity and unsafe names refused at indexing, symlinks and special files refused,
  offsets and sizes re-checked against bytes, integer safety, bombs and impossible ratios, limits on metadata.
- **MIME spoofing:** content signatures decide; names only for language/Markdown and PCX/TGA (with header checks).
- **Browser:** archive bytes never rendered as a document; previews `application/octet-stream` (images excepted,
  PDFs included), `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`,
  `nosniff`, `no-store`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`. HTML/XML/SVG shown as
  source; Markdown sanitized by a dedicated strict DOMPurify instance (no images — replaced in an inert DOMParser
  document —, media, frames, forms, styles, SVG, MathML, ids, names; links inert); highlighting output re-sanitized to
  `span[class]`; object URLs revoked; no external request (verified in Chromium).
- **Global headers:** none weakened; nginx config unchanged.

## 13. Resource limits and actual defaults

See the table in section 25 (and decision 0056 §9). Rationale: sized for the API container's default 1 GiB beside
transfers, clones and screenshot processing; worst preview case two concurrent image conversions ≈ 200 MiB; image
pixels 16.7 MP instead of the suggested 25 MP to keep that below a fifth of the container; inspection entries 200,000
instead of the agent's 500,000 (estimated ~150 MiB transient for the maximum, which would not fit the cache anyway);
directory and manifest 64 MiB; separate preview and download policies (download allows 30 min and streams; previews
60 s and buffer); short bounded queues so that a person clicking through files is not refused.

## 14. Cache and cancellation improvements

- **Cache:** existing index cache kept and improved: LRU, TTL, count, plus an **estimated byte budget** (320 bytes per
  entry + 2 bytes per character + hash strings) with admission control (an index larger than the budget is served
  and not kept); locators are part of the weight. Indexes are dropped when the row's identity changes or the object's
  size/mtime differ. Nothing extracted is ever cached. The estimate is not a process measurement.
- **Coalescing and cancellation ownership:** one `SharedLoad` per version; each requester joins with its own signal
  and leaves on its own; the load's controller aborts only when the last requester leaves, or at the inspection
  deadline; admission to the cache happens once. Previews and downloads each have their own operation signal
  (request close + deadline) whose reason becomes the error (`request_cancelled`, `archive_timeout`).
- **Propagation:** connection establishment (`access.open(endpoint, signal)`), SFTP reads (`read(…, signal)`; abort
  also closes the SSH session, ending in-flight requests; abandoned in-flight read promises are now settled),
  decompression (stream destroyed), image conversion (decoder deadlines, sharp timeout), download streams.
- **Tests:** cache hits (zero bytes read), expiry (TTL 0), LRU, byte-budget eviction, oversized admission, coalescing
  with one requester cancelled (other completes), all cancelled (load aborted, connections and handles back to 0),
  concurrent-load refusal, inspection deadline, preview deadline, preview concurrency, browser disconnect.

## 15. Resolution status of assessment findings R1–R10

| #   | Finding                          | Status             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Pending-load identity validation | Resolved           | `inspection.ts` `record()` (row re-read scoped by emulator/VM/id on every request), `checked()` applied on cache hit, coalesced and new loads; test "never hands a shared, still-loading index to a request for another VM" (listing and entry)                                                                                                                                                         |
| R2  | Cancellation and deadlines       | Resolved           | `SharedLoad.join`, `loadWithDeadline`, `operationSignal`, `ObjectReader.read(…, signal)`, session close on abort; tests for single/all requester cancellation, deadlines, disconnect                                                                                                                                                                                                                    |
| R3  | Memory pressure                  | Resolved           | Byte-budgeted cache with admission, configurable entry/directory/manifest limits (lower defaults), measured listing reads; synthetic large-archive tests (24 MiB, 5 GiB ZIP64). Production memory not measured here (see 22)                                                                                                                                                                            |
| R4  | Event-loop blocking              | Partially resolved | Manifest inflation async (`zip.ts`); previews stream on the thread pool; decoders yield under deadlines; sharp off-thread. Remaining synchronous and bounded: central-directory parsing (≤ 64 MiB), manifest `JSON.parse`/canonical re-serialization (≤ 64 MiB), index building (≤ 200,000 entries). Worker-thread move deferred: the index would have to cross threads; bounds make it unnecessary now |
| R5  | Configurable limits              | Resolved           | 21 `ARCHIVE_*` variables in `config.ts` with ranges, defaults, tests; `app.env.example`, deployment guide                                                                                                                                                                                                                                                                                               |
| R6  | Frontend error mapping           | Resolved           | `ARCHIVE_INSPECTION_ERROR_TEXT` covers every code the archive routes return, including `inspection_busy`, `archive_view_unavailable` and all new codes; `problems.tsx`; tests                                                                                                                                                                                                                           |
| R7  | Silent staging sweep failures    | Resolved           | `TransferService.sweepAndReport()`: warning with operation, staging root, consecutive failures; throttled to 15 min; recovery logged; test                                                                                                                                                                                                                                                              |
| R8  | Non-UUID staging artifacts       | Resolved           | `StagingArea.unexpected()` / `reportUnexpected()`: reported at start and after sweeps, again only on change, never deleted; active UUID directories untouched; test                                                                                                                                                                                                                                     |
| R9  | Preview security and framing     | Resolved           | No global header change; previews inert (`attachment`, sandbox CSP, octet-stream PDFs); PDF drawn on canvas, nothing framed; verified through the production nginx config                                                                                                                                                                                                                               |
| R10 | Archive cache identity           | Resolved           | Cache used only while row identity (repository, key, size, SHA-256) matches; extraction compares the object's size and mtime with the indexed ones and evicts on mismatch (`archive_changed`); local header re-check; tests for replaced objects                                                                                                                                                        |

## 16. Temporary storage assessment

Archive Explorer writes nothing: no file in `data/transfers` (staging), `/tmp`, the container's writable layer (the
API's root filesystem is read-only anyway), or any cache directory. Tested: an empty `TMPDIR` set for the duration of
listing, preview, download and hex operations stayed empty, and the staging/SFTP working directories were unchanged.
Staging remains reserved for the relay and clones.

## 17. New API endpoints and contracts

| Route                                                                     | Contract                                                        |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GET …/versions/:versionId/archive/entry?view&path`                       | `archiveEntryQuerySchema` → `archiveEntryDetailsSchema`         |
| `GET …/versions/:versionId/archive/entry/preview?view&path&kind[&offset]` | `archivePreviewQuerySchema` → bytes + `ARCHIVE_PREVIEW_HEADERS` |
| `GET …/versions/:versionId/archive/entry/download?view&path`              | `archiveEntryQuerySchema` → streamed attachment                 |

Existing summary and listing routes are unchanged in shape (they now accept cancellation). Error codes (all with
text): `entry_not_found`, `entry_not_file`, `entry_unsupported`, `unsupported_compression`, `preview_unavailable`,
`preview_too_large`, `preview_offset_unsupported`, `download_too_large`, `archive_changed`, `integrity_failed`,
`preview_busy`, `download_busy`, `image_invalid`, `image_too_large`, `resource_limit`, `archive_timeout`,
`request_cancelled`, `download_incomplete`, plus repository and inspection codes. Web client: `fetchArchiveEntry`,
`fetchArchivePreview`, `downloadArchiveFile`.

## 18. Dependencies and licenses

| Dependency                  | Where | Purpose                               | License                                              | Notes                                                          |
| --------------------------- | ----- | ------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `pdfjs-dist` 6.5.438 (new)  | Web   | PDF previews                          | Apache-2.0 (wasm: BSD/MIT-style, licenses published) | No transitive deps; lazy; self-hosted assets; QuickJS excluded |
| highlight.js 11.7 (reused)  | Web   | Syntax highlighting                   | BSD-3-Clause                                         | Vditor's self-hosted build, no new package                     |
| Lute via Vditor (reused)    | Web   | Markdown rendering                    | Mulan PSL v2                                         | `Vditor.md2html`                                               |
| DOMPurify (reused)          | Web   | Sanitizing                            | MPL-2.0 / Apache-2.0                                 | Separate strict instance                                       |
| sharp (reused)              | API   | Image metadata, TIFF and PNG encoding | Apache-2.0                                           | —                                                              |
| PCX/TGA decoders (new code) | API   | Legacy images                         | Project code                                         | No dependency                                                  |

README's third-party table now credits PDF.js; the lockfile is updated.

## 19. Important files changed

API: `src/archives/{inspection,extract,explorer,preview-image,legacy-images,policy,manifest,zip}.ts`,
`src/repository-access/ssh.ts`, `src/routes/{admin-archives,browser}.ts`, `src/app.ts`, `src/server.ts`,
`src/config.ts`, `src/transfers/{staging,service}.ts`. Contracts: `src/archive-inspection.ts`,
`src/archive-preview.ts`. Web: `src/components/ArchiveExplorer.tsx` (replaces `ArchiveContents.tsx`),
`src/components/archive-explorer/{Tree,FilePanel,viewers,PdfViewer,highlight,safe-html,problems}.tsx?`,
`src/api.ts`, `src/styles.css`, `pdfjs-assets.ts`, `vite.config.ts`. Tests: `apps/api/test/{archive-extract,
archive-explorer,staging-diagnostics}.test.ts`, `archive-sources.ts`, instrumented `sftp-server.ts`,
`packages/contracts/test/archive-preview.test.ts`, `apps/web/test/archive-explorer.test.tsx`. Docs: decision 0056,
`api.md`, `deployment.md`, `architecture.md`, `repositories.md`, README, `app.env.example`, `runbook-0056-mars.md`.
In all: 56 files, +9,103 / −643 lines.

## 20. Automated test results

All executed in this session (MariaDB 11.8 in Docker, the repository's test SFTP server):

| Suite                                                                                                   | Command                                                                             | Result                     |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| Contracts                                                                                               | `pnpm --filter @emucat/contracts test`                                              | 19 files, **448 passed**   |
| API (incl. repository access, archive inspection, extraction, explorer, clones, relay, config, staging) | `pnpm --filter @emucat/api test`                                                    | 42 files, **1,202 passed** |
| Web                                                                                                     | `pnpm --filter @emucat/web test`                                                    | 24 files, **556 passed**   |
| Deployer                                                                                                | `pnpm --filter @emucat/deployer test`                                               | 3 files, **51 passed**     |
| Type checks                                                                                             | `pnpm -r check`                                                                     | all workspaces pass        |
| Lint and format                                                                                         | `npx eslint .`, `npx prettier --check .`                                            | clean                      |
| Compose validation                                                                                      | `docker compose -f deploy/compose.yaml config --quiet` (with emucatctl's variables) | valid                      |

New tests: 19 extraction, 24 explorer API (plus slot queue), 2 staging diagnostics, 1 configuration, 6 contracts
detection/encoding, 19 web Archive Explorer; two existing archive UI tests rewritten. A pre-existing flake in the test
SFTP server (ssh2 generating an unparseable ed25519 key about 1 in 300 times) was fixed in the test helper.

**Not executed here, with reasons and commands:**

- `pnpm test:deploy` (deployment tooling integration in Docker): the test image's `apt-get` cannot download inside
  Docker in this environment. Nothing in `deploy/bin`, `deploy/systemd`, `apps/deployer` or `compose.yaml` changed.
  Run on a workstation: `pnpm test:deploy`.
- `pnpm test:compose`, `pnpm test:e2e`, `pnpm test:sftp`, `cargo test`: the agent and the deployment scripts are
  unchanged; the E2E suite builds the agent. Run: `pnpm test:compose`, `pnpm test:e2e`, `pnpm test:sftp`,
  `cargo test --manifest-path agent/Cargo.toml`.

## 21. Production build results

- `pnpm -r build`: contracts, deployer, API (tsc) and web (Vite) all succeed. Web chunks: main 985 KB (289 KB gzip;
  +57 KB for the explorer), `PdfViewer` 503 KB lazy, PDF worker 1.3 MB (loaded only for PDFs), `/vendor/pdfjs` data
  files. The pre-existing "chunk larger than 500 kB" warning for the main bundle remains (it was 928 KB before).
- Docker image builds could not run (Docker Hub answered 429 for the Node base image). Instead, the production
  `dist` was served by `nginxinc/nginx-unprivileged:1.28.0-alpine` with this repository's `nginx.conf`,
  `emucat.conf` and real-IP script: the PDF worker as `application/javascript`, wasm as `application/wasm`, CMaps as
  octet-stream, QuickJS 404, Vditor's highlight.js as JavaScript, `X-Frame-Options: DENY` on the app shell.
  `update` on MARS builds the images (with `EMUCAT_VERIFY=true` running the same type checks and tests).

## 22. Performance and resource validation results

| #   | Property                                        | Result                                                                                                                                              | Kind                                               |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Listing a large archive reads little            | 66,127 of 25,166,537 bytes (end records 64 KiB + directory + manifest)                                                                              | **Measured** (test)                                |
| 2   | Previewing a small file reads only it           | 61 bytes (local header + data); no read below the entry's header offset                                                                             | **Measured** (test)                                |
| 3   | Downloading a small file reads only it          | 61 bytes                                                                                                                                            | **Measured** (test)                                |
| 4   | No local copies                                 | Empty `TMPDIR` stays empty; staging unchanged; read-only container root                                                                             | **Measured** (test) / derived                      |
| 5   | Large files bounded                             | Hex window of a 24 MiB stored disk: 65,580 bytes; 5 GiB ZIP64 entry window: < 64 KiB + 200 bytes; oversized preview/download refused before reading | **Measured** (tests)                               |
| 6   | Cancellation releases resources                 | After disconnect, open SSH connections and SFTP handles return to 0, and 0 further bytes are read                                                   | **Measured** (tests)                               |
| 7   | Concurrency limits                              | Second preview with limit 1 and no queue: 503; loads beyond limit: `inspection_busy`; queue hands slots over                                        | **Measured** (tests)                               |
| 8   | Cache budget                                    | Budget never exceeded; oversized index not admitted (0 indexes, 0 bytes)                                                                            | **Measured** (tests); estimate, not process memory |
| 9   | Peak memory with defaults                       | ≈ 200 MiB for two image conversions + ≤ 64 MiB indexes + listing transients                                                                         | **Theoretical estimate**                           |
| 10  | Real browser                                    | No external request; no console error; PDF drawn; rapid switching shows the last file; phone has no horizontal scroll                               | **Measured** (Chromium, dev server)                |
| 11  | Production API memory, network, latency on MARS | Not measured here                                                                                                                                   | **Requires validation on Mars** (runbook 20.1)     |

## 23. Known limitations

- A deflated entry can be shown in hex only within its first 16 MiB (configurable); stored entries and OVAs at any
  offset.
- A streamed download's integrity is proven at its end; the browser keeps the bytes in memory until then (≤ 100 MiB).
- The archive's own SHA-256 is not recomputed by previews (that would read the whole archive); Verify does that.
- TAR/OVA files have no per-file checksum (`complete`, not `verified`); the OVA's own `.mf` is not consulted.
- Image formats: only the variants in section 8; TGA right-to-left images are not mirrored; TIFF first page only;
  PPM P1/P2/P4/P5 not supported. PDF: encrypted documents cannot be previewed; links and forms inert by design.
- Encoding detection between Windows-1252 and CP437 is heuristic; CP850 manual only; very short files may be guessed
  wrong (the UI says it is a guess).
- Every preview opens its own SSH connection (a handshake per file); no connection pooling.
- Remaining synchronous work is bounded but not on a worker thread (R4).
- Guest filesystems inside disk images, nested archives, editing and uploads are out of scope.
- Cache weights are estimates, not measurements of the Node.js heap.

## 24. Complete Mars deployment runbook

The runbook is committed as [`docs/runbook-0056-mars.md`](../runbook-0056-mars.md); it is reproduced here in full
(sections 19.1–19.6 there are sections 24–25 here, its section 20 is section 26, 21 is 27, 22 is 28).

### What this release changes on a host, and what it does not

| Component                  | Change                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deployment tooling         | **None.** `deploy/bin/emucatctl`, `apps/deployer` and `deploy/systemd` are unchanged since `a2e8988` |
| Docker Compose             | **None.** `deploy/compose.yaml` is unchanged                                                         |
| Persistent directories     | **None.** No new directory; Archive Explorer writes nothing to disk                                  |
| Docker volumes and mounts  | **None**                                                                                             |
| API container memory limit | **None required.** Defaults fit `EMUCAT_API_MEMORY_LIMIT=1g`; see 19.3                               |
| nginx in the web container | **None.** `deploy/docker/web/emucat.conf` is unchanged; `X-Frame-Options: DENY` stays everywhere     |
| VPS reverse proxy          | **None**                                                                                             |
| Cloudflare                 | **None**                                                                                             |
| MariaDB schema             | **None.** No migration: the newest is still `0021_server_repository_access`                          |
| SSH keys, `known_hosts`    | **None.** The server's repository key of decision 0055 is used as it is                              |
| Repository configuration   | **None**                                                                                             |
| Windows agent              | **None.** Neither the agent nor the protocol changed; Archive Explorer needs no agent                |
| `app.env`                  | **Optional** new `ARCHIVE_*` variables, all with defaults (19.2)                                     |
| `deploy.env`               | **None**                                                                                             |

**Is `emucatctl update` alone enough?** Yes, **if MARS already runs the release of decision 0055 with its tooling**
(installed by `emucatctl install` from that release, as its runbook required). Then the installed tooling is
identical to this release's, and `update` builds and starts the new images. If MARS is still on a release before
0055, deploy 0055 first with [its runbook](../runbook-0055-mars.md) (its `install` is required there). 19.1 and 19.4 check
which case applies, with commands, rather than assuming it.

### 19.1 Repository and tooling preparation

No checkout is needed on MARS: `update` fetches `develop` into its own mirror (`/opt/emucat/repo.git`) and builds from a
`git archive` of the exact commit. A checkout is only needed if the tooling must be reinstalled (see the check below).

On the workstation, after this milestone is pushed:

```bash
git fetch origin
git log -1 --format='%H %s' origin/develop
```

That commit ID is `<commit>`.

On MARS, fetch `develop` into the deployment mirror and see the target:

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

It must print `Latest:    <commit> …`. Then check that the installed tooling is this release's:

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat "$(sudo sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' /opt/emucat/state/current-release.json | head -1)" refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml apps/deployer apps/api/migrations
```

- `tooling is current`, and the second command prints **nothing** (or nothing but whitespace): no tooling refresh is
  needed. Go on with 19.4.
- Otherwise (MARS runs a release older than 0055, or its tooling was never reinstalled): refresh the tooling from a
  checkout of `<commit>` first. On the workstation:

  ```bash
  git archive --format=tar --prefix=emucat-src/ origin/develop | ssh mars 'rm -rf ~/emucat-src && tar -x -C ~'
  ```

  On MARS:

  ```bash
  cd ~/emucat-src && sudo deploy/bin/emucatctl install && sudo /opt/emucat/tooling/bin/emucatctl check
  ```

  When upgrading from a release before 0055, follow [the 0055 runbook](../runbook-0055-mars.md) from its 16.1 instead:
  it also provisions the server's SSH key, without which Archive Explorer reports that the server has no repository
  connection.

The `$(…)` reads the deployed commit as `emucatctl` itself does; `sudo /opt/emucat/tooling/bin/emucatctl status`
shows the same commit.

### 19.3 Infrastructure impact

- **Docker Compose, volumes, mounts, directories:** no change; nothing to do.
- **API container memory:** no change required. The worst case of the defaults is about 200 MiB for two concurrent
  image conversions, plus up to 64 MiB (estimated) of cached indexes and the listing transient of one large archive.
  If you raise `ARCHIVE_PREVIEW_IMAGE_*`, `ARCHIVE_PREVIEW_PDF_BYTES` or the concurrency, keep
  `EMUCAT_API_MEMORY_LIMIT` (in `deploy.env`, default `1g`) above roughly four times the largest preview limit times
  its concurrency, and apply it with `update`.
- **nginx (web container), VPS reverse proxy, Cloudflare:** no change. Previews and downloads are ordinary
  `GET /api/v1/...` responses; downloads are at most `ARCHIVE_DOWNLOAD_MAX_BYTES` (100 MiB) and stream with
  `proxy_buffering off`, already configured. Cloudflare's response size limits do not apply to responses this size.
- **MariaDB schema:** no migration. `update` still takes its backup.
- **SSH keys, repository configuration:** no change. Archive Explorer uses the server's existing repository
  connection (decision 0055). Without it, it says so (`server_repository_unavailable`), as View Archive Contents did.
- **Windows agent:** no update. No agent is involved in Archive Explorer.
- **Temporary storage:** none. Archive Explorer must not create files in `data/transfers` or `/tmp`; 20.1 checks it.

### 19.4 Pre-deployment checks

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Note the deployed commit: that is `<previous>`, for rollback.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

`Latest:` must be `<commit>`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Every line must be ok (including the transfer staging directory and the repository SSH directory of 0055).

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

Must print `tooling is current` (see 19.1 otherwise).

```bash
free -h
```

```bash
df -h /opt/emucat /var/lib/docker
```

```bash
sudo docker inspect -f '{{.Name}} memory limit {{.HostConfig.Memory}} bytes' emucat-api-1 emucat-web-1
```

The API's limit is `1073741824` by default.

```bash
sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' emucat-api-1 emucat-web-1
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
curl -fsS http://10.0.0.2:8095/healthz
```

Backup (an `update` takes one too; this is your own restore point):

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

```bash
sudo ls -lt /opt/emucat/backups | head -3
```

### 19.5 Deployment

1. Repository checkout: **not needed** when 19.1 said the tooling is current.
2. Tooling bootstrap: **not needed** in that case (otherwise 19.1).
3. Configuration changes: **none required** (19.2). If you want to change a limit, `sudoedit /opt/emucat/config/app.env`
   now.
4. Installer: **not needed** (`emucatctl install` only when 19.1 said so).
5. Application update:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. Stages: checking repository, fetching source, building (API and web images), testing
   (`EMUCAT_VERIFY=true`: type checks, contracts tests, database-free API tests, the web tests), backing up the
   database, applying migrations (prints that none were applied), starting services, health checking, completed. The
   same can be started from Admin › Application Updates.

6. Container recreation and service restart: done by `update` (`compose up` recreates both containers with the new
   images). Nothing else to restart; `emucat-deployer` is not touched.

### 19.6 Post-deployment verification

1. Running release:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl status
   ```

   ```bash
   sudo docker inspect -f '{{.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1 emucat-web-1
   ```

   Both must show `<commit>`.

2. Container health:

   ```bash
   sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}} {{.Image}}'
   ```

   Both `(healthy)`.

3. API health:

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/health
   ```

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/ready
   ```

4. Frontend and its new assets:

   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' https://emucat-test.dfri.info/
   ```

   ```bash
   curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' https://emucat-test.dfri.info/vendor/pdfjs/6.5.438/wasm/openjpeg.wasm
   ```

   `200 application/wasm`.

   ```bash
   sudo docker exec emucat-web-1 sh -c 'ls /usr/share/nginx/html/assets | grep pdf.worker'
   ```

   One `pdf.worker.min-….js` (a `.js`, not `.mjs`).

   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' https://emucat-test.dfri.info/vendor/pdfjs/6.5.438/wasm/quickjs-eval.wasm
   ```

   `404`: PDF scripting is not shipped.

   ```bash
   curl -sI https://emucat-test.dfri.info/ | grep -i x-frame-options
   ```

   `X-Frame-Options: DENY`, unchanged.

5. Configuration values in effect (only those set in `app.env` appear; the rest are defaults):

   ```bash
   sudo docker exec emucat-api-1 printenv | grep -E '^ARCHIVE_' || echo "defaults"
   ```

6. Logs:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
   ```

   No `Invalid configuration`. After opening an archive: `Archive indexed` with `entries` and `estimatedBytes`.

   ```bash
   sudo ls -t /opt/emucat/state/operations | head -2
   ```

   ```bash
   journalctl -u emucat-deployer -n 50
   ```

7. Repository connectivity: Admin › Repositories › **Test Server Connection**: every step green. A configuration
   change after deployment: `sudo docker stop emucat-api-1`, then `sudo /opt/emucat/tooling/bin/emucatctl update`
   (with the API stopped, `update` redeploys the same commit in full and the new container reads `app.env`).

8. Staging cleanup diagnostics:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 2000 | grep -E 'Staging cleanup|staging area|not UUID-named' || echo "no staging warnings"
   ```

   Normally `no staging warnings`. A warning names the files that EmuCat did not create in `data/transfers`; they are
   left alone (20, item 35).

## 25. Complete configuration change inventory

### 19.2 Configuration changes

All new variables are **optional**, go in `/opt/emucat/config/app.env`, have defaults applied by the API itself, and
need **no manual change** on an existing deployment. `emucatctl` does not add them; `deploy.env` gets nothing new.
They are read when the API container is created: set them **before** `update`. A change after deployment takes effect
when the API container is recreated (see 19.6 step 7).

| Variable                                 | Purpose                                                | Default     | Required | File      | Example    | Manual change on existing deployments | Restart                 |
| ---------------------------------------- | ------------------------------------------------------ | ----------- | -------- | --------- | ---------- | ------------------------------------- | ----------------------- |
| `ARCHIVE_INSPECTION_MAX_ENTRIES`         | Entries of an archive the server indexes (1000–500000) | `200000`    | Optional | `app.env` | `300000`   | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_DIRECTORY_BYTES` | ZIP central directory read into memory (1–128 MiB)     | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_MANIFEST_BYTES`  | Manifest inflated and parsed (1–128 MiB)               | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_CONCURRENT`      | Archives indexed at once (1–16)                        | `2`         | Optional | `app.env` | `1`        | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_TIMEOUT_SECONDS`     | Deadline for indexing one archive (5–3600)             | `120`       | Optional | `app.env` | `300`      | No                                    | API container recreated |
| `ARCHIVE_CACHE_MAX_INDEXES`              | Archive indexes kept in memory (0–256)                 | `8`         | Optional | `app.env` | `4`        | No                                    | API container recreated |
| `ARCHIVE_CACHE_TTL_SECONDS`              | How long an index is kept (0–86400)                    | `600`       | Optional | `app.env` | `1800`     | No                                    | API container recreated |
| `ARCHIVE_CACHE_MAX_BYTES`                | Estimated memory of the kept indexes (0–4 GiB)         | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_TEXT_BYTES`             | Text shown per file (4 KiB–16 MiB)                     | `262144`    | Optional | `app.env` | `524288`   | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_HEX_BYTES`              | One hex window (1 KiB–4 MiB)                           | `65536`     | Optional | `app.env` | `131072`   | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_IMAGE_BYTES`            | Largest image previewed (64 KiB–256 MiB)               | `20971520`  | Optional | `app.env` | `10485760` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_IMAGE_PIXELS`           | Most pixels of an image previewed                      | `16777216`  | Optional | `app.env` | `8388608`  | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_PDF_BYTES`              | Largest PDF previewed (64 KiB–512 MiB)                 | `26214400`  | Optional | `app.env` | `52428800` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_SEEK_BYTES`             | How far into a deflated entry hex may start (0–1 GiB)  | `16777216`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_MAX_CONCURRENT`         | Details and previews at once (1–16)                    | `2`         | Optional | `app.env` | `3`        | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_MAX_QUEUED`             | Previews that may wait up to 10 s for a slot (0–64)    | `8`         | Optional | `app.env` | `4`        | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_TIMEOUT_SECONDS`        | Deadline of one preview (5–600)                        | `60`        | Optional | `app.env` | `120`      | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_BYTES`             | Largest single-file download; `0` turns them off       | `104857600` | Optional | `app.env` | `52428800` | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_CONCURRENT`        | Single-file downloads at once (1–16)                   | `2`         | Optional | `app.env` | `1`        | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_QUEUED`            | Downloads that may wait up to 10 s for a slot (0–64)   | `2`         | Optional | `app.env` | `0`        | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS`       | Deadline of one download (10–86400)                    | `1800`      | Optional | `app.env` | `3600`     | No                                    | API container recreated |

PDF previews need no setting: PDF.js and its data files are part of the web image. There is no configuration
introduced by the deployment tooling in this release.

To see what is set now, without printing a secret:

```bash
sudo grep -E '^(ARCHIVE_|REPOSITORY_SSH_(CONNECT|REQUEST)_TIMEOUT|TRANSFER_)' /opt/emucat/config/app.env || echo "no ARCHIVE_ or TRANSFER_ settings: defaults apply"
```

```bash
sudo grep -vE '^(#|$)' /opt/emucat/config/deploy.env | grep -vE 'TOKEN|KEY|PASSWORD'
```

To change one (MARS needs none), before `update`:

```bash
sudoedit /opt/emucat/config/app.env
```

## 26. Mars functional acceptance checklist

### 20. Mars functional acceptance checklist

Prepare: one 86Box VM with a master and a snapshot, one QEMU VM with a snapshot, one VirtualBox OVA version, and in
at least one ZIP version the files listed below. If a VM lacks such files, register a snapshot after copying them
into its directory (for example a `docs/` folder): an extensionless `README`, a UTF-8 `notes.txt` with accents, a
Windows-1252 `win.txt` (curly quotes, `é`), a DOS `MENU.TXT` with box characters (CP437), `notes.md` containing a
table, a `<script>`, an image link to `https://example.com/x.png` and a web link, `page.html`, `logo.svg`, a PNG or
JPEG, a BMP, a PPM (QEMU screendumps are PPM), a PCX or TGA, a multi-page PDF, a ROM or `.nvr` file, and a file larger
than 100 MiB (a disk image is). "Archive Explorer" is Version History › a version › **View contents…**.

| #   | Scenario                      | How                                                                                                         | Expected outcome                                                                                                                                                                                      |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 86Box master                  | Open Archive Explorer on the 86Box master                                                                   | Title "Archive Explorer"; master, date, ZIP, size, repository; tree with folders first; placeholder on the right; **Archive details** show the SHA-256 and "the one verified when … registered"       |
| 2   | QEMU snapshot                 | Open it on a QEMU snapshot                                                                                  | "Snapshot: …"; same features as a master; its own files                                                                                                                                               |
| 3   | VirtualBox OVA                | Open it on an OVA version                                                                                   | Only **Stored entries**; `.ovf`, `.vmdk`, `.mf`; `.ovf` previews as XML; the `.vmdk` shows hex at any offset                                                                                          |
| 4   | Nested directories            | Expand several levels; collapse; expand again                                                               | Children appear under their parent, indented; collapsing and re-expanding does not reload; a folder of more than 200 entries shows **Show more**                                                      |
| 5   | Logical / physical            | Switch **VM files** ↔ **Stored entries**                                                                    | Physical shows `.emucat-manifest.json`; each view keeps its expanded folders                                                                                                                          |
| 6   | Search                        | Search a file name part                                                                                     | Flat list of matching paths; selecting one previews it; a folder result opens it in the tree                                                                                                          |
| 7   | Configuration file            | Select the `.cfg` (86Box) or a `.ini`                                                                       | Text mode, highlighted (sections, keys, values in colour); "UTF-8, valid throughout"; "matched its recorded checksum"                                                                                 |
| 8   | Extensionless README          | Select `README`                                                                                             | Detected as text from its contents; plain text, wrapped                                                                                                                                               |
| 9   | UTF-8 text                    | Select `notes.txt`                                                                                          | Accents correct; UTF-8 (detected)                                                                                                                                                                     |
| 10  | Windows-1252                  | Select `win.txt`                                                                                            | Windows-1252 (detected), "a guess from the bytes"; curly quotes and `é` correct                                                                                                                       |
| 11  | CP437 DOS text                | Select `MENU.TXT`                                                                                           | CP437 (detected); box lines drawn as `╔═╗ ║`                                                                                                                                                          |
| 12  | Manual encoding               | On `MENU.TXT` choose Windows-1252, then CP850, then CP437                                                   | Characters change at once; no new request in the browser's network panel                                                                                                                              |
| 13  | Syntax highlighting           | `AUTOEXEC.BAT`, a `.ps1`, `.xml`/`.ovf`, `.json`; toggle **Highlight**                                      | Colours per language; off shows plain text; nothing else changes                                                                                                                                      |
| 14  | PNG or JPEG                   | Select it                                                                                                   | Image fitted; "PNG, W × H pixels"; **100%**, **+**, **−** zoom; pixelated when enlarged                                                                                                               |
| 15  | BMP                           | Select it                                                                                                   | Shown by the browser; "BMP, W × H"                                                                                                                                                                    |
| 16  | PPM                           | Select a `.ppm`                                                                                             | Shown; "PPM, …, converted to PNG by the server for display"                                                                                                                                           |
| 17  | Legacy format                 | Select a `.pcx`, `.tga` or `.tif`                                                                           | Shown, converted to PNG; an unsupported variant says "not supported" without breaking the explorer                                                                                                    |
| 18  | PDF                           | Select the PDF; **Next page**, **Previous page**, type a page, **Fit width**, **+**/**−**                   | Page drawn; "Page n of N"; links in the PDF are not clickable; "Drawn as an image: links, forms, attachments and scripts in the PDF are not active"                                                   |
| 19  | Markdown                      | Select `notes.md`; **Rendered**, then **Text**                                                              | Rendered: headings, table; no script runs; the image shows "[image: …, not loaded]"; the link shows its target on hover but does not navigate. Text: the source                                       |
| 20  | HTML as inert source          | Select `page.html`                                                                                          | Source code with highlighting; nothing rendered or executed                                                                                                                                           |
| 21  | SVG as inert source           | Select `logo.svg`                                                                                           | XML source; never drawn as an image                                                                                                                                                                   |
| 22  | ROM / NVR in hex              | Select `*.bin` or `*.nvr`                                                                                   | "No preview is available"; hex rows `offset  hex  chars`; **CP437** toggle; **Next**, **Go** to `0x100`                                                                                               |
| 23  | Download                      | On a small file, **Download file**                                                                          | Browser saves it with its own name; "Downloaded and verified."                                                                                                                                        |
| 24  | Verify the download           | `sha256sum` the downloaded file                                                                             | Equals the SHA-256 shown in the details (from the manifest), or, for an OVA file, the source file's                                                                                                   |
| 25  | Oversized preview             | Select a large image or PDF over its limit (or lower `ARCHIVE_PREVIEW_PDF_BYTES` to test)                   | Only Hex offered, with "PDF files are previewed up to …"                                                                                                                                              |
| 26  | Oversized download            | Select the disk image (> 100 MiB)                                                                           | No **Download file** button; "Files larger than 100.0 MiB cannot be downloaded one at a time … Restore the version"                                                                                   |
| 27  | Rapid switching               | Click quickly through ten files                                                                             | The last clicked file is shown; never an earlier one; at most a short wait                                                                                                                            |
| 28  | Close during a preview        | Open the PDF or a large hex window and press **Escape** at once                                             | Dialog closes; no error                                                                                                                                                                               |
| 29  | Repository resources released | After 28: the command below                                                                                 | No SSH connection from the API remains after a few seconds                                                                                                                                            |
| 30  | Repository unreachable        | Block the NAS from the API (or stop its SSH) and open a version not opened in the last 10 minutes           | A clear message ("cannot be reached…"); the explorer stays usable; after unblocking, it works again                                                                                                   |
| 31  | Unauthorized access           | The `curl` commands below; and signed in as a non-administrator, if one exists                              | `401` without a session; `403` for a non-administrator; never file bytes                                                                                                                              |
| 32  | Light and dark                | Switch the theme in the header while a highlighted file is shown                                            | Both readable; highlight colours adapt                                                                                                                                                                |
| 33  | Clone still works             | Version History › **Clone…** a small version                                                                | Succeeds as before (decision 0055)                                                                                                                                                                    |
| 34  | HTTP relay still works        | An agent with `transport = "relay"`: run its repository check, or a small registration                      | Succeeds as before                                                                                                                                                                                    |
| 35  | Staging diagnostics           | `sudo touch /opt/emucat/data/transfers/transfers/stray.txt`; wait two minutes; read the log; then remove it | Log: "The staging area holds files EmuCat did not create … left in place" naming `stray.txt`, once; the file is **not** deleted by EmuCat; after `sudo rm` it logs that the area no longer holds them |

For 29 (repository connections; the NAS's SSH port, usually 22):

```bash
sudo nsenter -t "$(sudo docker inspect -f '{{.State.Pid}}' emucat-api-1)" -n ss -tn state established '( dport = :22 )'
```

Only the header line remains a few seconds after the last preview.

For 31, from any computer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://emucat-test.dfri.info/api/v1/admin/vms/86box/<vm>/versions/<version-id>/archive/entry/download?view=logical&path=README"
```

`401`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'sec-fetch-site: cross-site' "https://emucat-test.dfri.info/api/v1/admin/vms/86box/<vm>/versions/<version-id>/archive/entry?path=README"
```

`401` (no session; with an administrator's session cookie it would be `403`).

#### 20.1 Diskless architecture validation

These commands only read. Container names are those of the Compose project `emucat`; to discover them:

```bash
sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}}'
```

Pick a version whose archive is several GiB and holds a small file (an 86Box or QEMU VM with a large disk image and
its `.cfg`). Note its size on the Version History card. Unrelated activity (agents, transfers, clones, screenshot
processing, other administrators) changes network and memory counters: measure when the server is otherwise quiet,
and repeat a measurement if a number looks wrong.

1. Baseline, before opening the explorer:

   ```bash
   START=$(date '+%Y-%m-%d %H:%M:%S')
   ```

   ```bash
   api_rx() { sudo docker exec emucat-api-1 node -e 'const t=require("fs").readFileSync("/proc/net/dev","utf8").split("\n").slice(2).map(l=>l.trim().split(/[:\s]+/)).filter(p=>p[0]&&p[0]!=="lo").reduce((s,p)=>s+Number(p[1]),0);console.log(t)'; }
   ```

   ```bash
   api_rx
   ```

   ```bash
   sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.NetIO}}' emucat-api-1
   ```

   ```bash
   sudo ls -la /opt/emucat/data/transfers/transfers /opt/emucat/data/transfers/clones
   ```

   ```bash
   sudo docker exec emucat-api-1 sh -c 'find /tmp -mindepth 1 | head; df -k /tmp | tail -1'
   ```

   ```bash
   sudo docker ps --size --filter name=emucat-api-1 --format '{{.Names}} writable layer: {{.Size}}'
   ```

   ```bash
   sudo docker diff emucat-api-1
   ```

   The API's root filesystem is read-only (`read_only: true`), so `docker diff` prints nothing and the writable layer
   is `0B`; `/tmp` is a 64 MiB tmpfs.

2. **Listing.** Open Archive Explorer on that version (first time in 10 minutes, so it is not cached). Run `api_rx`
   again. The difference is what the listing read: expected tens of KiB to a few MiB (the end of the archive, the
   central directory, the manifest), whatever the archive's size.

3. **Preview.** Select the small `.cfg`. Run `api_rx`. Expected difference: a few KiB to tens of KiB (4 KiB to detect
   its type, then the file, plus SSH and database overhead).

4. **Individual download.** **Download file** on the same `.cfg`. Run `api_rx`. Expected: about the file's size plus
   overhead, never the archive's.

5. **Large file bounds.** Select the disk image: Hex at offset 0 and **Next**. Expected per window: about 64 KiB plus
   overhead.

6. Afterwards, the same commands as in step 1: `data/transfers` unchanged (nothing new since `$START`), `/tmp` still
   empty, `docker diff` empty, writable layer `0B`, memory back near its baseline within a minute (an index stays
   cached, at most `ARCHIVE_CACHE_MAX_BYTES`, estimated):

   ```bash
   sudo find /opt/emucat/data/transfers -newermt "$START" -mindepth 1 | head
   ```

   Prints nothing.

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 300 | grep -E 'Archive indexed|Archive file downloaded'
   ```

   `Archive indexed` with `entries` and `estimatedBytes`; `Archive file downloaded` with `bytes` and
   `integrity: verified`.

Expected relation: archive size (GiB) ≫ listing traffic (KiB–MiB) ≫ preview traffic (KiB) ≈ download traffic (the
file's size). For reference, the automated test measured, on a 25,166,537-byte archive: listing 66,127 bytes read from
the repository, text preview 61 bytes, single-file download 61 bytes, a 64 KiB hex window of the 24 MiB disk 65,580
bytes (SFTP payload only, without SSH and database overhead).

## 27. Rollback and recovery instructions

### 21. Rollback and recovery

No database migration is part of this release, so `rollback-app` to the previous release is safe, and no database
restore is ever needed for it. Do not restore a backup to undo this release. VM data, repository archives, notes,
screenshots and settings are untouched by it.

- **Restore the previous working release** (both containers, from images still present):

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
  ```

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl status
  ```

  To go forward again later: `sudo /opt/emucat/tooling/bin/emucatctl update`.

- **Failed deployment tooling update** (only if 19.1 made you run `install`): the application keeps running.
  `journalctl -u emucat-deployer -n 50`, fix what `install` printed, run it again from the same checkout. To return
  to the earlier tooling, `git archive <previous>` to MARS and run that checkout's `install`.

- **Failed application update:** before the containers were replaced, nothing changed (`status` shows `<previous>`).
  After a failed start without a migration, `update` restores the previous release by itself (`restored_previous`).
  Read `/opt/emucat/state/operations/<id>.log`, fix, run `update` again.

- **Incorrect configuration** (the API does not start; its log says `Invalid configuration` and names the variable):

  ```bash
  sudoedit /opt/emucat/config/app.env
  ```

  Fix or remove the named `ARCHIVE_*` line (an empty value means the default), then:

  ```bash
  sudo docker stop emucat-api-1
  ```

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl update
  ```

- **Preview limits too restrictive** (`preview_too_large`, `image_too_large`, "only the hexadecimal view" for files you
  expect to see, or `preview_busy` under normal use): raise `ARCHIVE_PREVIEW_PDF_BYTES`, `ARCHIVE_PREVIEW_IMAGE_BYTES`,
  `ARCHIVE_PREVIEW_IMAGE_PIXELS`, `ARCHIVE_PREVIEW_TEXT_BYTES` or `ARCHIVE_PREVIEW_MAX_QUEUED` in `app.env`, then stop
  the API and `update` as above. Mind 19.3.

- **API memory pressure** (`docker stats` near the limit, the container restarted with `OOMKilled`):

  ```bash
  sudo docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' emucat-api-1
  ```

  Lower `ARCHIVE_PREVIEW_MAX_CONCURRENT` to `1`, `ARCHIVE_PREVIEW_IMAGE_PIXELS` to `8388608`, `ARCHIVE_CACHE_MAX_BYTES`
  to `33554432` and `ARCHIVE_INSPECTION_MAX_CONCURRENT` to `1`; or raise `EMUCAT_API_MEMORY_LIMIT` in
  `/opt/emucat/config/deploy.env` (for example `1536m`). Then stop the API and `update`.

- **PDF rendering failures** ("This PDF could not be read" for every PDF, or nothing drawn): check that the worker and
  data files are served (19.6 step 4). The browser's console names a blocked or failed `/vendor/pdfjs/…` or
  `/assets/pdf.worker…` request. A single damaged or encrypted PDF failing is expected; it can still be downloaded.
  Everything else in the explorer keeps working. If PDF previews must be avoided, lower `ARCHIVE_PREVIEW_PDF_BYTES` to
  `65536`: PDFs then offer only hex and download.

- **Repository connection failures** (`repository_unreachable`, `host_key_*`, `ssh_authentication_failed`): Admin ›
  Repositories › **Test Server Connection** names the failing step; follow the 0055 runbook's rollback section for SSH
  credentials. The explorer reports it and nothing else is affected.

- **Frontend asset loading failures** (blank page, errors about `/assets/…` or `/vendor/…`): reload with the cache
  bypassed; check `curl -I https://emucat-test.dfri.info/` and the 19.6 asset checks; `sudo docker logs emucat-web-1
--tail 100`. If the web image is broken, `rollback-app --to <previous>`.

- **Reverse-proxy problems** (downloads cut off early on a healthy server): a proxy timeout or response size limit in
  front of the web container. Downloads are at most 100 MiB by default; `proxy_read_timeout` of one hour is already
  configured in the web container; check the VPS proxy's timeouts. Lower `ARCHIVE_DOWNLOAD_MAX_BYTES` if a proxy limit
  cannot be changed. No proxy change is needed by this release.

## 28. Moon production promotion instructions

### 22. Production promotion (MOON)

Only after every MARS check passed. Not done as part of this change.

1. Synchronize the local repository:

   ```bash
   git fetch origin
   ```

   ```bash
   git switch main
   ```

   ```bash
   git pull --ff-only
   ```

2. Merge `develop` into `main`:

   ```bash
   git merge --no-ff origin/develop -m "Merge develop: Archive Explorer (decision 0056)"
   ```

3. Push `main`:

   ```bash
   git push origin main
   ```

4. Verify the production commit:

   ```bash
   git log -1 --format='%H %s' origin/main
   ```

   ```bash
   git merge-base --is-ancestor <commit> origin/main && echo "contains <commit>"
   ```

   On MOON:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check-update
   ```

   It must name the merge commit as `Latest:`.

5. MOON configuration: `deploy.env` needs nothing new; `app.env` needs nothing new (19.2). Review the limits against
   MOON's memory: `free -h`, `sudo docker inspect -f '{{.HostConfig.Memory}}' emucat-api-1`.

6. MOON deployment tooling: same check as 19.1, on MOON, with `refs/remotes/origin/main`:

   ```bash
   sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/main:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
   ```

   If MOON is not yet on decision 0055, promote that first with its runbook (16.10 there), including MOON's own SSH key.

7. Deploy:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl backup
   ```

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

8. Verify production health: 19.6 steps 1–6 with MOON's public address and web container address.

9. Limited production smoke test: open Archive Explorer on one small version; preview one text file and one image;
   download one small file and compare its `sha256sum` with the details; check that no file appeared in
   `/opt/emucat/data/transfers`. Leave the rest to normal use.

## Explicit answers

| Question                                      | Answer                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Archive Explorer create temporary files? | **No.** Nothing is written to `data/transfers`, `/tmp`, the container layer or any cache; tested with an empty `TMPDIR`, and the API's root filesystem is read-only.                                                                  |
| Does any preview download an entire archive?  | **No.** Listing reads end records, central directory and manifest; previews read one entry's header and bytes, bounded by the preview limit (measured: 61 bytes for a small file of a 25 MB archive).                                 |
| Does individual file download use staging?    | **No.** It streams from the repository through a 1 MiB in-memory buffer; staging stays reserved for the relay and clones.                                                                                                             |
| What is cached in memory?                     | Archive **indexes** only (paths, metadata, compact locators, manifest hashes): at most 8, for 10 minutes, within an estimated 64 MiB. Never file contents.                                                                            |
| What are the maximum resource limits?         | Section 25: text 256 KiB, hex 64 KiB, image 20 MiB / 16.7 MP, PDF 25 MiB, download 100 MiB, previews 2 (+8 queued), downloads 2 (+2 queued), deadlines 60 s / 1800 s / 120 s (index), 200,000 entries, 64 MiB directory and manifest. |
| How are cancelled requests handled?           | Browser disconnect or deadline aborts the operation's signal: SFTP reads stop, the SSH session closes, inflation streams are destroyed, the slot is freed. Coalesced index loads stop only when every requester has left.             |
| Are repository connections always released?   | **Yes**: every connection is closed in a `finally`, at once on abort; tests assert open SSH connections and SFTP handles return to 0 after success, cancellation, deadlines and failures.                                             |
| Is any Windows agent update required?         | **No.** Agent and protocol unchanged; no agent is involved.                                                                                                                                                                           |
| Is deployment tooling refresh required?       | **No**, if MARS runs the decision-0055 release with its installed tooling (runbook 19.1 checks it with a `diff`); otherwise deploy 0055 first with its runbook.                                                                       |
| Are new environment variables required?       | **No.** 21 new `ARCHIVE_*` variables exist, all optional with safe defaults; no manual change.                                                                                                                                        |
| Are database migrations required?             | **No.** Newest migration remains `0021_server_repository_access`; `rollback-app` to the previous release is safe.                                                                                                                     |
| Are reverse-proxy changes required?           | **No.** Neither the web container's nginx, the VPS proxy nor Cloudflare change; `X-Frame-Options: DENY` stays.                                                                                                                        |

The mandatory configuration and installation instructions are complete (sections 24–28). Subject to the Mars
validation of section 26, the milestone is ready to deploy to MARS with `emucatctl update`.
