# 0052: A clone is a new VM made by an agent from one version's archive, and keeps only provenance

**Status:** Accepted. Extends [0012](0012-direct-agent-repository.md), [0014](0014-archive-and-manifest.md),
[0015](0015-registration-state-machine.md), [0041](0041-storage-cleanup.md) and
[0049](0049-ova-repository-import.md). Extends who may create a catalog VM: an administrator may now create one
from a version of another, not only by registering a discovered VM.

## Context

An administrator often wants a new VM that starts from a known state of an existing one: _Windows 95_ after Office
was installed becomes _Windows 95 - Office_, which then lives its own life. Until now that meant restoring the
version onto an agent, copying the directory by hand under a new name, discovering it and registering it. That is
slow, error-prone, and for VirtualBox needs a real import into VirtualBox and an export again.

Four facts shape the design:

- **The server never carries archive bytes** ([0012](0012-direct-agent-repository.md)). Whatever copies an archive is
  an agent, talking to the repository directly.
- **Every version is a complete standalone archive** ([0014](0014-archive-and-manifest.md)). A snapshot is not a
  delta: its archive alone is the whole VM, so there is nothing to reconstruct from parents.
- **A ZIP's manifest names its VM** (`vmName`), and a restore refuses a manifest that describes another VM. A ZIP
  copied byte for byte under a new name could never be restored.
- **An OVA carries no EmuCat identity.** The catalog name is not in it; VirtualBox gives every import a new machine
  UUID and, by default, new MAC addresses.

## Decision

### A clone is a registration of the new VM

`POST /admin/vms/:emulatorType/:vmName/versions/:versionId/clone` with `{ agentId, vmName, requestId }` creates a
`registration_operations` row with **`mode = 'clone'`** for the **new** VM. It inherits everything a registration
already guarantees: identities issued before anything happens (new version UUID, new archive key derived from the
new identity), the unique active marker on `(emulator_type, vm_name)` that reserves the destination name ignoring
case for as long as the clone runs, one operation per agent, the states and history of the Registrations page,
cancellation, journal-driven recovery and the commit transaction. A repeated `requestId` returns the same clone.

What the source is, is copied onto the row as **values** (`clone_source_vm_name`, `clone_source_version_id`, the
archive key, size and SHA-256, and the manifest SHA-256 its registration verified). None of them is a foreign key:
the source may later go, and nothing about the clone may hold it back or cascade from it. While the clone runs, the
source version is protected like any other reference ([0041](0041-storage-cleanup.md)): creation goes through
`lockUsableVersion`, and snapshot deletion and remasters count an active clone of a version as a use of it.

### The agent writes the clone; the server only checks and commits

`server.clone_request` names the source version (key, size, SHA-256, known manifest SHA-256) and the new identities.
The agent (`agent/src/vm_clone.rs`), sharing its one operation slot with every other operation:

1. derives both keys itself, from the identities, and refuses a request whose keys differ, whose names are equal
   ignoring case, or whose new key already holds an object (`archive_exists`: archives are never overwritten);
2. checks the source object's size, then downloads it into `staging/clone-<operation>/` and refuses it unless its
   size and SHA-256 are the registered ones (`source_archive_invalid`);
3. for **86Box and QEMU**, inspects the ZIP exactly as a restore does (structure, every entry, a canonical manifest
   that describes the source VM and, when known, is the one its registration verified), then writes a new ZIP:
   every entry copied as it is, compressed bytes and CRC included, directories as packaging writes them, and the
   manifest last with **only `vmName` changed**. It then inspects the new ZIP as a restore of the new VM would, and
   decompresses and hashes **every file** against the manifest. The clone is exactly the content of the version;
4. for **VirtualBox**, checks the OVA as `import-ova` does ([0049](0049-ova-repository-import.md)) and keeps it byte
   for byte (same SHA-256);
5. uploads to the staging key, verifies there, publishes without overwriting, and reports with the usual
   `agent.registration_result` (with the new manifest) or `agent.virtualbox_registration_result`.

The server accepts the report only for the operation and identities it issued, as for any registration, and commits
in one transaction: the new `virtual_machines` row (private, no display name, no description), one master
`vm_versions` row at the new key, and the provenance row. A collision that slipped in is refused at the commit
(`duplicate_registration`) and the clone's published object is deleted by exact key; the source's never is. The
agent holds no copy of the new VM, so there is no agent state and nothing to clean up locally: the operation ends
`succeeded`, `local_copy = preserved`.

An agent says it can clone with `clones: true` in `agent.registration_sync`. The server sends nothing to one that
does not, and fails a queued clone whose agent comes back without it (`clone_unavailable`).

### What a clone is, and is not

A clone has a **new identity** under the **same emulator type**, an **independent master and lifecycle**, its own
archive under its own key, and its own (empty) registration and execution state. It does **not** get the source's
snapshots or version history, tags, screenshots or their order and suppressions, notes, sessions, agent state or
discovery history, operations, publication, VirtualBox link, or temporary remote sessions. It is a VM like any other:
it can be restored, run, snapshotted, remastered and cloned again, and its snapshots are its own.

**Storage is independent.** The clone's archive is a separate object at `archives/<type>/<new name>/<new version>.zip`
(or `.ova`). There is no hard link, no shared object and no reference to the source's archive, so deleting either
VM's archives cannot affect the other. A VirtualBox clone's bytes are equal to its source's, stored twice.

### Provenance is information only

`vm_clone_provenance` holds, per clone, the source VM's name and title as they were, the source version's ID, kind,
snapshot name and title, the operation, who cloned it and when. Its only foreign key is to the clone itself (deleting
the clone removes it); there is none to the source. The VM page shows "Cloned from" with a link while a VM of that
name exists, and plain text otherwise. Nothing in deletion, cleanup, restore, snapshots, remasters, transfers,
execution or registration reads it.

## Consequences

- A clone of a large VM costs a download and an upload of its archive, and for a ZIP twice its size in the agent's
  staging space while it runs. The source is never touched, locally or in the repository.
- Recovery is the registration's: a failure or a restart before publication leaves nothing but a failed operation,
  and the agent removes its staging files and staging object; a restart during publication is resolved against the
  repository. Trying again is a new clone with a new version.
- The product has no way to delete a whole catalog VM yet. Clones are built so that one can be added without
  touching them: nothing refers to a source by key, and the provenance survives the source.
- Not done: cloning across emulator types or repositories; preserving a VirtualBox machine's MAC addresses or UUIDs
  (the clone's master is imported as a new machine, with VirtualBox's defaults); a ZIP64 entry above 4 GiB is copied
  with its own headers by the zip library, which the tests do not exercise at that size.
