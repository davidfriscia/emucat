# 0023: Publishing a restored VM is one rename that refuses to replace anything

**Status:** Accepted

**The VM is assembled at `.emucat-restoring-{operation_id}`, inside the base path.** Being on the destination's volume is what makes publishing a rename rather than a copy. A leading dot is
not a valid VM name, so discovery reports it as skipped and nothing can register it or mistake it for a VM, the same as `.emucat-removing-` in
[0015](0015-registration-state-machine.md#transfer). The name holds the operation's UUID, which is the only reason anything here ever deletes it. The base path's own
watcher cannot get in the way, as [0016](0016-screenshot-watcher.md) explains. The download itself stays in the staging directory, outside every VM.

**`MoveFileExW` without its replace flag.** It is atomic on one volume, and fails if the target exists, in any capitalization, including an empty directory.

- `std::fs::rename` was rejected. Its behavior over an existing target is not something it promises, and it has changed between Rust versions.
- Check-then-rename alone was rejected, as a race.
- Deleting anything to make room was never an option.

**On other systems** this is a check followed by `rename(2)`, which only replaces an empty directory or a file. A directory appearing in that moment would have to be empty, so
nothing can be lost. Restoring has only been exercised on Windows, the one platform that can pair today.

**The destination is listed, not probed.** That gives the same case-insensitive answer on any filesystem, and sees a link without following it. It happens first, before anything is
transferred, so an obvious conflict costs nothing, and again immediately before the rename.

**Everything is looked at again immediately before the rename.** The base path must not be a link, and must be the same directory it was at the start, by volume and file ID. What was assembled
must not be a link, and must be the same directory that was verified. A substitution in between is `restore_destination_unsafe`. Nothing here can stop a process with the same rights
from acting between the last check and the rename, and the journal's identity check below is what catches the result.

**A base path that is a junction is refused.** It could be repointed between checks, and the directory ID check would see only the junction. The ancestors above the base path are not
examined: they belong to the computer's administrator, and a junction further up is a normal thing to have.

**Transient locks are waited out, briefly.** An indexer or a virus scanner often holds a just-written file for a moment, which fails the rename with an access error. It is tried again for up
to five seconds, and then reported.

## What a crash leaves

The journal says `publishing` before the rename, with the identity of what was assembled and the result that will be reported. After a restart, the disk answers the question:

| What is there                                         | What it means, and what happens                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The final name, and it **is** the assembled directory | It was published. The result is reported                                            |
| The assembled name, with the recorded identity        | It was not. It is removed, and reported as `agent_restarted`                        |
| The final name, and it is some other directory        | Somebody else's. It is left alone, and reported as `restore_destination_exists`     |
| The assembled name, with some **other** identity      | The agent cannot tell what this is. It is left alone: `restore_ambiguous_directory` |
| Neither                                               | Nothing was published, as far as anyone can tell: `agent_restarted`                 |

NTFS keeps a file ID across a rename on one volume, which is what makes the first row a proof rather than a guess. **Nothing is ever deleted from a final name,** and nothing is deleted under
the assembled name unless it is a plain directory: a link there is left where it is.

## Consequences

- Restoring needs permission to create directories in the base path.
- A crash can leave `.emucat-restoring-*` behind only in the ambiguous case, which is reported with the path. Discovery shows it as skipped until someone looks.
- A directory moved aside by hand during a restore can fail the restore. That is the right answer.
