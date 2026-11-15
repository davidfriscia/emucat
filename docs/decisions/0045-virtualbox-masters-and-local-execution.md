# 0045: A VirtualBox master is an OVA export, and the original machine runs in place

**Status:** Accepted. VB2. Extends [0044](0044-virtualbox-discovery.md), [0015](0015-registration-state-machine.md)
and [0028](0028-launcher-architecture.md). Revises one sentence of 0044: `virtualbox` is now a catalog type, but it is
still not an emulator any filesystem code can be handed.

## Context

VB1 lists the machines VBoxManage shows, by UUID. VB2 makes one of them a catalog VM with an immutable master, and runs
it. Everything about a VirtualBox machine differs from a VM directory: VirtualBox owns its files, its settings and its
process, and anything can start or stop it behind EmuCat's back (VirtualBox Manager, a script, a shutdown inside the
guest). What must not differ is the catalog, the version model and the registration history: a second catalog or a
second versioning system would split what an administrator sees and what the lineage rules protect.

## Decision

### Identity

**`virtualbox` is a third value of `emulator_type`**, so a registered machine is `(virtualbox, vm_name)` like any other
catalog VM, with the same primary keys, foreign keys, version rows and history. `vm_name` is a catalog slug chosen or
confirmed at registration under the usual rules ([0002](0002-vm-names.md)); the VirtualBox display name stays display
text. Everything that reads a directory, or tells an agent to, is typed by `FILESYSTEM_EMULATOR_TYPES` (`86box`,
`qemu`) instead: discovery of directories, restore, verification, launch and stop of a process, media watching, local
copy removal. A VirtualBox VM cannot reach that code, which is what 0044 wanted from keeping it out altogether.

**`virtualbox_sources` holds the association**, one row per registered VirtualBox VM: the agent, the native UUID, the
last display name, and the last observed state. `UNIQUE (agent_id, machine_uuid)` makes a second master of one machine
impossible, whatever the application does. A rename changes the display name only. A machine that disappears from
VBoxManage keeps its catalog entry and its master: the row says `present = false`, and the VM page says that its
source is unavailable. Nothing is deleted or re-pointed automatically. No other part of VirtualBox's inventory is stored.

### Registration

**It is a registration operation**, `mode = 'copy'`, with `registration_operations.virtualbox_uuid` set. States,
history, progress, cancellation, acknowledgements, journal-driven recovery and the commit transaction are the existing
ones; transfer is refused, because the original machine is never removed. The request names the agent, the UUID, the
catalog name and the discovery that saw the machine powered off. The server refuses a machine that discovery did not
see as `powered_off` and accessible, a UUID that is already registered for that agent, and a catalog name that exists.

**The agent exports, and nothing else.** `server.virtualbox_registration_request` names the operation, the UUID, the
catalog name, the repository, the version and the key. The agent:

1. checks the key it was given against `archives/virtualbox/<vm-name-key>/<version-id>.ova`;
2. runs `showvminfo <uuid> --machinereadable` and refuses anything but `VMState="poweroff"` (`source_in_use` for a
   running, paused, saved, starting or stopping machine; `source_invalid` for aborted, stuck, busy, inaccessible or
   unknown), and remembers `VMStateChangeTime`;
3. runs `VBoxManage export <uuid> --output=<staging>/<operation-id>.ova --manifest` with a long time limit, polling for
   cancellation; the file name comes from the operation, never from the display name, and an existing file is refused;
4. checks the state again: if the machine left `poweroff` or its state change time moved, the export describes no
   single moment, and it fails with `source_changed`;
5. computes size and SHA-256, uploads to the usual staging key, verifies there, publishes with the usual no-overwrite
   link and checks the published size, exactly as for a ZIP ([0012](0012-direct-agent-repository.md));
6. reports `agent.virtualbox_registration_result` (key, size, SHA-256, and nothing about a manifest), keeps the journal
   until the server answers, and removes its staging file.

A partial or failed export is removed and never reported. The journal is separate from the directory registrations'
(`state/virtualbox-registrations`), but the agent's one-operation-at-a-time slot is shared, so an export and a ZIP
build never run together. A restart before publication fails the operation with `agent_restarted`; one during
publication is resolved against the repository, as for a ZIP.

**The archive is the `.ova`**, not a ZIP holding one. There is no EmuCat manifest: the manifest columns are `NULL`
for a VirtualBox master, and the OVA carries VirtualBox's own `.mf` checksums of its parts. The version's format is
known from its emulator type. Nothing that reads a ZIP (restore, verification, extraction) is offered for it.

**Fidelity is the exported current state.** OVF export writes the machine's settings (VirtualBox adds its own
`vbox:Machine` section) and a flattened copy of each disk at its current state. It does not keep native snapshots,
a saved state, or attached ISO images, and it preserves MAC addresses only because no `--options` strip them. This is
documented to administrators; it was established from VirtualBox's documentation and the installed VBoxManage's usage
text, without exporting anyone's machine.

### Execution

**Local only, against the original machine.** Launch runs `startvm <uuid> --type gui`; a graceful stop runs
`controlvm <uuid> acpipowerbutton`; a forced stop runs `controlvm <uuid> poweroff`, and needs the VM's name typed
again, as every forced stop does ([0031](0031-graceful-and-forced-shutdown.md)). Nothing is imported, cloned or
registered with VirtualBox. Remote Volatile and Remote Snapshot are refused by the server for a VirtualBox VM, and the
page does not offer them.

**A session is observed, not owned.** The agent never holds the VM's process, a PID or a process handle, and a command
that succeeds proves only that VirtualBox accepted it. The server keeps `vm_sessions` rows as for any VM (with no PID)
and moves them only on observed state: `running` (or paused, starting, stopping, stuck) means an active session, and
`poweroff`, `saved` or `aborted` ends it. A machine started outside EmuCat gets a session with no requester; one stopped
outside EmuCat ends its session. The PID and process-identity rules of 86Box and QEMU are untouched.

**Polling is centralized in the agent.** After each welcome the server sends `server.virtualbox_watch` with the UUIDs
registered for that agent; the agent answers with every state at once in `agent.virtualbox_states`, and then only
with changes. Its one loop runs `list runningvms` every 15 seconds while it watches anything, and `showvminfo` per
machine: every 15 seconds while it is active, every 60 while it is not, at once when it enters or leaves
`runningvms`, and every 2 seconds for a while after a start or stop. A machine missing from `runningvms` is never
assumed to be powered off: only `showvminfo` says that, or saved, or aborted. A failed or slow command marks nothing;
the previous observation stands until a command succeeds. Browsers never cause a VBoxManage call.

### Compatibility

The server offers VirtualBox registration and execution only to an agent whose `agent.registration_sync` says
`virtualbox: true`, so an older agent is never sent a message it does not know. An older server never sends the new
messages, and a new agent sends VirtualBox states only in answer to a watch.

## Consequences

- VB3 adds a snapshot version as another full export of the same powered-off machine: a `registration_operations` row
  with `mode = 'snapshot'`, a parent, and the same agent pipeline with a different commit. The parent is the version
  the machine was last exported as, which `agent_vm_state.local_source_version_id` already records.
- Restore of an OVA (`VBoxManage import`) is not implemented, and nothing offers it.
- An administrator who unregisters a machine in VirtualBox and registers a copy of it gets a new UUID, which EmuCat
  sees as another machine. Re-pointing a catalog VM to a new UUID is deliberately not automatic.
