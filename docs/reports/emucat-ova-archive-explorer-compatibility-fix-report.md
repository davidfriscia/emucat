# EmuCat — VirtualBox OVA Archive Explorer compatibility fix: report

Repository `davidfriscia/emucat`, branch `develop`. Decision record: [0057](../decisions/0057-ova-tar-compatibility.md).
Executed locally with Claude Code on the user's Windows 11 PC, 2026-11-26.

## 1. Executive summary

Archive Explorer refused the Xenix 386 VirtualBox OVA with `422 archive_malformed`. **The cause was the TAR end
marker.** VirtualBox 7.1.10 wrote this OVA with no end-of-archive blocks at all: the file ends exactly where the last
entry's (the manifest's) padding ends. The server's TAR reader (`apps/api/src/archives/tar.ts`) demanded a zero block
and threw `The archive has no end marker`. The agent had met the same export in November (commit `69b3063`, M6.1.1,
decision 0049) and accepts it by an exact-boundary rule. The server's reader, written later, never got that rule.

The server now reads OVAs by the agent's policy (decision 0057). An archive is complete at a zero block, or exactly at
the end of the last entry's padding with no extended header pending. Every other ending is still refused. Comparing
the two readers also turned up six smaller differences, aligned in the same change (section 8). One of them was a real
gap: a PAX `size` was not checked against the file's size before the entry was accepted.

The real `Xenix_386.ova` is now listed, previewed and downloaded through the full API with a real SFTP repository.
The listing reads 1,536 bytes of a 23,498,240-byte archive, the descriptor preview reads only the descriptor, and the
contents match the OVA's own SHA-1 manifest. The original file is unchanged (same SHA-256 before and after). No
reimport, agent update, configuration change, migration or tooling refresh is needed. Deploying is one
`emucatctl update`.

## 2. Starting point

| Item                   | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Branch                 | `develop`, synchronized with `origin/develop` (fetched)   |
| Starting commit        | `b695fea` (docs: Archive Explorer implementation report)  |
| `origin/main`          | `b695fea` at the start; not touched                       |
| Working tree           | Clean                                                     |
| Git identity           | The established `david` identity, as author and committer |
| Node / pnpm            | 22.22.3 (fnm) / 12.10.1; Node was not on `PATH` (see 16)  |
| Rust / Docker / Python | cargo 1.99.0 / Docker 29.9.3 / Python 3.10.11             |

## 3. Original failure reproduction

The production parser and the production local random-access source (`openLocal` from `apps/api/src/archives/zip.ts`)
were run directly against `C:\Users\david\Downloads\Xenix_386.ova`, counting every read:

```
FAILED: TarFormatError kind=malformed - The archive has no end marker
    at malformed (apps/api/src/archives/tar.ts:32:40)
    at readTar (apps/api/src/archives/tar.ts:167:21)
reads [ [ 0, 512 ], [ 7168, 512 ], [ 23497216, 512 ] ] bytes 1536
```

| Item              | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Exception         | `TarFormatError`, kind `malformed`, message `The archive has no end marker`                 |
| Failing function  | `readTar`, `apps/api/src/archives/tar.ts:167` (`if (!ended) throw …`)                       |
| Phase             | **Listing (indexing).** Nothing else is reachable: previews and downloads need the index    |
| Offset at failure | 23,498,240 = the file's size, right after the manifest's padding                            |
| Expected          | A 512-byte zero block at 23,498,240                                                         |
| Actual            | End of file: the loop `while (offset + 512 <= size)` ended without having seen a zero block |
| HTTP              | `GET …/archive` → `422 {"error":{"code":"archive_malformed", …}}`                           |
| Frontend          | "The archive is damaged or is not what EmuCat stores, so it was not listed."                |
| Also affected     | Server-made clones of the OVA (`copyOva` → `readTar`): `source_archive_invalid`             |

The same `422 archive_malformed` was reproduced end to end over HTTP and SFTP by running the new
`archive-explorer-real-ova.test.ts` against the parser at `b695fea`. The new unit tests fail 10 of 12 against the old
parser.

Nothing in the server's logs named the parser's reason: the inspection service mapped it to a generic 422 without
logging it. It now logs `Archive refused` with the reason (section 9).

## 4. Previous agent-side OVA compatibility findings

- **Original failure:** `emucat-agent import-ova` refused two real VirtualBox exports, **Xenix 386** and Windows XP,
  with "The archive ends before its end marker: the file is truncated".
- **Root cause:** `walk` in `agent/src/ova.rs` required a header or a zero block at every position. A file ending
  exactly after the last entry's padding was therefore treated as truncated.
- **Fix:** commit `69b3063` (2026-11-20), "fix(agent): accept complete OVA archives without TAR end markers".
- **Rule adopted:** `position == length && !entries.is_empty()` with no PAX or GNU long name pending means complete.
  A cut in a header, in data and in padding each get their own error, all with checked arithmetic. After a zero block,
  the next block (if any) must be zeros. Damaged checksums and trailing non-header data stay refused.
