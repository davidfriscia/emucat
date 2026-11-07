# 0032: Verifying a local copy hashes every file on the agent

**Status:** Accepted. Milestone 6. Strengthens the names-and-sizes check of [0021](0021-restore-lifecycle.md#local-state).

## Context

Until now, "verified" meant that a copy was verified when it was restored or registered, and that names
and sizes had not changed since. A same-size change went unnoticed.

## Decision

- **The agent hashes every file with SHA-256** and compares the result with the master's manifest. The
  server never reads a VM, and nothing is uploaded.
- **The manifest is authenticated by its SHA-256,** recorded at registration. The agent reads it from the
  local copy if it matches, otherwise from the archive in its cache, otherwise from the repository, and it
  checks the archive's SHA-256 too. A Copy registration now leaves the manifest next to the local copy.
- **Five results:** `verified`, `modified`, `missing`, `unavailable` (could not be checked now) and
  `verification_failed` (could not be compared reliably). Only the first three change what the catalog
  says about the copy; a failure changes nothing.
- **Screenshots are excluded,** as from archives. **Links are never followed:** a link, junction or other
  reparse point inside the VM fails the check, since following it could read outside the VM.
- **Read-only.** Verification opens files for reading and writes nothing into the VM.
- **One disk operation per agent.** Verification shares the agent's single operation slot with
  registration and restore, and is refused while the VM runs, since a running emulator changes its files.
- Counts are complete; at most 20 paths of each kind are reported, to keep messages bounded.

## Consequences

- Verifying a large VM reads all of it. Progress is not reported beyond the final counts and duration.
- A copy that has been run reports `modified`, which is accurate: running a VM writes to it.
