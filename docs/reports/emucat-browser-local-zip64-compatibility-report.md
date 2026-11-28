# EmuCat M0.1: Browser-local ZIP64 compatibility, implementation report

**Scope:** apply decision 0061's ZIP64 duplicate-record policy (F-4) to the browser-local nested-archive reader of
decision 0058. **Branch:** `develop`. **Date:** 2026-11-28.

Evidence labels used throughout:

- **[verified]** run in this session (Linux cloud container), with the command and its result.
- **[source]** a conclusion from reading the code or documents, not executed.
- **[expected]** expected behavior on MARS or MOON, from the code and tooling; **not run on either host**.
- **[not run]** a validation that was not executed, with the reason.

## 1. Executive summary

- **Defect confirmed [verified].** `apps/web/src/archive-local/zip.ts` took the **first** ZIP64 record of each central
  record (`zip64Field()`), so a nested ZIP written by the agent's zip 7.3 with a `large_file` entry (placeholder
  record of `0xFFFFFFFF`, then the real one) resolved its sizes to 4,294,967,295 and was refused as damaged by the
  check `localHeaderOffset + 30 + compressedSize > directoryOffset` (old `zip.ts:184`): the same symptom as F-4 on the
  server. It also accepted contradictory records silently and did not validate the framing of extra fields after the
  first ZIP64 record.
- **Fix [verified].** `resolveZip64()`, a port of the server's function of the same name (commit `7d54051`), resolves
  each `0xFFFFFFFF` field over **all** ZIP64 records, exactly as decision 0061's table says. One production file
  changed (`zip.ts`, +43/−27). No limit, error code, UI, API, contract, agent or deployment change.
- **Regression evidence [verified].** New `apps/web/test/archive-local/zip64.test.ts` (24 tests) and two interface
  tests in `apps/web/test/archive-nested.test.tsx`. Against the original `zip.ts`: **18 of 24** unit tests and **both**
  interface tests fail (3 of 3 runs); with the fix all pass.
- **Suites [verified].** Web: 653/653 tests (30 files), `tsc --noEmit`, ESLint, Prettier and `vite build` pass. API
  ZIP64, Archive Explorer and clone tests with MariaDB: 62/62. Full `pnpm test`: see §20.
- **Consistency.** The API and web readers now agree on every resolution case of decision 0061. They differ only in
  error wording, in the browser's smaller limits (which still apply to every resolved value), and in the browser
  listing unreadable entries instead of refusing the archive, all as before (§15).
- **Deployment.** Web image only changes in behavior. `sudo /opt/emucat/tooling/bin/emucatctl update` on MARS, as in
  M0; no migration, no tooling refresh, no agent update, no configuration [expected]. Nothing was deployed.

## 2. Implementation scope

In scope and done: the browser-local ZIP reader, its tests and fixture builder, a small archive generator for manual
acceptance, decision 0061 amended to cover both readers, decision 0058's format table, `docs/testing.md`,
`docs/archive-explorer.md` and this report.

Not touched: the API reader (`apps/api/src/archives/zip.ts` is byte-identical to `1c45e18`), the agent, protocol,
schema, Compose, nginx, deployment tooling, resource limits (`limits.ts` unchanged), E2E assertions and the Windows
browser-test launcher (M0.2), Disk Image Explorer (M1).

## 3. Repository baseline

