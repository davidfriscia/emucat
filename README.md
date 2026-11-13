# EmuCat

Self-hosted web catalog and local launcher for [86Box](https://86box.net/) and
[QEMU](https://www.qemu.org/) virtual machines.

**Status: Milestone 7 (immutable snapshots and the version tree).** There is a first-administrator
setup, local sign-in with persistent sessions, a public catalog, and an administration area. A native agent pairs with
the server, stays connected over an authenticated WebSocket, and reports the VMs it finds. An administrator can register
one, with **Copy** or **Transfer**: the agent builds a standalone ZIP with a manifest, uploads it directly to an SSH/SFTP
repository, verifies its SHA-256 there, and publishes it immutably, after which the server records one private master.
Screenshots synchronize by themselves from registered VMs to the server, and are public exactly while their VM is: see [the media guide](docs/media.md).
An administrator can **restore** any version onto an agent, launch a VM, stop it, and verify a local copy. A **snapshot** archives an agent's copy again as a new immutable version whose parent is the version that copy came from, so history branches; the version tree is shown to administrators only. **Remote Volatile** runs any version from a temporary copy and discards every change when the emulator exits; **Remote Snapshot** does the same, then publishes the result automatically as a new snapshot whose parent is exactly the version that ran. Neither needs or touches the agent's persistent copy, which a restore can now **replace** with any version, explicitly and safely. An administrator can also **remove** one agent's persistent copy, and **permanently delete** a leaf snapshot that nothing uses, from the repository ([decision 0041](docs/decisions/0041-storage-cleanup.md)). See [the launcher guide](docs/launcher.md#remote-modes) and [known limitations](#known-limitations).

| Part                                       | Technology                                       |
| ------------------------------------------ | ------------------------------------------------ |
| [`apps/web`](apps/web)                     | React, TypeScript, Vite, Bootstrap, React Router |
| [`apps/api`](apps/api)                     | Node.js, TypeScript, Fastify, MariaDB, WebSocket |
| [`packages/contracts`](packages/contracts) | Shared TypeScript types, rules and test fixtures |
| [`agent`](agent)                           | Rust and Tokio. Native headless `emucat-agent`   |
| [`compose.yaml`](compose.yaml)             | MariaDB for local development                    |

Read [architecture](docs/architecture.md), the [domain model](docs/domain-model.md), the
[agent guide](docs/agent.md), the [repository guide](docs/repositories.md), the [protocol](docs/protocol.md), the
[REST API](docs/api.md), [authentication](docs/authentication.md), the [brand guidelines](docs/brand.md) and the
[decision records](docs/decisions).

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

| Command             | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `pnpm install`      | Installs JavaScript dependencies.                                            |
| `pnpm install:all`  | Installs from the lockfile and fetches Rust dependencies.                    |
| `pnpm check`        | Type checks TypeScript and runs `cargo check`.                               |
| `pnpm lint`         | ESLint, Prettier check, `cargo fmt --check`, Clippy with warnings as errors. |
| `pnpm format`       | Formats everything with Prettier and rustfmt.                                |
| `pnpm test`         | Runs all tests. MariaDB must be running.                                     |
| `pnpm test:e2e`     | Builds the agent, and runs the real agent, API and SFTP server. Windows.     |
| `pnpm test:sftp`    | Runs the SFTP provider against a real OpenSSH container, and the ZIP64 test. |
| `pnpm test:deploy`  | Runs the deployment tooling against disposable hosts, in a Linux container.  |
| `pnpm test:compose` | Builds the production images and checks them under `deploy/compose.yaml`.    |
| `pnpm build`        | Production builds of contracts, API and web, plus the Release agent.         |
| `pnpm build:agent`  | Builds only the Release agent.                                               |
| `pnpm dev`          | Starts contracts watcher, API and web together.                              |
| `pnpm db:up`        | Starts MariaDB and waits for it to be healthy.                               |
| `pnpm db:migrate`   | Applies pending migrations.                                                  |
| `pnpm db:down`      | Stops MariaDB and keeps the data.                                            |
| `pnpm db:reset`     | Stops MariaDB and deletes the data.                                          |

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

`pnpm test:e2e` starts the compiled agent as a real process and takes it through pairing, DPAPI storage, presence,
discovery, a server restart and revocation. It then registers VMs for real, against a real OpenSSH server in a container:
copy, transfer, blocked transfers, interrupted uploads, restarts of either side, lost acknowledgements, changed host keys
and revocation. It only ever uses disposable temporary directories. It needs MariaDB, Docker and `ssh-keygen`, and runs
on Windows only, so CI does not run it.

`pnpm test:sftp` runs the provider's own tests against the same container image, in
[`infra/docker/sftp-test`](infra/docker/sftp-test). It needs Docker and `ssh-keygen`. `cargo test` needs neither.

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

Copy [`agent/agent.example.toml`](agent/agent.example.toml), fill in your paths, and then:

```powershell
.\target\release\emucat-agent.exe check-config --config agent.toml
.\target\release\emucat-agent.exe pair --config agent.toml   # prints a code for the Agents page
.\target\release\emucat-agent.exe run --config agent.toml    # Ctrl+C to stop
```

`discover` scans the configured directories and prints the report, with no server involved. `repository-check` tests a
configured repository the same way, and `cache-status` prints what the archive cache holds. The agent only connects out and has no listener. It launches 86Box and QEMU only when an administrator asks, from a command line it builds and checks itself, never through a shell: see [the launcher guide](docs/launcher.md). It removes a
VM directory in one case only: a transfer an administrator confirmed, after a verified master is committed. It creates one in one case only: a restore an administrator asked for, never over an existing
directory. Its credential is protected with DPAPI. The [agent guide](docs/agent.md) covers configuration, pairing, credential recovery, discovery,
registration, restoring and troubleshooting, and the [repository guide](docs/repositories.md) covers setting up SSH.

After upgrading from an earlier milestone, run `pnpm db:migrate`.

## Deploying to a server

Production Docker images, one Compose file without a database service, the `emucatctl` tool and an
admin-only **Application updates** section in Settings. See [the deployment guide](docs/deployment.md).
No server has been installed from it yet.

## Known limitations

- **"Remote" means the version, not the display.** Remote Volatile and Remote Snapshot run the emulator on the agent's computer, from a temporary copy of a version obtained from the repository; nothing is streamed. Launching is implemented in the Windows agent only. See [the launcher guide](docs/launcher.md).
- **Storage cleanup is deliberately narrow.** One agent's persistent copy can be removed, and a leaf snapshot can be deleted, one at a time and only when nothing uses it. A master, a registered VM, a snapshot with children and a branch cannot be deleted; nothing cascades, reparents, garbage-collects or applies a retention policy, and deleting the agents' cached ZIPs is left to the cache's own limit. A snapshot whose repository cannot be reached stays "being deleted", unusable, until an agent can delete its archive. See [decision 0041](docs/decisions/0041-storage-cleanup.md).
- **Replacing a persistent copy is conservative.** A copy known to differ from its version is replaced only when the administrator says to discard its changes; otherwise the agent verifies it first and refuses if anything differs, and a copy whose lineage it cannot prove counts as changed.
- **Manually created screenshots during a remote session are not synchronized,** and go with its temporary copy. A Remote Snapshot whose publication failed keeps its temporary copy, and its disk space, until it is published or abandoned.
- **Some QEMU launchers need a profile.** A `run.bat` that is more than one plain QEMU command, or that forwards a port on every interface, is refused until an `emucat-launch.json` describes the VM.
- **A graceful QEMU stop needs a guest that handles ACPI.** Otherwise it times out, and a forced stop is the administrator's choice. After an agent restart, QEMU can only be force-stopped.
- **Verification reads the whole VM,** and reports only its final counts. A VM that has been run is expected to verify as modified.
- **Remote HTTPS uploads are not integration-tested.** Remote agents must use HTTPS, and the agent enforces that, but screenshot uploads have only been exercised end to end over loopback HTTP. This test is deferred by decision.
- **An interrupted restore download starts over** rather than resuming. See [decision 0021](docs/decisions/0021-restore-lifecycle.md).
- **"Modified" is only as good as names and sizes between verifications.** A same-size change is caught by "Verify local copy", which hashes every file, but not by the cheaper check on reconnection. See [decision 0032](docs/decisions/0032-local-verification.md).
- **A transfer of a VM with screenshots can end as a partial success.** Screenshots are not in archives, so the VM is only removed once the
  server holds every one of them. If that cannot be proved, the master and the local VM both stay, and the removal can be retried.
- **Archiving is not a filesystem snapshot.** Changes during archiving are detected and fail the operation, and Windows also
  refuses files open for writing, but a VM should be stopped first. See
  [decision 0014](docs/decisions/0014-archive-and-manifest.md).
- **The repository needs hard links,** through `hardlink@openssh.com`, for publication that cannot overwrite. A server
  without them fails closed. See [decision 0013](docs/decisions/0013-ssh-provider.md).
- **One active SSH repository,** and one registration or restore per agent at a time. No HTTPS provider, replication or migration yet.
- **An address change must be made twice,** in the web app and in each agent's configuration. A mismatch is reported.
- **A failed publication can leave an unreferenced archive** in rare crash windows, such as a database reset mid-operation. It
  is harmless but is not cleaned up automatically.
- **One API process.** Agent presence and discovery results are in memory, so several instances would not work
  together. See [decision 0010](docs/decisions/0010-agent-connections-and-discovery.md).
- **Windows agents only for pairing.** Elsewhere the agent builds, and `discover` works, but there is no credential
  store yet, so it refuses to pair. It does not install itself as a service, and has no tray icon.
- **QEMU VMs need a recognized launcher.** A VM whose only script is named otherwise, such as `run.sh`, is reported as
  having no marker. See [the agent guide](docs/agent.md#what-counts-as-a-vm).
- **No media upload from a browser.** Screenshots only come from agents. Orphaned media files are reported at startup and removed by hand.
- **Single role.** Only administrators exist in practice, and there is no user management.
- **No password recovery** other than editing the database. See
  [authentication](docs/authentication.md#if-you-lose-the-password).
- **Rate limits are per API process.** See [decision 0007](docs/decisions/0007-local-authentication.md).
- **Deployment is built and tested on disposable hosts only.** Updates rebuild on the server and briefly
  interrupt the application; there is no automatic rollback across migrations. See
  [decision 0034](docs/decisions/0034-deployment-and-admin-updates.md).
- **The artwork has not had a designer's review**, and there are no raster icons. See
  [brand guidelines](docs/brand.md#outstanding-work).

## License

Not yet specified.

Administrators can capture running QEMU screenshots from the session card in all three execution modes.
Requested captures use a durable agent spool and publish through the existing VM gallery. After agent
restart, start a new session to regain QMP capture. See [the media guide](docs/media.md#requested-qemu-captures).
