# 0017: The media queue is one JSON file, and a cache of what the server says

**Status:** Accepted

**A file like the other state files.** The agent already keeps registration journals as files, replaced atomically and durably. A
database engine inside the agent would add a dependency and a recovery story of its own for a list of thousands of entries at most.
The cost is rewriting the file for each batch of changes. Saves happen once per pass of the loop, not per entry, so this stays small
next to what reading and uploading the images costs.

**One entry per file.** The identity is the agent (the file is per agent, and a queue from another identity is ignored), the VM, the
source path and the hash. Keying by path keeps the file bounded by what is on the disk. The hash decides what a change means: the same
hash under a new timestamp keeps its state, so touching a file sends nothing, and a new hash replaces the entry.

**It is not proof of anything.** It only saves work. Before uploading, the agent asks the server about each hash, so a lost file costs
one read of each screenshot and no uploads, and a damaged file is set aside rather than stopping the agent. A transfer does not consult
it at all: see [0020](0020-transfer-media-preservation.md).

**Permanent means the bytes themselves were refused:** 400, 413, 415 and 422, apart from a hash mismatch. Those end as `failed`, and
are not sent again unless the file changes. Everything else waits and retries with exponential backoff and jitter, up to a ceiling and
with no limit on attempts: 401 and 403 included, because a credential problem is not the screenshot's fault, and connectivity is what
stops an agent whose credential was really revoked. A hash mismatch retries because bytes can be damaged on the way, and if the file
changed, the next scan replaces the entry.

**Interrupted uploads simply start over.** There is no resuming partway. Screenshots are small, so this is cheap, and the server's
handling of a repeated upload is idempotent.

**Consequences.** Forgetting a file that is gone from the disk means that if it reappears it is hashed again, and the server then says
it already has it. An administrator who deletes an item on the server will not see it come back from a queue that says `completed`,
unless the file changes or a transfer finds that the server no longer has it, in which case it is uploaded again.
