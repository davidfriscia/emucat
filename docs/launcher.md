# Running VMs

Since Milestone 6 an administrator can launch a VM on an agent, follow its session, stop it, and verify
that the agent's local copy is still identical to its master. This guide covers what happens, what is
refused, and why. The decisions behind it are [0028](decisions/0028-launcher-architecture.md) to
[0033](decisions/0033-remote-execution-modes.md).

## Who does what

| Part    | What it may do                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Browser | Names an agent, a VM and a mode. Never a command, a path, an argument or a process                     |
| API     | Records sessions and verifications, checks for conflicts, and relays requests. Never executes anything |
| Agent   | Builds and checks the command line, starts the emulator, tracks it, stops it, and has the final say    |

Requests from the server are strict JSON: an unknown field is refused, so nothing can be smuggled into a
launch.

## Launching

**86Box** is started as

```text
86Box.exe --vmpath <VM directory> --vmname <VM name> --noconfirm <VM directory>\86box.cfg
```

from the VM's own directory, with the executable configured in `[emulators.86box]`. The configuration is
named exactly, so 86Box cannot pick up another VM's. `--noconfirm` lets a stop close it without a dialog
nobody may be there to answer.

**QEMU** is started from one of two descriptions, in this order:

1. `emucat-launch.json` in the VM's directory, a launch profile:

   ```json
   { "profileVersion": 1, "system": "i386", "args": ["-m", "64", "-hda", "disk.qcow2"] }
   ```

2. Otherwise the VM's `run-win.bat`, `run-win.cmd`, `run.bat` or `run.cmd`, which is **read, never
   executed**. It is accepted only if it is a plain QEMU command line: optional `@echo off`, `rem` and
   `::` comments, an optional `cd /d "%~dp0"` or `pushd %~dp0` first, `^` continuations, one
   `qemu-system-*` command, and an optional `exit` or `popd` after it. Anything that only a shell can
   interpret (`%`, `!`, `&`, `|`, `<`, `>`, parentheses, `^` inside a line, backticks) or a second command
   is refused with `launch_configuration_required`, and the fix is to add a profile.

A QEMU VM is still recognized by its run script: a directory with only `emucat-launch.json` is not
discovered as a VM.

The program is `qemu-system-<system>.exe` next to the configured QEMU executable, which must pass the same
checks. Nothing on `PATH` is searched. The agent then appends `-qmp stdio`, its own channel to QEMU's
monitor, which opens no listener.

### QEMU's human monitor

Run by itself, a graphical QEMU shows its human monitor (HMP) on a virtual console: Ctrl+Alt+2 opens it,
and Ctrl+Alt+1 returns to the VM. QEMU makes that monitor only while no other monitor is configured, and
`-qmp` counts as one, so the agent also appends `-monitor vc` after `-qmp stdio`, unless the VM's own
arguments say otherwise. Nothing is added when they:

- configure a monitor: `-monitor vc`, `-monitor vc:WxH`, or `-mon` on a `-chardev vc` or `-chardev null`;
- turn it off: `-monitor none`;
- turn QEMU's defaults off: `-nodefaults`, under which QEMU makes no monitor either;
- have no display: `-display none`, `-nographic` or `-machine graphics=off`.

Options are read in `-option value`, `--option value` and `-option=value` form, and a value is never
taken for an option. The rule is the same in Local, Remote Volatile and Remote Snapshot sessions, since
they all start the VM through the same plan; the VM's arguments, directory and `run.bat` are not changed.

Only monitors on QEMU's own window are allowed in a VM's arguments: `-monitor vc[:WxH]`, `-monitor none`,
`-chardev vc,id=…` (with `width`, `height`, `cols`, `rows`) or `-chardev null,id=…`, and
`-mon chardev=…,mode=readline` on one of them. `-monitor stdio` is refused, because standard input and
output carry the agent's QMP channel, and so are QMP monitors (`-qmp`, `-mon mode=control`), every other
monitor or character device backend, and character device IDs named `compat_monitor…`, which QEMU gives
its own monitors. Like running QEMU from `run.bat`, the human monitor gives whoever is at QEMU's window
full control of QEMU.

### What QEMU arguments are refused

Every argument is checked against an allowlist, whichever description it comes from. Every file argument
must resolve to a plain file inside the VM's directory: no absolute paths elsewhere, no `..`, no links.
Refused outright, with the reason in the error:

