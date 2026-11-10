# 0033: Remote modes exist in the contract, and are refused

**Status:** Accepted. Milestone 6. `remote_snapshot` implemented by [0038](0038-remote-snapshot-working-copies.md) in Milestone 7; the rule that a mode is refused, never replaced, stands.

## Context

Three ways of running a VM are planned: `local`, on the agent's own copy; `remote_volatile`, where the
user sees a VM running elsewhere and every change is discarded; and `remote_snapshot`, where the changes
become a new snapshot of the master. Only the first can be built safely now.

## Decision

- **All three modes are in the shared contracts,** so the protocol, the database and the interface do not
  change shape when the others arrive. `IMPLEMENTED_EXECUTION_MODES` is `['local']`.
- **A remote mode is refused, never replaced.** The API answers `409 execution_mode_unavailable` with the
  reason, without recording a session or sending anything; the agent refuses the same way if one ever
  reaches it. Silently launching locally would run the VM on a different copy, with different
  consequences for its changes, than the one the administrator chose.
- **The interface shows them disabled, with the reason:** remote volatile needs a remote display and a
  disposable working copy; remote snapshot needs snapshot publication, planned for Milestone 7.

## Consequences

- Nothing about remote display, working copies or snapshots is implemented or tested.
- An agent advertises the modes it supports in `agent.execution_sync`, so a later agent can offer more
  without a server change to the protocol.
