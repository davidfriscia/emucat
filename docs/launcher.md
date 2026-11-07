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

### What QEMU arguments are refused

Every argument is checked against an allowlist, whichever description it comes from. Every file argument
must resolve to a plain file inside the VM's directory: no absolute paths elsewhere, no `..`, no links.
Refused outright, with the reason in the error:

- monitors and character devices: `-monitor`, `-qmp`, `-mon`, `-chardev`, `-serial`, `-parallel`,
  `-nographic`;
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

| Mode              | Status                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `local`           | Implemented                                                         |
| `remote_volatile` | Not available. Needs a remote display and a disposable working copy |
| `remote_snapshot` | Not available. Needs snapshot publication, planned for Milestone 7  |

A remote mode is refused by the API and by the agent with `execution_mode_unavailable`. It is never
replaced by a local launch. See [decision 0033](decisions/0033-remote-execution-modes.md).

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