- **Regression tests** (`agent/tests/ova_import.rs`):
  - `an_archive_ending_right_after_its_last_entry_is_complete`
  - `a_last_entry_that_needs_no_padding_ends_the_archive_too` ("as in the Xenix export")
  - `an_empty_manifest_is_accepted_and_proves_nothing`
  - `a_manifest_without_an_end_marker_is_still_checked`
  - `an_archive_cut_anywhere_but_an_entry_boundary_is_truncated`
  - `only_a_proper_end_marker_or_an_entry_boundary_ends_an_archive`
  - `the_other_checks_apply_without_an_end_marker_too`
  - `a_dry_run_accepts_an_archive_without_an_end_marker`
- **Documented in:** decision 0049 ("The archive ends …") and `docs/agent.md` (Importing an existing OVA).
- **Server equivalent: none.** `apps/api/src/archives/tar.ts` was written for decision 0055 (commit `08aa3de`) and
  still required a zero block. Neither 0055 nor 0056 mentions the agent's termination rule.

The investigation read the code of both readers, not only commit messages. The agent's code is unchanged by this fix:
its behavior is the reference.

## 5. Structural analysis of `Xenix_386.ova`

Analysis used read-only positional reads of 512-byte headers and 96–512-byte windows (a scratch Node script that
never loads the file). In total 1,904 bytes were read for the walk and the dumps, plus one streaming pass for the
SHA-256.

| Property          | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Size              | 23,498,240 bytes = 45,895 blocks of 512; not a multiple of GNU tar's 10,240-byte record  |
| SHA-256           | `881648a1c25d13c38c2776d6c258399c9e2a41c20aa17aafd85214682a1d2d73` (Node and `certutil`) |
| Format            | POSIX ustar (`ustar\0` + `00`), all checksums valid (unsigned)                           |
| Writer            | uname `vboxovf10`, gname `vbox_v7.1.10r169112` (VirtualBox 7.1.10)                       |
| PAX / GNU headers | None                                                                                     |
| Entries           | 3, all type `0` (regular file), flat                                                     |

| #   | Name                     | Size       | Header offset | Data offset | Data end   | Padding | Next block |
| --- | ------------------------ | ---------- | ------------- | ----------- | ---------- | ------- | ---------- |
| 0   | `Xenix 386.ovf`          | 6,526      | 0             | 512         | 7,038      | 130     | 7,168      |
| 1   | `Xenix 386-disk001.vmdk` | 23,489,536 | 7,168         | 7,680       | 23,497,216 | 0       | 23,497,216 |
| 2   | `Xenix 386.mf`           | 137        | 23,497,216    | 23,497,728  | 23,497,865 | 375     | 23,498,240 |

- The OVF descriptor is first and unique, the manifest last. The disk is a whole number of blocks (no padding).
- The manifest is SHA-1 only: `SHA1 (Xenix 386.ovf) = f3bd3fd8…` and `SHA1 (Xenix 386-disk001.vmdk) = ed937cab…`.
  The disk starts with the sparse VMDK magic `KDMV` (`4b 44 4d 56`).

## 6. Actual TAR termination structure

The final header (the manifest's) at `0x01668a00`, and the last bytes of the file:

```
01668a00  58 65 6e 69 78 20 33 38 36 2e 6d 66 00 00 00 00  Xenix 386.mf....
01668a60  00 00 00 00 30 31 30 30 36 34 30 00 30 30 30 30  ....0100640.0000
01668a70  30 30 37 00 30 30 30 30 30 30 31 00 30 30 30 30  007.0000001.0000
01668a80  30 30 30 30 32 31 31 00 31 35 30 33 36 33 35 35  0000211.15036355     size 0211 = 137
01668a90  37 32 37 00 30 30 31 34 32 35 32 00 30 00 00 00  727.0014252.0...     checksum, type '0'
01668b00  00 75 73 74 61 72 00 30 30 76 62 6f 78 6f 76 66  .ustar.00vboxovf
01668c00  53 48 41 31 20 28 58 65 6e 69 78 20 33 38 36 2e  SHA1 (Xenix 386.     manifest data
01668c80  31 39 66 34 35 63 36 66 0a 00 00 00 00 00 00 00  19f45c6f........     data ends at 0x01668c89
01668c90  00 00 … (zeros: the manifest's 375 bytes of padding) …
01668df0  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................     EOF at 0x01668e00 = 23,498,240
```

- **Number of terminating zero blocks: 0.** The 375 zero bytes at the end are the manifest's own padding up to its
  block boundary, not an end marker.
- No trailing bytes beyond the last entry's block. The final entry is complete: its 137 bytes are all present.
- The archive ends exactly on an entry boundary.

**Classification:** a **non-canonical but compatible** TAR. It is structurally complete; only the optional-in-practice
end marker is missing. It is not truncated or corrupted: every header checksum is valid, every declared size fits,
and the manifest's SHA-1 digests match the descriptor and the disk (verified by streaming the entries through the
production extractor, section 12). Independent tools agree: GNU tar 1.35 (`tar -tvf`) and bsdtar 3.8.9 (Windows
`tar.exe`) list the three entries and exit 0 without a warning. Their acceptance alone was not taken as proof, since
tar readers stop at EOF leniently. The manifest is the integrity evidence.

