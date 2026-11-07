# 0026: Refusals about authorization wait for a change, not a timer

**Status:** Accepted. Supersedes the paragraph on what is permanent in [0017](0017-durable-media-queue.md), which treated 401 and 403 as passing failures with no limit on attempts. Everything else there stands.

**The problem.** 0017 retried everything that was not about the bytes, forever, on the reasoning that connectivity would stop an agent whose credential was really revoked. That holds for a revoked agent. It does not for an agent the
server knows, asking about a VM it has no claim on, which would repeat a request every fifteen minutes per screenshot, indefinitely, to no effect. And each attempt reads the file again first.

**Three kinds of failure, by what would have to change.**

| Answer                                             | Kind      | What happens                                                                           |
| -------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| 400, 413, 415, 422                                 | Permanent | `failed`. These bytes were refused. Only a change to the file makes a new attempt      |
| 401                                                | Blocked   | `blocked`, and **nothing** is sent until a connection proves that the credential works |
| 403, or 404 with `vm_not_registered`               | Blocked   | `blocked`, until the server lists this VM for this agent                               |
| 408, 429, 5xx, a 404 with no API code, the network | Transient | `retry_wait`, with backoff                                                             |

**A 404 with no API error code is not an answer.** A reverse proxy having a bad day says 404 too, and treating that as "this VM does not exist" would stop uploads over something passing. The API's own 404s have a code.

**What unblocks them is the real change, and it costs one attempt.** Each new connection, because that is what proves a credential, and each reconciliation that lists the VM, because the server has just said this agent holds it. So if the
server's two answers contradict each other, a blocked entry is tried once per reconciliation, which is rare and bounded. There is no retry button, because an administrator's action that fixes the cause, such as re-pairing or registering the VM,
already produces one of these changes.

**A revoked agent stops anyway,** on its connection, with the existing final end. That is still the only thing that stops an agent as a whole. A 401 on an upload alone stops uploads, and leaves the rest to the connection's own verdict.

**Nothing is discarded.** A blocked entry stays in the queue, and the file stays on the disk. The status message counts it among the failures with its error, so an administrator can see it, and a transfer treats it as a reason not to remove the
VM. It is a queue state, not a verdict on the file.

**Consequences.** An older agent reading a queue with the new state sets the file aside, which [0017](0017-durable-media-queue.md) already handles by hashing everything once and asking the server. A VM unregistered and registered again waits for
the next reconciliation or connection, up to `reconcile_interval_seconds`.
