# 0024: A small cache of verified ZIPs, with the file system as its index

**Status:** Accepted

**Why have one.** A master is immutable, so a copy of its archive stays good for as long as its bytes do. Restoring a VM twice should not transfer tens of gigabytes twice.

**The name is the identity:** `{version_id}-{archive_sha256}.zip`. Never a VM's name, which says nothing about contents. Both parts are there because a version names what should be
in the file, and the hash is what an operation is bound to.

**No index.** The agent already avoids a database, and an index is one more thing that can disagree with what is on the disk, or be half-written. Listing a directory is cheap at this size, and a
file's modification time is when it was last used, which is what least-recently-used eviction needs. Using an entry touches it.

**It is not proof of anything.** A restore hashes whatever it reads from the cache, through a handle that denies writers, and that handle is what it extracts from. So a damaged, truncated or
swapped entry costs a download, and is deleted. Its size is not trusted, and neither is its name. This reads the whole file on every hit, which on a large archive takes a while, and
that is still far less than downloading it, and is the point.

**Incomplete files cannot be mistaken for entries.** A copy from another volume is written to a name ending in `.part`, synchronized, and only then renamed, without replacing anything. Anything ending in `.part`
is removed on the next start. In the common case the staging directory shares a volume with the cache, and the download is moved in whole, after its hash has been checked.

**Eviction is conservative.** Oldest first, only when something new needs the room, and only if that frees enough: there is no point in losing entries for an archive that will not fit
anyway. An entry in use is pinned in memory and also held open with no delete sharing, so it cannot go away underneath a restore. Only names that look exactly like entries are ever touched.

**A cache failure never fails a restore.** If an archive will not fit, or the cache cannot be written, it stays in staging, is used from there, and is removed afterwards. A size of zero turns the
cache off altogether.

**Concurrent downloads of one archive do not arise,** because an agent runs one operation at a time. There is no coordination between agents, and none is planned.

**Separate from everything else.** `storage.cache_dir`, by default `archive-cache` in the state directory, and refused inside a base path by both `check-config` and the restore itself. Credentials, journals
and the screenshot queue live beside it in that default location, but not in it, and nothing else reads this directory.

**Reported, not managed.** `emucat-agent cache-status` prints the directory, the limit, and what it holds. Each restore's result says whether it was a hit and how many bytes were transferred, and each connection reports usage. Beyond
that there is no dashboard, since nothing here needs a decision from anyone. To empty it, stop the agent and delete the directory.

## Consequences

- Up to `cache_max_bytes` of disk, 20 GiB by default, holds copies of what is also in the repository.
- A hit still reads the whole archive, so it is not instant.
- An entry that outlives its VM's registration stays until it is evicted. It holds nothing the repository did not.
