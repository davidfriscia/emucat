# 0019: `sharp`, two small decoders, and files named by UUID

**Status:** Accepted. Its last sentence, on the time spent decoding, is replaced by [0025](0025-bounded-image-decoders.md).

**`sharp`.** It runs libvips off the main thread, handles limits and timeouts itself, and ships prebuilt binaries for Windows and Linux.
Its install script only verifies the platform binary, so it joins esbuild in `allowBuilds`.

**Two formats it cannot read, decoded by hand.** Prebuilt `sharp` has no PPM or BMP loader, and QEMU's `screendump` writes PPM, so that
one is not optional. A second native dependency for two very simple formats was not worth it. Each decoder is short, checks the header's
dimensions against the limits before it allocates anything, and refuses what it does not understand: compressed and exotic BMP variants
are `unsupported_image`, not a best guess. They run on the event loop, which is bounded by the upload size limit and takes milliseconds
for realistic screenshots.

**Limits come before decoding.** For PNG and JPEG, `sharp` reads the header first, so a small file claiming enormous dimensions is
refused without decoding a pixel, and `limitInputPixels` covers what the header does not.

**White, for transparency.** JPEG has none, and screenshots almost never do either. Any fixed color would be wrong for something, and
white is what most viewers assume. The original keeps its alpha channel.

**Metadata is dropped from derivatives.** Publishing a JPEG must not also publish what a tool wrote into the original. Originals are
never public, so they can stay byte for byte.

**UUID names, not content hashes.** Content-addressed files look attractive, and would save space for an image shared between VMs. But
that sharing would need coordination between a delete of one VM's item and an upload to another's, which cannot share a transaction, or
one could remove a file the other had just decided to reuse. With a new UUID for each item, no two uploads ever touch the same path. A
race between identical uploads is decided by the database's unique index, and the loser removes its own files. It costs a little space
in a rare case.

**Files first, then the row,** as [0008](0008-public-reads-and-media-lifecycle.md) requires. A row can then never refer to a missing file,
and the worst a crash can leave is an orphan that nothing can serve.

**Orphans are counted, not deleted.** A restored database makes good files look like orphans, and those could be the only copies of
private originals. Saving some disk is not worth that risk, so they are reported at startup, and removing them is a documented manual
step. Staged files are different: nothing ever referred to them, and they are removed once they are an hour old.

**Rows keep legacy tolerance.** `original_key` and `original_mime` are `NULL` only for rows that predate uploads, and a check makes one
without the other impossible. There are no such rows in a real deployment, since nothing could create media before this milestone, but a
forward-only migration must not assume that.

**`original_filename` holds the source-relative path,** such as `screenshots/session/one.png`, which is what tells an administrator where
an image came from. It is no longer than 255 bytes, and a path that is longer is refused.

**Consequences.** Conversion is the slowest part of an upload, and runs for each new image. Concurrency is capped, and `sharp` has its own
timeout. The time a request spends decoding PPM or BMP is not covered by that timeout, only by the size limit.
