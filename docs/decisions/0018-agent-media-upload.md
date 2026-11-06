# 0018: Screenshots are a PUT addressed by hash, and the WebSocket only reports

**Status:** Accepted

**HTTP for bytes.** The WebSocket's messages are limited to 64 KiB on purpose, and carrying images in it would need chunks, sequencing
and flow control beside heartbeats. HTTP has all of that already. It also fails independently: an upload that dies does not take the
control connection with it.

**`PUT /agent/media/vms/{emulator}/{vm}/screenshots/{sha256}`.** The hash is the resource's name, so a repeat is by definition the same
request, which is what makes retries safe without any coordination. The route says `screenshots`, partly because that is what it holds,
and partly because a test proves that no route name suggests transferring archives, and that test should keep meaning that.

**The agent's bearer credential, in a header.** A browser session is not accepted, a credential never appears in a URL, and redirects
are not followed. The agent's identity comes only from the credential. All of this happens in `onRequest`, before a byte of the body is
read, and `Content-Length` is checked before reading too.

**The association already existed.** A row in `agent_vm_state` exists only for an agent that registered a VM or holds a copy of it, so
no migration was needed. An unregistered VM answers 404, and one held by another agent answers 403. A row is checked again inside the
final transaction, since a revocation can arrive while bytes are on their way.

**Everything from the agent is a claim.** The server computes the hash, and compares it with the declared one. It works out the format
from the bytes. The source path is a label, stored and shown but never used as a path, and has to look like one of the watched locations
for that emulator. The modification time is for display.

**Two small additions, in protocol version 1.** `agent.media_sync_status` reports counts for the web interface, and
`server.registration_retry_cleanup` asks for a blocked removal to be retried. As with discovery in
[0010](0010-agent-connections-and-discovery.md), peers ignore or refuse types they do not know without ending the connection. No message
asks an agent to sync: a registration's own acknowledgement already tells it the moment a VM is registered, and reconnection covers the
rest.

**Status is ephemeral too,** like presence and discovery: in memory on the server, stale when the agent is offline, and sent again after
each welcome. A message is bounded by size as well as by count, since a long Unicode path counts for more bytes than characters.

**A busy server says so.** There is a cap on uploads running at once, and past it the answer is 503 with `Retry-After`. No request ever
waits in a queue holding a connection, since the agent's backoff is already the queue.

**Same transport rules as everything else.** Remote agents need HTTPS, plain HTTP is for this computer only, and the agent checks this
at startup, with no setting to widen it. See [0009](0009-agent-pairing-and-credentials.md).

**Consequences.** Every upload costs one extra round trip, to ask about the hash first. That is what makes a restart with an empty queue
cheap. Each upload also uses its own connection, since refusals close it rather than leaving a client sending bytes nobody will read.
