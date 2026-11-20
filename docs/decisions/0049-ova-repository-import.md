# 0049: An existing OVA is imported into the repository from the agent's command line

**Status:** Accepted. M6.1. Extends [0012](0012-direct-agent-repository.md),
[0015](0015-registration-state-machine.md) and [0045](0045-virtualbox-masters-and-local-execution.md). Extends who
may create a catalog VM in one narrow case: an agent may now create a new VirtualBox VM, never change an existing one.

## Context

An administrator often already has a VirtualBox export (an `.ova`) and no machine to export it from: an old
backup, a download, a machine deleted long ago. Until now the only way to make a VirtualBox master was a registration
of a machine VirtualBox had ([0045](0045-virtualbox-masters-and-local-execution.md)), so the OVA had to be imported
into VirtualBox first, exported again, and the copy removed. That changes the bytes, takes hours for a large disk,
and touches a real VirtualBox collection for no reason.

An OVA can be tens of gigabytes. It must not go through the API server ([0012](0012-direct-agent-repository.md)), a
browser upload form would be the wrong place for it, and the computer that holds it is normally one where an agent
is already configured with the repository's key.

## Decision

### A command, on the agent

`emucat-agent import-ova --file <path> --name <vm-name> [--description <text>] [--dry-run] [--json]` runs on the
computer that holds the file. It uses that agent's configuration, its paired credential and its repository settings,
and nothing else. It needs no running `emucat-agent run`, and does not disturb one. There is no upload form.

### The OVA is untrusted, and read as it is

The file is checked by streaming (`agent/src/ova.rs`), never extracted, executed or handed to VirtualBox:

- It must be a regular file ending in `.ova`, and a TAR archive whose every header checksum is right. A truncated,
  damaged or non-TAR file is refused. Headers are read and data is seeked over, so the check reads kilobytes,
  whatever the disk's size.
- **The archive ends** with its end marker (zero blocks, whatever follows them being zeros too), or, as some
  exporters write it (M6.1.1), **exactly where the last entry's padding ends**, with nothing after it. Every entry
  has then been read whole, so this is complete. Nothing else ends an archive: a file that stops inside a header,
  inside a file's data or its padding, after an extended header with no entry, or with trailing bytes that are not a
  whole zero block, is refused as truncated or damaged. Completeness is decided by these exact boundaries, never by
  the file's size alone. It is only the archive's structure: whether the disk image inside is sound is not checked,
  and VirtualBox decides that when the master is imported.
- Every entry must be a regular file at the top level with a safe name: no `..`, no absolute path, no drive, no
  control character, no link, no device, no directory, no duplicate (ignoring case). PAX and GNU long names are read,
  and checked like any other.
- The first entry must be the only `.ovf` descriptor, at most 16 MiB. It is parsed with `quick-xml`, without a
  document type: a `DOCTYPE` is refused, so no entity is ever expanded or fetched. The root must be an OVF 1 or 2
  `Envelope`, with at least one `VirtualSystem`. Every `References/File href` must name a file in the archive; an
  external URL is refused.
- A manifest (`.mf`) is optional. When present, it must name only files that are there. While hashing, each SHA-256
  entry is checked against the bytes of its part. SHA-1 entries are read and must be well formed, but are not
  relied on. **An empty manifest** is accepted as declaring nothing, like one with only SHA-1 entries: no part is
  then reported as checked against it (the command says so), and the descriptor's references, the TAR structure,
  the whole file's SHA-256 and the repository's verification are checked as for any other.
- The whole file is hashed with SHA-256 in one pass, in 1 MiB chunks, and its size and modification time are checked
  again before upload. The bytes uploaded are the file's own: nothing is rewritten.

### Authorization: an agent may create a new VM, and only that

The command calls new routes under `/api/v1/agent/ova-imports`, authenticated exactly as agent media is: the agent's
bearer credential and `X-EmuCat-Protocol-Version`. A browser session means nothing there. No new credential or
mechanism exists. The server then requires, at reservation **and again in the commit transaction**:

- the agent is paired and not revoked;
- it is associated with an enabled repository (`agent_repositories`). **The server chooses that repository**; the
  command never names one, so a path or repository given by the client is never trusted;
