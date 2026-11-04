# 0001: Technology choices and dependency versions

**Status:** Accepted

The stack (React, Fastify, MariaDB, Rust, Tokio) was given as a requirement. These are the choices made
within it.

- **Zod for validation** in contracts and API. The same schema gives the runtime check and the type.
- **`mysql2`** for MariaDB, with no ORM. The schema is hand-written SQL because its constraints are the
  point (see [0004](0004-schema-invariants.md)).
- **TOML for agent configuration**, with `clap` for the command line and `tracing` for logs.

**TypeScript 6.0, not 7.** TypeScript 7 is the latest release, but `typescript-eslint` 8 requires a
version below 6.1. Upgrade when that peer requirement allows it.

**`@types/node` stays on 22** to match the Node.js 22 runtime.

**Release age policy.** pnpm here refuses packages published within the last day. Rather than adding
exclusions, dependencies use a version old enough to pass, which is why `@fastify/websocket` was
initially resolved to 11.3.6 rather than the newest 11.3.7.

**Local ports.** MariaDB publishes on host port 3307 and the API uses 4000, because 3306 and 3000 are
commonly taken on developer machines. All of them are configurable.
