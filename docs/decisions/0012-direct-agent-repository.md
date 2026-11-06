# 0012: Archives travel directly between agent and repository

**Status:** Accepted

**The API is the control plane, and never touches archive bytes.** It authorizes, tracks and records. A proxying API
would have to buffer or stream tens of gigabytes through a process that also serves the web app, and would be the
wrong place for a credential that can write to the archive store. There is simply no route that accepts or returns an
archive, and an end-to-end test measures the bytes the API received during a registration.

```
Browser ─► API ─► MariaDB         commands, authorization, metadata
            ▲
            │ WebSocket           operation, progress, verified metadata
            ▼
          Agent ─────────────► SSH repository     archive bytes, directly
            │
            └─► API ─► media storage              screenshots
```

**So the claim about integrity is the agent's.** The server records what the agent reports having verified. It has
not read the archive, and the interface says "verified by the agent" rather than implying otherwise. A compromised
agent can lie about its own VM, and that is inherent in having the agent do the work. It cannot lie about anyone
else's, or create a master that nobody asked for.

**A report authorizes nothing.** A master can only come from an operation an administrator created, for this agent,
with the version UUID and archive key the server issued. A report that does not match is refused.

**Repositories are identified by UUID, and configured twice on purpose.** The server's row says which repository
exists and which agents may use it. The agent's own file says how to reach it. A command names a UUID and nothing else,
so neither a browser nor a compromised server can point an agent's key at another host. If the two disagree about the
address, the health check reports it. The cost is that an address change has to be made in both places.

**Provider-independent above the transport.** `ArchiveRepository` is a trait that speaks in validated repository-relative
keys. The registration workflow uses it as a trait object, and knows nothing about SSH. A future `HttpsArchiveRepository`
would implement the same trait, with its own way of guaranteeing no-overwrite publication, and without changing VM
identity, version identity, the manifest or the state machine. No placeholder exists for it, since a provider that
pretends to work is worse than none. The TypeScript `ArchiveRepository` interface was removed: the API has no business
implementing one.

**Publication is separate from upload.** Bytes go to `archives/.staging/{operation_id}.part`, are read back and
hashed, and only then become visible at `archives/{emulator}/{vm}/{version_id}.zip`. `upload` refuses any key outside
staging, so a final key can only ever be written by `publish`.

**Screenshots stay on their own path:** agent to API, over authenticated HTTPS, to server media storage. They are not in
archives, and never go through this interface. See [0018](0018-agent-media-upload.md) and
[0020](0020-transfer-media-preservation.md).
