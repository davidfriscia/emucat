# 0044: VirtualBox machines are discovered through VBoxManage, by UUID

**Status:** Accepted. Extends [0010](0010-agent-connections-and-discovery.md) with a third platform. Changes nothing
about how 86Box and QEMU are discovered, registered or run.

## Context

86Box and QEMU VMs are directories: discovery finds them under a configured base path, and a VM's identity is its
emulator and its directory's name ([0002](0002-vm-names.md)). VirtualBox is different. It keeps its own registry of
machines, whose files may be anywhere, and it identifies each by a UUID. Display names are free text: any script,
quotes, braces, and two machines may share one. Scanning directories for `.vbox` files would find machines VirtualBox
does not know about and miss ones it does, and EmuCat's ASCII VM-name rules would reject many real names.

VirtualBox support is planned in three steps. VB1, this one, only discovers. VB2 will register a powered-off machine as
a master through a full OVA export, and launch and stop it locally. VB3 will add snapshot versions, each a fresh OVA
export. Native VirtualBox snapshots are not EmuCat versions, and VirtualBox runs in Local mode only.

## Decision

**The agent asks VBoxManage, and scans nothing.** An optional `[platforms.virtualbox] vboxmanage` names the executable;
there is no built-in path and no base path. Discovery runs `--version`, `list vms` and, per machine, `showvminfo <uuid>
--machinereadable`, directly with an argument vector, one process at a time, each with a time limit and bounded output.
Every machine VBoxManage shows to the agent's Windows account is in scope. There is no allowlist and no per-VM grant:
EmuCat's administrator authentication is the only access control, as for the other platforms.

**The UUID is the identity, and the name is display text.** Commands always name a machine by UUID. Names keep any
characters except control characters, are bounded, and are never compared with catalog names, so a VirtualBox machine
is never shown as registered because a catalog VM happens to share its name.

**The report is an additive part of the existing discovery result.** `virtualbox` sits beside `emulators`, `vms` and
`skipped` in `agent.discovery_result`, with the same operation, freshness and connection binding. It is not added to
`EMULATOR_TYPES`, so registration, restore, execution and media code cannot be handed a VirtualBox machine by mistake.
No table is added: like the rest of discovery, the result lives in memory.

**A VirtualBox problem never costs the other results.** A missing executable, a failing or slow command, or an
unparseable listing is a `status` of the VirtualBox part. A machine that cannot be inspected is kept, with an `error`.
On the server, a VirtualBox part that fails validation becomes `invalid_report` instead of failing the operation, and a
state this version does not know reads as `unknown`. An older server drops the field; an older agent omits it.

**Only what VB2 needs, and no paths.** UUID, name, guest OS type, state (grouped, with VirtualBox's own value kept),
when it last changed, accessibility, memory and CPUs. Settings files, disks, logs and shared folders are never reported.

## Consequences

- VB1 shows machines and offers nothing to do with them. VB2 adds registration from a powered-off machine, by UUID, with
  its own catalog identity; how that identity is named is decided then, not by this report.
- States are a snapshot taken at discovery. Continuous polling (15 seconds for active machines, 60 for inactive ones,
  centralized in the agent) belongs to VB2, with launch and stop.
- On a non-UTF-8 code page, a name with characters outside that code page may arrive with them replaced. The UUID, and
  so every command, is unaffected.
