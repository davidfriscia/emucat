# 0015: Registration as a durable state machine, on both sides

**Status:** Accepted

A registration can take hours, and either side can restart at any point. The rule that shapes everything: **a failed or
interrupted registration must never cost anyone a VM**, so the only thing that can delete a source is a positive,
matching confirmation that a verified master exists.

## States

```
queued → validating → archiving ⇄ uploading ⇄ verifying → committing → cleaning_local → succeeded
   └──────────────────────┬─────────────────────┘             │              └───────→ partial_success
                          └→ failed, cancelled ←──────────────┘
```

| State             | Who moves it there | Meaning                                                             |
| ----------------- | ------------------ | ------------------------------------------------------------------- |
| `queued`          | API                | Created and authorized. Goes out as soon as the agent can be told   |
| `validating`…     | Agent's progress   | Only forward, apart from `uploading` ⇄ `verifying` for retries      |
| `committing`      | API                | The agent reported a verified, published archive. Metadata is saved |
| `cleaning_local`  | API, atomically    | **The master exists.** Nothing below this can be undone             |
| `succeeded`       | Agent's report     | Copy kept, or transfer removed                                      |
| `partial_success` | Agent's report     | The master exists. The local copy could not be safely removed       |
| `failed`          | Agent or API       | No master. The local VM is unchanged                                |
| `cancelled`       | API                | No master. The local VM is unchanged                                |

Publication is not a server state, because it is the agent's own step. Its journal knows, and tells the server by
reporting a result.

**The database enforces what matters.** A generated `active_marker` with two unique indexes means one active operation
per VM, across agents, and one per agent, whatever the application does. A `CHECK` means that a committed state cannot exist
without an archive hash and commit time. `vm_versions` already allows one master per VM, and its rows never change.

**The identities are issued up front.** The version UUID and archive key are created with the operation. A retry or a repeated
report can never produce a second identity. Trying again after a failure is a **new operation** with a new version UUID,
which is always safe because the failed one owns no master.

**The commit is one transaction:** the VM, its master, the agent's state and the operation's new state, holding the
operation's row lock. It re-checks that nothing was cancelled, that the agent is not revoked, and that it may still use this
repository. A failed commit rolls back whole, and leaves the operation in `committing` with what was verified.

## The agent's journal

`registrations/{operation_id}.journal` in the state directory, replaced atomically and durably before each step that
cannot be taken back.

| Phase        | After a restart                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `running`    | Reports `agent_restarted`, cleans up staging. The source was only ever read                    |
| `publishing` | Asks the repository: the final object, with the right bytes, means it was published            |
| `published`  | Repeats the result, and waits. **A restart by itself deletes nothing**                         |
| `cleaning`   | Repeats the result. Only a fresh acknowledgement restarts the removal, which is safe to repeat |
| `reported`   | Repeats the report until the server closes the operation                                       |

A journal holds no secret and no VM contents. A damaged one is kept and ignored, and the server treats that operation as lost.

## Reports repeat until answered

The agent sends every unanswered report again on each heartbeat, and after each welcome. The server's handlers are
idempotent, and it answers nothing if it could not record something. That one rule covers a lost message, a lost
acknowledgement, a failed commit, an API restart and an agent restart, with no retry logic anywhere else.

- **Verified and published, but the commit failed:** the archive stays, the operation stays in `committing`, and the next
  repeat commits it. An administrator can also retry from the stored metadata, even with the agent away.
- **Committed, but the acknowledgement was lost:** the repeat finds the commit and gets the same answer. No second master, and
  no deletion until the answer arrives.

**After each welcome the agent lists its journals,** and the server compares them with its own view. A queued operation goes
out. An operation the agent has never heard of is failed as `agent_lost_operation`, or becomes a partial success if its
master exists. Work that ended here while the agent was away is stopped. This message also marks an agent as able to
register, which keeps protocol version 1 valid for older agents: the addition is one they ignore.

## Cancellation

Allowed until the master exists. It holds the same row lock as the commit, so it either stops the commit, or finds that it
is too late. If the agent is connected it is asked, and the operation ends when it reports back. If it is offline, or
only a commit remains, it takes effect at once. **A cancellation beats a result that arrives later:** the answer is
`rejected` with `deletePublished`, and the agent removes the archive it just published, which nothing refers to.

The agent deletes a published archive only when the server says that nothing refers to it. An answer about an operation the
server does not know never carries that, so a restored database cannot make an agent delete a good archive.

## Transfer

Everything a copy does, and then, on the agent, in this order:

1. The server's acknowledgement must name this operation and version, say `removeLocal`, and the agent's own journal must
   say `transfer`. A server cannot turn a copy into a deletion.
2. The final archive is read back and hashed once more. If the repository cannot be reached, the files stay.
3. The directory must be the exact immediate child of the base path, spelled the same, not a link, with the marker, and with
   the same volume and file ID that was recorded before archiving. A replaced directory with the same contents is refused.
4. Nothing may be excluded from the archive, which today means screenshots. **Since screenshots are not uploaded yet, a
   transfer is refused up front if any exist,** and again here for any taken in the meantime. They are never deleted.
   _Superseded by [0020](0020-transfer-media-preservation.md): they are allowed once the server holds every one of them._
5. The tree must match the manifest exactly, with no extra files, and every file is hashed again. This takes about as long as
   reading the VM, and is the point: no file can be lost to something that happened after archiving.
6. The directory is renamed to `.emucat-removing-{operation_id}` in the same base path. On Windows that fails if a file is
   open, and after it no emulator can find the VM. A leading dot is not a valid VM name, so discovery reports it as skipped.
7. It is deleted. A crash after the rename continues from here, with the same identity check.

**If any of this fails,** the master stays, the files stay, and the operation is a `partial_success` with guidance. Rolling back a
verified master because a local cleanup failed would remove the one thing known to be good.

Being "not running" can only be judged indirectly. There is no launch tracking until a later milestone, so this relies on the
share modes and rename above. On Windows that is strong evidence. On other systems, where the transfer path has not been
exercised, the content checks are what remains.

## Not a job scheduler

One operation per agent, one kind of operation, and nothing retried on a timer beyond repeating reports. Anything more
general waits until a second kind of long operation shows what it needs.
