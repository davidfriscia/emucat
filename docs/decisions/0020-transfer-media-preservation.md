# 0020: A transfer deletes a screenshot only if the server holds exactly that content

**Status:** Accepted. Supersedes step 4 of the transfer checks in [0015](0015-registration-state-machine.md#transfer), and the refusal up
front that went with it. Everything else in 0015 stands.

Screenshots are excluded from archives, so a transfer's master does not protect them. Milestone 3 refused any transfer of a VM that had
some. Now that they can be uploaded, a transfer is allowed if, and only if, every excluded file is **proved** to be on the server. If
proof is not possible, the VM stays.

**The order had to change.** The refusal could come up front because it needed nothing from the server. Proof cannot: an unregistered VM
cannot upload, and a VM is registered by the commit. So the check comes after the commit, and failing it leaves a master and a local VM,
which is a partial success. A server without a commit cannot tell an agent to delete anything, so the safety of that order is unchanged.
An agent built without media synchronization still refuses up front.

**Only the server's answer counts.** The local queue can say `completed` about something an administrator has since deleted, or after
being restored from a backup. So the agent hashes what is on the disk right now, and asks about those exact hashes. Comparing content
rather than names means a file deleted and recreated with the same bytes is fine, and one with the same name and different bytes is not.

**The last look is after the rename.** A check followed by a rename leaves a gap in which a new screenshot could appear. Once the directory
is renamed nothing can reach it by its old name, and on Windows the rename itself fails if a file is open. So the excluded files are hashed
again under the new name, against the acknowledged set. If anything is new or different, the directory is moved back and the operation is
blocked. A removal resumed after a crash goes through the same look.

**Anything that cannot be uploaded blocks.** A text file in the `screenshots` tree is excluded from the archive and is not a media file, so
no upload can ever preserve it. Silently deleting it would break the promise, and archiving it would change what an archive holds. It
blocks, and the message names it.

**A bounded wait.** A transfer usually finishes faster than its screenshots upload, so it waits up to `transfer_wait_seconds`, in case they
are about to arrive. A rejected image ends the wait at once, since that will not get better.

**The retry is explicit, and rechecks everything.** The agent keeps the journal and manifest of a blocked transfer, in a phase of its own.
The server moves the operation back to `cleaning_local` when an administrator asks, and the normal path runs again. Doing this
automatically once screenshots arrived was rejected: the administrator agreed to delete a VM at one moment, and hours later it may be in
use. Asking again makes that a new decision, and the manifest check still refuses a VM that changed. If the request is lost, the agent's
next sync prompts the server to send it again.

**Only for this refusal.** Other partial successes stay final, as they were. The guidance for those is to look at the directory by hand,
because something about it is not what was archived.

**The watcher stays out of the way.** Its read handles could make the rename fail, so a VM is held while its directory is being moved.
Rarely, an in-flight read still causes `cleanup_in_use`, and the VM is simply kept.

**Consequences.** A transfer of a VM with screenshots always creates a master first, even if it then cannot remove the VM. Screenshots that
were uploaded stay on the server whatever happens next, including when the removal is never retried. The wait makes a transfer of a VM
with many screenshots slower, and with `transfer_wait_seconds` too low it ends as a retryable partial success rather than a failure.
