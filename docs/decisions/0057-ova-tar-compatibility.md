# 0057: The agent and the server read an OVA's TAR by one policy

**Status:** Accepted. Amends [0056](0056-archive-explorer.md) (Archive Explorer) and [0055](0055-server-repository-access.md)
(server-made clones); applies to the server the policy [0049](0049-ova-repository-import.md) set for the agent.

## Context

Archive Explorer refused a real VirtualBox OVA (a Xenix 386 export, VirtualBox 7.1.10) that the agent had imported
without complaint: the listing answered `422 archive_malformed`. The server's TAR reader
(`apps/api/src/archives/tar.ts`) required a zero block at the end of every archive (`The archive has no end marker`).
That OVA has none: its three entries are a descriptor, a disk of whole 512-byte blocks and a 137-byte manifest, and the
file ends exactly where the manifest's padding ends (23,498,240 bytes, 45,895 blocks). GNU tar 1.35 and bsdtar 3.8.9
list it without a warning, and the manifest's SHA-1 digests match the descriptor and the disk.

The agent had met the same export in M6.1.1 (commit `69b3063`, "accept complete OVA archives without TAR end markers",
decision 0049), and accepted it from then on by an exact-boundary rule. The server's reader, written later for View
Archive Contents (0055) and reused by Archive Explorer (0056) and by server-made clones, never received that rule. An
archive the agent imports must be one the server can list and clone, so the two readers must agree.

Comparing them also showed smaller differences, all of which let the server refuse what the agent accepts, or accept
what the agent refuses:

| Area                                    | Agent (`agent/src/ova.rs`, `walk`)              | Server before                       |
| --------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| End exactly after the last entry        | Complete                                        | Refused: "no end marker"            |
| Block after the first zero block        | Must be zeros                                   | Not read                            |
| Extended header, then a zero block      | Refused                                         | Accepted, the header ignored        |
| A PAX `size` beyond the end of the file | Refused before anything is read                 | Not checked against the file's size |
| Signed header checksums                 | Accepted (historical tars)                      | Refused                             |
| Type `7` (contiguous file)              | A regular file                                  | Refused                             |
| Global PAX header (`g`)                 | Ignored unless it sets a path or size (refused) | Refused                             |
| ustar prefix field                      | Only with the POSIX magic `ustar\0`             | Also with the GNU magic `ustar  `   |

## Decision

The server reads an OVA's TAR by the agent's policy, still header by header through random access, reading 512 bytes
per entry for a listing and nothing of any entry's data:

**Accepted endings**

- A zero block, normally two. If a second block follows the first, it must be zeros too; zeros beyond it (GNU tar's
  10 KiB records) are not read.
- No end marker at all, when the file ends **exactly** where the last entry's padding ends, after at least one entry
  and with no PAX or GNU long-name header pending. Every entry has then been read whole.
- An archive of nothing but zero blocks is read as no entries (and refused later as an OVA without a descriptor,
  wherever a descriptor is required).

**Refused, as `archive_malformed`**

- A file shorter than one block; a cut inside a header (any partial final block, zeros included).
- A cut inside a file's data, or inside its padding: a declared size, from the header or from PAX, reaching past the
  end of the file. This is checked before any entry is accepted, with safe-integer arithmetic.
- An extended header with no entry after it, whether the file ends there or a zero block follows.
- A non-zero block right after the first zero block; a header whose checksum (unsigned or signed) is wrong.
- Everything already refused: links, devices, directories, subdirectories, unsafe or duplicate names, unreasonably
  large extended headers, global PAX headers setting a path or a size, more entries than the limit.

The decision is made from exact boundaries, never from the file's size alone, and never from the file's name. The
archive is not repaired, rewritten or re-imported: existing repository objects are read as they are.

## Consequences

- OVAs exported without an end marker (VirtualBox writes some) can be listed, previewed and downloaded from in Archive
  Explorer, and cloned by the server, as they could already be imported and restored by an agent.
- Genuinely truncated or damaged archives are still refused, now including a few the server used to accept (an
  extended header with nothing after it, data after a zero block, a PAX size beyond the file).
- A TAR records no checksum of its data: a structurally complete archive says nothing of whether the disk inside is
  sound. File previews of an OVA stay `complete`, never `verified` (0056).
- The agent is unchanged. A change to either reader's TAR policy must now change both, with their tests:
  `agent/tests/ova_import.rs` and `apps/api/test/tar-termination.test.ts` cover the same cases.
