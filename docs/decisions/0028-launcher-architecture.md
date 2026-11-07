# 0028: Only the agent builds a command line

**Status:** Accepted. Milestone 6.

## Context

Launching a VM means running a program on someone's computer. The browser and the API are reachable
over the network; the agent runs on the computer that holds the VM and the emulator. Existing QEMU VMs
start from batch files that can contain anything.

## Decision

- **The browser names an agent, a VM and a mode, and nothing else.** The API relays those names; it
  never executes an emulator and has no field that could carry a command, a path or an argument.
  Server messages are decoded strictly, so an unknown field is refused.
- **The agent builds the command line itself,** from its own configuration and the VM's own directory:
  `86Box --vmpath … --vmname … --noconfirm …\86box.cfg`, or `qemu-system-<system>` with arguments from
  `emucat-launch.json` or a parsed `run.bat`.
- **No shell, ever.** The process is created directly with an argument vector. A batch file is read as
  text and accepted only if it is one plain QEMU command; anything a shell would interpret is refused
  with `launch_configuration_required`, and a launch profile is the remedy.
- **An allowlist, not a blocklist, of QEMU arguments,** with every file argument confined to the VM's
  directory and no links. Monitors, listeners, host files, host devices and options that detach the
  process are refused by name, so the error can say why. A host forward must name `127.0.0.1`.
- **The executable is checked:** its file name must be `86Box.exe` or `qemu-system-*.exe`, and the QEMU
  system binary is the sibling of the configured one. `PATH` is never searched.

## Consequences

- Some existing VMs need an `emucat-launch.json`, such as one whose `run.bat` forwards a port on every
  interface. That is a one-time edit, and `launch-check` shows the result without starting anything.
- An emulator is always a child of the agent's user, with that user's rights. EmuCat does not sandbox
  the emulator itself.
