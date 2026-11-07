# 0022: An archive is untrusted input, even when its hash matches

**Status:** Accepted

The SHA-256 says these are the bytes somebody registered. It says nothing about what those bytes try to do, and who could write to the repository, or
what an agent was tricked into archiving, is not something a hash can answer. So every entry is checked, the whole archive has to agree with its manifest, and
nothing is created until all of that has passed.

## The order

1. The size and SHA-256 of the file, through a handle that denies writers. That same handle is used from here on, so what is extracted is what was hashed.
2. The central directory, read by a small reader of our own (below).
3. Every entry's type and path.
4. The manifest: found exactly once at the root, within a size limit, and valid.
5. The two compared: the same entries, the same types, the same sizes.
6. Extraction into a new directory, hashing each file as it is written.
7. The tree listed again, and compared with the manifest.

## A central directory reader of our own

The `zip` crate is what decompresses, and it keeps entries in a map keyed by name. A second entry with the same name simply vanishes from its view, and
which one a given tool extracts is exactly how an archive shows different contents to different readers. `archive.len()` cannot reveal that either.

So [`zip_directory`](../../agent/src/zip_directory.rs) reads the directory as it is written, entry by entry, including ZIP64. It is short, and it is also what
makes the limits real: the entry count and directory size are checked before anything is allocated for them, and a count that cannot fit in the stated size is
refused. Multi-disk archives are refused. A directory that is not where the end record says it is, is refused. The crate is still the one reading
compressed data, where a bug would be far more expensive to write ourselves.

## What is refused

**Paths.** Absolute paths, `.` and `..` segments, empty segments, drive letters, UNC paths and alternate data streams (a backslash or a colon is enough to refuse
those), control characters, the characters Windows forbids, trailing dots and spaces (Windows drops them, so `name.` and `name` would be one file), and
reserved device names in any capitalization and with any extension. These apply on every system: an archive that is harmless on Linux today would not be when the VM
reaches Windows.

**Collisions.** Duplicate names, and names differing only by capitalization, compared under both lowercase and uppercase folding, since neither alone covers every
pair NTFS treats as one. Whatever gets past that is still stopped at creation, because nothing is ever opened over an existing file.

**Types.** Symbolic links, junctions, reparse points, devices, FIFOs and sockets, from either system's attributes. Encryption and compression methods other than
stored and deflate. A directory holding data, or an entry whose type and name disagree.

**The set.** An entry the manifest does not list, an entry listed and missing, and a type or a size that differs. The manifest itself is not listed, as
[0014](0014-archive-and-manifest.md) says, and only one is allowed, at the root, spelled exactly.

## The manifest

No second schema: this reads what [0014](0014-archive-and-manifest.md) defined, and checks it means what it says. The bytes must be exactly what serializing it gives back,
which refuses unknown fields, other key orders and other spacing in one check, and means that the same content has only one form. Entries must be in canonical order,
which also refuses duplicates. Totals must add up, and each file needs a size and a lowercase hash. It must name this VM and this emulator, and its hash must be
the one the registration verified, when that is known. A parent directory has to be listed, because a file in an unlisted directory is not something a
registration writes.

## Limits

From configuration, never from the archive: `restore_max_files`, `restore_max_expanded_bytes`, and a ceiling on how large a manifest can be. Compressed data is read through a cap
at the size the manifest gave, so a bomb stops where its claim stops, and nothing past it is written. Sizes in the central directory are compared with the manifest, and
never believed by themselves. Memory is one buffer, whatever the archive's size.

## Limits of this

- **Permissions and times are not restored.** The ZIP's timestamps are, as [0014](0014-archive-and-manifest.md) says, only a convenience, and nothing relies on them. Restored
  files carry the time they were restored.
- **8.3 aliases are not predicted.** An entry named like another's short alias fails at creation, as a collision. That is a refusal rather than a mistake.
- **Disk images are not inspected.** What a VM's disk holds is its own business, and is not run or converted here. No script in a VM is ever executed.

## Consequences

Each file is synchronized as it finishes, which costs time on a VM with thousands of small files. That is the price of a rename that means the contents are on the disk.
