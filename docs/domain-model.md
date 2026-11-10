# Domain model

The rules here are implemented in [`packages/contracts`](../packages/contracts) and
[`agent/src`](../agent/src), and enforced by the
[database schema](../apps/api/migrations/0001_initial_schema.sql) where possible.

## Virtual machine identity

A VM is identified by `(emulator_type, vm_name)`.

- `emulator_type` is `86box` or `qemu`.
- `vm_name` equals the local directory name. The directory is `BASE_PATH/VM_NAME`, with one base path
  per emulator on each agent.
- The same name under different emulators is two different VMs.
- Identity never changes. Renaming a directory makes it a different VM.
- `display_name` is the catalog title, and can be changed freely. Without one, the title is `vm_name`.

A VM enters the catalog only through agent discovery followed by user registration. A directory is a
candidate when its root contains, as a regular file:

| Emulator | Marker                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| `86box`  | `86box.cfg`                                                                                      |
| `qemu`   | At least one of `run.bat`, `run.cmd`, `run-win.bat`, `run-win.cmd`, `run-mac.sh`, `run-linux.sh` |

Marker names are matched exactly, on every system. Scripts are never executed. See
[decision 0011](decisions/0011-qemu-launcher-markers.md).

Discovery reports candidates without registering them. A discovered VM is an observation, held in memory, and is
not a catalog entry. A QEMU VM is _compatible_ with a host if it has one of that host's scripts: `run.bat`, `run.cmd`,
`run-win.bat` or `run-win.cmd` on Windows, `run-mac.sh` on macOS, `run-linux.sh` on Linux. See
[the agent guide](agent.md#discovery).

### VM names

A name must work as a directory on Windows, macOS and Linux, and in remote object keys.

| Rule                                                    | Rejects, for example                     | Why                                                 |
| ------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| At most 64 characters                                   |                                          | Long base paths on Windows; the snapshot suffix     |
| Only ASCII letters, digits, `.`, `_`, `-`, and space    | `a/b`, `C:`, `a*b`, `café`, `Аdmin`      | Separators, reserved punctuation, Unicode ambiguity |
| Starts and ends with a letter or digit                  | `..`, `.hidden`, `-rf`, `name.`, `name ` | Traversal, hidden files, options, Windows stripping |
| No `..`, no consecutive spaces                          | `a..b`, `a  b`                           | Naive traversal checks, visual ambiguity            |
| Not a Windows device name, with or without an extension | `CON`, `nul.txt`, `COM1`, `LPT0`         | These cannot be files on Windows                    |
| Does not end in `_` and twelve digits                   | `foo_202601010000`                       | Would be indistinguishable from a snapshot of `foo` |

Names are **case-insensitive for comparison** and keep their original spelling. `Win98` and `win98` are
one VM, because they would be one directory on Windows and on default macOS volumes. The database has
the same behavior through its collation.

## Versions

Every VM has one immutable **master** and any number of **snapshots**.

- Each version is a **full, standalone archive**. Snapshots are not incremental: the parent records
  origin and is never needed for a restore.
- A snapshot's parent is the version it originated from. Parents can have many children, so history
  can branch. A parent must be a version of the same VM.
- Versions never change after creation.

```
master ──▶ snapshot A ──▶ snapshot C
   └─────▶ snapshot B
```

### Identifiers and names

| Concept       | Example                                | Purpose                  | Unique? |
| ------------- | -------------------------------------- | ------------------------ | ------- |
| Version ID    | `018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60` | The identity (UUID)      | Yes     |
| Snapshot name | `Win98_202601311530`                   | Label for people         | **No**  |
| Archive key   | `archives/qemu/win98/<version id>.zip` | Location in a repository | Yes     |

A snapshot name is `VM_NAME_YYYYMMDDhhmm` in UTC. Two snapshots within the same minute share a name, so
nothing may use it as a key. Archive keys are derived from the ID so that they can never collide.

## Agents

An agent is created when it collects its credential after an administrator approved its pairing request. See the
[protocol](protocol.md#pairing). Revoking keeps the row, because catalog history refers to it, and removes the
credential's digest. Re-pairing makes a new agent, so a revoked identity never returns.

Online or offline is not stored. It is whether this API process holds a live connection on which the agent has said
hello. `last_connected_at` and `last_seen_at` are stored.

## Local agent state

For each VM it holds, an agent tracks:

| Field                                  | Meaning                                |
| -------------------------------------- | -------------------------------------- |
| `emulatorType`, `vmName`               | VM identity                            |
| `localSourceVersionId`                 | The version the local copy came from   |
| `executionState`                       | See below                              |
| `contentStatus`                        | `unverified`, `verified` or `modified` |
| `lastVerifiedAt`, `lastVerifiedSha256` | The last content verification          |
| `pendingOperations`                    | Operations queued or in progress       |

`contentStatus` starts as `unverified`. A cached VM may change while its agent is offline, so
`isLocalContentTrusted` only accepts a verification made since the agent's latest connection.

Registration sets the first of these: a copy makes the master the VM's local source version, as `idle` and `verified`. A
completed transfer leaves `absent`, with no source version. A transfer whose local cleanup failed leaves `error` and
`unverified`. `lastVerifiedSha256` is the manifest's hash, since that is what describes a local copy.

A **restore** sets the same fields a copy does, because it means the same thing: this directory came from this master, and was verified at this moment. After that:

| What is known                                     | `executionState`    | `contentStatus` | How it is known                                   |
| ------------------------------------------------- | ------------------- | --------------- | ------------------------------------------------- |
| A registered master, and no local copy here       | No row, or `absent` |                 | Registration, or a discovery that did not find it |
| A verified local copy, as of a moment             | `idle`              | `verified`      | A restore or a copy that just finished            |
| A local copy, not checked since it last connected | `idle` or `unknown` | `unverified`    | The next connection, or a discovery that found it |
| A local copy that differs from what was restored  | `idle`              | `modified`      | Names or sizes differ from its manifest           |

Nothing is ever reported as unchanged without having been verified. See [decision 0021](decisions/0021-restore-lifecycle.md#local-state).

The rest are declared for future use, with no behavior yet:

- **Execution states:** `unknown`, `absent`, `idle`, `downloading`, `extracting`, `verifying`,
  `starting`, `running`, `stopping`, `archiving`, `uploading`, `error`.
- **Operation types:** `discover_vms`, `register_vm`, `download_version`, `verify_content`, `launch_vm`,
  `stop_vm`, `create_snapshot`, `upload_snapshot`, `upload_media`, `remove_local_copy`.
- **Operation states:** `queued`, `running`, `succeeded`, `failed`, `cancelled`.

## Media

Media are independent of VM archives and versions.

| Emulator | Watched                                              | Excluded from archives              |
| -------- | ---------------------------------------------------- | ----------------------------------- |
| `86box`  | Supported images anywhere in the `screenshots/` tree | The entire `screenshots/` directory |
| `qemu`   | `.ppm` files in the VM root                          | `.ppm` files in the VM root         |

Files elsewhere, such as a `.ppm` in a subdirectory, are ordinary VM content. Matching ignores case, so
a media file cannot end up in an archive because of how a host spelled its name.

The agent uploads the original over authenticated HTTP(S). The server validates it from its bytes, keeps it unchanged, and makes a
full-resolution JPEG and a thumbnail with its longest side at about 400 pixels. A row in `vm_media` holds the original's hash,
filename, type, size, dimensions and the storage keys of all three, and is unique per VM and content hash. Files never live in the
database, and a screenshot can never create a VM. See [the media guide](media.md).

## Repositories

A repository stores version archives. Agents reach it directly. `ArchiveRepository`, in the agent, is the
provider-independent interface: `health_check`, `stat`, `upload`, `download`, `verify`, `publish` and `delete`, with
`SftpArchiveRepository` as its one implementation. Archives are immutable: an upload can only write to a staging key, and
publishing can never replace an object. See [decision 0012](decisions/0012-direct-agent-repository.md).

The `repositories` table holds connection details and no secrets. `agent_repositories` says which agents may use which
repository, and holds each one's last health check. Private keys stay on the agents. There is one active SSH repository for
now, which a unique index enforces. See [the repository guide](repositories.md).

## Registration

Registration turns a discovered VM into a catalog entry with a master version. An administrator asks for it explicitly: nothing
registers automatically, and the new entry is private. **Copy** keeps the local VM. **Transfer** removes it, once a verified
master is committed and every local check has passed again.

A `registration_operations` row is the durable record of one attempt, kept after it ends. It is bound to the administrator, the
agent, the VM's identity, the repository, the mode, and a version UUID and archive key issued when it is created. Its states
are in [decision 0015](decisions/0015-registration-state-machine.md). A failed attempt owns nothing: trying again is a new
operation, with a new version UUID.

An archive is a complete standalone ZIP of the VM's directory, ending with a deterministic manifest. Media are excluded. See
[decision 0014](decisions/0014-archive-and-manifest.md).

## Restore

An operation restores one immutable version, the master or any snapshot, onto one agent. It holds the operation's UUID, the VM's identity, the version's UUID, the repository's and the agent's UUIDs, the administrator who asked, its state and its
progress, and it keeps the archive's key, size and hash as they were when it was created. The destination is not in the request: the agent derives it from its own base path, as `{base_path}/{vm_name}`, or for a working copy from its state directory.
See [decision 0021](decisions/0021-restore-lifecycle.md).

## Snapshots

A snapshot is a `registration_operations` row with `mode = 'snapshot'`, naming its parent and its label, which commits one `vm_versions` row with `kind = 'snapshot'`. Its parent is the version the archived files came from: the agent's `local_source_version_id`, or a working copy's `source_version_id`. A commit moves that source to the new snapshot. See [decision 0037](decisions/0037-snapshots-as-registrations.md).

## Working copies

A `vm_workspaces` row is a working copy of one VM on one agent, with a `purpose`: `remote_volatile` or `remote_snapshot` for a remote session, or `manual` for one prepared by hand in Milestone 7. A remote session moves through `preparing`, `ready`, `running`, then `held` when its emulator was not accounted for, `publishing` and `publish_failed` for Remote Snapshot, `discarding`, and ends `discarded`, `failed` or `lost`; manual ones keep their old lifecycle. It records the version chosen (`base_version_id`, a Remote Snapshot's parent), its session, its current publication attempt and their count, the version it published, and when an administrator abandoned it. Restores, snapshots and sessions that concern it name it. A restore that replaced a persistent copy records `replace_existing`, the version replaced and whether local changes were discarded. See decisions [0038](decisions/0038-remote-snapshot-working-copies.md) and [0040](decisions/0040-temporary-remote-sessions.md).

## Database tables

| Table                     | Holds                                    | Key                                  |
| ------------------------- | ---------------------------------------- | ------------------------------------ |
| `users`                   | Accounts. None are seeded.               | `id`                                 |
| `user_sessions`           | Browser sessions, as token digests       | `id`                                 |
| `agents`                  | Paired agents, as credential digests     | `id`                                 |
| `repositories`            | Archive storage locations                | `id`                                 |
| `virtual_machines`        | Registered VMs                           | `(emulator_type, vm_name)`           |
| `vm_versions`             | Masters and snapshots                    | `id`                                 |
| `agent_vm_state`          | Each agent's view of its local copy      | `(agent_id, emulator_type, vm_name)` |
| `vm_sessions`             | Runs of a VM on an agent                 | `id`                                 |
| `vm_media`                | Media metadata                           | `id`                                 |
| `agent_pairing_requests`  | Pairing requests, as digests             | `id`                                 |
| `agent_repositories`      | Which agents may use which repository    | `(agent_id, repository_id)`          |
| `registration_operations` | Registrations, kept after they end       | `id`                                 |
| `restore_operations`      | Restores, kept after they end            | `id`                                 |
| `vm_workspaces`           | Remote sessions and working copies       | `id`                                 |
| `system_bootstrap`        | That first-run setup has happened        | `id`, always 1                       |
| `schema_migrations`       | Migration history, managed by the runner | `version`                            |

The view `public_catalog_card_media` is the public read path for card images.
