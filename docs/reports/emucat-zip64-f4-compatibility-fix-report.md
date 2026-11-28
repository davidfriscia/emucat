# EmuCat M0: ZIP64 compatibility fix (F-4), implementation report

**Change:** the server's ZIP reader resolves the duplicated ZIP64 extended-information records that the agent's
`zip` crate 7.3 writes ([decision 0061](../decisions/0061-zip64-duplicate-records.md)).
**Branch:** `develop`. **Scope:** API only. No agent, protocol, schema, configuration or tooling change.
**Status:** implemented, validated on the workstation, committed and pushed to `origin/develop`. Not deployed to MARS
or MOON.

Labels used throughout: **[verified]** measured in this session; **[source]** concluded from reading the code;
**[expected]** deployment behaviour that follows from the code and the tooling but was not run on a host;
**[not run]** a validation that was not executed, with the reason.

## 1. Executive summary

- **Defect.** `readCentralDirectory` (`apps/api/src/archives/zip.ts`) took the first ZIP64 record of a central record.
  zip 7.3 writes a placeholder record (sizes `0xFFFFFFFF`) before the real one, so the server read 4 GiB sizes and
  refused valid agent archives: "An entry's data overlaps the central directory". Archive Explorer, View Archive
  Contents and server-made clones failed for every 86Box/QEMU version with a file of ≥ 3.75 GiB, or > 4 GiB in all.
- **Reproduced [verified]** on the implementation baseline `2f460b1` with the real agent-built archive and the 9 GiB
  legacy archive of the assessment, and in the new tests: 12 of 20 new unit tests and both new integration tests fail
  on the original code, with the same errors users would see (`archive_malformed` 422; clone `source_archive_invalid`).
- **Fix.** Each field marked `0xFFFFFFFF` is resolved over all ZIP64 records: `0xFFFFFFFF` yields to any other value,
  equal values agree, two different real values are refused as contradictory. Every existing check still applies to
  the resolved values. One function (`resolveZip64`, 35 lines with its comment) replaces the first-record logic.
- **Rewriting** (server clone) needed no change: it already drops every ZIP64 record and writes one canonical record.
- **Validated [verified]** on the real archives: the agent-built 18 MB archive with a 3.75 GiB file, and the 9 GiB
  legacy archive with entries beyond 4 GiB, through `readCentralDirectory`, `inspectZip`, `hashEntry`, the extraction
  path and `rewriteZip`. The server-rewritten clones pass CPython `zipfile` (full CRC), 7-Zip 24.09 (no warning) and
  the agent's own reader with the zip crate's full CRC read. The original archives are byte-identical afterwards.
- **Regression suites:** `pnpm lint`, `pnpm check`, `pnpm test` (contracts 456, deployer 51, web 627, API 1,245 + 2 skipped, agent 579 + 2 ignored), `pnpm test:sftp` (151), `pnpm test:deploy`, `pnpm test:compose` (48, production images built) and `pnpm build` pass. `pnpm test:e2e` has 12 failures that are **pre-existing**: the identical 12 fail with the original `zip.ts` (stale UI assertions after decision 0060). The web browser suite could not start on this workstation (`spawnSync npx ENOENT`, a pre-existing harness issue; web is unchanged).
- **Deployment:** API image only. `emucatctl update` alone is enough on a host running decision 0055 tooling or newer.

## 2. Implementation scope

In scope and done: the API's ZIP64 central-record parsing; tests; documentation; this report and runbooks.

Inspected and deliberately unchanged:

| Area                                                            | Why unchanged                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `rewriteZip` (server clone writer)                              | Already writes one canonical ZIP64 record; verified (§14)                                         |
| Local-header handling (`localDataOffset`, `extract.ts`)         | Never reads ZIP64 values from local headers (§13)                                                 |
| Agent (`packaging.rs`, `zip_directory.rs`, `vm_clone.rs`)       | Its reader is correct; its writer's output is what the fix accepts                                |
| Web nested-archive reader (`apps/web/src/archive-local/zip.ts`) | Same first-record logic, but outside the API-only scope; reported as a follow-up (§30)            |
| `deploy/docker/api.Dockerfile` verify stage                     | Its explicit test list does not include the new test; left unchanged to keep tooling out of scope |

Out of scope and not started: Disk Image Explorer, guest filesystems, NTFS WASM, Deflate checkpoint indexing, seekable
packaging, agent or protocol changes, migrations, endpoints, frontend features, Compose, proxy, dependencies.

## 3. Repository baseline

| Item                               | Value                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                         | `C:\Users\david\src\emucat`, remote `git@github.com:davidfriscia/emucat.git`                                                                                                          |
| Local `develop` at session start   | `628082373e549c75382f4b3b6849e8795455dee8`, clean, 5 commits behind `origin/develop`                                                                                                  |
| `origin/develop` after `git fetch` | `2f460b1be6bd33b1cc8d00164967d2ba2add6756`                                                                                                                                            |
| Synchronization                    | `git merge --ff-only origin/develop` (fast-forward, no local changes)                                                                                                                 |
| **Implementation baseline**        | **`2f460b1be6bd33b1cc8d00164967d2ba2add6756`** ("fix(web): give General's metadata…")                                                                                                 |
| `origin/main`                      | `79981c5f49c1fd820572bf3c28915a511533d9a4`, not touched                                                                                                                               |
| Git identity                       | `david <davidfriscia@gmail.com>` (author and committer)                                                                                                                               |
| Existing ZIP64 correction upstream | None: `git log -i --grep=zip64` finds only decisions 0056/0058; the defective line was unchanged                                                                                      |
| Toolchain                          | Windows 11; Node v22.22.3 (fnm installation, put on `PATH` per command); pnpm 12.10.1; Rust stable MSVC; Docker Desktop with `emucat-mariadb-1` healthy; 7-Zip 24.09; CPython 3.10.11 |
| Disk                               | 58 GB free on `C:` before the large tests, 53 GB at the lowest                                                                                                                        |

