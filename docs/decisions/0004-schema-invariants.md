# 0004: Invariants live in the schema, including main media

**Status:** Accepted

Rules that protect data or privacy are enforced by MariaDB, so that a bug in a future endpoint cannot
violate them.

| Invariant                           | Mechanism                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| One master per VM                   | Unique index on a generated `master_marker`, which is 1 or `NULL`                                                                    |
| Master vs. snapshot shape           | `CHECK` on `kind`, `parent_version_id`, `snapshot_name`                                                                              |
| Parent, source are the same VM      | Composite foreign keys that include `(emulator_type, vm_name)`                                                                       |
| Versions never change               | `BEFORE UPDATE` trigger. InnoDB foreign key actions do not fire triggers, so `ON DELETE SET NULL` on attribution columns still works |
| No version cycles                   | Follows from the above: a parent must exist first and can never change                                                               |
| Case-insensitive VM identity        | `ascii_general_ci` collation on `vm_name`                                                                                            |
| One active session per agent and VM | Unique index on a generated `active_marker`                                                                                          |

## Main media is a column on the media row

The obvious design is `virtual_machines.main_media_id`, with a composite foreign key to guarantee it
points at the same VM. It has real problems:

- `ON DELETE SET NULL` is impossible, because a composite key would null the VM's own primary key columns.
  Deleting a selected media item would have to fail, or depend on application code running first.
- It creates a circular dependency between two tables.

Instead `vm_media` has `is_main`, with a generated `main_marker` and a unique index on
`(emulator_type, vm_name, main_marker)`.

- The selected media belongs to the same VM by construction, because it is that row.
- At most one per VM is guaranteed by the unique index.
- Deleting the media removes the selection with it, and nothing can dangle.

Changing the selection takes two updates in a transaction: clear the old flag, then set the new one.

Public reads go through the view `public_catalog_card_media`, which requires a public VM and the main
flag, so privatizing or deleting cannot expose anything and no other item is promoted. Media once had a
published visibility of their own, which the view also required; since
[decision 0036](0036-vm-level-publication.md) the VM alone decides.

## Foreign key deletion behavior

`RESTRICT` protects anything tied to stored archives or media: a VM with versions, a version with
descendants or dependents, a repository in use. Removing those will be a deliberate operation that also
cleans up storage. `SET NULL` applies to attribution, such as which agent created a version, so history
survives when an agent or user is removed. `CASCADE` applies only to data with no meaning alone: a user's
sessions, and an agent's state.
