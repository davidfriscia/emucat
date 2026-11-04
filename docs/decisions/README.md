# Decision records

Short records of decisions that are costly to reverse or not obvious from the code. Add a new numbered
file for a new decision. To change one, add a new record that supersedes it.

| No.                                | Decision                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| [0001](0001-technology-choices.md) | Technology choices and dependency versions                  |
| [0002](0002-vm-names.md)           | VM names are a conservative, case-insensitive ASCII subset  |
| [0003](0003-version-identity.md)   | Versions are identified by UUID, not by snapshot name       |
| [0004](0004-schema-invariants.md)  | Invariants live in the schema, including main media         |
| [0005](0005-migrations.md)         | A small, forward-only migration runner                      |
| [0006](0006-shared-fixtures.md)    | TypeScript and Rust share test fixtures, not generated code |
