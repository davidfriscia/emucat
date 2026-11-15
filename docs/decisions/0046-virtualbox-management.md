# 0046: VirtualBox snapshots are OVA exports, imports create new machines, and links change only by hand

**Status:** Accepted. VB3. Extends [0045](0045-virtualbox-masters-and-local-execution.md),
[0039](0039-version-history-is-administrative.md) and [0042](0042-qemu-monitor-capture.md). Revises 0045 on one point: the link between a
catalog VM and a VirtualBox machine is no longer fixed at registration.

## Context

VB2 registers a machine with an OVA master and runs it in place. Four things were missing: snapshots, screenshots,
getting a version back into VirtualBox, and getting rid of a machine. All four touch a machine EmuCat does not own:
VirtualBox keeps its files, anyone can start it, rename it or remove it, and two machines can share a name. The
catalog, on the other hand, is EmuCat's: its versions and its screenshots must outlive any machine, and nothing
EmuCat does may destroy them or any machine it was not explicitly told to.

## Decision

### Identity: the catalog entry owns the history, the machine is only where it runs now

The catalog identity stays `(virtualbox, vm_name)`. It owns the master, the snapshots and the screenshots. The
VirtualBox UUID in `virtualbox_sources` names only the machine the VM is **linked** to now, and that can change: an
import creates a new machine with a new UUID. `agent_vm_state.local_source_version_id` records which version the
linked machine comes from (its lineage), when that is known.

### Links

**A link changes only when an administrator changes it**, through `POST …/virtualbox/link` or `…/unlink`, and each
change is recorded in `virtualbox_operations` (`link`, `relink`, `unlink`) with the previous UUID. Never because two
machines have similar names, never because an agent disconnected, and never as a side effect of an import.

- A machine is linked **by UUID**, from a discovery that saw it, or from an import that created it. Exactly one of
  `discoveryOperationId` and `importOperationId` is named.
- A relink names the machine the administrator saw linked (`replaceMachineUuid`, or `null` for none). If the link
  changed since the page loaded, the request fails with `link_changed` and changes nothing.
- One machine is linked to at most one catalog VM (`UNIQUE (agent_id, machine_uuid)`), and one VM to at most one machine
  (the primary key).
- Linking, relinking and unlinking are refused unless the machines involved are powered off, and while a session, an
  import, a deletion or a registration is active.
- A new link from discovery records no lineage. A link to an imported machine records the imported version.
- Unlinking or relinking **never deletes anything**: the previous machine stays in VirtualBox, unchanged.

### Snapshots

**A snapshot is a full OVA export of the linked, powered-off machine**: VB2's export path, run again, with the result
recorded as a snapshot version whose parent is the version the machine comes from. VirtualBox's own snapshots are
neither made nor read. It reuses `registration_operations` with `mode = 'snapshot'` and `virtualbox_uuid` set, and the
unchanged `server.virtualbox_registration_request`, so any VB2 agent can make one. The server refuses a workspace,
a machine that is not present, accessible and powered off, and a parent other than the known lineage. On commit, the
lineage becomes the snapshot, marked `unverified` like any other new state. Snapshot names are generated, as for
directory snapshots.

### Import

`POST …/versions/:versionId/virtualbox-import` names an agent, the new machine's name and a request ID.
`server.virtualbox_import` names the operation, version, repository, key, size, SHA-256 and target name. The agent:

1. checks the key, and the name (`invalid_target_name`: not empty, at most 128 characters, none of `\ / : * ? " < > |`
   or control characters, no leading `-` or space, no trailing space or `.`);
2. runs `list vms` and refuses a name VirtualBox already has (`target_name_in_use`), case-insensitively;
3. checks free space, downloads the OVA to `staging/virtualbox-import-<op>/<op>.ova` (a path made of the operation ID
   alone, refused if it exists), and checks its size and SHA-256 (`hash_mismatch`);
4. runs `import <ova> --dry-run --vsys=0 --vmname=<name>` (`dry_run_failed`);
5. records the machines VirtualBox has, and marks the journal **irreversible**, before anything else;
6. runs `import <ova> --vsys=0 --vmname=<name>` with a twelve-hour limit; this cannot be cancelled;
7. removes the downloaded file (that file, then its now-empty directory: never a wildcard or a recursive delete), lists
   the machines again, and attributes the import by comparing the two lists.

