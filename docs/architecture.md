# Architecture

EmuCat keeps a catalog of emulated virtual machines on a server and runs them on users' own
computers through a local agent.

```
 Browser ──HTTP──▶ API (Fastify) ──▶ MariaDB
                     │      │
                     │      └──────▶ Media files (server filesystem)
                     ▲
        outbound WebSocket and HTTP
                     │
                 Agent (Rust) ──▶ Local VM directories, emulators
                     │
                     └──────────────▶ Remote archive repository (future)
```

## Components

**Web (`apps/web`).** A React single-page app. It only talks to the API, with same-origin `/api`
requests. In development, Vite proxies them to the API; a production deployment needs a reverse proxy
that does the same, so the API has no CORS configuration.

**API (`apps/api`).** A Fastify server with a versioned REST API under `/api/v1` and the agent
WebSocket endpoint.

| File                           | Responsibility                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `src/server.ts`                | Entry point: configuration, listening, graceful shutdown        |
| `src/app.ts`                   | Builds the app from injected dependencies, for tests            |
| `src/config.ts`                | Validated, environment-based configuration                      |
| `src/errors.ts`                | One error response shape for every failure                      |
| `src/validation.ts`            | Zod schemas as Fastify route validators                         |
| `src/readiness.ts`             | Database and migration checks                                   |
| `src/routes/system.ts`         | `health`, `ready`, `info`                                       |
| `src/routes/browser.ts`        | Wires up the routes the web app uses                            |
| `src/routes/auth.ts`           | Setup, sign-in, sign-out, account and sessions                  |
| `src/routes/public-catalog.ts` | Public listing, detail and published images                     |
| `src/routes/admin-catalog.ts`  | Administration of existing VMs and media                        |
| `src/auth/`                    | Passwords, sessions, setup, guards, agent tokens, rate limiting |
| `src/catalog/repository.ts`    | All catalog SQL                                                 |
| `src/storage/`                 | Reads and removes media files, safely                           |
| `src/routes/agent-ws.ts`       | Authenticated agent WebSocket skeleton                          |
| `src/db/`                      | Connection pool and migration runner                            |
| `migrations/`                  | Forward-only SQL migrations                                     |

The web application's routes are optional dependencies of `buildApp`, so tests of the system routes and the agent
endpoint need no database. See the [API reference](api.md) and [authentication](authentication.md).

**Web structure.** `src/api.ts` is the only file that talks to the API, and it validates each response against the
contracts. `src/auth.tsx` holds the signed-in state, `components/Guards.tsx` protects routes, and catalog filters
live in the URL. Brand artwork is in `src/assets/brand`, described in the [brand guidelines](brand.md).

**Contracts (`packages/contracts`).** The shared vocabulary: Zod schemas, types and pure domain rules,
with no I/O. Both API and web depend on it. `fixtures/` holds language-neutral test vectors, which the
Rust tests read too.

**Agent (`agent`).** A native headless executable using Tokio. Windows x64 comes first. Platform
specifics are limited to `platform.rs`, `shutdown.rs` and default paths in `config.rs`, and CI also
builds and tests on Linux so that portability stays honest.

| Module         | Now                                             | Later                    |
| -------------- | ----------------------------------------------- | ------------------------ |
| `config`       | File, environment, validation                   |                          |
| `protocol`     | Envelope and message types                      | More messages            |
| `connectivity` | Derives the WebSocket address                   | Connection, reconnection |
| `emulators`    | Types, names, identity, root markers            | Discovery, launching     |
| `filesystem`   | Safe paths                                      | Directory operations     |
| `archives`     | Version rules, exclusions, repository interface | Creation, transfer       |
| `media`        | Watched paths, visibility                       | Watcher, upload          |
| `state`        | State and operation types                       | Persistence              |

## Principles

- **Agents connect out.** An agent opens outbound connections only and has no listener, so it works
  behind NAT and exposes nothing on the user's machine.
- **The archive is authoritative.** A VM's ZIP archive defines its contents. The database has no
  hardware configuration, disk inventory or emulator settings.
- **Explicit entry to the catalog.** A VM appears only through agent discovery followed by user
  registration. There is no other way in, and nothing is registered automatically.
- **Don't trust a cached copy.** A local VM can change while its agent is offline, so a verification
  only counts if it happened after the latest connection.
- **Private by default.** VMs and media are private until explicitly made public, and the public
  catalog reads through a view that only ever exposes a published main image. See
  [decision 0008](decisions/0008-public-reads-and-media-lifecycle.md).
- **The database enforces invariants.** Identity, version shape, one master and one main image are
  constraints, not just application code. See [decision 0004](decisions/0004-schema-invariants.md).
- **Fail closed.** The agent endpoint rejects every connection until pairing exists to issue
  credentials.
- **No default credentials.** The first administrator comes from an explicit, one-time setup. See
  [decision 0007](decisions/0007-local-authentication.md).

## Configuration

Everything comes from the environment, and nothing developer-specific is built in.

| Setting                                  | Where                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Database, API address, logging           | `.env` ([`.env.example`](../.env.example))                                |
| Media storage path                       | `STORAGE_PATH` in `.env`                                                  |
| Sessions, cookies, setup token, proxies  | `.env`. See [authentication](authentication.md)                           |
| Archive repository (placeholder)         | `ARCHIVE_REPOSITORY_*` in `.env`                                          |
| API URL, emulator paths, state directory | Agent configuration ([`agent.example.toml`](../agent/agent.example.toml)) |

Precedence for the agent is command line, then environment, then file. Unknown settings in the file
are errors, so a typo cannot silently disable something. The API refuses to start without a database
password. There are no default credentials anywhere.

## Reliability behavior

- `GET /api/v1/health` means the process is running. It does not touch the database.
- `GET /api/v1/ready` returns 503 unless MariaDB answers within two seconds and every migration in
  this build has been applied. The API never applies migrations by itself.
- On `SIGINT`, `SIGTERM` or `SIGBREAK` the API stops accepting work, closes WebSockets and the
  database pool, and exits. It forces an exit after ten seconds.
- The agent handles Ctrl+C, Ctrl+Break, console close, logoff and shutdown on Windows, and `SIGINT`
  and `SIGTERM` on Unix.

## Reproducing a full verification

Follow the [README quick start](../README.md#quick-start). A complete verification is:

```powershell
pnpm install --frozen-lockfile
pnpm env:init
pnpm db:reset
pnpm db:up
pnpm db:migrate
pnpm lint
pnpm check
pnpm test
pnpm build
.\agent\target\release\emucat-agent.exe --version
.\agent\target\release\emucat-agent.exe --help
```