- QMP monitors, ports and the console: `-qmp`, `-qmp-pretty`, `-serial`, `-parallel`, `-nographic`, and
  monitors or character devices other than those above;
- anything that changes how QEMU runs or detaches from the tracked process: `-daemonize`, `-no-shutdown`,
  `-run-with`, `-sandbox`;
- host files and code: `-virtfs`, `-fsdev`, `-object`, `-plugin`, `-readconfig`, `-writeconfig`, `-L`,
  `-D`, `-pidfile`, `-add-fd`, `-loadvm`;
- listeners: `-s`, `-gdb`, `-vnc`, `-spice`, `-incoming`;
- host devices: `usb-host`, `vfio-pci`, `ivshmem`, `loader`, 9p and similar, and device keys such as
  `romfile=` or `file=`.

User networking is allowed, but a host forward must name the loopback address. `hostfwd=tcp::8888-:8080`
would listen on every interface and is refused; write `hostfwd=tcp:127.0.0.1:8888-:8080` instead, in a
profile. A Windows XP VM whose `run.bat` forwards `tcp::8888-…` needs exactly that change.

`emucat-agent launch-check --emulator qemu --vm <name>` prints the program, working directory, source and
arguments the agent would use, and starts nothing.

### Start grace

An emulator that exits within `start_grace_seconds` (3 by default) is a failed launch,
`launch_exited_early`, with its exit code. Typical causes are missing ROMs or a disk the configuration
names but the directory does not hold.

## Sessions

A session is recorded on both sides: a journal on the agent, written atomically before the process is
started, and a row in `vm_sessions` on the server. Its states are:

| State         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `requested`   | The server has asked; the agent has not answered yet                                      |
| `starting`    | The agent is starting the emulator, or waiting out the start grace                        |
| `running`     | The process runs, and the agent holds a verified handle on it                             |
| `stopping`    | A stop was requested                                                                      |
| `stopped`     | Ended after a stop request                                                                |
| `exited`      | Ended by itself, for example when the guest shut down or a person closed it               |
| `failed`      | Never ran                                                                                 |
| `interrupted` | The server lost track: the agent forgot it, was revoked, or an administrator dismissed it |
| `unknown`     | The agent cannot tell whether the emulator still runs                                     |

`requested`, `starting`, `running`, `stopping` and `unknown` count as active: the VM is protected as if
it ran.

### Process identity

A process is identified by its PID, its creation time as Windows reports it, and its image path. All
three must match before the agent touches it. After a restart the agent opens the PID again and compares
the creation time and image; a PID now used by another program is never signalled, and the session ends
as `exited_while_agent_away`. The agent never kills a process by PID alone, or by name.

### After a restart

| What the journal says          | What the agent finds            | Result                                                                                        |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| A process                      | The same process, still running | `running`, reattached. QEMU's monitor belonged to the old run, so `graceful_stop_unavailable` |
| A process                      | Gone, or a different process    | `stopped` or `exited`, `exited_while_agent_away`, exit code unknown                           |
| No process yet, or uncheckable | -                               | `unknown`, until an administrator dismisses it                                                |

On reconnection the agent lists every session it has a journal for. The server redispatches a launch it
never got an answer to (for two minutes), fails it after that (`launch_not_acknowledged`), and marks a
session the agent no longer knows as `interrupted` (`agent_lost_session`). If the agent later reports
such a session as running, the server reopens it: the agent is the one that can see the process.

## Stopping

**Graceful, by default.** 86Box gets `WM_CLOSE` on its windows; QEMU gets `system_powerdown` over QMP,
which the guest operating system must act on. If the emulator is still running after
`stop_timeout_seconds` (120 by default), the session returns to `running` with `stop_timeout`, and
nothing more happens on its own.

**Forced, only when confirmed.** The administrator types the VM's name. QEMU is first asked to `quit`
over QMP, which exits cleanly; otherwise the verified process is terminated. The session ends as
`stopped` with the informational code `forced`. A forced stop can lose what the guest had not written to
disk, but never deletes or changes the VM's files.

A stop is never queued for an agent that is offline. A session in `unknown` cannot be stopped, only
dismissed after checking that computer, also by typing the VM's name.

## Conflicts

While a session is active:

- a second launch of the VM on that agent is refused (`session_active`, `vm_already_running`);
- launching is refused while a registration, restore or verification of the VM runs (`operation_in_progress`, `vm_busy`);
- verification is refused (`session_active`, or `unavailable` with `vm_running` from the agent);
- a restore is refused (`vm_running`);
- a transfer's removal of the local copy is postponed (`transfer_blocked_running`), and can be retried
  once the VM has stopped.