**Exactly one new machine, with the requested name, is a success**, and is reported with its UUID. Anything else is
not a guess: no new machine after a failure is `failed` (`import_failed`, `import_timeout`); any other outcome is
`uncertain` (`import_ambiguous`, `import_unconfirmed`), with every new machine listed as a stray (at most 16).
Nothing removes a stray, nothing is overwritten, and **nothing is linked automatically**: the VM page offers to link,
or to replace the link with, a machine an import created. An uncertain import is never repeated automatically, by
either side. A repeated request with the same request ID returns the same operation.

### Deleting from VirtualBox

`POST …/virtualbox/delete` names the agent, the UUID, VirtualBox's name for the machine **typed again by the
administrator**, and a request ID. The server accepts only the machine linked to this VM, or one an import created for
it that was not deleted since; any other is `machine_not_associated`. The typed name must match exactly, case included
(`confirmation_mismatch`), and the machine must have been seen powered off.

`server.virtualbox_delete` names the UUID and that name. Just before deleting, the agent runs `showvminfo` again and
deletes nothing if the machine is missing (`machine_missing`), has another name (`machine_name_mismatch`), cannot be
read (`machine_inaccessible`) or is not powered off (`machine_not_powered_off`). It then marks the journal
irreversible and runs **`unregistervm <uuid> --delete`, once**: VirtualBox removes the machine and its files. EmuCat
never deletes a machine's files itself, never names a machine by its display name, and never repeats the command. It
then looks again: a machine VirtualBox no longer lists is `succeeded`; a refusal is `delete_failed`; a machine still
listed after a successful command is `uncertain` (`delete_unconfirmed`).

A successful deletion of the linked machine unlinks it (recorded as an `unlink`) and drops its `agent_vm_state` row.
**The catalog entry, its versions, their OVAs and its screenshots are all kept.**

### Screenshots

**A running or paused linked machine can be captured** with `controlvm <uuid> screenshotpng <file>`, through the
QEMU capture model of 0042: a row in `qemu_captures` (now with `emulator_type` and `machine_uuid`), the same API and the
same states. `server.virtualbox_capture` names the session, the VM and the UUID. The agent refuses a machine its
monitor is not watching (`machine_not_linked`) and one VirtualBox does not show running or paused
(`machine_not_running`), validates the PNG, keeps it in `state/virtualbox-captures/<id>/` (at most 8 unpublished),
uploads it to `vms/virtualbox/<vm>/screenshots/<sha256>` with the label `emucat-capture-<id>.png`, and keeps it until
the server acknowledges. Acknowledgements and retries reuse `server.qemu_capture_ack` and `server.qemu_capture_retry`,
which name only the operation; the agent routes them by which module owns it. The screenshot belongs to the catalog VM,
like every other screenshot, and survives any change of machine.

### Protocol and capability

New messages: `server.virtualbox_import`, `server.virtualbox_delete`, `server.virtualbox_operation_ack`,
`server.virtualbox_capture`; `agent.virtualbox_operation_progress`, `agent.virtualbox_operation_result`,
`agent.virtualbox_capture`. An agent says it can use them with `virtualboxManagement: true` in
`agent.registration_sync`, alongside its open import and deletion journals (`virtualboxOperations`: `running`,
`irreversible` or `reported`). The server sends none of them to an agent that does not say so, and says why on the
page. On every sync, the server reconciles: a journal the agent reports is resumed or re-reported; an operation the
agent no longer knows is failed if it never reached the irreversible step, and `uncertain` (`agent_lost_operation`)
otherwise. An agent that restarts mid-import or mid-deletion never runs the command again: an irreversible journal is
reconciled by listing or inspecting, and reported as `uncertain` (`agent_restarted`) when that proves nothing.

`virtualbox_operations.active_marker` with `UNIQUE (agent_id, active_marker)` lets at most one import or deletion run
per agent, and the agent's one-operation slot is shared with registrations and exports.

## Consequences

- An administrator can get any version back into VirtualBox, run it, and make snapshots from it, without EmuCat ever
  overwriting or deleting a machine it was not told to.
- Destructive steps are journalled before they run, done once, and reconciled rather than retried. The price is that
  an interrupted import or deletion can end `uncertain`, and an administrator has to look at VirtualBox.
- Commands go to VBoxManage as argument vectors, never through a shell, and name a machine by UUID. A name is only
  passed to `--vmname` on import, after validation.
- Not done: cancelling an import once VirtualBox has started it; checking free space where VirtualBox will put the
  imported disks (only the download's staging space is checked); deleting a catalog entry; automatic cleanup of strays.
