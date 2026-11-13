# Decision records

Short records of decisions that are costly to reverse or not obvious from the code. Add a new numbered
file for a new decision. To change one, add a new record that supersedes it.

| No.                                                     | Decision                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [0001](0001-technology-choices.md)                      | Technology choices and dependency versions                                    |
| [0002](0002-vm-names.md)                                | VM names are a conservative, case-insensitive ASCII subset                    |
| [0003](0003-version-identity.md)                        | Versions are identified by UUID, not by snapshot name                         |
| [0004](0004-schema-invariants.md)                       | Invariants live in the schema, including main media                           |
| [0005](0005-migrations.md)                              | A small, forward-only migration runner                                        |
| [0006](0006-shared-fixtures.md)                         | TypeScript and Rust share test fixtures, not generated code                   |
| [0007](0007-local-authentication.md)                    | Local authentication, sessions and first-run setup                            |
| [0008](0008-public-reads-and-media-lifecycle.md)        | Public reads, and the lifecycle of media files                                |
| [0009](0009-agent-pairing-and-credentials.md)           | Device-style pairing, with credentials the server cannot read                 |
| [0010](0010-agent-connections-and-discovery.md)         | Presence in memory, newest connection wins, discovery is not stored           |
| [0011](0011-qemu-launcher-markers.md)                   | QEMU launcher markers include `run.bat` and its variants                      |
| [0012](0012-direct-agent-repository.md)                 | Archives travel directly between agent and repository                         |
| [0013](0013-ssh-provider.md)                            | SSH/SFTP provider, mandatory host keys, no-overwrite publication              |
| [0014](0014-archive-and-manifest.md)                    | Immutable ZIP archives, with a deterministic manifest inside them             |
| [0015](0015-registration-state-machine.md)              | Registration as a durable state machine, on both sides                        |
| [0016](0016-screenshot-watcher.md)                      | One watch per base path, and notifications are only hints                     |
| [0017](0017-durable-media-queue.md)                     | The media queue is one JSON file, and a cache of what the server says         |
| [0018](0018-agent-media-upload.md)                      | Screenshots are a PUT addressed by hash, and the WebSocket only reports       |
| [0019](0019-media-processing-and-storage.md)            | `sharp`, two small decoders, and files named by UUID                          |
| [0020](0020-transfer-media-preservation.md)             | A transfer deletes a screenshot only if the server holds exactly that content |
| [0021](0021-restore-lifecycle.md)                       | Restoring as a durable operation, with nothing to undo                        |
| [0022](0022-safe-zip-extraction.md)                     | An archive is untrusted input, even when its hash matches                     |
| [0023](0023-atomic-local-publication.md)                | Publishing a restored VM is one rename that refuses to replace anything       |
| [0024](0024-local-archive-cache.md)                     | A small cache of verified ZIPs, with the file system as its index             |
| [0025](0025-bounded-image-decoders.md)                  | The hand-written decoders are limited by input, by allocation and by time     |
| [0026](0026-media-retry-classification.md)              | Refusals about authorization wait for a change, not a timer                   |
| [0027](0027-catalog-detail-and-public-covers.md)        | Why a public VM can have no cover, and saying so                              |
| [0028](0028-launcher-architecture.md)                   | Only the agent builds a command line                                          |
| [0029](0029-process-identity.md)                        | A process is its PID, its creation time and its image                         |
| [0030](0030-session-durability.md)                      | Sessions are durable on both sides, and the agent's word wins                 |
| [0031](0031-graceful-and-forced-shutdown.md)            | Graceful by default, forced only when an administrator confirms               |
| [0032](0032-local-verification.md)                      | Verifying a local copy hashes every file on the agent                         |
| [0033](0033-remote-execution-modes.md)                  | Remote modes exist in the contract, and a mode is refused, never replaced     |
| [0034](0034-deployment-and-admin-updates.md)            | Images built on the server, updated on demand by a separate service           |
| [0035](0035-self-contained-opt-emucat.md)               | Everything a server keeps lives under /opt/emucat                             |
| [0036](0036-vm-level-publication.md)                    | Publication is decided by the VM alone                                        |
| [0037](0037-snapshots-as-registrations.md)              | A snapshot is a further registration of a registered VM                       |
| [0038](0038-remote-snapshot-working-copies.md)          | Remote Snapshot runs a disposable working copy, and keeps changes when asked  |
| [0039](0039-version-history-is-administrative.md)       | Version history is for administrators only                                    |
| [0040](0040-temporary-remote-sessions.md)               | Remote modes run a temporary copy, and finish on their own                    |
| [0041](0041-storage-cleanup.md)                         | A local copy is removed on request, and only a leaf snapshot is ever deleted  |
| [0042](0042-qemu-monitor-capture.md)                    | Typed QMP stdio commands and durable on-demand screenshots                    |
| [0043](0043-registration-history-and-discovery-page.md) | The agent page is for discovery; registrations are a paginated history        |
