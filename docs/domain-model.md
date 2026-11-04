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

A VM enters the catalog only through agent discovery followed by user registration. A directory is a
candidate when its root contains, as a regular file:

| Emulator | Marker                                                      |
| -------- | ----------------------------------------------------------- |
| `86box`  | `86box.cfg`                                                 |
| `qemu`   | At least one of `run-win.cmd`, `run-mac.sh`, `run-linux.sh` |

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

Declared for future use, with no behavior yet:

- **Execution states:** `unknown`, `absent`, `idle`, `downloading`, `extracting`, `verifying`,
  `starting`, `running`, `stopping`, `archiving`, `uploading`, `error`.
- **Operation types:** `discover_vms`, `register_vm`, `download_version`, `verify_content`, `launch_vm`,
  `stop_vm`, `create_snapshot`, `upload_snapshot`, `upload_media`, `remove_local_copy`.
- **Operation states:** `queued`, `running`, `succeeded`, `failed`, `cancelled`.

## Media

Media are independent of VM archives and versions.

| Emulator | Watched                          | Excluded from archives              |
| -------- | -------------------------------- | ----------------------------------- |
| `86box`  | Files directly in `screenshots/` | The entire `screenshots/` directory |
| `qemu`   | `.ppm` files in the VM root      | `.ppm` files in the VM root         |

Files elsewhere, such as a `.ppm` in a subdirectory, are ordinary VM content. Matching ignores case, so
a media file cannot end up in an archive because of how a host spelled its name.

Planned flow: the agent uploads the original over authenticated HTTP POST. The backend validates it,
verifies its SHA-256, converts it to a full-resolution JPG, generates a JPG thumbnail, stores the files
under `STORAGE_PATH`, and stores metadata in MariaDB.

Rules:

- **Deduplication** is by VM identity and original hash. The same image on two VMs is two items, each
  with its own visibility.
- **Private by default.** Publishing is explicit.
- **At most one main item per VM**, belonging to that VM.
- **Public cards** show the main item only while it is published. Otherwise they show a placeholder.
- **No fallback.** Deleting or privatizing the main item results in the placeholder. Another published
  item is never promoted, because that would expose something nobody chose to show on the card.

`resolvePublicCardImage` implements this in code, and the `public_catalog_card_media` view implements
it in SQL.

## Repositories

A repository stores version archives. `ArchiveRepository` (in TypeScript and Rust) is the abstract
interface: `stat`, `put`/`upload`, `get`/`download` and `delete`. There are no implementations yet.
Archives are immutable, so writing to an existing key must fail. The `repositories` table holds
connection details but no secrets: `secret_ref` only names where a secret lives.

## Database tables

| Table               | Holds                                    | Key                                  |
| ------------------- | ---------------------------------------- | ------------------------------------ |
| `users`             | Accounts. None are seeded.               | `id`                                 |
| `user_sessions`     | Browser sessions, as token digests       | `id`                                 |
| `agents`            | Paired agents, as credential digests     | `id`                                 |
| `repositories`      | Archive storage locations                | `id`                                 |
| `virtual_machines`  | Registered VMs                           | `(emulator_type, vm_name)`           |
| `vm_versions`       | Masters and snapshots                    | `id`                                 |
| `agent_vm_state`    | Each agent's view of its local copy      | `(agent_id, emulator_type, vm_name)` |
| `vm_sessions`       | Runs of a VM on an agent                 | `id`                                 |
| `vm_media`          | Media metadata                           | `id`                                 |
| `schema_migrations` | Migration history, managed by the runner | `version`                            |

The view `public_catalog_card_media` is the public read path for card images.
