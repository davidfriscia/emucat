# 0011: QEMU launcher markers include `run.bat` and its variants

**Status:** Accepted. Supersedes the "Marker rules are unchanged" paragraph of
[0010](0010-agent-connections-and-discovery.md).

Milestone 2 kept the documented marker list and reported real QEMU directories using `run.bat` as
`missing_marker`. Every real QEMU VM on the reference machine has one, so a rule that excludes all of them describes
nothing useful. The markers are now:

`run.bat`, `run.cmd`, `run-win.bat`, `run-win.cmd`, `run-mac.sh`, `run-linux.sh`

**The same marker rules otherwise.** One regular file directly in the VM's root is enough. A link, junction or other
reparse point does not count. A script is reported and never executed, by discovery or by registration. Original
filenames are kept: nothing is renamed or normalized.

**Compatibility follows from the extension.** `.bat` and `.cmd` are Windows scripts, so any of the four means
Windows compatible. `run-mac.sh` and `run-linux.sh` are for their own systems. A generic `run.sh` is not a marker,
because it does not say which system it is for. It stays ordinary VM content.

**Matching stays exact, on every system.** `RUN.BAT` is not a marker. It is reported as `marker_wrong_case` so that it
is easy to spot and rename. This looks strict on Windows, where the two names mean the same file. The alternative is
worse: an answer that differs between Windows and Linux for the same directory, and a marker whose exact spelling a
launcher later cannot rely on. Because the root is listed rather than probed, the real spelling is what gets compared,
as [0010](0010-agent-connections-and-discovery.md) explains.

**The VM name rules of [0002](0002-vm-names.md) are unaffected.** A directory with a valid marker and an invalid name
is still reported as `invalid_name`.
