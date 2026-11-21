# 0051: Screenshots are volatile media, not VM state

**Status:** Accepted. Supersedes [0020](0020-transfer-media-preservation.md) and the screenshot rule of
[0041](0041-storage-cleanup.md). Refines [0050](0050-media-order-deletion-and-tags.md).

## Context

Local screenshots exist only so that they can be captured and uploaded to EmuCat's media catalog. They were already
left out of archives, but the VM lifecycle still depended on them:

| Where                                | What screenshots did                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Transfer, before archiving           | Without media synchronization, any screenshot refused the transfer (`transfer_blocked_media`)  |
| Transfer, before removal             | Every screenshot was hashed, and the removal waited until the server acknowledged each hash    |
| Transfer, last look after the rename | A screenshot the server did not hold put the directory back and refused the removal            |
| Transfer, unsupported files          | A non-image file in an 86Box `screenshots` tree refused the removal                            |
| Local copy removal                   | A screenshot the server did not hold refused the removal (`local_copy_unsynced_media`)         |
| Archive listing (`scan_tree`)        | Links, odd names, case collisions and the number of files in the media area could fail a build |
| Restore with **replace**             | The replaced copy was deleted with its screenshots, pending or not, without a word             |

Decision 0050 made this worse: a screenshot deleted from the catalog is not acknowledged, so the file left in the VM's
directory blocked every later transfer until someone moved it by hand.

## Decision

**Screenshots are not part of a VM's persistent state.** They are never archived, never compared with a manifest, and
never decide whether a VM is synchronized, modified, transferable or removable. The media lifecycle (ingestion,
reconciliation, deduplication, suppression, deletion) is separate.

**Archives and diffs.** One listing, `scan_tree`, decides what an archive holds, what verification compares and what a
removal checks. It now sets aside the media area before any rule for archived files applies: everything inside an
86Box `screenshots` tree, its root directory if that is a link, and regular files, links and special files whose names
end in `.ppm` in a QEMU VM's root. Entries there are never followed, never archived, never counted toward the file
limit and never checked for names or case collisions. A file named `screenshots`, an 86Box `screenshots` directory
below the root, and any other file are VM content as before, with every check they had. VirtualBox VMs are archived as
OVA exports and have no media area.

**Transfers and removals no longer ask about screenshots.** The checks that protect real VM files are unchanged: the
directory's identity, the manifest's paths, types, sizes and hashes, links and special files among VM files, files in
use, a running VM. `transfer_wait_seconds` is accepted and ignored.

**Pending screenshots go to the media spool, at the last moment.** A transfer, a local copy removal and the removal of
a copy replaced by a restore all call `detach_pending` with the directory that is about to be deleted, once it is set
aside and checked, so nothing can add to it any more. Every screenshot there that the queue does not already record
as uploaded (or refused by the server) for exactly that file is copied, through the same safe walk uploads use, into
`media/spool/` in the agent's state directory, hashed while it is written, published by rename, and queued as a new
entry with its own key, under its original source path. The queue is saved before the directory is deleted. A copy
whose content the queue already records as uploaded for that VM is discarded.

Spooled entries upload whether or not the server still lists the VM for this agent and whether or not the VM is held.
A copy ends with its entry when the upload succeeds (a suppressed screenshot answers 200, and stays deleted), when the
server refuses the bytes, or when the server no longer accepts screenshots of that VM from this agent. Passing
failures are retried with the usual backoff. Copies no entry refers to, left by a crash, are removed at startup.

**Nothing is claimed that did not happen.** Spooled screenshots count as pending in the agent's media status until
they are uploaded. What cannot be kept (over the upload limit, the spool over `SPOOL_MAX_BYTES` (1 GiB), unreadable,
or an agent without media synchronization) is deleted with the directory, logged, and named in the result's message.
None of it stops the removal.

**The server still accepts them.** A local copy removal deletes the agent's `agent_vm_state` row, so uploads are also
accepted for 30 days after this agent's successful removal of that VM's copy (`REMOVED_COPY_MEDIA_GRACE_DAYS`). A
transfer keeps the row, marked `absent`, as before.

## Consequences

- A transfer or removal of a VM with screenshots, synchronized, pending, deleted from the catalog or not images at all,
  behaves exactly as for a VM without any.
- Screenshots never make a copy look modified, and verification never fails because one changed while it ran.
- Pending screenshots survive the removal of their directory and agent restarts, and are uploaded later; a screenshot
  written after the directory was set aside, or one that does not fit in the spool, is lost, and said to be.
- `transfer_blocked_media` and `local_copy_unsynced_media` are reported only by agents older than this decision. Their
  recovery text says to update the agent. A transfer an older agent left blocked can still be retried, and succeeds.
- Working copies of remote sessions are still not watched, as before: their manually created screenshots are not
  synchronized.
