# 0021: Restoring as a durable operation, with nothing to undo

**Status:** Accepted

The rule that shapes this: **a failed restore must never damage or overwrite an existing VM**, and a VM must not appear
half-finished. Everything before the last step happens where nothing else looks, and the last step is one rename that refuses to
replace anything. So there is no rollback to get wrong: a restore that stops anywhere has only temporary files to tidy up.

## States

```
queued → validating → downloading ⇄ verifying → extracting → publishing_local → committing → succeeded
   └──────────────────────┬──────────────────────────┘                                  └──→ partial_success
                          └→ failed, cancelled
```

| State              | Who moves it there | Meaning                                                                     |
| ------------------ | ------------------ | --------------------------------------------------------------------------- |
| `queued`           | API                | Created and authorized. Goes out as soon as the agent can be told           |
| `validating`…      | Agent's progress   | Only forward, apart from `verifying` back to `downloading` after a bad copy |
| `publishing_local` | Agent's progress   | The rename is about to happen. **Cancelling is no longer possible**         |
| `committing`       | API                | The agent reported a verified, published VM. Recording it is what is left   |
| `succeeded`        | API                | The local copy exists, is verified, and is in `agent_vm_state`              |
| `partial_success`  | API                | The local copy exists, but something got ahead of the report: see below     |
| `failed`           | Agent or API       | Nothing was published                                                       |
| `cancelled`        | Agent or API       | Nothing was published                                                       |

**A separate table, not a mode on registrations.** The states, the reported columns and what a success means are all different, and a
registration's commit creates a VM where a restore's creates a local copy. They share the shape: a row, a journal, reports that
repeat until answered, and the same `AgentLink` idea. A generic job framework remains unjustified, as
[0015](0015-registration-state-machine.md) said it would until a second kind of operation showed what it needed. Having now seen
one, what they share is a few lines each, and what differs is everything that matters.

**One operation per agent, of either kind.** The `active_marker` index guarantees that for restores, and registration's own guarantees it
for registrations. Across the two tables, creating a restore takes the agent's row exclusively, and creating a registration takes it
shared, so they cannot start together. The agent also refuses a second operation of any kind, since one disk is enough work at a time.
Different agents can restore the same VM at once: they have nothing to do with each other.

**The operation is bound to immutable facts.** The archive key, size and SHA-256 are copied from `vm_versions` when the operation is
created, and what the registration verified about the manifest comes with them. A browser names a VM, a version and an agent, and
nothing else: it has no way to say where anything goes, and neither does the server. The agent derives the destination from its own
base path, recomputes the key, and refuses a repeated request with other identities.

## Knowing what an agent can do

`agent.restore_sync`, after each welcome, says which emulators have a base path, which repositories have local settings, and how the
cache is doing. That keeps protocol version 1 valid for older agents, as with registration: a connection that never sends it cannot
restore. Eligibility comes from this and the database, and is refused with a reason rather than left to fail on the agent. The base
paths shown to administrators are only what the agent said: the agent decides again when it acts.

## The agent's journal

`restores/{operation_id}.journal`, replaced atomically and durably before each step that cannot be taken back.

| Phase        | After a restart                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `running`    | Reports `agent_restarted`, and removes what it left. Nothing was published, and it is safe to retry |
| `publishing` | Asks the disk, as [0023](0023-atomic-local-publication.md) describes                                |
| `published`  | Repeats the result, and waits for an answer                                                         |
| `reported`   | Repeats the report, and waits for an answer                                                         |

**An interrupted download is not resumed.** It fails, with `agent_restarted`, and trying again starts over. A partial download cannot be
trusted without rehashing it anyway, and `ArchiveRepository::download` has no notion of an offset. An interruption while
connected is retried within the operation, like an upload. Nothing here is lost but the bytes transferred, and a verified
archive that made it to the cache is never transferred again.

**Reports repeat until answered,** on each heartbeat and after each welcome. The server's handlers are idempotent, and it answers nothing if
it could not record something. That covers a lost message, a lost acknowledgement, a failed commit, an API restart and an agent restart.

## Answers can never delete anything

**The agent keeps a published directory whatever anyone says.** A server that does not recognize an operation answers `rejected`, which means
"forget it", because the alternative is an agent deleting a verified VM on the word of a restored database. There is no message that asks an
agent to delete a restored VM.

**A verified local copy exists at this point, whatever has been decided.** So a result that arrives after a cancellation, or after the server
gave up on the operation, is still recorded, and the operation becomes a `partial_success` with `restore_cancel_too_late`. Saying
"cancelled" would be a lie about the disk, and the next restore would then find a directory nobody knows about.

**Revocation** ends what a revoked agent was doing as `failed`. It says nothing about what is on that agent's disk, and cannot.

## The server's claim is the agent's

As with registration ([0012](0012-direct-agent-repository.md)), the server records what the agent reports having verified, and the interface
says so. A compromised agent can lie about its own disk, and that is inherent. It cannot make the server record a copy of a version it
was not asked to restore: a result with other identities is refused, and records nothing.

## Local state

The existing `agent_vm_state` row is what a restore updates. A restored copy is `idle` and `verified`, with the version as its source
and the manifest's hash, which is exactly what a copy registered from that directory would say.

**Verified means at that moment.** A VM can change while nothing is watching, so `verified` lasts until the next connection, as `isLocalContentTrusted`
has always said. After each welcome the agent reports each copy it knows of as `unverified`, `modified` or `absent`.

- **A difference proves a change, and no difference proves nothing.** The agent keeps the manifest of what it restored, and compares names and sizes
  without opening a file. So it can say `modified`, and otherwise only `unverified`. There is deliberately no way for a report to say that a copy is
  unchanged. Hashing a VM's disks on every connection is not worth what it would cost, and an explicit check can come later.
- **`modified` stays,** until something verifies the copy again. A later `unverified` does not take it back, because same-looking sizes do not
  undo a difference that was seen.
- **Discovery also says what is there.** A completed scan marks a copy that has gone as `absent`, which makes restoring possible again, and one that
  came back as `unknown` and `unverified`. Emulators whose scan did not finish say nothing, so nothing is concluded from them.

Discovery already marked a VM as registered when its row exists, which needed no change: **a restored VM is not offered for registration.**

## Not done automatically

A restore never starts a VM, never runs a script in it, and never uploads anything back. A VM that has changed stays changed until a later
milestone gives that a meaning.

## Consequences

- An interrupted restore of a large VM starts over, unless the archive reached the cache.
- A restored VM that nobody wanted, after a late cancellation, is left for an administrator to remove.
- `modified` is only as good as names and sizes. A change that keeps every size goes unnoticed until something hashes the files.
