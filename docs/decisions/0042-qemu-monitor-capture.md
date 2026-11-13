# 0042: Typed QMP on stdio, and durable on-demand screenshots

**Status:** Accepted. QEMU graphical controls, first increment. Extends 0017–0019 and 0028–0031.

## Decision

Keep `-qmp stdio` and the existing conditional `-monitor vc`. A browser names a session and a request
UUID. It never supplies a monitor command, filename, executable argument, or path. Only administrators
can request captures, with the existing session, same-origin and CSRF checks. 86Box is unchanged.

The internal Rust `qmp::Command` enum supports capabilities, powerdown, quit and screendump. Commands
serialize arguments and unique UUID IDs. A serialized caller accepts only its matching response, returns
structured data or a structured QMP error, and has a deadline including time spent waiting for the channel.
Dedicated reader/writer threads keep pipe I/O off Tokio and bound a caller even if QEMU stops reading.
Events are separate from responses and currently ignored; stale responses cannot complete another command.
The frame size and response buffer are bounded. No public generic execution endpoint exists.

## Session and restart limitation

The exact running session, VM identity, verified process handle/creation identity and liveness must match.
A capture claim serializes captures per session and protects cleanup while QMP is executing. Shutdown
continues to use powerdown/quit with its existing timeouts and fallback. A concurrent stop can end a capture;
the failure is explicit and any output remains in the spool.

After an agent restart the VM may still run, but its old stdio handles cannot be recovered. Process recovery
does not recover QMP. The agent reports screenshot availability independently; the API and interface explain
that a new VM session is needed. No pipe reconstruction or process hijacking is attempted. A reconnectable
transport requires a separate decision.

## Capture ownership and publication

`qemu_captures` is a durable operation associated with a session, agent, VM, execution mode and source version.
Its unique browser request ID is idempotent. One active operation per session is enforced by the database.
States are `requested`, `capturing`, `uploading`, `completed`, and `failed`; uncertainty is recorded separately.
Agent reports are accepted only from the active authenticated connection and the recorded identities.
Capture and upload transitions report immediately; heartbeat/welcome replay supplies recovery. If no
capture confirmation arrives within 60 seconds, the API records a failed, uncertain outcome rather than
leaving the interface busy indefinitely. A later committed image can still complete that operation.

The agent first journals intent under `{state_dir}/captures/{operationId}`. QEMU writes an agent-generated
absolute `pending.ppm` path. The agent validates a regular, readable, complete P6 raster (8-bit RGB), dimensions
and size before renaming to `ready.ppm`, hashing and queueing it. Windows directory handles deny replacement
of the spool ancestors during capture and upload; links/junctions/reparse points are refused. The spool
inherits the managed state directory's ownership; it is not a VM directory and must not be shared with
untrusted local users. As with existing emulator execution, same-user hostile code is not sandboxed.

The existing media queue has an optional capture source identity. Ordinary media still resolves from
configured persistent roots. Capture sources resolve only from their validated operation spool and send
the synthetic `emucat-capture-{operationId}.ppm` label, never the local path. The same authenticated HTTP
upload, hashing, conversion, storage and VM-level deduplication apply. A capture-ID header permits upload
only when the server has a matching capture operation for that agent and VM, even after workspace removal.
Ordinary upload authorization is unchanged; authorization is checked again before the media transaction commits.

The API resolves a reported hash against committed media for that VM before completing the operation and
acknowledging the media ID. An agent's claim or aggregate queue status is insufficient. Multiple captures
of identical bytes independently complete against the same media item, including when no upload is needed.
Media remains VM-scoped; the operation retains session/version provenance. No main image changes automatically.
All images of a public VM are public under decision 0036; the capture interface explains this.

## Remote modes and recovery

Local, Remote Volatile and Remote Snapshot use the same capture source. Output never enters a persistent
VM, remote workspace or archive. Temporary workspace cleanup and immutable snapshot publication cannot
remove queued captures. This does not enable automatic synchronization of manually created remote screenshots.

Recovery examines pending/ready output and never blindly reissues screendump for a journaled operation.
A complete, closed image can be finalized after restart; an incomplete or missing image is retained/reported
as interrupted with uncertainty. Duplicate command delivery returns the journal state. Journals remain as
tombstones after publication. A published image can be removed from the spool only after a matching API ack.
API restart/reconnect redispatches durable operations and agents repeat reports on heartbeat/welcome.

The spool reserves 64 MiB per unpublished/uncertain capture, with eight slots (512 MiB reserved). New captures
are refused explicitly when full, and existing files are never evicted to make space. Failed uncertain output
remains reserved for recovery. PPMs above 64 MiB are refused and retained for inspection. Administrators
should monitor state-directory space; no general retention/abandonment UI is introduced here.

Capture uploads stop after five transient attempts in an upload cycle; permanent errors and authentication
blocks remain visible with their files preserved. An administrator can retry recovery/upload of a retained
capture at most three times, using numbered idempotent retry commands. A retry never takes a new frame.
If no complete output exists, request a new capture from an eligible session; retain uncertain files for
inspection. Ordinary background screenshot retry policy stays unchanged.

## Interface and future work

The existing session card offers Capture screenshot only for eligible QEMU sessions. It announces capturing,
uploading and publication, displays failure/retry information, refreshes matching galleries without replacing
their page state, and links the committed image. Existing theme classes and keyboard-native controls apply.

Future controls can add typed internal commands and dedicated authorization/lifecycle rules. Pause/resume,
reset, media/device management, event subscriptions, reconnectable transports and M8 HTTPS repositories
are not implemented by this decision.
