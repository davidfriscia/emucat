# 0030: Sessions are durable on both sides, and the agent's word wins

**Status:** Accepted. Milestone 6. Follows the reporting pattern of [0015](0015-registration-state-machine.md).

## Context

The agent, the server and the network can each fail while an emulator runs. The emulator does not
depend on any of them. What protects a VM from a restore or a removal is knowing that it may be running.

## Decision

- **The agent writes a journal per session,** atomically (temporary file and rename), before it starts
  the process, and after every change. On start it reconciles every journal with what is running.
- **The server keeps a row per session in `vm_sessions`,** forever. A session is active while `ended_at`
  is NULL; a unique key on `(agent, emulator, VM, active)` makes two active sessions of a VM on one agent
  impossible, and a CHECK keeps the state and `ended_at` in agreement. `request_id` is unique, so a
  repeated click starts one session.
- **Ends are reported until acknowledged.** The agent repeats a terminal status on every heartbeat; the
  server records it, answers `server.vm_execution_ack`, and only then does the agent delete the journal.
- **After each welcome the agent sends `agent.execution_sync`** with every session it knows. The server
  redispatches an unanswered launch for two minutes, then fails it; it marks a session the agent no longer
  knows as `interrupted`; and it reopens an `interrupted` session the agent reports as running.
- **Unknown is active.** A session the agent cannot account for blocks destructive work until an
  administrator checks that computer and dismisses it, typing the VM's name.

## Consequences

- Times come from the agent's clock, so the old CHECK ordering `ended_at` after `started_at` was dropped.
- Revoking an agent ends its sessions on the server as `interrupted`, with a message saying the emulator
  may still be running there.
