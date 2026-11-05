# 0014: Immutable ZIP archives, and a deterministic manifest inside them

**Status:** Accepted

**Every version is a complete, standalone ZIP** of the VM directory's contents, with no wrapper directory. Entry paths
use `/`, and names are stored as UTF-8. ZIP64 is used where needed, and a test round-trips more than 4 GiB. Disk images
are never inspected or converted.

**The manifest is the archive's last entry,** `.emucat-manifest.json`. It travels with the archive, so a copy can always be
checked on its own, and there is no second object that could go missing or disagree. A file with this name in a VM's root
fails the archive, rather than being silently replaced. It lists every other entry and so never describes itself, and the
archive's hash covers it.

```json
{
  "manifestVersion": 1,
  "emulatorType": "qemu",
  "vmName": "Win98",
  "fileCount": 2,
  "totalUncompressedBytes": 4294967296,
  "entries": [
    { "path": "disk.qcow2", "type": "file", "sizeBytes": 4294967295, "sha256": "…" },
    { "path": "nvram", "type": "directory" },
    { "path": "run.bat", "type": "file", "sizeBytes": 1, "sha256": "…" }
  ]
}
```

**Deterministic by construction.** Paths are sorted by their bytes, and serialization is compact with fixed key order.
It holds no timestamp, operation or version, so the same VM always produces the same manifest bytes. Comparing two
manifests shows what changed between versions, which is what a future snapshot needs. Nothing relies on ZIP timestamps,
which are only a convenience for whoever extracts the archive. The ZIP's own bytes are not deterministic, and do not
need to be.

**What is left out.** 86Box: the root `screenshots/` directory, ignoring case. QEMU: `.ppm` files in the root, ignoring
case. Nothing else, so a `.ppm` in a subdirectory or a `screenshots` file is ordinary content. A VM holding a symlink,
junction, other reparse point or special file **fails**. Skipping them would make the archive silently incomplete, and
for a transfer that would mean losing them.

**Compression is by file type.** Formats that are already compressed, or rarely compress further (`qcow2`, `vmdk`, `vhdx`,
`vdi`, `chd`, and archive and media formats), are stored. A raw `.img` is deflated, because a mostly empty raw disk shrinks a
lot. Files above 256 MiB use the fastest level. Files are not sniffed for content: a compressed qcow2 inside something
with another extension just takes longer.

**A VM may be changing while it is read, so the rule is conservative.** Metadata is recorded first. Each file must have the same
size and times before reading, after reading through the open handle, and again by name. The whole tree is listed again at the
end and must be identical, and the marker is checked again. Any difference fails the archive. On Windows, each file is
opened denying writers, so a file an emulator holds open for writing fails at once with `source_in_use`, which is the best
available evidence of a running VM.

**The limitation, stated plainly.** This is not a transactional snapshot. On a system where the open cannot deny writers, a
program could change a file and restore its timestamps during the read, or write through a mapping without changing
them. Nothing short of a filesystem snapshot closes that, and it is why the interface says to stop the VM first. What a torn
read cannot do is go unnoticed through normal writes, and a detected change is never a warning.

**Staging is local, and outside every VM.** `storage.staging_dir`, by default under the state directory. `check-config` refuses
one inside a base path, and the build refuses one inside the VM's own directory after resolving links. Free space is checked
first where the platform can tell, against the worst case of no compression at all, which can refuse a VM that would in
fact have fit. On any failure nothing is left behind.