## 7. Root cause

`readTar` treated "no zero block seen" as damage. For an archive ending exactly at an entry boundary, the loop ends by
its own condition and the final check throws. This is the same mistake the agent made before M6.1.1. The two readers
diverged because the server's reader (0055) was written from the TAR specification, not from the agent's
already-amended policy.

**Why import succeeded and Archive Explorer failed:** the agent's import (and restore) validate with `agent/src/ova.rs`,
which accepts the exact-boundary ending since `69b3063`. Archive Explorer and server-made clones validate with
`apps/api/src/archives/tar.ts`, which did not. The repository object itself is the VirtualBox export, byte for byte.

## 8. Agent versus server validation comparison

| Validation area                  | Rust agent (`ova.rs`)                                                 | TypeScript server before                       | TypeScript server now                 |
| -------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Header checksum                  | Unsigned **or signed** sum                                            | Unsigned only                                  | Unsigned or signed                    |
| Entry size parsing               | Octal; GNU base-256; PAX `size` for regular files                     | Same, but PAX size applied after bounds checks | PAX size applied before bounds checks |
| Entry alignment                  | 512-byte blocks, checked arithmetic                                   | Same                                           | Same, safe-integer checks             |
| Entry boundary validation        | Data end and padding end ≤ file size, separate errors                 | Padded end ≤ size (header size only)           | As agent (data, then padding)         |
| Zero-filled termination blocks   | Accepted; the next block, if any, must be zeros                       | Accepted; nothing after checked                | As agent                              |
| Single termination block         | Accepted                                                              | Accepted                                       | Accepted                              |
| Missing termination blocks       | Accepted at an exact entry boundary, ≥ 1 entry, nothing pending       | **Refused**                                    | As agent                              |
| EOF at a complete entry boundary | Complete                                                              | **Refused**                                    | Complete                              |
| Trailing padding (zeros)         | Whole zero blocks accepted; partial block refused                     | Partial block refused ("no end marker")        | As agent                              |
| Truncated entry data             | Refused (data, padding)                                               | Refused                                        | Refused (data, padding)               |
| Extended header, then end        | Refused, at EOF or at a zero block                                    | At EOF refused; at a zero block **accepted**   | Refused in both                       |
| PAX extensions                   | `x` path and size; `g` ignored unless it sets path/size               | `x` only; `g` refused                          | As agent                              |
| GNU extensions                   | `L` long name; `K` refused as a link; prefix only with `ustar\0`      | `L`; prefix also with GNU `ustar  `            | As agent                              |
| Unsupported entry types          | Links, devices, FIFOs, directories refused; `7` is a regular file     | Same, but `7` refused                          | As agent                              |
| Names                            | Flat, safe, case-insensitively unique                                 | Same (`entryPathProblem`)                      | Unchanged                             |
| Limits                           | 4,096 entries; 64 KiB extended headers                                | Configured entries (≤ 10,000); 1 MiB           | Unchanged                             |
| Manifest handling                | `.mf` parsed; SHA-256 checked while hashing; SHA-1 reported unchecked | Not parsed: physical view, previews `complete` | Unchanged                             |

The rows that could make an archive accepted by import be rejected by Archive Explorer are the missing end marker
(this failure), signed checksums, type `7` and global PAX headers. Two rows went the other way: an extended header
followed by a zero block, and a PAX `size` beyond the file. There the server accepted what the agent refuses. The
second could index an entry whose bytes do not exist, although extraction's own locator check (`checkLocator` in
`extract.ts`) still refused to read past the file. All are aligned.

