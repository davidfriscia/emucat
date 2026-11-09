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
                     └──────────────▶ SSH/SFTP archive repository, directly
```

The API is the control plane and never carries an archive: there is no route for one. Archive bytes go straight between
agent and repository, and the API records what the agent verified. Screenshots take the other path, from the agent over authenticated
HTTP(S) to the API and server media storage, and never through the archive repository. See
[decision 0012](decisions/0012-direct-agent-repository.md) and [the media guide](media.md).

## Components

**Web (`apps/web`).** A React single-page app. It only talks to the API, with same-origin `/api`
requests. In development, Vite proxies them to the API; a production deployment needs a reverse proxy
that does the same, so the API has no CORS configuration.

**API (`apps/api`).** A Fastify server with a versioned REST API under `/api/v1` and the agent
WebSocket endpoint.

| File                                | Responsibility                                                  |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/server.ts`                     | Entry point: configuration, listening, graceful shutdown        |
| `src/app.ts`                        | Builds the app from injected dependencies, for tests            |
| `src/config.ts`                     | Validated, environment-based configuration                      |
| `src/errors.ts`                     | One error response shape for every failure                      |
| `src/validation.ts`                 | Zod schemas as Fastify route validators                         |
| `src/readiness.ts`                  | Database and migration checks                                   |
| `src/routes/system.ts`              | `health`, `ready`, `info`                                       |
| `src/routes/browser.ts`             | Wires up the routes the web app uses                            |
| `src/routes/auth.ts`                | Setup, sign-in, sign-out, account and sessions                  |
| `src/routes/public-catalog.ts`      | Public listing, detail and public VMs' images                   |
| `src/routes/admin-catalog.ts`       | Administration of existing VMs and media                        |
| `src/auth/`                         | Passwords, sessions, setup, guards, agent tokens, rate limiting |
| `src/catalog/repository.ts`         | All catalog SQL                                                 |
| `src/storage/`                      | Reads, publishes and removes media files, safely                |
| `src/media/`                        | Decodes and converts screenshots, and stores an upload          |
| `src/routes/agent-media.ts`         | What an agent uses to synchronize screenshots                   |
| `src/routes/agent-ws.ts`            | Authenticates agents, and hands sockets to the hub              |
| `src/routes/agent-pairing.ts`       | What an agent uses before it has a credential                   |
| `src/routes/admin-agents.ts`        | Agents, pairing decisions, revocation, starting discovery       |
| `src/agents/hub.ts`                 | Every connected agent, protocol handling, presence              |
| `src/agents/discovery.ts`           | Tracks scans in memory, and decides which answers count         |
| `src/agents/pairing.ts`             | The pairing state machine and all its SQL                       |
| `src/agents/repository.ts`          | SQL for agents, and presence in the database                    |
| `src/routes/admin-registrations.ts` | Registrations and repositories, for administrators              |
| `src/registration/coordinator.ts`   | The registration state machine and all its SQL                  |
| `src/registration/repositories.ts`  | SQL for repositories and which agents may use them              |
| `src/routes/admin-system.ts`        | Version, and application updates relayed to the deployer        |
| `src/deployment/client.ts`          | The deployment service client, over its Unix socket             |
| `src/db/`                           | Connection pool and migration runner                            |
| `migrations/`                       | Forward-only SQL migrations                                     |

The web application's routes are optional dependencies of `buildApp`, so tests of the system routes and the agent
endpoint need no database. See the [API reference](api.md) and [authentication](authentication.md).

**Web structure.** `src/api.ts` is the only file that talks to the API, and it validates each response against the
contracts. `src/auth.tsx` holds the signed-in state, `components/Guards.tsx` protects routes, and catalog filters
live in the URL. Brand artwork is in `src/assets/brand`, described in the [brand guidelines](brand.md).

**Deployment (`apps/deployer`, `deploy/`).** Production Dockerfiles for the API and the web app, one Compose
file without a database, the `emucatctl` tool and a small deployment service that runs outside Docker, on a Unix
socket, and performs updates the API asks for. The API itself holds no deployment privilege. See the
[deployment guide](deployment.md) and [decision 0034](decisions/0034-deployment-and-admin-updates.md).

**Contracts (`packages/contracts`).** The shared vocabulary: Zod schemas, types and pure domain rules,
with no I/O. Both API and web depend on it. `fixtures/` holds language-neutral test vectors, which the
Rust tests read too.

**Agent (`agent`).** A native headless executable using Tokio. Windows x64 comes first. Platform
specifics are limited to `platform.rs`, `shutdown.rs` and default paths in `config.rs`, and CI also
builds and tests on Linux so that portability stays honest.

