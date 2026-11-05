# 0013: SSH/SFTP provider and its security model

**Status:** Accepted

**`russh` and `russh-sftp`.** Pure Rust and Tokio-native, so a transfer is an ordinary task beside the WebSocket, with
cancellation and backpressure from the same runtime. `russh` is built with its `ring` backend, not the default `aws-lc-rs`,
which needs CMake and NASM: the README promises neither is required, as [0009](0009-agent-pairing-and-credentials.md)
already decided for TLS. `ssh2` was rejected for binding to C `libssh2` and OpenSSL. The raw SFTP session is used, because
it exposes `hardlink@openssh.com`, `fsync@openssh.com` and `statvfs@openssh.com`, and allows a bounded window of
requests in flight.

**Host keys are always verified, with no way to turn that off.** A repository's configuration must name trusted
fingerprints (`SHA256:…`, as `ssh-keygen -lf` prints them), a `known_hosts` file, or both, or the configuration does not
load. A key that is unknown or has changed ends the connection before anything is authenticated or sent. The agent never
adds a key by itself, because trust-on-first-use is exactly the window in which an impostor would be believed. Host
certificates are refused, since nothing configures a trusted CA.

**Private keys stay on the agent's computer.** The configuration names a file, and the API never sees it. The server
stores no secret at all for a repository, and the old `secret_ref` column stays unused. A passphrase, if the key has one,
goes in a DPAPI-protected file with its own entropy, through `emucat-agent repository-passphrase`, which reads it from
standard input so that it is never in an argument, a file or a log. A key inside a VM base path is refused by
`check-config`, since it could otherwise end up in an archive. The pairing credential is a different secret for a
different server, and is never used for SSH.

**Only SFTP is used.** No shell, no `exec`, no port forwarding, so a dedicated `internal-sftp` account in a chroot is
enough, and is what [the guide](../repositories.md) recommends and the tests run against.

**Immutable publication uses `hardlink@openssh.com`.** `link(2)` fails atomically if the target exists, which is the
guarantee needed: two racers cannot both win, and nothing can be overwritten.

- Plain `SSH_FXP_RENAME` was rejected. The draft says it should fail if the target exists, but servers differ, and
  `posix-rename@openssh.com` replaces on purpose.
- Creating the final name with `O_EXCL` and then writing was rejected, because an incomplete object would be visible at
  a final key.
- Check-then-rename was rejected as a race.

Tested, not assumed: the health check makes a hard link, and then checks that a second link over it fails. A concurrent
test races eight publications to one key against a real OpenSSH server. **A server without working hard links fails closed:**
the health check says so, and registrations fail before anything is published. A filesystem that lacks them, such as FAT
or some network mounts, cannot host a repository for now. The future HTTPS provider will have its own mechanism.

**If a publication's answer is lost,** trying again gets `AlreadyExists`. The existing object is then read back. If its
bytes match, then it is this operation's, since its key holds this operation's version UUID. Otherwise the operation fails.

**Remote verification reads the bytes back.** After upload, the agent reopens the object over SFTP and hashes the stream.
Size alone is not trusted, and a test changes one byte in place to prove it. No shell access is assumed, so `sha256sum` on the
server is not an option. This doubles the data transferred, which is the accepted price of knowing.

**Timeouts and retries.** A connection attempt is bounded, and a network failure is retried with backoff. Each SFTP
request has its own timeout, so a transfer that stops progressing ends, however large it is. An upload is retried from the
start, replacing the staging object, because a partial object cannot be trusted to resume. Authentication failures, host key
problems, full disks and refused permissions are not retried, since they cannot fix themselves. OpenSSH reports a full disk
as a generic failure, so a failed write is reported as probably that. `statvfs@openssh.com`, where available, catches it
before uploading.

**Memory is bounded.** 16 requests of 64 KiB are in flight at once, whatever the archive's size.