The server checks first, so the browser can explain. The agent checks again right before acting, against
its own sessions, and that check is the one that counts.

## Verifying a local copy

The agent hashes every file of the local copy with SHA-256 and compares them with the master's manifest.
It reads the manifest from the copy itself if its SHA-256 matches the one recorded at registration;
otherwise from the archive in its cache, or downloaded from the repository. Nothing is uploaded, and the
server never reads a VM.

| Result                | Meaning                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `verified`            | Every file is present and identical, and there is nothing extra                                     |
| `modified`            | Some file differs, or there are files the master does not have                                      |
| `missing`             | Files are missing, or the whole VM (`vm_not_found`)                                                 |
| `unavailable`         | It could not be checked now: the VM runs, or the agent is busy                                      |
| `verification_failed` | It could not be compared reliably, for example a file changed during the check, or a link was found |

The `screenshots` directory is not part of a VM's content and is skipped. Links, junctions and other
reparse points are never followed: one inside the VM fails the check. Counts are complete; at most 20
paths of each kind are listed.

A verified result marks the copy verified in the catalog; modified or missing marks it modified. Note
that running a VM changes it: 86Box writes its settings and NVRAM, and a guest writes its disks, so a
copy that has been run is expected to report `modified`.

## Execution modes

| Mode              | What runs, and what happens to its changes                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `local`           | The agent's persistent copy. Changes stay in it                                                                      |
| `remote_volatile` | A temporary copy of a version you choose. Every change is deleted when the emulator exits                            |
| `remote_snapshot` | A temporary copy of a version you choose. When the emulator exits, it becomes a new snapshot of exactly that version |

A mode that cannot run is refused by the API and by the agent with `execution_mode_unavailable`. It is never
replaced by another one. All three are chosen in the same **Run and verify** panel. See decisions [0033](decisions/0033-remote-execution-modes.md) and [0040](decisions/0040-temporary-remote-sessions.md).

## Snapshots

**A snapshot** is a new, immutable, standalone version of a registered VM: the agent archives its copy exactly as registration does, uploads it to staging, verifies it, publishes it under its own UUID without being able to overwrite anything, and the server records it only then. Its parent is **the version the copy came from**, which the administrator chooses and the server and the agent both check. So after restoring an older version, the next snapshot is a child of that older version, and the history branches. The copy is only read. See [decision 0037](decisions/0037-snapshots-as-registrations.md).

A snapshot is refused while the VM runs on that agent, or may (an `unknown` session counts), and a launch is refused while one is being made. Stop the VM first.

## Remote modes

**Remote Volatile** and **Remote Snapshot** run any version without needing, or touching, the persistent copy. In **Run and verify**, choose the mode, the version and the agent, then **Start**; or choose **Run volatile** or **Run and snapshot** on a version in the version history, which selects them in that panel. From there the server drives everything:

1. The agent obtains the version (from its cache, or over SFTP), verifies it and extracts it into a temporary copy, `{state_dir}\workspaces\{id}\{VM name}`, outside every base path, exactly as a restore would.
2. The emulator starts from there, with the same command-line rules, process tracking and stop behavior as a local launch. Stop it as any session.
3. When the emulator exits:
   - **Remote Volatile**: the temporary copy is deleted, with every change.
   - **Remote Snapshot**: the temporary copy is archived, uploaded, verified and recorded as a new, immutable snapshot whose parent is exactly the version you chose, even if nothing changed; then it is deleted.
4. If publication fails, the temporary copy is kept and nothing is recorded. It is retried automatically a few times when the error may heal (an unreachable repository, a file still in use), and **Retry publication** retries it at any time. A retry never creates a second version. **Abandon snapshot** deletes the copy after you type the VM's name: it is the only way a Remote Snapshot's changes are lost.
5. If the session ends without the agent accounting for the emulator (the agent lost track of it, or was revoked), the session is **held**: nothing is published or deleted until you check that computer and **Resume**, typing the VM's name.

One remote session of a VM per agent at a time, a failed publication included, and one session of a VM per agent, whichever copy it runs. While a temporary copy runs, its VM counts as running on that agent for everything, including the persistent copy. Working copies prepared by hand in Milestone 7 are listed as **manual working copies** in the version history, and keep their own Preserve and Discard actions. See [decision 0040](decisions/0040-temporary-remote-sessions.md).

