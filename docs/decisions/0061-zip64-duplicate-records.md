# 0061: The server resolves the agent's duplicated ZIP64 records

**Status:** Accepted. Amends [0055](0055-server-repository-access.md) (archive inspection, server-made clones) and
[0056](0056-archive-explorer.md) (Archive Explorer). Corrects defect F-4 of the Seekable Deflate feasibility
assessment; changes no archive, no agent and no protocol.

## Context

The agent packages VMs with the `zip` crate 7.3 ([0014](0014-archive-and-manifest.md), `agent/src/packaging.rs`). For
every entry whose central record needs ZIP64, zip 7.3 writes **two** ZIP64 extended-information records (header ID
`0x0001`) into that record:

1. the one reserved by `start_file`, written again at the end with the sizes it had by then: both are the placeholder
   `0xFFFFFFFF` (as 64-bit values); its offset, when present, is already the real one;
2. the local header's record, patched after compression, with the real sizes and offset.

An entry's central record needs ZIP64 when either:

- **(A)** the agent set `large_file`, because the **source file** has 3.75 GiB or more (`0xF000_0000` bytes,
  `ZIP64_ENTRY_THRESHOLD`), whatever it compresses to: an 18 MB archive of a 3.75 GiB disk of zeros has it;
- **(B)** its local header starts beyond 4 GiB of archive data, as every entry after the first 4 GiB does, the
  manifest included, however small.

The server's reader (`apps/api/src/archives/zip.ts`, `readCentralDirectory`, since 0055) took the **first** ZIP64
record. It read sizes of 4,294,967,295 bytes and refused such archives as malformed: "An entry's data overlaps the
central directory". Archive Explorer, View Archive Contents and server-made clones therefore failed for every 86Box or
QEMU version holding a file of 3.75 GiB or more, or larger than 4 GiB in all. The data was intact: the agent's reader
(`agent/src/zip_directory.rs`) and the zip crate's fill a field only while it still holds `0xFFFFFFFF`, so the second
record wins there; CPython's `zipfile` takes the last record; 7-Zip reads it with a "Headers Error" warning when an
offset is in ZIP64.

## Decision

For each fixed field of a central record that is `0xFFFFFFFF` (uncompressed size, compressed size, local header
offset, in that order), every ZIP64 record holds one 64-bit value, at the position the spec gives it (APPNOTE 4.5.3).
The server resolves each such field over **all** the record's ZIP64 records:

| Case                                                    | Result                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| No field is `0xFFFFFFFF`                                | The fixed fields; ZIP64 records, if any, are not read (as before)         |
| A field is `0xFFFFFFFF`, no ZIP64 record                | Refused: "An entry needs ZIP64 and has no ZIP64 field" (as before)        |
| Any ZIP64 record shorter than the fields it must hold   | Refused: "A ZIP64 field is truncated", whichever record it is             |
| Any value above 2^53 − 1, in any record                 | Refused: "A size or offset is too large"                                  |
| One record                                              | Its values (as before)                                                    |
| The agent's placeholder, then real values               | The real values: a `0xFFFFFFFF` yields to any other value                 |
| Several records, the same values                        | Those values                                                              |
| Two different values other than `0xFFFFFFFF`, any order | Refused: "An entry's ZIP64 records contradict each other"                 |
| Every record gives `0xFFFFFFFF` for a field             | `0xFFFFFFFF` is the value                                                 |
| Bytes after the fields a record must hold               | Ignored (as before; some writers add the disk number)                     |
| Unknown extra-field IDs                                 | Kept, as before, in `ZipEntry.extra`; every ZIP64 record is removed there |

Then every existing check applies to the resolved values, unchanged: the entry's data must end before the central
directory; its local header must be where the offset says, name the same file and use the same method; the manifest
must list the same size; and whatever is read is checked against the size and CRC.

**Why not "last record wins".** It is what CPython does, but it would silently take whichever of two contradicting
records comes last, and the agent's reader takes the first real one. Accepting only what both agree on, and refusing
contradictions, gives one answer for every archive the server accepts, the same as the agent's.

**Why `0xFFFFFFFF` is not refused outright.** It is a legitimate value: a file of exactly 4,294,967,295 bytes, or an
entry starting at that offset, must have it in ZIP64, and zip 7.3 then writes it in both records. A placeholder that
no record resolves is never taken as a real 4 GiB size either: the data's bounds, the manifest's sizes, or the size
and CRC read back refuse the entry.

**Rewriting.** A server-made clone (`rewriteZip`) already wrote what is wanted, and is unchanged: every ZIP64 record of
the source is dropped, and a central record that needs ZIP64 gets exactly one, with the real sizes and, beyond 4 GiB,
the real offset. Other extra fields are kept. Local headers are written again with one ZIP64 record of real sizes.

**Local headers.** The server never takes a value from a local header's ZIP64 record: it reads only the extra field's
length there, to find the data. The same defect cannot occur in local headers.

## Consequences

- Archive Explorer, View Archive Contents and server-made clones accept agent archives under (A) and (B). Existing
  archives are read as they are: none is changed, migrated or repackaged, and no agent needs updating.
- Archives without ZIP64, and archives with one ZIP64 record per entry, are read exactly as before.
- An archive whose ZIP64 records contradict each other, which earlier releases read through its first record, is now
  refused as malformed. No known EmuCat writer produces one.
- A clone made by the server from an affected version has one ZIP64 record per entry. Every reader tested accepts it,
  7-Zip without the warning it gives for the agent's own layout, and so does a release before this one.
- Not changed: the browser-local reader of nested archives (`apps/web/src/archive-local/zip.ts`, 0058) still takes the
  first ZIP64 record. A nested archive is held in memory and never reaches (B); it reaches (A) only when it is an agent
  archive of a 3.75 GiB file that compresses to fit the nested-archive limit. Applying this policy there is a separate
  change.