## 4. Original assessment references

Not copied into the repository; all under `C:\Users\david\emucat-assessments\seekable-deflate\`:

- `emucat-zip64-f4-follow-up.md`: the F-4 brief (primary specification).
- `emucat-seekable-deflate-feasibility-report.md`: §26 (ZIP64 and large-offset results, finding F-4), §25, the
  artifact inventory and the decision tables referring to M0. The sections on ZIP64, the artifact inventory and the
  M0 milestone were read; the Seekable Deflate design itself was not repeated or re-assessed.
- `archives\zip64-agent\995368e9-8a39-489f-a9b3-7ea2f4be2fdb.zip`: real agent build of a 4,026,544,185-byte file.
- `archives\synth\big9g-legacy.zip` (zip 7.3, production options) and `big9g-seek4.zip` (one ZIP64 record per entry).
- `evidence\zip64\f4-central-extras.txt`, `agentbuild.json`, `agentbuild-api-reader.json`, `agent-verify-legacy.log`,
  `7z-legacy.log`; `poc\pack-harness\target\release\pack-harness.exe` (the agent's code, used for `verify`).

No assessment artifact was modified, moved or deleted; no assessment cleanup command was run.

## 5. Reproduction of the original defect [verified]

Against the production source at `2f460b1` (not the assessment's transpiled snapshot): a scratch script imported
`apps/api/src/archives/zip.ts` directly through `tsx`.

| Archive                        | Result at `2f460b1`                                              |
| ------------------------------ | ---------------------------------------------------------------- |
| agent build, 18,321,280 bytes  | `ZipFormatError: An entry’s data overlaps the central directory` |
| `big9g-legacy.zip`, 4.9 GB     | `ZipFormatError: An entry’s data overlaps the central directory` |
| `big9g-seek4.zip` (one record) | Accepted, correct values (control)                               |

In the repository's own tests (§18), on the original `zip.ts`, Archive Explorer answers `422 archive_malformed` ("The
archive is damaged or is not what EmuCat stores, so it was not listed.") and a server clone fails with
`source_archive_invalid` ("The source archive was refused: An entry’s data overlaps the central directory.").

## 6. Root cause [verified + source]

`zip.ts:216` at the baseline:

```typescript
const zip64Record = extraRecords(rawExtra).find((record) => record.id === EXTRA_ZIP64);
```

zip 7.3 (`~/.cargo/registry/src/*/zip-7.3.0/src/write.rs`):

1. `start_entry` puts a ZIP64 block (`Zip64ExtraFieldBlock::maybe_new(large_file, 0, 0, header_start)`) first in the
   entry's extra data.
2. `update_local_file_header`, when `large_file`, patches the local header's block with the real values, copies them
   into the in-memory extra data, then sets `file.compressed_size = file.uncompressed_size = 0xFFFFFFFF`.
3. `write_central_directory_header` writes a **fresh** block from those fields (sizes now `0xFFFFFFFF`, offset real),
   then the stored extra data, which still contains the **real** block.

So the central record carries `[placeholder sizes, real offset]` then `[real sizes, real offset]`, with the same field
set in both. The server took the first. The agent (`zip_directory.rs::apply_zip64_extra`) and the zip crate's reader
(`read.rs::parse_single_extra_field`) overwrite a value only while it still equals `0xFFFFFFFF`, so they take the
second. The agent's own clone (`vm_clone.rs`, `raw_copy_file`) goes through the same `start_entry`/`finish_file`
path and produces the same layout [source].

## 7. Exact triggering conditions [verified]

| Condition | Rule (agent / zip 7.3)                                                                                     | Example                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A         | `large_file(stamp.size_bytes >= 0xF000_0000)` (`packaging.rs:42, :578`): source file ≥ 4,026,531,840 bytes | agent build: `big.img`, 18.3 MB compressed, both sizes in ZIP64 |
| B         | `header_start > 0xFFFFFFFF` forces `large_file`; `header_start >= 0xFFFFFFFF` adds the offset field        | 9 GiB: `z-after.img` (32 MiB) and the manifest (395 bytes)      |

Stored and Deflated entries are both affected (tests §17 cover both). VirtualBox OVAs are TAR and unaffected.

## 8. ZIP64 record layout analysis [verified]

Central records as stored, dumped independently with CPython (`zipfile.ZipInfo.extra`):

| Archive / entry               | Fixed csize / usize / lho        | ZIP64 records                                                              |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| agent build `big.img`         | `FFFFFFFF` / `FFFFFFFF` / `0x43` | `[4294967295, 4294967295]`, `[4026544185, 18320609]`                       |
| 9 GiB `big.img`               | `FFFFFFFF` / `FFFFFFFF` / `0`    | `[4294967295, 4294967295]`, `[9663676416, 4884194429]`                     |
| 9 GiB `z-after.img`           | all three `FFFFFFFF`             | `[4294967295, 4294967295, 4884194486]`, `[33554432, 16860912, 4884194486]` |
| 9 GiB `.emucat-manifest.json` | all three `FFFFFFFF`             | `[4294967295, 4294967295, 4901055467]`, `[395, 261, 4901055467]`           |

Note the order: uncompressed size first, then compressed (APPNOTE 4.5.3). The placeholder's offset is already real.

## 9. Alternative correction approaches

| Approach                                                                      | Agent archives | Standard ZIP64 | Determinism | Malformed input                                               | Matches agent reader                                                                                            |
| ----------------------------------------------------------------------------- | -------------- | -------------- | ----------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Last ZIP64 record wins (CPython)                                           | Yes            | Yes            | Yes         | Silently picks one of two contradicting records               | Only for zip 7.3's layout                                                                                       |
| 2. Fill a field while it is still `0xFFFFFFFF` (agent, zip crate)             | Yes            | Yes            | Yes         | First real value silently wins over a later one               | Yes, but the agent's reader also shifts positions by current value, which misreads records whose layouts differ |
| **3. Per-field resolution over all records, contradictions refused (chosen)** | Yes            | Yes            | Yes         | Refuses contradictions, truncation and overflow in any record | Same values for every archive it accepts                                                                        |

## 10. Selected resolution policy and rationale

For each fixed field equal to `0xFFFFFFFF`, in the order uncompressed size, compressed size, local header offset, each
ZIP64 record holds a value at the positional slot the spec assigns (decided by the fixed fields, never by values read
so far). The field resolves to the one value other than `0xFFFFFFFF` that the records give; to `0xFFFFFFFF` when they
all give it; and the archive is refused when they give two different values other than `0xFFFFFFFF`. Full table in
[decision 0061](../decisions/0061-zip64-duplicate-records.md). Rationale: it accepts exactly what the agent's reader
and the zip crate's accept, gives one answer that CPython also gives for every archive EmuCat writes, and refuses the
only case where readers disagree, instead of choosing silently.

## 11. Handling of legitimate sentinel-valued fields

`0xFFFFFFFF` is never classified as invalid by itself. A file of exactly 4,294,967,295 bytes must be in ZIP64 and zip
7.3 then writes `0xFFFFFFFF` in both records; an entry can start exactly at offset `0xFFFFFFFF`. Both are tested
(virtual archives) and accepted, in one record and in the agent's two. A placeholder that nothing resolves resolves to
`0xFFFFFFFF` and must then pass the data bounds, the manifest's sizes and the size/CRC read-back; the tests show it is
refused there (`overlaps the central directory`, `integrity`, `limit`), never listed as a real 4 GiB file in a VM.
This deliberately departs from the brief's literal "do not accept a record that would leave a field at `0xFFFFFFFF`",
which would refuse the legitimate cases; the task's §9 asked for exactly this distinction.

## 12. Malformed and conflicting record handling

| Input                                                 | Outcome                                                               | Test   |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| ZIP64 needed, no record                               | "An entry needs ZIP64 and has no ZIP64 field"                         | 12     |
| Any record too short (first, second, or the real one) | "A ZIP64 field is truncated"                                          | 13     |
| Extra-field framing past its end                      | "An extra field is truncated"                                         | 14     |
| Placeholders only (one or two records)                | "…overlaps the central directory"; manifest `integrity`; read `limit` | 15     |
| Two different real values, any order, sizes or offset | "An entry’s ZIP64 records contradict each other"                      | 16     |
| Identical duplicates                                  | Accepted                                                              | 17     |
| Resolved offset at no local header                    | "The local header of … is damaged"                                    | 18     |
| Resolved offset / compressed size past the directory  | "…overlaps the central directory"                                     | 19, 20 |
| Resolved compressed size too short                    | "…does not match its size or CRC"                                     | 19     |
| Value ≥ 2^53, in any record including the placeholder | "A size or offset is too large"                                       | 21     |
| Unknown extra IDs                                     | Kept in `ZipEntry.extra`, every ZIP64 record removed                  | §17    |

All errors are the existing `ZipFormatError('malformed')`, mapped to `archive_malformed` / `source_archive_invalid` as
before. Only one message is new ("contradict each other"). Limits, multi-disk refusal, EOCD and locator checks,
UTF-8 names, manifest validation, CRC and SHA-256 verification, cancellation and resource limits are untouched.

## 13. Local-header analysis [source + verified]

- `zip.ts::localDataOffset` reads the local header's name and extra **lengths** only, to find the data; it checks the
  name and method against the central record and takes no value from a local ZIP64 record.
- `extract.ts::zipDataOffset` (previews, downloads) compares the local CRC and the 32-bit local sizes unless they are
  `0xFFFFFFFF`, and checks `dataOffset + compressedSize ≤ directoryOffset`; it never parses local ZIP64 records.
- `rewriteZip` only asks whether a local ZIP64 record exists, to decide whether to write sizes in ZIP64.
- zip 7.3's local headers carry one (patched) ZIP64 record anyway (§6).

So no equivalent defect exists for local headers. Extraction, preview, download and hashing all go through the
central record's resolved values, which the tests exercise (`readSmallEntry`, `hashEntry`, `entryChunks`, Archive
Explorer preview and download over SFTP).

## 14. Server-side clone analysis [source + verified]

`rewriteZip` (unchanged):

- Copies each entry's compressed bytes from the **resolved** data offset and size, with its method, CRC, flags, times
  and attributes; writes the local header again without a data descriptor.
- Drops every ZIP64 record from both local and central extras (`withoutZip64` filters all `0x0001` records), keeps the
  others, and appends **one** ZIP64 record: sizes when the source had ZIP64 or a size ≥ `0xFFFFFFFF`, plus the offset
  when the new offset ≥ `0xFFFFFFFF`. Fixed fields become `0xFFFFFFFF` exactly for those fields.
- Writes a ZIP64 end record and locator when the directory is beyond 4 GiB.
- Replaces the manifest last; compression policy unchanged; no seekable metadata.

Verified results: §17 (one canonical record per entry, the extended-timestamp field kept, CRC and SHA-256 equal), §19
and §20 (real archives), §21 (independent readers).

## 15. Production source changes

| File                           | Change                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `apps/api/src/archives/zip.ts` | New `resolveZip64`; `readCentralDirectory` collects every ZIP64 record and calls it; two doc comments |

No other production file changed. Test and documentation files:

| File                                                                               | Change                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/archive-sources.ts`                                                 | A repeated-block segment for `virtualSource`; `buildZip64Layout` (exact ZIP64 layouts, the agent's included; stored or deflated zeros that take no memory), `vmZip64`, `zip64Data`, `zerosSha256` |
| `apps/api/test/zip64.test.ts` (new)                                                | 20 tests: parsing, beyond 4 GiB, malformed/ambiguous, hashing and rewriting                                                                                                                       |
| `apps/api/test/archive-explorer.test.ts`                                           | `agentZip64` option; 1 test over SFTP                                                                                                                                                             |
| `apps/api/test/clones.test.ts`                                                     | `archivedWorld` takes an archive; 1 test of a server clone                                                                                                                                        |
| `apps/api/test/tools/validate-zip-archive.ts` (new)                                | Optional real-archive validation through the API's code (not run by any suite, not in the image)                                                                                                  |
| `docs/decisions/0061-zip64-duplicate-records.md` (new), `docs/decisions/README.md` | The policy                                                                                                                                                                                        |
| `docs/testing.md`                                                                  | "ZIP64 archives": the virtual fixtures and the optional validation                                                                                                                                |
| `docs/reports/emucat-zip64-f4-compatibility-fix-report.md` (new)                   | This report                                                                                                                                                                                       |

## 16. Security and integrity considerations

- No relaxation: every record is length-checked and overflow-checked, not only the one used; contradictions, which
  earlier releases resolved silently by taking the first record, are now refused.
- Resolution is bounded: at most 65,535 bytes of extra field per record, so at most ~16,000 ZIP64 records, each read
  in O(1) per field; the central directory limit (128 MiB) and entry limit (500,000) still apply first.
- Values stay below 2^53 (`u64` refuses more), so all later arithmetic is exact or, at worst, larger than any offset,
  which the overlap check refuses.
- Agent-layout compatibility is the general rule "a placeholder yields", not an exception for one writer.

## 17. Automated regression tests

`apps/api/test/zip64.test.ts` (20 tests), numbered as in the task:

| Task #  | Test(s)                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1       | reads a plain ZIP as before                                                                                            |
| 2       | reads a standard archive with one ZIP64 record                                                                         |
| 3, 7, 8 | takes the real sizes after the agent’s placeholder record, stored or deflated (condition A)                            |
| 4, 10   | reads sizes and offsets after the agent’s placeholder (condition B; virtual 4 GiB + 1 MiB archive)                     |
| 5, 6    | reads a standard archive whose only ZIP64 field is the offset; accepts every combination of fields (6 layouts)         |
| 9       | lists and previews a deflated file of 3.75 GiB whose data is small (≈ 4 MB of real deflate, `entryChunks`)             |
| 11, 23  | inspects a realistic agent archive beyond 4 GiB, manifest last and in ZIP64                                            |
| 12–21   | the "malformed and ambiguous" describe block (§12 table)                                                               |
| 17      | accepts the same real values repeated                                                                                  |
| 22      | accepts real values equal to 0xFFFFFFFF                                                                                |
| 26–29   | hashes, rewrites for a clone with one canonical ZIP64 record per entry (extended timestamp kept), and the clone passes |
| 30      | rewrites a plain archive exactly as before: no ZIP64 anywhere; plus every existing archive test                        |
| —       | keeps every other extra field, and drops every ZIP64 record from what it keeps                                         |

Integration over a real SSH/SFTP server and MariaDB:

| Task # | Test                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 24, 25 | `archive-explorer.test.ts`: lists, details, previews and downloads a version whose entries carry the agent’s two ZIP64 records                                                 |
| 26–29  | `clones.test.ts`: clones an archive whose entries carry the agent’s two ZIP64 records (one record per rewritten entry, timestamp kept, every file read back, source unchanged) |

The virtual archives make zeros only when read; the suite writes no large file. Their cost is computing the CRC and
SHA-256 of 4 GiB of zeros a few times: the whole file runs in about 17 s [verified].

## 18. Before-and-after regression evidence [verified]

The new tests were run against the baseline `zip.ts` (`git show HEAD:apps/api/src/archives/zip.ts`, restored after):

| Suite             | Original `zip.ts`                                                       | Fixed `zip.ts` |
| ----------------- | ----------------------------------------------------------------------- | -------------- |
| `zip64.test.ts`   | **12 failed**, 8 passed (20)                                            | 20 passed      |
| Explorer F-4 test | **failed**: `422 archive_malformed`                                     | passed         |
| Clone F-4 test    | **failed**: `source_archive_invalid`, "…overlaps the central directory" | passed         |

The 8 that pass on both are the controls: plain ZIP, single record, offset-only, identical duplicates (first-record
also gives the right answer), missing record, framing, placeholder-only, plain rewrite. Among the 12: conflicting
records and over-large placeholder values were _accepted_ by the original code, now refused.

## 19. Real agent-generated archive validation [verified]

`archives\zip64-agent\995368e9-8a39-489f-a9b3-7ea2f4be2fdb.zip`, 18,321,280 bytes, SHA-256
`ce797c10dbc050a22f9392cb493715baf7553287393ad544875d5e76fb5fee0a` (equal to `agentbuild.json`).

| Check                                                  | Result                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Baseline reader                                        | refused, "overlaps the central directory"                                       |
| `readCentralDirectory` (fixed)                         | 2.8 ms; `big.img`: usize 4,026,544,185, csize 18,320,609, lho 67, `zip64: true` |
| `inspectZip`                                           | ok; VM `assess-zip64`, manifest `53a3cd38…94fb3c` (equal to `agentbuild.json`)  |
| `hashEntry` `86box.cfg`                                | `452409a7…68bd94`, matches the manifest                                         |
| `hashEntry` `big.img` (full, 3.75 GiB inflated, 4.3 s) | `dffb88af…f10864`, matches the manifest; size and CRC verified                  |
| `rewriteZip` → `agentbuild-clone.zip`                  | 51 ms, 18,321,258 bytes; inspected and hashed again: both files match           |

Full hashing was justified: the 18 MB read proves the resolved sizes end to end through size and CRC.

## 20. Large-offset archive validation [verified]

`archives\synth\big9g-legacy.zip`, 4,901,056,234 bytes, SHA-256 `6d4001de…17091d`; control `big9g-seek4.zip`,
4,899,464,459 bytes, `c7ee459d…94d04`.

| Check                                    | `big9g-legacy.zip`                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline reader                          | refused, "overlaps the central directory"                                                                                                                                                      |
| `readCentralDirectory` (fixed)           | `big.img` 4,884,194,429 / 9,663,676,416 / 0; `z-after.img` 16,860,912 / 33,554,432 / **4,884,194,486**; manifest 261 / 395 / **4,901,055,467**: identical to the assessment's independent dump |
| `inspectZip`                             | ok; VM `assess-big`, manifest `cb480de0…f15ec`                                                                                                                                                 |
| `hashEntry` `z-after.img` (beyond 4 GiB) | `3a25fd0d…071ae5`, matches the manifest (66 ms)                                                                                                                                                |
| `big.img`                                | bounded: first 4 MiB read through `entryChunks` (the preview/download path)                                                                                                                    |
| `rewriteZip` → `big9g-legacy-clone.zip`  | 57.1 s, 4,901,056,107 bytes; `z-after.img` again at 4,884,194,486; inspected again, `z-after.img` hash matches                                                                                 |

`big9g-seek4.zip` (one record per entry): same results as before the fix (central directory, inspection, `z-after.img`
hash), as expected.

A full API `hashEntry` of the 9 GiB `big.img` was not run: its bytes were verified in full by the three independent
readers on the rewritten clone (§21), and its resolved values by Python on the source.

## 21. Independent reader compatibility [verified]

On the server-rewritten clones (`C:\Users\david\emucat-zip64-f4-validation\`):

| Reader                                                            | `agentbuild-clone.zip`                  | `big9g-legacy-clone.zip`                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CPython 3.10 `zipfile`: ZIP64 records per entry                   | `big.img`: one `[4026544185, 18320609]` | `big.img` `[9663676416, 4884194429]`; `z-after.img` `[33554432, 16860912, 4884194486]`; manifest `[4901055459]` (offset only) |
| CPython: names, methods, CRCs, sizes, offsets                     | equal to the source (manifest replaced) | equal to the source (manifest replaced)                                                                                       |
| CPython `testzip` + SHA-256 of every file vs manifest             | `None` (all OK), all match (12.6 s)     | `None`, all match (60.6 s)                                                                                                    |
| 7-Zip 24.09 `t`                                                   | Everything is Ok                        | **Everything is Ok, no warning** (source: "Headers Error")                                                                    |
| Agent `zip_directory` + `inspect_archive` (pack-harness `verify`) | ok, manifest `eb0911cd…778806`          | ok, manifest `71792cb5…42f622`                                                                                                |
| zip 7.3 crate full read, CRC checked                              | ok; `big.img` `dffb88af…f10864`         | ok; `big.img` `06345c83…6665ae`, equal to the source's in `agent-verify-legacy.log`                                           |
| Baseline (pre-fix) API reader                                     | reads it; hashes match                  | reads it; hashes match                                                                                                        |

Distinctions: 7-Zip's "Headers Error … Zip64_ERROR" belongs to the agent's source layout and is a pre-existing
warning, not data corruption; the server's rewrite introduces no warning and removes it. No reader reported
corruption. These are four readers, not a claim of universal compatibility.

## 22. Archive integrity verification [verified]

SHA-256 of the three original assessment archives before and after all tests: identical (`diff` of the two listings
is empty). The seven original disk image fixtures were not touched. The only files written were the two clones in
`C:\Users\david\emucat-zip64-f4-validation\` (deleted after validation; their SHA-256 were `3652301a…0649d0` (agent build clone) and `61eef48d…67f8c` (9 GiB clone)) and scratch files in the session's temporary folder.

## 23. Full regression suite results

All on the Windows workstation, sequentially, with the repository's default worker settings (2 API workers on
Windows), unless stated. MariaDB `emucat-mariadb-1` was otherwise idle.

| Command                                                                                                                                                   | Result                                                                                                                                                                     | Time          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `pnpm lint` (ESLint, Prettier, `cargo fmt`, clippy)                                                                                                       | pass (one run flagged only this report's formatting, fixed with Prettier; `prettier --check .` clean)                                                                      | 77 s          |
| `pnpm check` (contracts build, `tsc` all packages, `cargo check`)                                                                                         | pass                                                                                                                                                                       | 16 s          |
| `pnpm test`                                                                                                                                               | pass: contracts 456; deployer 51; web 627 (29 files); **API 1,245 passed, 2 skipped (46 files)**; agent 579 passed, 2 ignored                                              | 31 min        |
| Archive suites after the final test refactor                                                                                                              | `zip64`, `archive-extract`, `archives`, `clones`, `archive-explorer`: 92 passed                                                                                            | 177 s         |
| `pnpm test:sftp` (agent SFTP, packaging, restore incl. ZIP64, real OpenSSH)                                                                               | pass: 30 + 100 + 21                                                                                                                                                        | 250 s         |
| `pnpm test:e2e` (compiled agent, API, browser, OpenSSH)                                                                                                   | **12 failed, 88 passed, 1 skipped** (101): 11 in `restore.e2e.test.ts` "the public cover and the VM detail page", 1 in `execution.e2e.test.ts` #13                         | 708 s         |
| The same two e2e files with the **original** `zip.ts`                                                                                                     | **the same 12 failed**, 42 passed (54)                                                                                                                                     | —             |
| `pnpm --filter @emucat/web test:browser`                                                                                                                  | **not run**: every file fails in `beforeAll` with `spawnSync npx ENOENT` (`execFileSync('npx', …)` cannot resolve `npx.cmd` on Windows), from Git Bash and from PowerShell | 3 s           |
| `pnpm test:deploy` (deployment tooling, Linux container)                                                                                                  | pass: 46 of 47 + 3 of 3, 0 failed                                                                                                                                          | 67 s          |
| `pnpm test:compose` (production images under `deploy/compose.yaml`)                                                                                       | pass: 48 passed, 0 failed                                                                                                                                                  | 123 s         |
| Linux (`node:22.22.3-bookworm-slim`, as in `docs/testing.md`): `zip64`, `archives`, `archive-extract`, `clones`, `archive-explorer`, `archive-inspection` | 99 of 100; the one failure was a 30 s timeout in the existing first Explorer test ("detects what each file is…"). Rerun of `archive-explorer` + `zip64`: **47 of 47**      | 275 s + rerun |

**The e2e failures are not caused by this change** [verified]: the same 12 tests fail on the baseline code. Their
errors are UI assertions: `expected [ 'Metadata', 'Run and verify' ] to deeply equal [ 'Metadata', 'Details', … ]`
(General lost its Details panel in decision 0060), a Playwright strict-mode violation on the text "Making it public
publishes all of its screenshots." (now shown twice), and a cascade (`expected 404 to be 200`) in tests that depend
on the publication step. No archive, clone or ZIP code is involved. They need their own fix (§30).

**The browser suite** fails in its build step before any test, on Windows; the web code is unchanged by this change.

## 24. Build and container validation

| Build                                                                  | Result [verified]                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm build` (contracts, API `tsc`, web Vite, deployer; agent release) | pass, 29 s                                                              |
| API Docker image (`deploy/docker/api.Dockerfile`)                      | built by `pnpm test:compose`, container healthy, 48 smoke checks passed |
| Web Docker image                                                       | built by `pnpm test:compose`, unchanged sources                         |
| Agent                                                                  | unchanged; `cargo build --release` up to date                           |

The image `verify` stage (with `EMUCAT_VERIFY=true` on a host) runs an explicit list of database-free API tests that
does not include `zip64.test.ts`; that list was left unchanged (§2). The new test is database-free and could be added
in a later tooling change.

## 25. Deployment impact matrix

Verified against `git diff --stat 2f460b1 <final>` (§31):

| Component                    | Impact                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| API                          | **Changed**: `apps/api/src/archives/zip.ts` only                                             |
| Web                          | None (the web image is rebuilt by `update` with identical sources)                           |
| Contracts                    | None                                                                                         |
| Windows agent                | None; no version change                                                                      |
| Agent protocol               | None                                                                                         |
| MariaDB schema               | None; newest migration still `0021_server_repository_access`                                 |
| Compose configuration        | None                                                                                         |
| Reverse proxy                | None                                                                                         |
| Deployment tooling           | None: `deploy/` and `apps/deployer` unchanged; last tooling change `08aa3de` (decision 0055) |
| Existing repository archives | Unchanged; read as they are                                                                  |
| Environment variables        | None                                                                                         |

`emucatctl update` alone is sufficient when the host's tooling is that of decision 0055 or newer [source]; §26 checks
it on the host.

## 26. MARS deployment runbook

MARS: branch `develop`, `https://emucat-test.dfri.info`, installation root `/opt/emucat`, Compose project `emucat`.
Every command exists in this release's `deploy/bin/emucatctl` (`status`, `check`, `check-update`, `update`, `backup`,
`logs`, `rollback-app`). Nothing here was run on MARS. Placeholders: `<commit>` = the final `develop` commit (§31);
`<previous>` = what MARS runs now (expected `2f460b1…` or older).

### 26.1 Pre-deployment

On the workstation, the target:

```bash
git fetch origin && git log -1 --format='%H %s' origin/develop
```

On MARS, the installation layout. The tooling keeps a **bare** repository at `/opt/emucat/repo.git`; there is no
`/opt/emucat/repo` checkout, and none is needed:

```bash
ls -d /opt/emucat/tooling/bin/emucatctl /opt/emucat/repo.git
```

- Both exist: continue.
- `/opt/emucat/tooling` missing: the host predates decision 0035's self-contained layout; do not use this runbook,
  install the tooling as described in `docs/deployment.md` first.

Current release (note it as `<previous>`), available update (`Latest:` must be `<commit>`), prerequisites:

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Tooling is current, and nothing needs it refreshed:

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat <previous> refs/remotes/origin/develop -- deploy apps/deployer apps/api/migrations
```

- `tooling is current` and an empty diff: no tooling refresh, no migration, no `emucatctl install`. Continue.
- The diff is not empty, or the tooling differs: MARS runs a release older than decision 0055. Deploy that first with
  `docs/runbook-0055-mars.md`, then come back.

Health and space:

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
df -h /opt/emucat /var/lib/docker
```

Active operations: the update restarts the API. A running server-side clone restarts from the beginning after a
restart (and fails with `server_restarted` after three interrupted attempts); relay transfers are interrupted and
resumed. Deploy only when nothing runs: Admin › Registrations › **Needs attention** shows no operation in Queued,
Validating, Archiving, Uploading, Verifying, Committing or Cleaning up, and no Remote Snapshot is publishing. Or, in
SQL:

```sql
SELECT id, mode, state, emulator_type, vm_name, created_at FROM registration_operations WHERE active_marker = 1;
```

Agents: Admin › Agents, note each agent's version and that it is online (for comparison afterwards).

Backup: `update` takes one itself; a separate one is optional, as no data changes:

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

### 26.2 Deployment

1. Repository checkout: **not needed**; `update` fetches `develop` into `/opt/emucat/repo.git`.
2. Tooling refresh, `emucatctl install`: **not needed** (26.1).
3. Configuration, environment variables, Compose, reverse proxy: **none**.
4. Database migrations: **none**; `update` reports none applied.
5. Agents: **no update**; every deployed agent keeps working.
6. Update (answer `y`):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   It records `<previous>`, backs up, builds the API and web images at `<commit>` (with `EMUCAT_VERIFY=true`, the
   image `verify` stages run their usual tests), and restarts the containers. Expect a short API interruption while
   `emucat-api-1` restarts; existing agents reconnect by themselves.

### 26.3 Post-deployment

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

Both `(healthy)`.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/health
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

`ready` reports `migrations: ok`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

No errors; in particular no `archive_malformed`, `source_archive_invalid` or "ZIP64" messages for valid archives:

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 2000 | grep -Ei 'zip64|overlaps the central|contradict|archive_malformed' || echo "none"
```

Admin › Agents: every agent online, same versions as before. Open Archive Explorer on any version: it lists.

## 27. MARS functional acceptance checklist

Use disposable destinations for every clone and restore (for example `TEST_F4_*`); never change a production master.

| #   | Scenario                            | How                                                                                 | Expected                                                                  |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Ordinary 86Box archive              | Version History › folder icon on a usual 86Box version                              | Lists as before                                                           |
| 2   | Ordinary QEMU archive               | Same, a QEMU version                                                                | Lists as before                                                           |
| 3   | VirtualBox OVA                      | Same, an OVA version                                                                | Physical view lists as before                                             |
| 4   | Affected archive, file ≥ 3.75 GiB   | A version holding such a file (see "affected archive" below)                        | Lists; before this release it answered "archive is damaged"               |
| 5   | Archive with an entry beyond 4 GiB  | A version larger than 4 GiB in total                                                | Lists; the manifest and last files appear                                 |
| 6   | Explorer lists contents             | Logical and physical views on 4 and 5                                               | Directories and files with sizes; the ≥ 3.75 GiB file shows its real size |
| 7   | Manifest information                | View Archive Contents summary                                                       | Manifest VM name, file count, "matches registration"                      |
| 8   | Archive inspection                  | Same summary                                                                        | Complete, no warnings                                                     |
| 9   | Preview a small file                | A `.cfg` or text file on 4 or 5                                                     | Text preview, integrity "verified"                                        |
| 10  | Download a small file               | Download on the same file                                                           | Downloads; content as expected                                            |
| 11  | Nested archives                     | Open a ZIP/ISO inside an ordinary VM, as in 0058                                    | Works as before                                                           |
| 12  | Server clone of an affected version | Copy-plus on version 4 (or 5) › `TEST_F4_CLONE`                                     | Operation "Cloning VM", performed by the server                           |
| 13  | Clone completes                     | Wait                                                                                | "VM cloned: TEST_F4_CLONE"; no `source_archive_invalid`                   |
| 14  | Destination published correctly     | Open `TEST_F4_CLONE`                                                                | Private, one master, Cloned from names the source                         |
| 15  | Open the cloned archive             | Folder icon on its master                                                           | Lists like the source; manifest names `TEST_F4_CLONE`                     |
| 16  | Cloned file contents                | Preview/download the same small file as in 9–10                                     | Same content; details show the same SHA-256 as the source                 |
| 17  | Agent restore of the clone          | On a disposable test machine: restore `TEST_F4_CLONE` locally                       | Restore verifies and completes                                            |
| 18  | Ordinary snapshot and restore       | On a disposable test VM: create a snapshot, restore it                              | As before                                                                 |
| 19  | API logs                            | 26.3 grep                                                                           | No ZIP64 parsing errors                                                   |
| 20  | Originals unchanged                 | `sha256sum` of the source version's object in the repository, before 4 and after 17 | Equal; also equal to the version's recorded SHA-256                       |

**Affected archive.** If MARS holds no version with a file ≥ 3.75 GiB or > 4 GiB in total, make one through the
supported workflow only: on a disposable test VM, add a file of at least 4,026,531,840 bytes to its directory on the
agent machine (a sparse or zero-filled file is enough: `fsutil file createnew <path> 4026531840` on Windows), then
register it or create a snapshot. The agent packages it (an archive of a few MB for zeros), uploads, verifies and
registers it as usual. Use that version for items 4–17. Never edit repository objects or the catalog by hand.

For item 20, on the repository host, the object path is the version's `archive_key` (Admin › version details or
`SELECT archive_key, archive_sha256 FROM vm_versions WHERE id = '<version>'`).

## 28. Rollback runbook

Record `<previous>` before updating (26.1 `status`). To go back:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Then the 26.3 health checks. With no operation running, as in 26.1.

- **Database:** no restore. Nothing in the schema or data changes [source].
- **Archives:** nothing to roll back. Original archives are only read. Clones the fixed server made carry one standard
  ZIP64 record per entry, which the previous release reads correctly [verified: the baseline reader read both
  server-rewritten clones and matched their hashes, §21]. Archives already affected by F-4 (the agent's two-record
  layout) become unreadable by the server again after a rollback, exactly as before this release; the agent still
  reads them.
- **Agents, tooling, configuration:** nothing to roll back.
- **Disposable test artifacts:** delete `TEST_F4_*` VMs and test snapshots as you usually do with test VMs, before or
  after rollback; they are ordinary versions.

Forward again: `sudo /opt/emucat/tooling/bin/emucatctl update`.

## 29. MOON production deployment guidance

Only after MARS passes §27 and you have promoted `develop` to `main` yourself.

- **Preconditions:** `origin/main` contains the fix commit; no operation running on MOON (26.1 SQL or UI); agents
  online.
- **Synchronization:** none by hand; `update` fetches `main` into `/opt/emucat/repo.git`.
- **Tooling:** same check as 26.1 with `refs/remotes/origin/main` and MOON's `<previous>`; expected current, no refresh.
- **Update:** `sudo /opt/emucat/tooling/bin/emucatctl status` (note `<previous>`), `check-update`, `check`, then
  `sudo /opt/emucat/tooling/bin/emucatctl update`.
- **Validation:** 26.3 against MOON's URL; Archive Explorer on one ordinary version and, if one exists, one affected
  version (read only: no clone of production masters unless to a disposable destination).
- **Rollback:** `sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>`; no database restore.
- **Agents:** no update; every deployed agent keeps working, and archives they already uploaded need no change.

## 30. Remaining limitations and unverified scenarios

- **Not run on MARS or MOON.** Every deployment statement in §25–29 is [expected] from the code and the tooling.
- **Pre-existing failures elsewhere** (not caused by this change, not fixed here): 12 e2e tests on the public cover and
  General page (stale after decision 0060); the web browser suite's `execFileSync('npx', …)` on Windows.
- **Browser-local nested archives** (`apps/web/src/archive-local/zip.ts`, decision 0058) still take the first ZIP64
  record. The impact is narrow: a nested agent archive of a ≥ 3.75 GiB file that still fits the nested-archive
  limit; never condition B. Fixing it is a web change, left out of this API-only scope.
- **Full API `hashEntry` of the 9 GiB `big.img`** not run; covered by three independent full-CRC reads of the
  rewritten clone and by Python's metadata on the source.
- **Real agent restore** of a server-rewritten clone not run here. The agent's `inspect_archive` and the zip crate's
  full read of both clones passed, which is what a restore verifies before writing. MARS checklist item 17 covers it.
- **Readers:** four (CPython 3.10, 7-Zip 24.09, the agent with zip 7.3, the server's old and new code); no claim of
  compatibility beyond them.
- **Contradictory ZIP64 records** are now refused where the old code took the first. No EmuCat writer produces them;
  an archive from another tool with such records would no longer list (its meaning was ambiguous before).
- The suite's virtual archives model zip 7.3's layout from its source and from the real archives' dumps. The real
  ≥ 3.75 GiB fixture stays outside the repository by design (18 MB archive, 4 GB input).

## 31. Final repository status and commit references

| Commit                                     | Content                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `7d54051113e704f3bd270c788f912150860dc50d` | `fix(api): resolve agent-generated duplicate ZIP64 extra records` (`zip.ts` only) |
| `bc03ece3d3aa986bd108a0fdc73bc466e8f1b161` | `test(api): ZIP64 layouts of the agent, standard and malformed records (F-4)`     |
| the commit adding this report              | `docs: ZIP64 duplicate records (decision 0061), report and MARS runbook`          |

- Base: `2f460b1be6bd33b1cc8d00164967d2ba2add6756`. Pushed to `origin/develop` by fast-forward; no force push, no
  history rewritten. `main` (`79981c5`) unchanged. Nothing deployed to MARS or MOON.
- Author and committer: `david <davidfriscia@gmail.com>`.
- Not committed: no assessment artifact, synthetic archive, guest data or large binary; the scratch validation
  outputs were deleted (§22).
- `git diff --stat 2f460b1 -- deploy apps/deployer agent apps/api/migrations packages apps/web` is empty.