| Module         | Now                                                | Later                    |
| -------------- | -------------------------------------------------- | ------------------------ |
| `config`       | File, environment, validation                      |                          |
| `protocol`     | Envelope and message types                         | More messages            |
| `connectivity` | The WebSocket, heartbeats, reconnection            | More commands            |
| `pairing`      | Device-style pairing                               | Credential rotation      |
| `credentials`  | The credential store interface, and DPAPI          | Keychain, Secret Service |
| `discovery`    | Read-only scanning of the base paths               |                          |
| `emulators`    | Types, names, identity, root markers               | Launching                |
| `filesystem`   | Safe paths                                         | Directory operations     |
| `archives`     | Version rules, exclusions                          |                          |
| `repository`   | Provider-independent store interface, safe keys    | HTTPS provider           |
| `sftp`         | The SSH/SFTP provider, with host-key checks        |                          |
| `packaging`    | Standalone ZIP, manifest, source consistency       | Extraction               |
| `registration` | Durable operations, journals, recovery             | Snapshots                |
| `removal`      | Conservative local removal after a transfer        |                          |
| `media`        | Watched paths, safe scanning and reading           | The watcher              |
| `media_queue`  | The durable record of what has to reach the server | Uploading                |
| `media_sync`   | Watcher, reconciliation, upload to the API         | Archive transfers        |
| `state`        | State types, local source version                  | Fuller persistence       |

## Principles

- **Agents connect out.** An agent opens outbound connections only and has no listener, so it works
  behind NAT and exposes nothing on the user's machine.
- **The archive is authoritative.** A VM's ZIP archive defines its contents. The database has no
  hardware configuration, disk inventory or emulator settings.
- **Explicit entry to the catalog.** A VM appears only through agent discovery followed by user
  registration. There is no other way in, and nothing is registered automatically.
- **Don't trust a cached copy.** A local VM can change while its agent is offline, so a verification
  only counts if it happened after the latest connection.
- **Private by default.** VMs are private until explicitly made public, and their media are public
  exactly while they are. The public catalog reads through a view that only ever exposes a public VM's
  main image. See [decision 0008](decisions/0008-public-reads-and-media-lifecycle.md) and
  [decision 0036](decisions/0036-vm-level-publication.md).
- **The database enforces invariants.** Identity, version shape, one master and one main image are
  constraints, not just application code. See [decision 0004](decisions/0004-schema-invariants.md).
- **Fail closed.** Without a live credential that a person approved, the agent endpoint opens no socket. See
  [decision 0009](decisions/0009-agent-pairing-and-credentials.md).
- **One API process.** Agent presence and discovery results are in memory, as rate limits are. See
  [decision 0010](decisions/0010-agent-connections-and-discovery.md). Registration is not: it lives in the database.
- **Durable, idempotent operations.** Agents repeat their reports until they are answered, which covers a restart of either
  side. See [decision 0015](decisions/0015-registration-state-machine.md).
- **Source preservation comes first.** Only a positive, matching confirmation of a verified master can lead to a deletion,
  and only for a confirmed transfer.
- **No default credentials.** The first administrator comes from an explicit, one-time setup. See
  [decision 0007](decisions/0007-local-authentication.md).

## Configuration

Everything comes from the environment, and nothing developer-specific is built in.

| Setting                                  | Where                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Database, API address, logging           | `.env` ([`.env.example`](../.env.example))                                |
| Media storage path                       | `STORAGE_PATH` in `.env`                                                  |
| Sessions, cookies, setup token, proxies  | `.env`. See [authentication](authentication.md)                           |
| Repository metadata                      | MariaDB, through the Repositories page                                    |
| Repository access, private key location  | Each agent's configuration. See the [repository guide](repositories.md)   |
| API URL, emulator paths, state directory | Agent configuration ([`agent.example.toml`](../agent/agent.example.toml)) |

Precedence for the agent is command line, then environment, then file. Unknown settings in the file
are errors, so a typo cannot silently disable something. The API refuses to start without a database
password. There are no default credentials anywhere.

## Restoring

A master comes back the way it went out: directly between the agent and the repository, through `ArchiveRepository`, with the API coordinating and never touching a byte.

```
Browser ─► API ─► MariaDB          who may restore what, operation state, what the agent verified
            ▲
            │ WebSocket            immutable identities, progress, results
            ▼
          Agent ◄──────────────── SSH repository    the ZIP, directly
            │
            ├─► staging, then archive cache         the download, outside every VM
            └─► base path/.emucat-restoring-{id}    verified as it is extracted
                     │ one rename, never replacing
                     ▼
                base path/{vm_name}
```

Screenshots are not in archives, and are not restored: they stay on the server, and keep arriving through the API from a VM once it is held locally.
See decisions [0021](decisions/0021-restore-lifecycle.md) to [0024](decisions/0024-local-archive-cache.md).

## Running VMs

```
Browser ─► API ─► MariaDB          vm_sessions, vm_verifications: names, states, results
            ▲
            │ WebSocket            launch, stop, verify: identities only
            ▼
          Agent ─► journal          written before the process starts
            │
            └─► 86Box / qemu-system-*   argument vector built and checked by the agent, no shell,
                   tracked by PID + creation time + image; QMP over stdio for QEMU
```

The API never executes anything, and the browser never supplies a command or a path. Conflicts are checked by the API, so it can explain, and again by the agent, whose check counts. See [the launcher guide](launcher.md) and decisions [0028](decisions/0028-launcher-architecture.md) to [0033](decisions/0033-remote-execution-modes.md).

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
pnpm test:sftp                 # the SFTP provider against a real OpenSSH server, needs Docker
pnpm test:e2e                  # the real agent, API, SFTP server and a real browser, on Windows
```