- no other operation of this agent is in progress (`agent_busy`), and none for this name (`registration_in_progress`);
- no VirtualBox VM of this name exists, ignoring case (`vm_already_registered`).

Possession of the repository's SSH key alone authorizes nothing in the catalog: without a valid agent credential
there is no reservation and no commit, and an object put in the repository by other means is never registered. An
agent can only create: an existing VM is never remastered, overwritten or given a version.

### One durable operation, as a registration

The import is a `registration_operations` row with `mode = 'import'` ([0015](0015-registration-state-machine.md)),
so it shares the active-operation markers, the history, the admin page and the commit code:

| Step the command shows | Operation state | Where                                                        |
| ---------------------- | --------------- | ------------------------------------------------------------ |
| Validating, Hashing    | none yet        | Only on the agent: nothing exists on the server              |
| Reserving              | `queued`        | Version id and archive key issued; name and agent reserved   |
| Uploading              | `uploading`     | Straight to the repository's staging key                     |
| Verifying, Publishing  | `verifying`     | Read back and hashed there, then published without overwrite |
| Registering            | `committing`    | One transaction                                              |
| Done                   | `succeeded`     | `local_copy = preserved`: the file is never touched          |

The declared size and SHA-256 are stored at reservation (`import_size_bytes`, `import_sha256`). The completion must
report the same archive at the issued key, or the import fails with `hash_mismatch` and the published object is
deleted; a database check enforces the same. The commit creates one `virtual_machines` row (with the description,
discovered by this agent) and one `vm_versions` master, and nothing else: no snapshot, no VirtualBox machine UUID, no
`virtualbox_sources` link and no copy on any agent. The VM therefore is not locally executable anywhere until an
administrator imports its master into VirtualBox ([0046](0046-virtualbox-management.md)), which works on it exactly as
on any VirtualBox master.

The WebSocket protocol is unchanged: the server never sends an import to an agent, and the running agent's
`registration_sync` never mentions imports, which are excluded from it, from dispatch and from reconciliation
messages. There is no new capability and no `PROTOCOL_VERSION` change. An older server answers 404, which the command
reports as `server_unsupported`.

### Recovery and cancellation

The command keeps a journal in `state/ova-imports/<request-id>.json`, written atomically, holding no secret: the
request id it chose, the file's identity and hash, and what the server issued. Running **the same command again**
finds it and settles with the server before anything irreversible:

- a reservation whose answer was lost is found again by its request id (idempotent creation);
- an object already published, or a staging object that verifies, is not uploaded again;
- a commit whose answer was lost is recognized and reported as done, never repeated;
- a different file under the same name is refused while the first import is open.

**Ctrl+C** before the commit cancels: the operation becomes `cancelled`, the staging object and any object published
for it are deleted, and the command exits 130. A second Ctrl+C exits at once and leaves the journal, so the next run of the same command settles what was left. An
administrator can cancel an import from the Registrations page at once, since no agent message is involved; the
command learns it at its next progress report (every 2 seconds) and stops. A cancellation always wins over a later
completion, which is answered `rejected` with the object deleted. Once committed, nothing can cancel it.

When the server cannot be reached, nothing that would need it is decided locally: the journal stays and the command
says to run it again.

### Exit codes

0 success, 1 unexpected, 2 invalid argument, 3 not an importable OVA, 4 configuration or authorization, 5 catalog
conflict, 6 server or repository unavailable, 130 cancelled. `--json` prints one object on standard output, and
progress on standard error.

## Consequences

- An OVA becomes a master byte for byte, with no VirtualBox involved and nothing passing through the server.
- The agent's credential now authorizes creating a VirtualBox catalog VM through an associated repository. Revoking
  the agent or removing its association stops that, including for an import already under way.
- An imported VM has a master and no machine. It is shown as a VirtualBox VM that is not on any agent, and is made
  runnable by importing its master into VirtualBox.
- What the descriptor declares (OS type, hardware, disks) is not interpreted beyond the checks above: VirtualBox
  decides that when the master is imported.
