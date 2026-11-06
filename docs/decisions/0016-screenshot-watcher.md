# 0016: One watch per base path, and notifications are only hints

**Status:** Accepted

**Notifications decide nothing.** They can be missed: `ReadDirectoryChangesW` drops events when its buffer fills, a network drive may
send none, and nothing is watching while the agent is stopped. So a notification only marks a VM as worth scanning, and the scan makes
every decision. A periodic reconciliation and each new connection repeat everything, which makes a missed event a delay, not a loss.

**A recursive watch on the base path, not one on each VM.** This looks wasteful, because the agent hears about a running VM's disk
writes and throws them away. The alternative has a worse problem: on Windows, a handle inside a directory stops that directory from
being renamed, and renaming it is how a transfer proves that nothing is in use ([0015](0015-registration-state-machine.md#transfer)). A
handle on the base path does not. Dropping VM watches for the length of a transfer was the other option, and would have needed the
watcher and the transfer to agree on timing. The callback decides from the path alone, touches no disk, and uses a bounded channel. If
that fills, the agent looks everywhere next time instead.

**Stable means unchanged for a while, then read in full.** Size and modification time must hold for a configurable period, and again
across the hash. On Windows the read also denies writers, which fails at once on a file still being written. A screenshot tool that
pauses for longer than the window produces an image the server may reject, and the next change makes it new content, so this cannot
wedge.

**The server says which VMs count.** The list comes from the server and is asked for again on each reconciliation. A local directory,
even one discovered and carrying a marker, means nothing, so an unregistered VM cannot leak a screenshot.

**Scans are bounded** by files and depth, with truncation recorded. A truncated scan does not forget any tracked files, since it cannot
know that they are gone. Filesystem work runs on the blocking pool, so that heartbeats continue.

**No polling.** Every wait is on an event or a computed deadline, and an idle agent does nothing between reconciliations. A deadline
exists only for something that could actually happen then, because anything else wakes the loop for nothing, repeatedly.

**Consequences.** Latency is the debounce plus the stability window, a few seconds. A base path that appears after startup is only
watched from the next reconciliation.