| Item                    | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| Baseline commit         | `1c45e188ab5a8a8eaa03b0087d192739cddf7359` (`origin/develop`, M0's last) |
| `origin/main`           | `79981c5f49c1fd820572bf3c28915a511533d9a4` (unchanged)                   |
| Local clone before work | `a2e8988`, fast-forwarded to `1c45e18`; no other commit on `develop`     |
| Toolchain               | Linux; Node 22; pnpm 12.10.1; Vitest 5.1.0; Docker 29.9.3 (MariaDB)      |

The commits M0 reported (`7d54051`, `bc03ece`, `1c45e18`) are present and are the newest three on `develop`
[verified: `git log --oneline -5 origin/develop`].

## 4. Relationship to the API-side F-4 correction

F-4 is the agent's zip 7.3 writing two ZIP64 records per central record that needs ZIP64 (decision 0061, "Context").
M0 fixed the server's reader and explicitly left the browser-local reader out, recording it in 0061's
"Consequences" and in M0's report §30. M0.1 closes that item with the same policy; the server's code is unchanged and
its tests still pass (§20).

## 5. Decision 0058 architecture review [source]

Unchanged by this milestone, and re-checked against the diff:

- A nested archive is downloaded whole through the existing single-file download, only when expanded; deeper levels
  are extracted by the worker from bytes it already holds. The outer master or snapshot is never downloaded.
- Everything is held in the module worker's memory; nothing in IndexedDB, localStorage, OPFS, Cache Storage or a
  service worker; no temporary files, no WebAssembly, no native code.
- `readZip()` still runs only inside `LocalArchive.open()`, inside the worker (`engine.ts:92`). The fix adds no
  import, no allocation proportional to declared sizes, no loop beyond the extra field's length.

## 6. Decision 0061 policy review [source + verified]

The server's `resolveZip64()` (`apps/api/src/archives/zip.ts`), read line by line against 0061's table:

| 0061 rule                                                   | Server code                                      | Web code (new)                       |
| ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| No field `0xFFFFFFFF`: fixed fields, records not read       | `wanted === 0 → return fixed`                    | same                                 |
| Field `0xFFFFFFFF`, no record: refused                      | `records.length === 0 → malformed`               | same (`malformed`)                   |
| Any record shorter than `8 × wanted`: refused               | loop over every record                           | same                                 |
| Value above 2^53 − 1 in any record (at a wanted position)   | `u64()` throws "A size or offset is too large"   | `u64()` returns `null` → `malformed` |
| `0xFFFFFFFF` yields to another value; equal values agree    | `candidate === MAX_U32 \|\| === resolved → skip` | same                                 |
| Two different non-placeholder values: refused               | "records contradict each other"                  | same (`malformed`)                   |
| All records `0xFFFFFFFF`: that is the value                 | `resolved` stays `MAX_U32`                       | same                                 |
| Bytes after the required fields: ignored                    | not read                                         | same                                 |
| Extra-field framing: a record running past the end: refused | `extraRecords()` walks every record              | `zip64Records()` walks every record  |
| Then every existing bounds/local header/size/CRC check      | unchanged                                        | unchanged                            |

No shared-policy defect was found in the API implementation.

## 7. Browser-local defect reproduction [verified]

The original reader (`git show 1c45e18:apps/web/src/archive-local/zip.ts`) was put back in place of the fix and the
new tests run against it, then the fix restored (`git diff --stat` confirmed):

```bash
pnpm --filter @emucat/web exec vitest run test/archive-local/zip64.test.ts
```

Result: `Tests  18 failed | 6 passed (24)`. The agent-layout cases fail with
`LocalArchiveError: The archive is damaged or is not the format it appears to be.` at `readZip src/archive-local/zip.ts:184`,
the bounds check that 4 GiB placeholder sizes break. The malformed-record cases fail with `Expected a failure`: the old
reader accepted contradictory records (first wins), records too short in a second ZIP64 record, out-of-range values in
a second record, and broken framing after the first ZIP64 record.

Through the interface:

```bash
pnpm --filter @emucat/web exec vitest run test/archive-nested.test.tsx
```

Original reader, three runs: `Tests  2 failed | 11 passed (13)` each time:
`Unable to find role="treeitem" and name "docs, directory"` (the nested ZIP64 archive did not open) and
`Unable to find role="alert"` (the contradictory archive was not refused). With the fix: 13/13, three runs.

## 8. Practical exposure under current resource limits [source + verified]

Limits (`apps/web/src/archive-local/limits.ts`, unchanged): nested archive 64 MiB; depth 5; retained cache 128 MiB;
20,000 entries; 2 opens at once, 4 waiting; text 256 KiB; hex window 64 KiB; deflate seek 16 MiB; image 20 MiB and
16.7 MP; PDF 25 MiB; download of an inner file 100 MiB; path 4096 bytes; 60 s per operation. Methods: stored and
deflate only (others listed and marked). Cancellation: checked between 4 KiB inflate slices and rows of images; the
worker yields every few milliseconds.

| Layout                                                          | Can it reach the browser?                                    | Behavior now                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Small archive using ZIP64 fields for small entries (`zip -fz`)  | Yes                                                          | Read, as before (one record)                                                                                              |
| Agent archive (two records) whose entries are small             | Only if a writer marks small entries ZIP64; zip 7.3 does not | Read (was refused)                                                                                                        |
| Agent archive of a ≥ 3.75 GiB file that compresses below 64 MiB | Yes: 0061 condition (A), e.g. a zero-filled disk image       | Opens and lists with the real size (was refused); hex/text previews read its start; download/open whole refused by limits |
| Duplicated records with equal values                            | Yes, any writer                                              | Read                                                                                                                      |
| Offsets beyond 4 GiB (condition B)                              | No: a nested archive is in memory and at most 64 MiB         | A ZIP64 offset resolves the same way; one beyond the payload is refused by the bounds check                               |
| Malformed ZIP64 trying to bypass limits                         | Yes                                                          | Refused or bounded (§14)                                                                                                  |

So the user-visible change is narrow: nested agent archives under (A), and any nested archive whose writer duplicates
ZIP64 records. No limit was raised.

## 9. Selected implementation approach

The smallest change that matches the server: `zip64Field()` (first record) became `zip64Records()` (every record,
validating the framing of the whole extra field, as before for the part it walked), and the inline `take()` became
`resolveZip64(fixed, records)`, the server's function with the web's error type and its null-returning `u64()`.
`readZip()` destructures the three resolved values; everything after is untouched.

Rejected: last-record-wins (silently picks one of two contradictory records, decision 0061 "Why not last record
wins"); refusing `0xFFFFFFFF` outright (a legitimate value, 0061).

## 10. Shared-code assessment

Kept separate, documented in decision 0061 ("The browser-local reader"):

- `packages/contracts` is the only shared package. Its archive code (`archive-preview`) is byte-level content
  detection; it has no ZIP structure, and the worker imports it through a build alias to keep zod out (0058 §7).
- The server reads `Buffer`s with `readBigUInt64LE` from a streamed directory and throws `archive_malformed` with
  messages; the browser reads `Uint8Array`s with its own bounds-safe readers and throws code-only
  `LocalArchiveError`s. A shared function would need both an error factory and a reader abstraction for twenty lines.
- Dependency direction and bundle size: adding parser code to contracts would ship it to every contracts consumer.

Divergence is prevented instead by mirrored tests: every API case in `apps/api/test/zip64.test.ts` that can exist in
memory has a counterpart in `apps/web/test/archive-local/zip64.test.ts` (§15), and 0061 now says a policy change
changes both.

## 11. ZIP64 resolution semantics

For each of uncompressed size, compressed size, local header offset (that order), when the fixed field is
`0xFFFFFFFF`: every ZIP64 record (`0x0001`) holds a 64-bit value at the position given by the count of earlier
`0xFFFFFFFF` fields. The value is the one non-placeholder value all records agree on; a record giving `0xFFFFFFFF`
yields; if none gives anything else, `0xFFFFFFFF` is the value. Fields not marked are never taken from ZIP64.

## 12. Malformed and contradictory record handling [verified]

All refused with `malformed` ("The archive is damaged or is not the format it appears to be"), the whole nested
archive refused, the rest of the explorer usable:

| Case                                                                   | Test                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Field needs ZIP64, no record                                           | `refuses an entry that needs ZIP64 and has no record`                         |
| First or second record too short (0, 8 or 15 bytes for 16)             | `refuses a record shorter than the fields it must hold, first or second`      |
| Framing past the end: in the ZIP64 record, after it, before it         | `refuses an extra field whose framing runs past its end`                      |
| Different real values, either order, after a placeholder, offset alone | `refuses records that give two different real values, whichever comes first`  |
| All records `0xFFFFFFFF` for the compressed size                       | `never reads an unresolved compressed size placeholder as 4 GiB of data`      |
| ≥ 2^53, `0xFFFF…FFFF`, 2^60 in a placeholder record                    | `refuses values beyond what can be represented, even in a placeholder record` |

## 13. Numeric safety and archive-boundary validation [source + verified]

- `u64()` (`bytes.ts`) returns `null` unless the value is a safe integer; `resolveZip64` refuses `null` in any record
  at a wanted position. Every resolved value is therefore an exact integer ≤ 2^53 − 1, and sums such as
  `localHeaderOffset + 30 + compressedSize` stay exact.
- The bounds check (`localHeaderOffset + 30 + compressedSize > directoryOffset`) runs on the resolved values, as
  before: a resolved offset of 10 MiB in a few-hundred-byte archive and a compressed size running into the directory
  are refused [verified]. An offset inside the archive but not at a local header is caught when the local header is
  checked: a stored entry is listed and marked "its local header does not match", a deflated one fails `malformed`
  when read [verified].
- Reads use `subarray` within the payload; `u16`/`u32` read a missing byte as zero and callers check lengths, as
  before.

## 14. Browser-local resource-limit preservation [verified]

| Attempt                                                                 | Result                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 MiB of zeros (≈1 KiB deflated) declaring 5 GiB                        | Listed at 5 GiB; `whole()` → `download_too_large` before inflating; 4 KiB prefix and 64-byte hex window read; hex at 32 MiB → `offset_unsupported` |
| Real value `0xFFFFFFFF` (all records) for the uncompressed size         | Listed at 4,294,967,295; whole read refused                                                                                                        |
| ZIP64 size of 1000 for 1 MiB of output (one record or the agent's two)  | `decompression_limit` once 1000 bytes are exceeded                                                                                                 |
| Nested ZIP64 archive declaring 5 GiB                                    | `archive_too_large`, before decompression                                                                                                          |
| Nested archive declaring 1000 B with a 64 KiB archive limit, real 1 MiB | `decompression_limit`                                                                                                                              |
| Top-level payload above `maxArchiveBytes`                               | `archive_too_large`                                                                                                                                |
| Deflated nested ZIP64 archive above the cache budget                    | `memory_budget`; the parent stays open                                                                                                             |
| ZIP64 archives nested 8 deep                                            | `depth_limit` at level 6; 5 held                                                                                                                   |
| Compressed size of 1 TiB                                                | `malformed` while listing; nothing allocated                                                                                                       |
| Declared 2^52 bytes                                                     | Listed; whole read refused by size                                                                                                                 |

[source] No buffer is sized from untrusted metadata alone: `inflateBounded` allocates `min(wanted, maxOutput)`,
where `wanted` is a preview's length or a size already checked against a limit (`whole()` checks
`entry.sizeBytes > maxBytes` first). Stored reads are views. CRC is checked on every whole read (`integrity_failed`
test for stored and deflated ZIP64 entries). Unsupported methods stay listed and unread (BZIP2 test).

## 15. API and web policy consistency matrix

| ZIP64 layout                                                | API (`apps/api/test/zip64.test.ts`) | Browser (`apps/web/test/archive-local/zip64.test.ts`) | Difference justified by limits?              |
| ----------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Plain ZIP                                                   | Read                                | Read                                                  | —                                            |
| One standard record, ZIP64 end records                      | Read                                | Read                                                  | —                                            |
| Agent placeholder then real, stored and deflated (A)        | Real values                         | Real values                                           | —                                            |
| Every combination of fields, one record or two (14 layouts) | Read                                | Read                                                  | —                                            |
| Offset only                                                 | Read                                | Read                                                  | —                                            |
| Identical records repeated; trailing disk number            | Read                                | Read                                                  | —                                            |
| Unknown extra fields around ZIP64 records                   | Read; kept in `ZipEntry.extra`      | Read; not kept                                        | Browser never rewrites archives              |
| No record when needed                                       | Refused                             | Refused                                               | —                                            |
| Truncated record, first or second                           | Refused                             | Refused                                               | —                                            |
| Truncated framing                                           | Refused                             | Refused                                               | —                                            |
| Contradictory values, any order                             | Refused                             | Refused                                               | —                                            |
| Unresolved placeholder compressed size                      | Refused (bounds)                    | Refused (bounds)                                      | —                                            |
| Offset / compressed size outside the archive                | Refused                             | Refused                                               | —                                            |
| Value ≥ 2^53 in any record                                  | Refused                             | Refused                                               | —                                            |
| Real value `0xFFFFFFFF` (size)                              | Accepted                            | Accepted; whole read refused by size limits           | Yes: 100 MiB download, 64 MiB nested archive |
| Real value `0xFFFFFFFF` (offset), entries beyond 4 GiB (B)  | Accepted                            | Not representable: payload ≤ 64 MiB                   | Yes: in-memory nested archives               |
| ≥ 3.75 GiB file, small data (A)                             | Lists, previews, extracts, clones   | Lists, previews the start; whole read or open refused | Yes: bounded decompression (0058 §5)         |
| Wrong CRC                                                   | Refused when read                   | `integrity_failed` when read                          | —                                            |
| Entry with unreadable local header / unsupported method     | Archive refused (EmuCat archive)    | Entry listed and marked; archive opens                | 0058 §2–4, unchanged                         |
| Error presentation                                          | `archive_malformed` + message       | `malformed`, fixed wording                            | 0058 error taxonomy, unchanged               |
| Hashing / clone rewriting                                   | Covered                             | Not applicable                                        | Browser writes nothing                       |

Resolution semantics: identical in every row.

## 16. Changed production files

| File                                | Change                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/web/src/archive-local/zip.ts` | `zip64Field()` → `zip64Records()`; new `resolveZip64()`; `readZip()` uses it; doc comment |

No other file under `apps/*/src`, `packages/*/src`, `agent/`, `deploy/` changed [verified: §31 `git diff --stat`].

## 17. Regression tests

- `apps/web/test/archive-local/fixtures.ts`: `zip64Layout()` (exact ZIP64 records per entry: `agent`, `single`,
  `none` or raw; chosen fixed fields; lying real values; unknown fields before/after; raw broken extra; optional ZIP64
  end records), `zip64Data()` (64-bit values, `bigint` for > 2^53) and `extraField()`. Adapted from the API's
  `buildZip64Layout`, in memory: each fixture is a few hundred bytes to a few KiB.
- `apps/web/test/archive-local/zip64.test.ts`, 24 tests in four groups: valid layouts (8), malformed and
  contradictory (10, including CRC and unsupported method), browser limits (6 tests covering cases 21–26), nested
  ZIP64 inside ZIP and ZIP64, stored and deflated (1, four outer layouts).
- `apps/web/test/archive-nested.test.tsx`, 2 new interface tests (§19).
- `apps/web/test/tools/make-nested-zip64.mjs`: generator for manual acceptance (§27), outside every suite.

Mapping to the requested cases: 1–10 → "valid ZIP64 layouts" and "nested ZIP64 archives"; 11–20 → "malformed and
contradictory"; 21–26 → "browser-local limits"; 27–34 → §19.

## 18. Before-and-after regression evidence [verified]

| Suite                              | Original `zip.ts`           | Fixed `zip.ts` |
| ---------------------------------- | --------------------------- | -------------- |
| `test/archive-local/zip64.test.ts` | 18 failed, 6 passed (24)    | 24 passed      |
| `test/archive-nested.test.tsx`     | 2 failed, 11 passed (13) ×3 | 13 passed ×3   |

The six that pass on the original are layouts it already handled (plain ZIP, one standard record, offset-only, a
missing record, an unresolved placeholder, a real `0xFFFFFFFF` size), kept as guards against regressions in the other
direction. In one earlier "original" run, a pre-existing interface test (`opens a nested ZIP with one download…`)
also failed once; it passed in the following three original runs and every fixed run, so it is a timing flake
under parallel load, not related to ZIP64.

## 19. Functional integration tests [verified]

In jsdom with the real worker handler in the same thread, under StrictMode (`archive-nested.test.tsx`):

1. **Browses, previews and downloads from a nested ZIP64 archive with the agent's duplicate records:** expand
   `agent64.zip` (one API download); a directory row; text preview with "matched the CRC-32"; expand `docs`; PNG
   preview; `MOUSE.COM` as hex; download with exact bytes and "Saved from the nested archive, after matching its
   CRC-32"; expand the ZIP64 `drivers.zip` inside it and preview `INSTALL.TXT`; no further API request.
2. **Refuses a nested archive whose ZIP64 records contradict each other, and keeps the rest usable:** "damaged" alert;
   then the same worker (not terminated, still one) opens `agent64.zip` and previews its README.

Existing ordinary nested-archive tests (11) pass unchanged.

## 20. Broader regression suite results [verified]

| Command                                                                    | Result                                                                                                                   | Duration   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `pnpm --filter @emucat/web exec vitest run` (run 1)                        | 652 passed, 1 failed (`capture.test.tsx`, see below)                                                                     | 56 s       |
| same (run 2)                                                               | **653 passed** (30 files)                                                                                                | 50 s       |
| `npx tsc --noEmit` in `apps/web`                                           | pass                                                                                                                     | 11 s       |
| `npx eslint .` (repository)                                                | pass, 0 problems                                                                                                         |            |
| `npx prettier --check .` (repository)                                      | pass                                                                                                                     |            |
| `npx vite build` in `apps/web`                                             | pass                                                                                                                     | 1 s        |
| API `test/zip64.test.ts test/archive-explorer.test.ts test/clones.test.ts` | **62 passed** (3 files), MariaDB in Docker                                                                               | 139 s      |
| `pnpm test` (contracts, deployer, web, API, agent)                         | contracts 456, deployer 51, web 653, **API 1,245 + 2 skipped**: pass; agent: stopped at its first failing binary (below) | 5 min 53 s |
| `cargo test --manifest-path agent/Cargo.toml --no-fail-fast`               | 578 passed, 12 failed, 23 ignored (Linux, as root; below)                                                                |            |

**Agent on Linux.** `agent/` is byte-identical to the baseline (`git diff --stat 1c45e18 -- agent` is empty), so
none of these can come from M0.1. The agent is a Windows program, and this container runs as root: `ova_import` 6
(`command_line::*`: the documented "no secure credential store is implemented for linux yet", `docs/testing.md`),
`launcher` 3 (Windows paths; "Launching emulators is only implemented on Windows"), `registration` 2 and `restore` 1
(directory-substitution checks; `docs/testing.md` notes root passes or changes permission checks, and prescribes an
unprivileged Linux run from Windows). M0 ran the agent suite on Windows: 579 + 2 ignored. Not re-run on Windows here.

`capture.test.tsx > captures, uploads, and announces publication in local` failed once in the first full web run
(`expected "vi.fn()" to be called 1 times, but got 0 times`), then passed 3 of 3 in isolation and in the second full
run. It tests screenshot upload, imports nothing from `archive-local`, and is a load-dependent flake that this change
cannot affect; it is not one of the documented baseline issues either.

## 21. Known baseline test failures

- `pnpm test:e2e` (12 failures from decision 0060's UI changes) and the Windows `npx` launcher issue of
  `pnpm --filter @emucat/web test:browser`: **[not run]** here, left to M0.2 as instructed. `test:e2e` needs a built
  Windows agent; the browser suite was not attempted, as it has no ZIP64-specific case and its Windows issue is out of
  scope. No E2E assertion or launcher was modified.
- The two flakes in §18 and §20 and the agent's Linux/root failures in §20 are separate from those two, observed
  and not fixed; none touches code changed here.

## 22. Build and bundle impact [verified]

`vite build` before (stash) and after:

| Asset                 | Before                    | After                     |
| --------------------- | ------------------------- | ------------------------- |
| `archive.worker-*.js` | 40.62 kB                  | 40.74 kB (+0.12 kB)       |
| `index-*.js`          | 1,063.23 kB (315.19 gzip) | 1,063.23 kB (315.18 gzip) |

The main bundle only changes by the worker's file name (new content hash); the worker loads only when a nested
archive is opened, as before.

## 23. Security considerations

- Untrusted metadata cannot raise a limit: every resolved value goes through the same bounds, size-limit, local
  header, decompression and CRC checks as before (§13–14).
- The new loop is bounded by the extra field's length (≤ 65,535 bytes, so at most 16,383 records) times three fields;
  no recursion, no allocation besides `subarray` views.
- Stricter than before: contradictory records, short second records, out-of-range values in any record and broken
  framing after the first ZIP64 record are now refused. An archive from a third-party writer with such records, which
  the old reader opened through its first record, is now "damaged". No known writer produces them.
- No new endpoint, request, storage, worker, dependency or external service.

## 24. Deployment impact matrix [verified against the diff]

| Component                    | Impact                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Web application              | Changed: `archive-local/zip.ts` (worker bundle)                                           |
| API                          | None (source unchanged; its image is rebuilt by `update` with a new revision label only)  |
| Shared contracts             | None                                                                                      |
| Windows agent                | None                                                                                      |
| Agent protocol               | None                                                                                      |
| MariaDB schema               | None; newest migration unchanged                                                          |
| Compose configuration        | None                                                                                      |
| Reverse proxy                | None                                                                                      |
| Deployment tooling           | None (`deploy/`, `apps/deployer` unchanged)                                               |
| Environment variables        | None                                                                                      |
| Existing repository archives | Unchanged: the browser only reads nested archives; no migration, repackaging or re-upload |

## 25. MARS deployment runbook [expected; not run on MARS]

MARS: branch `develop`, `https://emucat-test.dfri.info`, installation root `/opt/emucat`. The commands are those of
M0's runbook, re-checked in this release's `deploy/bin/emucatctl` (`status`, `check`, `check-update`, `update`,
`backup`, `logs`, `rollback-app [--to COMMIT] [--yes]` all present, lines 1302–1309). `update` fetches the branch into
`/opt/emucat/repo.git`, builds the API and web images (and their `verify` stages, which for web run `tsc` and the
whole web suite, the new tests included), backs up the database, applies migrations (none), restarts and health-checks.
Placeholders: `<commit>` = final `develop` commit (§31); `<previous>` = what MARS runs now (`1c45e18` if M0 was
deployed, otherwise older).

### 25.1 Pre-deployment

On any machine with the repository, the target:

```bash
git fetch origin && git log -1 --format='%H %s' origin/develop
```

On MARS, the layout (a bare repository, no checkout; `/opt/emucat/repo` is not used):

```bash
ls -d /opt/emucat/tooling/bin/emucatctl /opt/emucat/repo.git
```

If `/opt/emucat/tooling` is missing, stop: install the tooling as in `docs/deployment.md` first.

Current release (note `Deployed:` as `<previous>`), update available (`check-update`: `Latest:` must be `<commit>`), prerequisites:

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Tooling current and nothing to refresh (`check-update` has fetched the branch):

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat <previous> refs/remotes/origin/develop -- deploy apps/deployer apps/api/migrations
```

- `tooling is current` and an empty diff: no tooling refresh, no `emucatctl install`, no migration. Continue.
- Otherwise MARS runs a release older than decision 0055: deploy that first with `docs/runbook-0055-mars.md`.

Health, space:

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
df -h /opt/emucat /var/lib/docker
```

Active work: `update` restarts the API. Deploy when Admin › Registrations › **Needs attention** shows no operation in
Queued, Validating, Archiving, Uploading, Verifying, Committing or Cleaning up, no Remote Snapshot is publishing and
no server-side clone runs; or in SQL:

```sql
SELECT id, mode, state, emulator_type, vm_name, created_at FROM registration_operations WHERE active_marker = 1;
```

Note each agent's version and status in Admin › Agents. Optional backup (`update` takes its own):

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

Before updating, note the worker asset currently served (for 25.3):

```bash
curl -fsS https://emucat-test.dfri.info/ | grep -o 'assets/index-[^"]*\.js' | head -1
```

### 25.2 Deployment

1. Repository synchronization: none by hand (`update` fetches `develop`).
2. Tooling refresh / `emucatctl install`: not needed (25.1).
3. Configuration, environment, Compose, nginx: none.
4. Database migrations: none (`update` reports none applied).
5. Agents: no update.
6. Update (answer `y`):

```bash
sudo /opt/emucat/tooling/bin/emucatctl update
```

### 25.3 Post-deployment

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

```bash
sudo docker inspect -f '{{.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1 emucat-web-1
```

Both `<commit>`.

```bash
sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}}'
```

All `(healthy)`.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/health
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

New web assets served: the entry script's name and the worker it references differ from 25.1's:

```bash
INDEX=$(curl -fsS https://emucat-test.dfri.info/ | grep -o 'assets/index-[^"]*\.js' | head -1); echo "$INDEX"; curl -fsS "https://emucat-test.dfri.info/$INDEX" | grep -o 'archive.worker-[A-Za-z0-9_-]*\.js' | head -1
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs web --tail 200
```

**Browser reload:** required. An Archive Explorer page loaded before the update keeps the old worker; reload the page
(Ctrl+F5 if in doubt). The hashed asset names make a normal reload fetch the new worker.

**Agents:** unaffected; they reconnect after the API restart. Compare Admin › Agents with 25.1.

## 26. MARS functional acceptance checklist

Use a disposable test VM version for everything ZIP64-specific (§27). Keep the browser's developer console open.

| #   | Scenario                            | How                                                                                                                                          | Expected                                                                                       |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Ordinary 86Box archive              | Version History › folder icon on an 86Box version                                                                                            | Lists as before                                                                                |
| 2   | Ordinary QEMU archive               | Same, a QEMU version                                                                                                                         | Lists as before                                                                                |
| 3   | VirtualBox OVA                      | Same, an OVA version                                                                                                                         | Lists as before                                                                                |
| 4   | Ordinary nested ZIP                 | Expand a `.zip` inside an ordinary VM                                                                                                        | Opens as before                                                                                |
| 5   | Nested ZIP64 with duplicate records | Test version › expand `zip64-agent-layout.zip`                                                                                               | Opens: `README.TXT`, `docs`, `MOUSE.COM`, `drivers.zip`. Before this release: "damaged"        |
| 6   | Directory navigation                | Expand `docs`; breadcrumb back                                                                                                               | `setup.png` listed; breadcrumb works                                                           |
| 7   | Text preview                        | Select `README.TXT`                                                                                                                          | Text, status "matched the CRC-32"                                                              |
| 8   | Image preview                       | Select `docs/setup.png`                                                                                                                      | 1 × 1 PNG preview                                                                              |
| 9   | Binary in hex                       | Select `MOUSE.COM`                                                                                                                           | Hex viewer, 512 bytes                                                                          |
| 10  | Download a nested file              | Download `MOUSE.COM`                                                                                                                         | 512-byte file; "Saved from the nested archive, after matching its CRC-32"                      |
| 10b | ZIP64 inside ZIP64                  | Expand `drivers.zip` › `INSTALL.TXT`                                                                                                         | Text preview, no new network request in DevTools                                               |
| 11  | Oversized entry refused             | Expand `zip64-oversized.zip` › `disk.raw`; try Download                                                                                      | Listed at 5.00 GiB; hex of its start shows; download refused ("larger than the browser saves") |
| 12  | Contradictory records refused       | Expand `zip64-contradictory.zip`                                                                                                             | "The archive is damaged or is not the format it appears to be"                                 |
| 13  | Recovery after a malformed archive  | After 12, expand/preview 5–10 again and another VM file                                                                                      | All work; no reload needed                                                                     |
| 14  | Limits still effective              | Expand a nested archive > 64 MiB if one exists; open several nested archives                                                                 | Refused before download with the 64 MiB message; memory-budget message when full, as before    |
| 15  | Server-side Archive Explorer        | Logical and physical views, a top-level text preview and download                                                                            | As before                                                                                      |
| 16  | API-side F-4 correction             | Open a version with a file ≥ 3.75 GiB (M0 checklist item 4) if present                                                                       | Lists, as since M0                                                                             |
| 17  | Browser console                     | DevTools › Console during 1–15                                                                                                               | No errors (an expected refusal is shown in the page, not logged as an error)                   |
| 18  | Server logs                         | 25.3 `logs api` / `logs web`; `logs api --tail 2000 \| grep -Ei 'zip64\|overlaps the central\|contradict\|archive_malformed' \|\| echo none` | Nothing new: nested archives are read in the browser only                                      |

## 27. Synthetic test archive generation procedure

On any machine with Node.js 22 and a checkout of `<commit>` (for example the workstation), into a new empty
directory:

```bash
node apps/web/test/tools/make-nested-zip64.mjs ./zip64-test-files
```

It writes, deterministically (same bytes every run [verified]):

| File                      | Size        | Content                                                                                                                                            |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zip64-agent-layout.zip`  | 1,569 bytes | Agent layout (placeholder record, then real) for every entry, ZIP64 end records; text, directory, PNG, 512-byte binary, nested ZIP64 `drivers.zip` |
| `zip64-contradictory.zip` | 265 bytes   | One entry whose two records give 11 and 12 bytes                                                                                                   |
| `zip64-oversized.zip`     | 1,283 bytes | `disk.raw`: 1 MiB of zeros declared as 5 GiB                                                                                                       |

Checked here [verified]: the fixed browser reader opens `zip64-agent-layout.zip` (every file `verified`, `drivers.zip`
detected as ZIP), refuses `zip64-contradictory.zip` (`malformed`) and lists `disk.raw` at 5,368,709,120 bytes while
refusing it whole (`download_too_large`). `unzip -t` reports no errors on all three; CPython 3.13's `zipfile`
lists them (it read the first of the contradictory values: another reason not to accept such archives).

Introducing them through supported workflows only:

1. On the agent machine, use a **disposable** test VM (for example a copy of a small 86Box VM registered as
   `TEST_M01_ZIP64`), never a production master.
2. Copy the three files into that VM's directory on the agent machine.
3. Create a snapshot of it (or register it if it is new) through EmuCat as usual. The agent packages the files as
   ordinary small entries of its own archive; the server verifies and stores the version.
4. Open that version in Archive Explorer and run checklist items 5–13.
5. Delete the test VM or its test snapshot afterwards as usual.

Never edit repository archives or catalog rows by hand.

## 28. Rollback runbook [expected]

`<previous>` is the `Deployed:` commit noted from `status` in 25.1. To return to it:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Then the 25.3 checks (revision labels `<previous>`, health, ready).

- **Database:** no restore; nothing in the schema or data changed.
- **Agents:** compatible both ways; nothing to change.
- **Repository / archives:** nothing to reverse; the browser never wrote anything. Disposable test versions from §27
  remain ordinary versions; delete them as usual if wanted.
- **Browser cache:** reload open pages after the rollback; assets are content-hashed, so the old worker comes back
  with the old `index-*.js`. After rollback, nested agent ZIP64 archives are "damaged" again, as before M0.1.

Forward again: `sudo /opt/emucat/tooling/bin/emucatctl update`.

## 29. MOON production deployment guidance [expected]

Only after MARS passes §26, after the stabilization scope chosen by the user, and after the user has promoted
`develop` into `main`. MOON: branch `main`, installation root `/opt/emucat`.

- **Preconditions:** `origin/main` contains this milestone's commits; no operation running (25.1 SQL or UI); agents
  online; note `<previous>` from `status`.
- **Synchronization:** none by hand; `update` fetches `main` into `/opt/emucat/repo.git`.
- **Tooling:** the 25.1 checks with `refs/remotes/origin/main` and MOON's `<previous>`; expected current, no refresh,
  no `install`.
- **Update:** `status`, `check-update`, `check`, then:

```bash
sudo /opt/emucat/tooling/bin/emucatctl update
```

- **Post-deployment:** 25.3 against MOON's URL; reload the browser; open one ordinary version and one ordinary nested
  archive (read-only).
- **Rollback:** `sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>`; no database restore.

## 30. Remaining limitations and unverified scenarios

- **Nothing was run on MARS or MOON**; §25–29 are [expected].
- **No real agent-generated nested archive** was opened: the fixtures and the generator model zip 7.3's layout as
  decision 0061 and M0's dumps describe it. A real nested agent archive of a ≥ 3.75 GiB file small enough for the
  64 MiB limit was not built here.
- **Agent suite on Windows** not run (no Windows host here); on Linux as root 12 platform failures (§20), agent
  unchanged.
- **Real browsers:** the jsdom interface tests use the real worker handler in-thread; the Playwright browser suite
  (`test:browser`) was not run (§21). The worker bundle builds; no worker or nginx change was made.
- **`pnpm test:e2e`, `pnpm test:sftp`, `pnpm test:deploy`, `pnpm test:compose`**: [not run]; nothing they cover
  changed (agent, SFTP, deployment, Compose).
- Two timing flakes observed (§18, §20), not fixed (out of scope).
- Third-party archives with contradictory ZIP64 records are now refused in the browser, as on the server since M0.

## 31. Final repository status and commit references

| Commit                        | Content                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `615d051`                     | `fix(web): align nested ZIP64 parsing with decision 0061` (`zip.ts` only)    |
| `7b268d6`                     | `test(web): ZIP64 duplicate-record layouts in the browser-local reader`      |
| the commit adding this report | `docs: browser-local ZIP64 (decision 0061 amended), report and MARS runbook` |

- Base: `1c45e188ab5a8a8eaa03b0087d192739cddf7359`. Pushed to `origin/develop` by fast-forward; no force push, no
  history rewritten. `main` (`79981c5`) unchanged. Nothing deployed to MARS or MOON.
- Author and committer: `david <davidfriscia@gmail.com>`.
- `git diff --stat 1c45e18 -- apps/api agent deploy apps/deployer packages apps/web/src/archive-local/limits.ts` is
  empty. No binary fixture is committed: every archive is built by test code or by the generator.
