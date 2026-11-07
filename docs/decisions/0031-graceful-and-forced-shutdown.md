# 0031: Graceful by default, forced only when an administrator confirms

**Status:** Accepted. Milestone 6.

## Context

Ending an emulator at once is like pulling the plug on a real computer: the guest loses what it had not
written, and its file systems may need repair. It never changes the VM's files on the host, but it can
leave the guest inconsistent.

## Decision

- **Stop is graceful.** 86Box receives `WM_CLOSE` on its top-level windows and is started with
  `--noconfirm`, so it closes without a dialog. QEMU receives `system_powerdown` over QMP on its standard
  input and output, which the guest must act on.
- **A graceful stop that does not finish in `stop_timeout_seconds` is reported, not escalated.** The
  session goes back to `running` with `stop_timeout`. Nothing is forced automatically.
- **A forced stop needs the VM's name typed again,** checked by the API before anything is sent. For QEMU
  the agent first sends QMP `quit`, which exits cleanly; otherwise it terminates the verified process.
  The session ends as `stopped` with the informational code `forced`.
- **No stop is queued.** A stop for an offline agent is refused: arriving later, it could surprise
  someone using the VM.
- After an agent restart QEMU's monitor pipes belong to the previous run, so graceful stop is reported as
  unavailable; 86Box can still be closed through its windows.

## Consequences

- A QEMU guest without ACPI handling, such as one at its BIOS or DOS, cannot be stopped gracefully. That
  is reported as `stop_timeout`, and the administrator chooses.
