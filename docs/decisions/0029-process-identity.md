# 0029: A process is its PID, its creation time and its image

**Status:** Accepted. Milestone 6.

## Context

Windows reuses PIDs quickly. An agent that restarts and signals "PID 4242" may end an unrelated program.

## Decision

- The agent records, before and after starting an emulator: the PID, the creation time Windows reports
  through `GetProcessTimes`, and the image path.
- **Nothing is signalled unless all three match.** After a restart the agent opens the PID, compares the
  creation time and the image, and only then keeps the handle. A mismatch means the emulator is gone:
  the session ends as `exited_while_agent_away`, and the other process is left alone.
- Every stop goes through the handle the agent holds: `WM_CLOSE` to that process's windows, QMP on its
  own pipes, or `TerminateProcess` on that handle. **Never by PID alone, never by name.**
- When the state cannot be checked at all, the session becomes `unknown`, not `stopped`.

## Consequences

- A test starts a real process, records a journal with its PID and a different creation time, and checks
  that the agent declares the session over and leaves the process running.
- The identity is reported to the server (PID and creation time) for display only; the server cannot
  use it to stop anything.
