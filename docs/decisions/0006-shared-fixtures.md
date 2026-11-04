# 0006: TypeScript and Rust share test fixtures, not generated code

**Status:** Accepted

The domain rules exist in two languages. Generating one from the other, or from a schema language, would
add a build step and tooling for a small amount of code, and such tools handle rules like VM name
validation poorly.

Instead both implementations are hand-written and tested against the same JSON files in
`packages/contracts/fixtures`: valid and invalid names with their error codes, snapshot names, archive
paths, VM root markers, and serialized messages and states. The Rust tests embed these files with
`include_str!`.

Adding a case to a fixture tests both languages. A rule changed in only one of them fails that test.
Serialization tests compare whole JSON values, so a renamed field is caught too.
