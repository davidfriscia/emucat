# 0010: Presence in memory, newest connection wins, discovery is not stored

**Status:** Accepted

**Presence is not a column.** An "online" flag in the database goes stale the moment a server crashes, and clearing
it needs a sweep at startup and a rule for when that is safe. Holding it in the process that owns the socket means
it cannot be wrong: a restart makes everyone offline, which is true, until they reconnect. Only the timestamps
(`last_connected_at`, `last_seen_at`) are stored.

The cost is that **the API must be a single process**. A second instance would report agents connected to the first
as offline, and could not reach them. Rate limits already have this property. Real multi-instance support would need
shared presence and message routing, and nothing needs it yet.

**The newest connection wins.** The realistic cause of two connections is a half-open socket: the agent's network
dropped, it reconnected, and the server has not noticed the old one. The new connection is the live one, so refusing
it would lock the agent out until the old one times out. Replacing happens at hello rather than at the handshake, so
that a connection which never says hello cannot disturb anything.

The other cause is two running copies, and there "newest wins" would make them replace each other forever. So an
agent that is superseded **stops**, and says why. This never affects the half-open case, since a dead socket
receives nothing.

**Revocation is enforced twice.** The admin route removes the digest and closes the sockets, which is immediate.
`UPDATE … WHERE revoked_at IS NULL` on hello and heartbeat also notices one made elsewhere, within one heartbeat, and
closes the race between checking a credential and saying hello.

**A database hiccup does not cut off agents.** A heartbeat that cannot be recorded is still acknowledged. A failure at
hello closes the connection with 1011, and the agent backs off and retries: it cannot be marked as connected, and a
credential check that fails with 5xx is not a rejection. Only 401 stops an agent.

**A version 1 addition, not version 2.** Discovery adds message types that older peers ignore. By the rule in the
[protocol](../protocol.md#versioning) that is not breaking, and no agent had ever connected anyway. `agent.hello`
kept its fields, and `server.welcome` is unchanged.

**One report, one message.** Splitting a report into chunks would add sequencing, reassembly and partial failure, for
a collection that is a handful of directories on a real machine. 256 VMs and 64 skipped entries fit in 64 KiB even
at their longest, a test proves it, and a report over a limit says `truncated`. If a real collection ever exceeds
this, chunks can be added, with an increased limit before them.

**Discovery state is ephemeral.** Results are a snapshot of someone else's disk, stale as soon as they arrive, so
storing them would invite treating them as true. Only the latest operation per agent is kept, in memory. Whether a VM
is registered is worked out when read, rather than stored with the result, so it cannot be out of date. Milestone 3
may need more, and can add it for a concrete reason.

**The directory's root is listed rather than probed.** Probing for `86box.cfg` on Windows would also find
`86BOX.CFG`, giving a different answer than Linux. The domain rule in `isValidVmRoot` is exact matching, so the scan has to read the real spelling. This does mean listing each candidate's
root, which is bounded, and only a marker's own metadata is read.

**Any reparse point is refused,** not only what Rust calls a symlink. Junctions are covered by that, but OneDrive
placeholders and deduplicated files are reparse points too, and can lead somewhere other than where they appear to
be. Being strict means that such a VM is skipped with a clear reason, which is the safer way to be wrong.

**Marker rules are unchanged.** Real QEMU directories using `run.bat` do not qualify. That is the documented domain
rule, so they are reported as `missing_marker` rather than the rule being stretched to fit.
