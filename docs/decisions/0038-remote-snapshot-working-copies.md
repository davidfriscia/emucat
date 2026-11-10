# 0038: Remote Snapshot runs a disposable working copy, and keeps changes only when asked

**Status:** Accepted. Milestone 7. Implements `remote_snapshot` from [0033](0033-remote-execution-modes.md).

## Context

`remote_snapshot` means: run a chosen version of a VM, and let its changes become a new snapshot of that version.
The version can be any in the tree, and the agent may already hold the VM's persistent local copy, which must not
be overwritten ([0021](0021-restore-lifecycle.md), [0023](0023-atomic-local-publication.md)) or replaced. Nothing
must be published without an explicit decision, and no mode may be quietly substituted for another.

## Decision

**A working copy is its own thing.** A `vm_workspaces` row, and on the agent a directory
`{workspaces_dir}/{workspace_id}/{vm_name}`. `workspaces_dir` defaults to `workspaces` under the state directory, and
`check-config` refuses one inside an emulator's base path, so discovery never sees a working copy and it can never
be mistaken for, or collide with, the persistent copy. The persistent copy's `agent_vm_state`, local manifest and
local state file are never touched by anything a working copy does.

**Everything reuses an existing operation:**

| Step     | Existing mechanism                                                                              |
| -------- | ----------------------------------------------------------------------------------------------- |
| Prepare  | A restore ([0021](0021-restore-lifecycle.md)) with `workspaceId`, into the workspace            |
| Launch   | A session ([0030](0030-session-durability.md)) in mode `remote_snapshot`                        |
| Stop     | The session's stop, graceful or confirmed forced ([0031](0031-graceful-and-forced-shutdown.md)) |
| Preserve | A snapshot ([0037](0037-snapshots-as-registrations.md)) with `workspaceId`                      |
| Discard  | `server.workspace_discard`, the only new command                                                |

The cache, the integrity checks, safe extraction, the no-replace rename, process identity, journals and repeated
reports are therefore the ones already tested.

### States

```
preparing ──restore succeeded──▶ ready ──discard──▶ discarding ──agent removed it──▶ discarded
    │                            │  ▲
    └─restore failed/cancelled─▶ failed     launch / stop / preserve keep it ready
                                 └──agent no longer has it──▶ lost
```

| State        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `preparing`  | Its restore is running. Nothing is on disk until that restore's rename            |
| `ready`      | The directory exists. It can be launched, preserved or discarded                  |
| `discarding` | Removal was asked. The agent refuses while a session or an operation uses the VM  |
| `discarded`  | The agent removed it                                                              |
| `failed`     | Its restore did not publish anything                                              |
| `lost`       | The agent no longer lists it, for example because its state directory was removed |

`preparing`, `ready` and `discarding` are active; a unique key allows one active working copy per VM per agent.

**`source_version_id` moves.** It starts as the restored version. A successful preservation makes it the new
snapshot, because the directory is then exactly that snapshot; the next preservation branches from there. A
working copy restored from an old version therefore produces a branch from that old version.

**Changes are flagged conservatively.** `may_have_changes` becomes true when a session of the working copy is
created, whatever then happens, and false only when a preservation commits. Discarding with it set requires typing
the VM's name.

### What is never done automatically

- **Nothing is published without an explicit Preserve.** Stopping a session never uploads anything.
- **Nothing is removed without an explicit Discard.** A working copy survives agent and server restarts, crashes of
  the emulator and lost connections; it simply stays `ready`.
- **No substitution.** If an agent cannot run `remote_snapshot` (it does not advertise the mode, or cannot restore),
  the request is refused with `execution_mode_unavailable`. It is never launched locally instead, and
  `remote_volatile` remains refused.

### Conflicts

One active session per agent and VM, persistent copy or working copy, as before. While a working copy's session is
active, the VM is running on that agent for every purpose: snapshot, restore and discard are refused on both sides.
The agent's own check is per VM, which also protects a working copy from a concurrent operation on the persistent
copy and the other way round. Unknown sessions count as running.

### Discard

The server asks; the agent removes `{workspaces_dir}/{workspace_id}` only after checking that it is an immediate,
real child of `workspaces_dir`, not a link, and that nothing runs or works on the VM. It renames it to
`.removing-{workspace_id}` first, so a crash midway leaves nothing that looks like a working copy, and finishes on
the next start. The result is reported once; `agent.restore_sync` lists the working copies the agent holds after each
welcome, and the server reconciles from that, so a lost answer or a lost request is recovered on the next connection.

## Consequences

- A working copy uses disk space until discarded. The interface lists them on the VM's page.
- Screenshots taken in a working copy are not synchronized, and are excluded from its snapshots, as for any archive.
  They are removed with the working copy.
- The emulator still runs on the agent's computer: "remote" means the VM comes from the repository rather than the
  persistent local copy. A remote display remains out of scope, with `remote_volatile`.
