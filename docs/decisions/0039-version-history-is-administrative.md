# 0039: Version history is for administrators only

**Status:** Accepted. Milestone 7. Builds on [0036](0036-vm-level-publication.md).

## Context

A VM's version tree says when it changed, from what, on which agent, by whom, how large its archives are and where
they are stored. Publication is decided by the VM alone ([0036](0036-vm-level-publication.md)), and nothing defines
whether a public VM's history is public too.

## Decision

**No snapshot or version data appears in any public response,** for public or private VMs. The public catalog
and detail page are unchanged. `GET /admin/vms/:emulatorType/:vmName/versions` returns the tree, and requires an
administrator's session like every other administrative read. A visitor asking for it gets `401`/`403`, and a
private VM still answers like one that does not exist on every public route.

Even to administrators, the tree carries no archive key, repository path, host, credential or local path: only the
version's identity, kind, parent, name, creation time, archive size and hash, what the agent verified about its
manifest, the repository's name and whether it is enabled, and which agents hold a copy derived from it.

**The tree is a list of nodes with parent references,** plus each node's children, never a flattened timeline.
`buildVersionTree` in the contracts checks it (one root, no unknown parent, no cycle, no node of another VM) and
both the API tests and the interface use it, so a corrupted tree is reported rather than drawn wrongly.

## Consequences

- Publishing a VM never publishes its history. If public history is wanted later, it needs its own decision about
  which of these fields are safe, and a public route of its own.