The agent and the server now share one documented OVA TAR policy, decision 0057, with tests covering the same cases on
both sides. The limits differ on purpose (the server's configured entry limit, its 1 MiB extended-header bound) and
are unchanged. The agent needed no change.

## 9. Implemented corrective changes

- `apps/api/src/archives/tar.ts`, `readTar`: rewritten termination and bounds logic, as the agent's `walk`:
  - At `offset === size` with at least one entry and no PAX/long-name pending: complete. Pending: refused ("ends
    after an extended header … truncated").
  - Less than a header left: refused ("ends in the middle of a header: it is truncated"). A short read from the
    source is refused the same way.
  - At a zero block: if a second block exists it must be zeros ("data after an empty header: it is damaged"); a
    pending extended header is refused ("ends inside an extended header").
  - PAX `size` (digits only) is applied **before** the bounds checks; `data end > size` → "ends in the middle of a
    file"; `padded end > size` → "ends in the padding after a file". Safe-integer checks on the next offset.
  - Signed checksums accepted; type `7` read as a regular file; `g` headers ignored unless they set `path` or
    `size` (refused); the ustar prefix only with the exact POSIX magic.
  - Minimum size: one block, not two (an unterminated single-entry OVA can be smaller than 1 KiB).
- `apps/api/src/archives/inspection.ts`: an archive refused by the ZIP, manifest or TAR checks now logs
  `Archive refused` at `warn` with `versionId`, `format` and the reader's `reason`. The HTTP response is unchanged.
- No change to `extract.ts`, `explorer.ts`, `policy.ts`, routes, contracts, the web app or the agent.
- The fix has no special case for any file name.

## 10. Accepted and rejected TAR structures

| Structure                                                 | Verdict             | Why                                                                              |
| --------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Two zero blocks (canonical)                               | Accepted            | POSIX end of archive                                                             |
| One zero block                                            | Accepted            | GNU tar and the agent accept it; nothing is missing                              |
| No end marker, EOF exactly after the last entry's padding | **Accepted**        | VirtualBox exports (this OVA); every entry read whole; agent policy since M6.1.1 |
| More zero blocks (10 KiB record padding)                  | Accepted            | Only the block after the first zero block is read, and must be zeros             |
| Only zero blocks (empty archive)                          | Accepted, 0 entries | As agent; refused later wherever a descriptor is required                        |
| Empty file, or shorter than 512 bytes                     | Rejected            | Not a TAR                                                                        |
| Partial final header (any bytes, zeros included)          | Rejected            | Truncated inside a header                                                        |
| Final entry's data cut short                              | Rejected            | Truncated inside a file                                                          |
| Final entry's data whole, padding cut short               | Rejected            | Truncated inside the padding: not an entry boundary                              |
| Declared size (ustar, base-256 or PAX) beyond the file    | Rejected            | Would point at bytes that do not exist                                           |
| Invalid header checksum                                   | Rejected            | Damaged header                                                                   |
| Non-zero block right after a zero block                   | Rejected            | Data after the end: damaged or concatenated                                      |
| Non-header garbage after the last entry                   | Rejected            | Fails the checksum (or its number field)                                         |
| PAX or GNU `L` header with no entry after it              | Rejected            | Truncated: the described file is missing                                         |
| Global PAX header setting `path` or `size`                | Rejected            | Meaningless in an OVA                                                            |
| Links, devices, directories, subdirectories, unsafe names | Rejected            | Unchanged                                                                        |

## 11. Security and integrity considerations

- Header checksum, entry-boundary, declared-size, name/path, duplicate and entry-count checks are all preserved. The
  bounds check is now stricter (PAX sizes).
- Completeness is decided by exact boundaries with safe-integer arithmetic, never by the file size alone. A malformed
  final header is never taken for an end marker: only an all-zero full block is one, and a partial block is
  truncation.
- An archive is still never read past its size: no declared entry may extend beyond it, and `extract.ts` checks each
  locator again before reading.
- Resource limits, timeouts, cancellation, repository identity checks (size against the registration, the cached
  index's identity) and read-only access are untouched: the change is confined to the parsing loop.
- A TAR records no data checksum; OVA previews remain `complete`, not `verified`. Nothing claims that the disk is
  sound.

## 12. Real OVA validation results

Two opt-in tests run against the real file; both are skipped when `EMUCAT_OVA_FIXTURE` is unset, so the ordinary
suite does not depend on it.

**A. Production parser and extractor on the file in place** (`tar-termination.test.ts`, "A real OVA"): `readTar` +
`checkOvaLayout` through `openLocal`. The listing read exactly 3 × 512 bytes. Each entry named in the manifest was
streamed through `entryChunks`, and its SHA-1 matched the OVA's own VirtualBox manifest (descriptor and 22.4 MiB
disk). Result: **passed**.

**B. Full API workflow** (`archive-explorer-real-ova.test.ts`): MariaDB, the real in-process SSH/SFTP repository server,
the admin HTTP API, the production inspection, explorer, preview and download code. The test repository holds a copy
of the OVA, removed with the test's server; the fixture itself is only read. Result: **passed**.

| #   | Check                               | Result                                                                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Archive inspection completes        | `200`; format `ova`; views `physical`                                                                        |
| 2   | Entries listed                      | 3: `Xenix 386-disk001.vmdk`, `Xenix 386.mf`, `Xenix 386.ovf` (listing order)                                 |
| 3   | Names and sizes                     | 23,489,536 / 137 / 6,526: identical to the independent analysis and to GNU tar                               |
| 4   | Directory navigation                | An OVA is flat: all entries at the root (`path=''`), as decision 0056 defines                                |
| 5   | OVF previewed as text               | `200`, integrity `complete`, contains `<Envelope`                                                            |
| 6   | Manifest previewed                  | `200`, the two SHA-1 lines                                                                                   |
| 7   | XML highlighting                    | Entry details detect `{ kind: 'text', language: 'xml' }`, which the web app's highlighter uses               |
| 8   | Small downloads                     | `.ovf` 6,526 bytes and `.mf` 137 bytes                                                                       |
| 9   | Contents match reference            | Downloaded `.ovf` SHA-1 = manifest's `f3bd3fd8…`; disk SHA-1 = manifest's `ed937cab…` (test A)               |
| 10  | Bounded hex of the disk             | 65,536 bytes from offset 0, equal to the file's bytes at data offset 7,680; begins with `KDMV`               |
| 11  | Oversized download blocked          | With a 1 MiB download limit, the 22.4 MiB disk → `413 download_too_large`                                    |
| 12  | No disk payload read for descriptor | Descriptor preview read exactly 6,526 bytes from the repository: the descriptor and nothing else             |
| 13  | No temporary files                  | `TMPDIR`/`TEMP`/`TMP` pointed at an empty directory for the run: still empty; repository directory unchanged |
| 14  | Resources released                  | 0 open SFTP connections and 0 open handles afterwards                                                        |
| —   | Original OVA unchanged              | SHA-256 and size identical before and after the run                                                          |

Cancellation and release on cancellation are covered by the existing Archive Explorer tests (deadlines, dropped
downloads, aborted previews), which pass unchanged (section 16). The parser change does not touch those paths.

The browser rendering (XML colours, tree, buttons) was not exercised against the real OVA locally. It is unchanged
code covered by the web tests, and the Mars acceptance test (section 21) checks it by eye.

## 13. Selective repository read measurements

Bytes read from the SFTP repository, measured by the test server, for the 23,498,240-byte OVA:

| Operation                         | Bytes read | Share of archive |
| --------------------------------- | ---------- | ---------------- |
| Listing (index construction)      | 1,536      | 0.0065 %         |
| Descriptor text preview (6,526 B) | 6,526      | 0.028 %          |
| Descriptor download               | 6,526      | 0.028 %          |
| Manifest download (137 B)         | 137        | 0.0006 %         |
| Disk hex preview (64 KiB window)  | 65,536     | 0.28 %           |

## 14. Temporary storage verification

The fix adds no I/O. The new real-OVA test points the process temporary directory at an empty directory for the whole
workflow, and it is still empty afterwards. The repository's directory listing is unchanged, so nothing was staged
there. The existing "reads only what it needs … and writes nothing anywhere" test passes as well.

## 15. Automated regression tests

New `apps/api/test/tar-termination.test.ts` (12 tests, plus one opt-in real-OVA test), with synthetic fixtures in the
Xenix layout (descriptor, whole-block disk, short manifest last):

| Test                                                                                 | Expectation                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| accepts the canonical end marker of two zero blocks                                  | Accepted                                                                                   |
| accepts an archive that ends exactly after its last entry, as VirtualBox writes them | Accepted; identical entries to the terminated archive; exact offsets; only 3 headers read  |
| accepts a single zero block, and more zero padding than two blocks                   | Accepted (512 B; 10 KiB)                                                                   |
| accepts a last entry that needs no padding, at the very end of the file              | Accepted                                                                                   |
| reads an empty archive as no entries, and refuses an empty file                      | 1,024 or 512 zeros → `[]`; 0 or 100 bytes → refused                                        |
| refuses an archive cut anywhere but at an entry boundary                             | Cuts in header / data / padding refused with distinct messages; cut at a boundary is valid |
| refuses an entry that declares more bytes than the file holds                        | Octal, base-256 (1 TiB) and PAX sizes                                                      |
| refuses partial blocks, data after an empty header, and damaged headers              | Partial zeros, partial header, garbage, data after a zero block, bad checksums             |
| refuses an extended header with no entry after it, with or without an end marker     | PAX `x` and GNU `L`                                                                        |
| reads PAX and GNU long names, and global PAX headers that set neither path nor size  | Accepted; `g` with `path` refused                                                          |
| accepts signed header checksums and contiguous files, as the agent does              | Accepted                                                                                   |
| extracts one entry of an archive without an end marker, reading only that entry      | `readEntry` reads exactly each entry's bytes, from its data offset                         |

Ten of these fail against the parser at `b695fea`. New `apps/api/test/archive-explorer-real-ova.test.ts` is opt-in
(section 12). `apps/api/test/zip-builder.ts` exports its `tarHeader` helper. To run the opt-in tests locally:

```powershell
$env:EMUCAT_OVA_FIXTURE = 'C:\Users\david\Downloads\Xenix_386.ova'; pnpm --filter @emucat/api exec vitest run tar-termination archive-explorer-real-ova
```

## 16. Full test suite results

Run locally on Windows 11 with the repository's own commands. Node 22.22.3 was installed through fnm but not on the
shell's `PATH`. It was put on `PATH` for these commands, and nothing was installed or upgraded. MariaDB was the
project's own `docker compose` container (`emucat-mariadb-1`, already running and healthy).

| Suite                                                                                              | Result                                                                                               |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm check` (type checks of contracts, API, web, deployer; `cargo check`)                         | **Passed**                                                                                           |
| `pnpm lint` (ESLint, Prettier, `cargo fmt --check`, Clippy `-D warnings`)                          | **Passed**                                                                                           |
| Contracts tests                                                                                    | **448 passed**                                                                                       |
| Deployer tests                                                                                     | **51 passed**                                                                                        |
| Web tests                                                                                          | **556 passed**                                                                                       |
| API tests (`vitest run`)                                                                           | **1,209 passed, 5 failed, 2 skipped** (the two opt-in real-OVA tests); the 5 are pre-existing, below |
| New TAR tests (`tar-termination.test.ts`)                                                          | **12 passed**; with `EMUCAT_OVA_FIXTURE`, **13 passed**                                              |
| Real-OVA end-to-end (`archive-explorer-real-ova.test.ts`)                                          | **Passed** with `EMUCAT_OVA_FIXTURE`                                                                 |
| Archive tests (`archives`, `archive-extract`, `archive-inspection`, `repository-access`, `clones`) | **All passed**                                                                                       |
| `pnpm build` (all packages; web Vite build; agent `--release`)                                     | **Passed**                                                                                           |
| `cargo test --manifest-path agent/Cargo.toml --no-fail-fast`                                       | **617 passed, 1 failed, 27 ignored**; `ova_import` **53 of 53**; the 1 is pre-existing, below        |
| `pnpm test:e2e` (real agent binary, real browser)                                                  | **84 passed, 16 failed, 1 skipped**; the 16 are pre-existing, below                                  |

**Pre-existing failures, identical without this fix.** Each suite with failures was run again on the sources of
`b695fea` (the two changed source files swapped back), and the same tests failed:

- API, 5 tests, Windows-specific:
  - `notes.test.ts`, two tests: `symlink` fails with `EPERM` (Windows needs Developer Mode or elevation).
  - `notes.test.ts`, one test: it expects file mode `0o640` (416) and Windows reports `0o666` (438).
  - `archive-explorer.test.ts`, "writes nothing anywhere": it redirects `TMPDIR`, but on Windows `os.tmpdir()` reads
    `TEMP`. The new real-OVA test redirects `TEMP` and `TMP` too and passes, so the diskless property is verified here.
  - `archive-explorer.test.ts`, "shares one load … (R2)": a timing race. The small archive is indexed before the
    abort arrives, so it stays cached (`indexes: 1`).
- Agent, 1 test: `packaging.rs` `a_junction_inside_the_screenshots_directory_is_refused_too` expects an archive build
  to refuse a junction under `screenshots/`. Since decision 0051, screenshots are excluded from archives, so the build
  succeeds. Junction tests run only on Windows, which is why a Linux run does not see it. The agent is not changed by
  this fix.
- e2e, 16 tests, identical sets with and without the fix:
  - `execution.e2e.test.ts`, 3 tests: two 30 s browser locator timeouts (real QEMU launch; Remote Snapshot from
    history), and one layout assertion (restore history table).
  - `restore.e2e.test.ts`, 7 tests: five 30 s browser locator or URL timeouts, then two API calls answering
    `409 local_copy_exists` because the earlier steps did not complete.
  - `media.e2e.test.ts`, 4 of 5 tests, and `registration.e2e.test.ts`, 1 test: screenshot/transfer scenarios that
    expect `partial_success` or a kept local copy, but get `succeeded` with the copy `removed`. That is the behavior
    decision 0051 (screenshots are not VM state) introduced. The fifth media test fails only because its Fastify app
    was already closed by an earlier failure.

  The causes were not investigated further. None involves archive inspection or TAR reading.

These are outside this fix and were not changed.

## 17. Docker build results

Docker 29.9.3 (Docker Desktop, Linux containers), with the project's own scripts:

| Command                                              | Result                                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:deploy` (`deploy/test/integration.sh`)    | **Passed.** Deployer image (`deploy/docker/deployer.Dockerfile`, `artifact` target) built; deployer integration 46 passed, 1 skipped, 0 failed; fresh `/opt/emucat` installation 3 of 3                                     |
| `pnpm test:compose` (`deploy/test/compose-smoke.sh`) | **API and web production images built** (`deploy/docker/api.Dockerfile`, `web.Dockerfile`, `runtime` targets) from the working tree with this fix, exported with the server's modes (umask 027); **47 of 48 checks passed** |

The one failing compose check is "notes files the API writes belong to UID/GID 1000". It runs `stat -c %u:%g` on the
**host** path of the bind mount (`compose-smoke.sh`, line 214). From Git Bash on Windows that path is an NTFS file,
whose owner is reported as the Windows account's mapped UID, never 1000. It cannot pass on a Windows host and does
not involve archives. It was not re-run at `b695fea`, since neither notes nor the deployment files are changed. On
Mars, `emucatctl update`'s build and verification stage builds the same images on Linux.

## 18. Important changed files

| File                                                                   | Change                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/api/src/archives/tar.ts`                                         | Termination and bounds policy of decision 0057                        |
| `apps/api/src/archives/inspection.ts`                                  | `Archive refused` warning with the reader's reason                    |
| `apps/api/test/tar-termination.test.ts`                                | New: termination, corruption, extraction; opt-in real-OVA parser test |
| `apps/api/test/archive-explorer-real-ova.test.ts`                      | New: opt-in end-to-end Archive Explorer test on a real OVA            |
| `apps/api/test/zip-builder.ts`                                         | Exports `tarHeader`                                                   |
| `docs/decisions/0057-ova-tar-compatibility.md`                         | New decision                                                          |
| `docs/decisions/0049-…`, `0056-…`, `README.md`                         | Cross-references                                                      |
| `docs/reports/emucat-ova-archive-explorer-compatibility-fix-report.md` | This report                                                           |

## 19. Configuration and infrastructure impact

| Item                                   | Required? | Why                                                                                                                         |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Repository checkout on Mars            | No        | `emucatctl update` fetches `develop` into `/opt/emucat/repo.git` itself                                                     |
| Deployment tooling refresh / `install` | No\*      | `deploy/`, `apps/deployer`, `deploy/systemd` unchanged since `08aa3de` (0055) except the `app.env.example` comments of 0056 |
| `emucatctl update`                     | **Yes**   | Rebuilds and restarts the API image with the fixed parser                                                                   |
| Configuration / environment variables  | No        | None added                                                                                                                  |
| Docker Compose                         | No        | `deploy/compose.yaml` unchanged                                                                                             |
| Database migrations                    | No        | Newest is still `0021_server_repository_access`                                                                             |
| Reverse proxy / nginx / Cloudflare     | No        | Unchanged                                                                                                                   |
| SSH keys, `known_hosts`, repositories  | No        | Unchanged                                                                                                                   |
| Windows agent rebuild or update        | No        | The agent's reader is the reference and unchanged; Archive Explorer needs no agent                                          |
| Archive reimport / repair              | No        | The server reads existing objects as they are                                                                               |

\* Provided that Mars runs the tooling of 0055 or later, as the 0056 runbook required. 20.1 checks this rather than
assuming it.

## 20. Exact Mars deployment runbook

Mars: branch `develop`, `https://emucat-test.dfri.info`, web container on `10.0.0.2:8095`, Compose project `emucat`,
installation root `/opt/emucat`. `<commit>` is the commit pushed by this fix (section 24); `<previous>` is the one Mars
runs now.

### 20.1 Pre-deployment checks

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Note the deployed commit: `<previous>`, for rollback. It should be `b695fea…` or another commit of 0056.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

`Latest:` must be `<commit>`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Every line ok.

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat "$(sudo sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' /opt/emucat/state/current-release.json | head -1)" refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml apps/deployer apps/api/migrations
```

- Expected: `tooling is current`, and the second command prints nothing. Go on with 20.2.
- If not, Mars runs a release before 0055/0056: follow [runbook-0056-mars.md](../runbook-0056-mars.md) 19.1 (which
  points to the 0055 runbook if needed) before this one.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

### 20.2 Deployment

1. Repository checkout: **not required**.
2. Tooling refresh and `emucatctl install`: **not required** (when 20.1 said the tooling is current).
3. Configuration changes, new environment variables: **none**.
4. Docker Compose changes, reverse-proxy changes, SSH key changes: **none**.
5. Database migrations: **none** (`update` reports that none were applied).
6. Windows agent: **no rebuild or update**.
7. Application update, the only required step:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. It fetches, builds the API and web images, runs the verification stage, backs up the database, applies
   (no) migrations, recreates the containers and health-checks them. The same can be started from Admin › Application
   Updates.

### 20.3 Post-deployment checks

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

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

No `Invalid configuration`, no unexpected errors.

## 21. Mars functional acceptance checklist

The Xenix VM's master in the repository is the OVA that VirtualBox exported. If it was imported from this same file,
its Version History card shows size **23,498,240 bytes** (22.4 MiB) and SHA-256 `881648a1…2d73`. Its contents are
then exactly those of the local test file. If the size differs, it is another export of the same VM: the steps
below still apply, with that export's own names and sizes. Nothing is reimported or replaced.

| #   | Step                   | How                                                                                                                       | Expected                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Deployed commit        | 20.3 commands                                                                                                             | `<commit>` on both containers                                                                                   |
| 2   | Version History        | Catalog › Xenix 386 › Manage › **Version History**                                                                        | The master (and any snapshots), each with its size                                                              |
| 3   | Select the version     | The master (or the snapshot that failed before)                                                                           | Its card                                                                                                        |
| 4   | Open Archive Explorer  | **View contents…**                                                                                                        | The dialog opens with no "The archive is damaged or is not what EmuCat stores" message                          |
| 5   | Listing                | Look at the tree                                                                                                          | Only **Stored entries**; `Xenix 386.ovf` (6.4 KiB), `Xenix 386-disk001.vmdk` (22.4 MiB), `Xenix 386.mf` (137 B) |
| 6   | Preview the OVF        | Select `Xenix 386.ovf`                                                                                                    | Text, XML, highlighted (tags and attributes in colour); `<Envelope …>` and `VirtualSystem`; read completely     |
| 7   | Preview the manifest   | Select `Xenix 386.mf`                                                                                                     | Two lines: `SHA1 (Xenix 386.ovf) = f3bd3fd8…` and `SHA1 (Xenix 386-disk001.vmdk) = ed937cab…`                   |
| 8   | Download a small entry | On `Xenix 386.ovf`, **Download file**; then on the downloading PC, the PowerShell command below                           | Saved as `Xenix 386.ovf`, 6,526 bytes; SHA-1 `F3BD3FD8B8FA4DAF3DC97ECAF6E30EA50A78C42E`                         |
| 9   | Disk header in hex     | Select `Xenix 386-disk001.vmdk`                                                                                           | Hex rows from `00000000`; first bytes `4b 44 4d 56` (`KDMV`); **Next** pages forward                            |
| 10  | No temporary files     | The two commands below, before step 4 and after step 9                                                                    | No new file in `data/transfers`; the `/tmp` count in the API container is the same before and after             |
| 11  | ZIP / ZIP64 unaffected | Open Archive Explorer on an 86Box or QEMU version; preview its `.cfg`; download a small file; open a ZIP64 version if any | Both views, previews and downloads as before                                                                    |
| 12  | Logs                   | The log command below                                                                                                     | `Archive indexed` with `entries: 3` for the Xenix version; no `Archive refused` for it; no errors               |

Step 8, on the Windows PC that downloaded the file:

```powershell
Get-FileHash -Algorithm SHA1 "$env:USERPROFILE\Downloads\Xenix 386.ovf"
```

Step 10, on Mars, on a quiet server (transfers and clones create staging files of their own):

```bash
sudo find /opt/emucat/data/transfers -type f -newer /opt/emucat/state/current-release.json
```

```bash
sudo docker exec emucat-api-1 sh -c 'find /tmp -type f | wc -l'
```

Step 12:

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 300 | grep -E 'Archive (indexed|refused)|"level":(50|60)'
```

An `Archive refused` line for any other version is new diagnostic output: its `reason` names what the reader found.
Such a version was already refused before this fix.

## 22. Rollback instructions

The fix has no migration, configuration or tooling change. `rollback-app` to the previous release is therefore safe,
and no database restore is needed:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

`status` and the 20.3 `docker inspect` must show `<previous>`. To go forward again: `sudo /opt/emucat/tooling/bin/emucatctl update`.
After a rollback, Archive Explorer refuses the Xenix OVA again (`archive_malformed`), as before. No data is affected
either way: Archive Explorer and the parser only read. A failed `update` leaves `<previous>` running (it rolls back by
itself when no migration was applied, which is the case here).

## 23. Known limitations

- The real-OVA tests are opt-in: CI runs the synthetic fixtures only, since the OVA is not committed.
- Neither reader verifies that the disk image is sound; the TAR format records no data checksum. VirtualBox's manifest
  is SHA-1 here, which EmuCat does not check (the agent checks SHA-256 manifests at import; the server checks none).
- After a zero block, only the next block is checked (as in the agent); zeros or a partial block beyond it are not
  read. A partial trailing block after the end marker is therefore not refused. It is outside the archive and is never
  read for any entry.
- The local Windows run could not exercise the browser UI against the real OVA; section 21 covers it on Mars.

## 24. Git commits and push confirmation

| Commit    | Subject                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `7882591` | fix(api): read OVAs without a TAR end marker, as the agent does (decision 0057) |
| (next)    | docs: OVA Archive Explorer compatibility fix report (this file)                 |

Both are on `develop`, on top of `b695fea`, by the established `david` identity, and pushed to `origin/develop`.
`<commit>` for the runbook is the tip of `origin/develop` after the push: `git log -1 --format=%H origin/develop`.
No feature branch was created, `main` is unchanged, and nothing was deployed to Mars or Moon. The OVA file was not
committed, uploaded or modified: its SHA-256 and modification time are the same as before the session, and no
extracted VM content is in the repository.

## Explicit answers

| Question                                                    | Answer                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Was the failure caused by the TAR termination marker?       | **Yes.** The OVA has zero end-of-archive blocks; the server's reader required one (`tar.ts:167`, "The archive has no end marker")                  |
| Was the same issue previously addressed in the Rust agent?  | **Yes**, in commit `69b3063` (M6.1.1, decision 0049), found with this very Xenix 386 export                                                        |
| Why did agent import succeed while Archive Explorer failed? | Two readers: the agent's (`ova.rs`) had the exact-boundary rule; the server's (`tar.ts`, written later for 0055/0056) did not                      |
| Can the original OVA now be inspected without modification? | **Yes**: listed, previewed and downloaded in place; SHA-256 unchanged                                                                              |
| Are existing repository archives affected?                  | Only in being readable now: they are read as they are, never modified. Server-made clones of such OVAs work too                                    |
| Is archive reimport required?                               | **No**                                                                                                                                             |
| Is an agent update required?                                | **No**                                                                                                                                             |
| Does the fix preserve diskless selective archive access?    | **Yes**: 1,536 bytes read to list a 23.5 MB OVA; only the selected entry's bytes for previews; no temporary files, staging, cache on disk or agent |
| Is a deployment tooling update required?                    | **No**, given Mars runs the 0055/0056 tooling (20.1 verifies it)                                                                                   |
| Are configuration changes required?                         | **No**                                                                                                                                             |
