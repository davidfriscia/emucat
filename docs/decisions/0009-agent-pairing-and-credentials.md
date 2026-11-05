# 0009: Device-style pairing, with credentials the server cannot read

**Status:** Accepted

An agent is headless and has no inbound listener, so it cannot show a login page or be called back. It asks for a
short code instead, which a signed-in administrator enters in the web app. See the [protocol](../protocol.md#pairing).

**The code and the secret do different jobs.** The code is short so that people can type it, so it is too weak to
protect anything: it only identifies a request to an administrator who is already authenticated. The polling secret
has 256 bits and never leaves the agent, so someone who reads the code off a screen still cannot collect the
credential. Approval needs the code as well as the request's ID, so a list of requests cannot be used to approve one
without looking at the agent. This also means that a rogue request cannot be approved by mistake from the list.

**Digests only.** All three values are stored as SHA-256. Bare SHA-256 suits the secret and the credential, which
have 256 random bits, as it does for session tokens. A code has only 40 bits, so its digest is not real protection
against someone who can read the database; the code lasts minutes, grants nothing alone, and is held this way
simply so that no table can be read for a usable value.

**Expiry is a comparison, not a job.** `expired` is not a stored state. Authorization compares `expires_at` with the
database's clock, so nothing depends on a sweeper having run or on two servers' clocks agreeing.

**The credential is issued when collected, not when approved.** The agent row and credential are created in one
transaction, holding the row lock. So an approval that is never collected leaves nothing behind, and concurrent
polls cannot produce two credentials. The cost is that a lost response cannot be retried, because the server no
longer has the plaintext: the agent has to pair again. Re-issuing on a repeated poll was rejected, since it would
make "exactly one credential" untrue for a window with no benefit beyond a rare retry.

**Re-pairing is a new identity.** A revoked identity never comes back, so "revoked" is final. The name can repeat,
and the history of the old identity stays attached to the old one.

**DPAPI, scoped to the user.** `CRYPTPROTECT_LOCAL_MACHINE` would let any account on the computer decrypt the file.
The price is that moving the agent to another account needs a new pairing, which is
[documented](../agent.md#credential-storage) and which the agent reports rather than works around. Application
entropy keeps other programs' DPAPI blobs from being swapped in.

**The credential is tied to its server.** Its origin is stored with it, and the agent refuses to present it to any
other `api_url`. A change of one configuration line must not be able to send a secret to a different host.

**No plaintext fallback.** Other platforms get a store that refuses, until they have a real one. Silently writing a
credential to a file on Linux would be worse than not working.

**TLS from the operating system.** `reqwest` and `tungstenite` use `native-tls`, which is SChannel on Windows. It
needs no CMake or NASM (the README promises neither is required, and `rustls` with `aws-lc` needs them), and it
honors a private CA installed in Windows, which suits a self-hosted server. Linux builds need OpenSSL headers.

**Plain HTTP only to this computer.** A remote `http` URL stays a warning in `check-config`, as it was, but `pair`
and `run` refuse it: secrets are now at stake. There is no override. Redirects are not followed, since one could
carry a bearer secret to another host or from `https` down to `http`.

**In-process rate limits**, as in [0007](0007-local-authentication.md): wrong codes per session and per address, new
requests per address, wrong secrets per address, polls per request, and a cap on requests waiting at once.