## Replacing a persistent copy

Restoring onto an agent that already holds the VM replaces its persistent copy, after a confirmation that shows the version installed now and the one replacing it, confirmed with a button. A copy known to differ from its version is replaced only when you tick **Discard any changes**, and the dialog offers to **snapshot it first**; without that tick, the agent verifies the copy against its version first and refuses if anything differs. The new version is extracted beside the old one first, the old one is moved aside, the new one moved into place, and only then is the old one deleted; a crash at any point is resolved on the next start, and a failure before the swap leaves the old copy as it was. A replacement is refused while the VM runs. Restore history marks replacements.

## Removing a persistent copy

**Remove local copy…**, beside each agent in **Local copies and restores**, deletes that agent's persistent copy of the VM, and only that: versions in the repository, the master, snapshots, other agents' copies and remote sessions are not touched. The dialog shows the agent, the VM, the installed version, where it is and whether it has local changes, and is confirmed with a button. A copy known to differ from its version needs **I understand that local changes … are lost** ticked first, and the button then reads **Discard changes and remove local copy**; snapshot it first to keep them. Without that tick, the agent checks the copy against its version first, and keeps it if anything differs, cannot be proven, or a screenshot has not reached the server. Removing is refused while the VM runs or may run, and while the agent works on anything else. Afterwards the agent holds no copy: Local mode is unavailable there until a version is restored again, and remote modes stay available. The removal history under the table says how each one ended.

## Deleting a snapshot

**Delete snapshot…**, on a snapshot in the version history, permanently deletes its archive from the repository. Only a leaf can be deleted: never the master, and never a snapshot that other versions were created from, that is in use by a restore, a session, a remote session, a verification or a snapshot, or that an agent holds as its persistent copy (replace or remove that copy first). Where it cannot be deleted now, the page says why. The dialog names the exact version, with its immutable ID, parent, creation time, archive size and repository, and warns that this cannot be undone. From that moment the snapshot cannot be restored, run or used as a parent; an agent configured for the repository deletes the archive, and the snapshot then leaves the tree. If the repository cannot be reached, it stays **Being deleted** with the last error, is retried automatically, and can be retried now. Its parent and every other version are kept, nothing is reparented, and history still names it. See [decision 0041](decisions/0041-storage-cleanup.md).

## Configuration

```toml
[execution]
# How long a graceful stop may take before it is reported as timed out. 5 to 3600.
stop_timeout_seconds = 120
# An emulator that exits sooner than this failed to start. 1 to 60.
start_grace_seconds = 3
```

`check-config` warns about an emulator that cannot be launched, for example an executable that is not
`86Box.exe` or `qemu-system-*.exe`.

## Troubleshooting

| Code                            | What to do                                                          |
| ------------------------------- | ------------------------------------------------------------------- |
| `emulator_not_configured`       | Set the emulator's `executable` and restart the agent               |
| `executable_invalid`            | Point it at the real `86Box.exe` or `qemu-system-*.exe`             |
| `vm_not_available`              | The VM is not in the base path. Restore it                          |
| `vm_unsafe`                     | The VM directory, or a file it names, is a link                     |
| `launch_configuration_required` | Add `emucat-launch.json`, as above                                  |
| `launch_exited_early`           | Start it by hand on that computer to see why                        |
| `stop_timeout`                  | Shut the guest down from inside, or force a stop                    |
| `graceful_stop_unavailable`     | The agent restarted while QEMU ran. Close it there, or force a stop |
| `process_state_unknown`         | Check that computer, then dismiss the session                       |
| `workspace_unavailable`         | The session is not in a state that allows this. Reload              |
| `remote_session_pending`        | Finish, publish or abandon the remote session still on that agent   |
| `local_copy_modified`           | Snapshot the copy first, or tick Discard any changes                |
| `local_copy_changed`            | The copy is not the version the page showed. Reload                 |
| `snapshot_parent_mismatch`      | The copy comes from another version. Reload, and choose that one    |

## Graphical QEMU screenshot action

Running QEMU sessions can expose a typed Capture screenshot action. The existing `-qmp stdio` and
conditional graphical `-monitor vc` are retained; launch profiles do not gain permission to supply
other monitor transports. Stdio supports argument-bearing commands with response IDs, but cannot
be recovered after agent restart. Existing shutdown semantics and 86Box launching are unchanged.
See [decision 0042](decisions/0042-qemu-monitor-capture.md).
