# EmuCat

Self-hosted web catalog and local launcher for [86Box](https://86box.net/) and
[QEMU](https://www.qemu.org/) virtual machines.

**Status: Milestone 1 (identity, catalog and branding).** There is a first-administrator setup, local
sign-in with persistent sessions, a public catalog, and an administration area for the metadata and media of
registered VMs. VM registration, archive transfers, launching, snapshots, media upload and pairing are **not**
implemented yet, so **there is currently no way to add a VM to the catalog**: it stays empty until the agent
milestones arrive. See [known limitations](#known-limitations).

| Part                                       | Technology                                       |
| ------------------------------------------ | ------------------------------------------------ |
| [`apps/web`](apps/web)                     | React, TypeScript, Vite, Bootstrap, React Router |
| [`apps/api`](apps/api)                     | Node.js, TypeScript, Fastify, MariaDB, WebSocket |
| [`packages/contracts`](packages/contracts) | Shared TypeScript types, rules and test fixtures |
| [`agent`](agent)                           | Rust and Tokio. Native headless `emucat-agent`   |
| [`compose.yaml`](compose.yaml)             | MariaDB for local development                    |

Read [architecture](docs/architecture.md), the [domain model](docs/domain-model.md), the
[protocol](docs/protocol.md), the [REST API](docs/api.md), [authentication](docs/authentication.md), the
[brand guidelines](docs/brand.md) and the [decision records](docs/decisions).

## Prerequisites

Windows 11 x64 with Node.js 22 (22.22.2 or later), pnpm 12, Rust stable with the MSVC target (plus
the Visual Studio C++ Build Tools), and Docker with Compose. Python, CMake and Ninja are not needed.

`.node-version` pins the Node.js version for version managers such as fnm. `packageManager` in
`package.json` pins pnpm. Commands work in PowerShell, cmd and Git Bash, as long as `node` and `pnpm`
are on the `PATH`. With fnm, that means a shell where `fnm env` has run.

## Quick start

```powershell
cd emucat                      # the directory you cloned
pnpm install                   # JavaScript dependencies
pnpm env:init                  # creates .env with random database passwords
pnpm db:up                     # starts MariaDB and waits until it is healthy
pnpm db:migrate                # applies migrations
pnpm dev                       # starts the API and web app
```

Then open <http://127.0.0.1:5173>. The status indicator in the navigation bar should say
**API online**, and the catalog is empty.

### First-time setup

There are no default credentials. Go to **Sign in**, which takes you to the setup page, and enter the one-time
token the API printed to its log in the terminal, along with the administrator you want to create. Details are in
[authentication](docs/authentication.md#setting-up-the-first-administrator). `pnpm db:reset` starts over.

| Service           | Address                 | Notes                                      |
| ----------------- | ----------------------- | ------------------------------------------ |
| Web (development) | `http://127.0.0.1:5173` | Proxies `/api` to the API                  |
| API               | `http://127.0.0.1:4000` | See the [API reference](docs/api.md)       |
| MariaDB           | `127.0.0.1:3307`        | Host port 3307 to avoid clashing with 3306 |

All of these can be changed in `.env`. See [`.env.example`](.env.example).

### Stopping

- Press `Ctrl+C` in the terminal running `pnpm dev` to stop the contracts watcher, API and web app.
  On Windows, cmd may then ask `Terminate batch job (Y/N)?` because pnpm is launched through a `.cmd`
  file. Answer `Y`.
- A production API (`node dist/server.js` in `apps/api`) handles `Ctrl+C` by closing connections and the
  database pool before it exits. Under `pnpm dev`, `tsx watch` manages the process and may end it directly.
- `pnpm db:down` stops MariaDB and keeps its data.
- `pnpm db:reset` stops MariaDB and **deletes its data**. Run `pnpm db:up` and `pnpm db:migrate` to
  start over with a fresh database.

## Commands

Run from the repository root.

| Command            | What it does                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `pnpm install`     | Installs JavaScript dependencies.                                            |
| `pnpm install:all` | Installs from the lockfile and fetches Rust dependencies.                    |
| `pnpm check`       | Type checks TypeScript and runs `cargo check`.                               |
| `pnpm lint`        | ESLint, Prettier check, `cargo fmt --check`, Clippy with warnings as errors. |
| `pnpm format`      | Formats everything with Prettier and rustfmt.                                |
| `pnpm test`        | Runs all tests. MariaDB must be running.                                     |
| `pnpm build`       | Production builds of contracts, API and web, plus the Release agent.         |
| `pnpm build:agent` | Builds only the Release agent.                                               |
| `pnpm dev`         | Starts contracts watcher, API and web together.                              |
| `pnpm db:up`       | Starts MariaDB and waits for it to be healthy.                               |
| `pnpm db:migrate`  | Applies pending migrations.                                                  |
| `pnpm db:down`     | Stops MariaDB and keeps the data.                                            |
| `pnpm db:reset`    | Stops MariaDB and deletes the data.                                          |

There is no root script named `install`: npm-style lifecycle rules would run it during every
`pnpm install`. Use `pnpm install` or `pnpm install:all`.

## Testing on Windows

```powershell
pnpm env:init   # only once
pnpm db:up
pnpm test
```

| Suite     | Command                                | Needs MariaDB |
| --------- | -------------------------------------- | ------------- |
| Contracts | `pnpm --filter @emucat/contracts test` | No            |
| API       | `pnpm --filter @emucat/api test`       | Yes           |
| Web       | `pnpm --filter @emucat/web test`       | No            |
| Agent     | `cargo test` in `agent`                | No            |

The API tests create uniquely named `emucat_test_*` databases using the root password from `.env`,
and drop them afterwards. They never touch the development database. If MariaDB is not running they
**fail** with a message saying so, rather than being skipped. Run `pnpm build:contracts` before a
single-package API or web run, if the contracts have changed.

The TypeScript and Rust domain code is tested against the same files in
[`packages/contracts/fixtures`](packages/contracts/fixtures), so they cannot drift apart unnoticed.

## The agent

```powershell
cd agent
cargo build --release
.\target\release\emucat-agent.exe --version
.\target\release\emucat-agent.exe --help
.\target\release\emucat-agent.exe info
```

Copy [`agent/agent.example.toml`](agent/agent.example.toml), fill in your paths, and check it:

```powershell
.\target\release\emucat-agent.exe check-config --config agent.toml
.\target\release\emucat-agent.exe run --config agent.toml   # Ctrl+C to stop
```

So far `run` validates the configuration, reports the platform, and waits for a shutdown
signal. It opens no connections, has no listener, launches no emulator and changes nothing in VM
directories.

## Known limitations

- **No way to add a VM.** Registration arrives with agent pairing. Until then the catalog stays empty on a real
  installation. The catalog and media features are tested against fixture rows in throwaway databases.
- **No media upload.** The administration pages manage media rows that already exist. Nothing creates them yet.
- **Single role.** Only administrators exist in practice, and there is no user management.
- **No password recovery** other than editing the database. See
  [authentication](docs/authentication.md#if-you-lose-the-password).
- **Rate limits are per API process.** See [decision 0007](docs/decisions/0007-local-authentication.md).
- **The artwork has not had a designer's review**, and there are no raster icons. See
  [brand guidelines](docs/brand.md#outstanding-work).

## License

Not yet specified.
