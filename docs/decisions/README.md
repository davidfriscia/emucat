# Decision records

Short records of decisions that are costly to reverse or not obvious from the code. Add a new numbered
file for a new decision. To change one, add a new record that supersedes it.

| No.                                              | Decision                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| [0001](0001-technology-choices.md)               | Technology choices and dependency versions                          |
| [0002](0002-vm-names.md)                         | VM names are a conservative, case-insensitive ASCII subset          |
| [0003](0003-version-identity.md)                 | Versions are identified by UUID, not by snapshot name               |
| [0004](0004-schema-invariants.md)                | Invariants live in the schema, including main media                 |
| [0005](0005-migrations.md)                       | A small, forward-only migration runner                              |
| [0006](0006-shared-fixtures.md)                  | TypeScript and Rust share test fixtures, not generated code         |
| [0007](0007-local-authentication.md)             | Local authentication, sessions and first-run setup                  |
| [0008](0008-public-reads-and-media-lifecycle.md) | Public reads, and the lifecycle of media files                      |
| [0009](0009-agent-pairing-and-credentials.md)    | Device-style pairing, with credentials the server cannot read       |
| [0010](0010-agent-connections-and-discovery.md)  | Presence in memory, newest connection wins, discovery is not stored |
| [0011](0011-qemu-launcher-markers.md)            | QEMU launcher markers include `run.bat` and its variants            |
| [0012](0012-direct-agent-repository.md)          | Archives travel directly between agent and repository               |
| [0013](0013-ssh-provider.md)                     | SSH/SFTP provider, mandatory host keys, no-overwrite publication    |
| [0014](0014-archive-and-manifest.md)             | Immutable ZIP archives, with a deterministic manifest inside them   |
| [0015](0015-registration-state-machine.md)       | Registration as a durable state machine, on both sides              |
