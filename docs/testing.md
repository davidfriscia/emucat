# Testing EmuCat

How the test suites are run, what each one needs, and the rules that keep them meaningful on both platforms EmuCat is
developed on: Windows, where the agent runs and where most development happens, and Linux, where the server runs in
production. The quick reference is in the [README](../README.md#testing-on-windows); this guide is the full one.

## The suites

| Command                                                      | What it runs                                                                 | Needs                                      | Platform       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ | -------------- |
| `pnpm test`                                                  | Contracts, API, web and deployer unit and integration tests                  | MariaDB (`pnpm db:up`)                     | Windows, Linux |
| `cargo test --manifest-path agent/Cargo.toml --no-fail-fast` | The agent's unit and integration tests                                       | Nothing                                    | Windows, Linux |
| `pnpm test:sftp`                                             | The agent's SFTP, packaging and restore tests against real OpenSSH, ZIP64    | Docker, `ssh-keygen`                       | Windows, Linux |
| `pnpm test:e2e`                                              | The compiled agent, the API, a browser and a real OpenSSH server, end to end | MariaDB, Docker, `ssh-keygen`, Edge/Chrome | Windows        |
| `pnpm test:deploy`                                           | The deployment tooling on disposable hosts, in a Linux container             | Docker                                     | Windows, Linux |
| `pnpm --filter @emucat/web test:browser`                     | Archive Explorer and Version History, production builds, in a real browser   | Edge, Chrome or `EMUCAT_BROWSER_PATH`      | Windows, Linux |
| `pnpm test:compose`                                          | The production images under `deploy/compose.yaml`                            | Docker                                     | Windows, Linux |

`pnpm test:e2e` also runs real QEMU and 86Box when they are installed, and skips only those tests otherwise.

The API tests create uniquely named `emucat_test_<random>` databases with the root password from `.env` and drop them
when each test ends; they never open the development database. The e2e tests do the same, and use only temporary
directories and containers named `emucat-e2e-<suite>-<random>` that they remove. `pnpm test:compose` uses its own
Compose project, `emucat-smoke-<random>`. No suite deletes a volume, a database or a container it did not create.

## Prerequisites on Windows 11

| Tool                    | Version used for this guide | Notes                                                                              |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| Node.js                 | 22.22.3                     | Through fnm; put its installation directory on `PATH` in each new shell            |
| pnpm                    | 12.10.1                     | Through Corepack, as `package.json` pins it                                        |
| Rust                    | 1.99.0                      | `cargo` on `PATH`                                                                  |
| Docker Desktop          | 29.9.3, Compose 5.7.0       | Linux containers, WSL 2 backend                                                    |
| Git for Windows         | Any recent                  | Provides Git Bash, which `pnpm test:deploy` and `pnpm test:compose` run in         |
| OpenSSH client          | Windows' own                | `ssh-keygen`, for the SFTP and e2e tests                                           |
| Microsoft Edge (Chrome) | Any recent                  | The e2e browser tests launch it headless                                           |
| QEMU, 86Box             | Optional                    | Their e2e tests are skipped, and say so, when they are not installed               |
| VirtualBox              | Optional                    | `virtualbox.e2e.test.ts` runs only with `EMUCAT_E2E_VBOXMANAGE` set; it only reads |

**Developer Mode is not needed.** Tests that need a link to a directory create a junction, which any account may
create; the one case that needs a file symbolic link runs on Linux only (see below).

```powershell
$env:PATH = "$env:APPDATA\fnm\node-versions\v22.22.3\installation;$env:PATH"
node -v; pnpm -v; cargo -V; docker version --format '{{.Server.Version}}'
pnpm install
pnpm env:init   # only once: writes .env with generated passwords
pnpm db:up
docker ps --filter name=emucat-mariadb --format '{{.Names}} {{.Status}}'
```

MariaDB must report `healthy` and listen on `127.0.0.1:3307`.

## API test workers

Each API test creates a database of its own and applies every migration to it: the isolation every test relies on.
That DDL serializes inside MariaDB, so running more test files at once mostly makes each test wait longer. On the
Windows workstation (Docker Desktop, WSL 2), the whole API suite on an otherwise idle MariaDB measured:

| `EMUCAT_API_TEST_WORKERS` | Wall time        | p95 per test   | p99 per test   | Tests over 15 s | Failures |
| ------------------------- | ---------------- | -------------- | -------------- | --------------- | -------- |
| 4 (two runs)              | 1,281 s, 1,286 s | 14.5 s, 14.1 s | 16.7 s, 16.1 s | 50, 44          | 0, 0     |
| 2                         | 1,380 s          | 8.2 s          | 10.1 s         | 2               | 0        |
| 1                         | 1,616 s          | 4.7 s          | 6.5 s          | 1               | 0        |

With 4 workers, dozens of tests run within a factor of two of the 30-second test timeout. In one run made under
slightly more load, 9 of them timed out. Two workers keep every test well inside the timeout for 7% more time, so they
are the Windows default; 4 stay the default elsewhere. Set `EMUCAT_API_TEST_WORKERS` to override it, and keep
workers × 12 well under MariaDB's `max_connections` (151).

## Rules for a test

**No sleep is a synchronization.** A test waits for the state it needs: a promise, an event, a polled condition with a
deadline (`waitFor`/`until` in the helpers), a URL, an element. A fixed delay is acceptable only where the subject is
time itself (a timeout the product applies), and the comment says so.

**Concurrency is made deterministic, not raced.** To test what happens during an operation, hold the operation at that
point, act, then release it. The SFTP test server can hold its replies: `holdReads(after)` lets `after` reads through,
holds every later one until the returned function is called, and `heldReads()` says how many are held. Archive Explorer's
cancellation tests (R2) use it to cancel at the first read, in the middle and at the last read, and to prove that one
requester leaving never stops the load others wait for.

**A test names the behaviour it proves.** When a decision changes behaviour, the tests that pinned the old behaviour are
rewritten to prove the new one, not deleted or loosened. Decision 0051, for example, made screenshots volatile media:
the e2e tests that expected a transfer to be blocked by a screenshot now prove that the transfer goes ahead, that no
screenshot is archived, and that pending screenshots still reach the server from the agent's spool.

**Browser tests find elements as a person does.** By role and accessible name (`getByRole('navigation', { name: 'VM' })`,
`getByRole('link', { name: 'Manage this VM' })`), never by position (`Screenshot 2 of`) or by a name another control may
share: a `Tags of …` button also contains a screenshot's file name, so the thumbnail is matched by its full label. They
follow the product's navigation (decision 0054): a public VM opens on its public page, **Manage this VM** leads to
General, and Version History, Local copies and restore, Notes and Screenshots are routes of their own, reached from the
VM's sidebar or opened directly.

**Each test cleans up what it made**, including when it fails: browser contexts are closed in `finally`, servers are
restarted if a test stopped them, and containers are removed in `afterAll`.

## Platform-specific filesystem semantics

The API runs in Linux containers in production; Windows is a development platform. Some filesystem features differ, and
the helpers in [`apps/api/test/platform.ts`](../apps/api/test/platform.ts) make the same check on each:

| Subject                 | Linux                                  | Windows                                                                          | Helper                       |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| A link to a directory   | Symbolic link                          | Junction: any account may make one, and `lstat` reports it as a symbolic link    | `linkDirectory`              |
| A link to a file        | Symbolic link, refused by `O_NOFOLLOW` | Needs Developer Mode, and Node has no `O_NOFOLLOW`: that case runs on POSIX only | `fileLinksRefusable`         |
| File permission bits    | Exact (`0o640`)                        | None (Node reports `0o666`); the check is "a regular, writable file"             | `expectFileMode`             |
| The temporary directory | `TMPDIR`                               | `TEMP`, then `TMP`                                                               | `redirectTemporaryDirectory` |

A case that cannot exist on a platform says so in a comment where it is skipped; nothing is skipped silently, and the
Linux assertions are unchanged. The agent's Rust tests follow the same rule with `#[cfg(unix)]` and `#[cfg(windows)]`
modules: on Windows, links among VM files are junctions (`mklink /J`), which the packaging tests create without
elevation. Decision 0051's media area is tested on both: a junction at or below an 86Box root `screenshots` directory is
set aside and never followed, and a junction anywhere else still fails the archive as unsafe.

**Compose on Windows.** `pnpm test:compose` checks that notes the API writes belong to UID/GID 1000. On Linux it reads
the owner on the host. On Windows the host's `stat` reports the Windows account, so the script reads the owner from
inside a replaced container, where Docker Desktop keeps a bind-mounted file's Linux owner: a file written as root
would show `0:0` there.

**The SFTP test image** ([`infra/docker/sftp-test`](../infra/docker/sftp-test)) disables OpenSSH's `PerSourcePenalties`.
Every connection from the host reaches the container from one address, the Docker gateway, and the e2e tests freeze
the server (`docker pause`) mid-transfer, which can crash a pre-authentication child. With penalties on, that one crash
refused every later connection in the file, the agent's and the API's alike, with `Disconnected`.

## Diagnosing a failed browser test

Set `EMUCAT_E2E_ARTIFACTS` to a directory before `pnpm test:e2e`, in PowerShell:

```powershell
$env:EMUCAT_E2E_ARTIFACTS = "$env:TEMP\emucat-e2e-artifacts"
pnpm test:e2e
```

For each failed test, every page still open is saved there as `<test>/<n>.png` (full page), `<n>.html` (the DOM) and
`<n>.txt` (the URL, the browser console, page errors, failed requests and 4xx/5xx responses), from
[`apps/api/e2e/artifacts.ts`](../apps/api/e2e/artifacts.ts). Without the variable nothing is recorded. To run one file or
one test:

```powershell
cd apps/api
npx vitest run --config e2e/vitest.config.ts e2e/restore.e2e.test.ts -t "interruptions"
```

The e2e tests in a file are one scenario around one running agent and run in order, so a filtered run still runs the
file's `beforeAll` setup.

## Browser tests of the web application

`pnpm --filter @emucat/web test:browser` builds Archive Explorer alone (`apps/web/e2e/harness`) with the
application's own Vite configuration, serves it the way the web container's nginx does (its MIME table, `nosniff`),
and drives it with Playwright against a stand-in for the archive routes of the API. It needs no database, Docker or
agent. It proves what jsdom cannot: the archive worker and PDF.js's worker load as module workers with nginx's types,
nested archives open, preview (canvas, PDF, legacy images) and download with exact bytes, no request leaves the
origin, no console error is logged, and the page stays responsive while the worker indexes archives of 1 to 64 MiB.

It launches Edge, then Chrome. Elsewhere, name a Chromium binary:

```powershell
$env:EMUCAT_BROWSER_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
pnpm --filter @emucat/web test:browser
```

```bash
EMUCAT_BROWSER_PATH=/usr/bin/chromium pnpm --filter @emucat/web test:browser
```

`EMUCAT_BROWSER_SCREENSHOTS=<directory>` also saves screenshots and the measurements as `measurements.json`.

The same command runs `e2e/version-history.browser.test.ts` (decision 0059). It builds the **whole** application into
`apps/web/e2e/dist-app` (ignored by Git), serves it with nginx's `try_files … /index.html` fallback, and answers only
the routes Version History reads, from the synthetic histories in `e2e/version-history-fixtures.ts`. It checks card
height and one toolbar row on a wide screen, tooltips on hover and keyboard focus, a disabled action's reason, the
Info panels inside the window and the focus returned on Escape, the dialogs each action opens, branch collapse, the
sidebar icons, both themes, no sideways scrolling at 390 px, Archive Explorer opening from **View contents**, no
request other than `GET`, and no console error. Its screenshots are named `version-history-*.png`, or with the prefix
in `EMUCAT_BROWSER_SCREENSHOT_PREFIX`, for before-and-after comparisons.

`e2e/operations.browser.test.ts` (decision 0060) uses the same build against a stand-in whose operations listing each
test sets: the spinner's animation (and 3 s under reduced motion), indicators within a card's one toolbar row, details
inside the window, several operations on a 390 px phone, both themes, endings with the tree read again, an unavailable
status and its recovery, and the General page. `EMUCAT_BROWSER_DIST=<built app> EMUCAT_BROWSER_CAPTURE_ONLY=1` captures
only General from another build, for before-and-after screenshots.

## Linux validation from Windows

The API runs on Linux in production, so the platform-specific assertions are also run there, from a Windows checkout,
with Docker. Both commands copy the checkout into the container, so that the Windows `node_modules` and `target` are
never used, and run the tests as an unprivileged user (UID 1000), since root would pass permission checks that a real
account fails. Run them from the repository root in PowerShell, with `pnpm db:up` done and nothing else using MariaDB:
a MariaDB shared with another test run is slowed by every database's migrations, and tests then time out in their
setup.

The whole API suite, on the development MariaDB's network (`emucat_default`, where it is `emucat-mariadb-1:3306`). The
root password comes from the copied `.env`, and nothing is printed:

```powershell
docker run --rm --network emucat_default -v "${PWD}:/src:ro" -e DB_HOST=emucat-mariadb-1 -e DB_PORT=3306 -e CI=true node:22.22.3-bookworm-slim bash -c 'set -e; corepack enable; mkdir /work; tar -C /src --exclude=node_modules --exclude=target --exclude=.git -cf - . | tar -C /work -xf -; chown -R node:node /work; su node -c "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /work && pnpm install --frozen-lockfile && pnpm build:contracts && cd apps/api && npx vitest run"'
```

The agent's packaging tests, whose `#[cfg(unix)]` module covers symbolic links, odd names and the media area:

```powershell
docker run --rm -v "${PWD}/agent:/src:ro" rust:1-bookworm bash -c 'set -e; useradd -m t; mkdir /work; tar -C /src --exclude=target -cf - . | tar -C /work -xf -; chown -R t /work; su t -c "export PATH=/usr/local/cargo/bin:\$PATH CARGO_HOME=/usr/local/cargo; cd /work && cargo test --test packaging"'
```

Not every agent test applies on Linux: the agent is a Windows program, and stores its credential with DPAPI. On Linux,
six command-line tests of `tests/ova_import.rs` fail before any import runs, with "no secure credential store is
implemented for linux yet". That is a limit of the agent, not of the code under test.

## Troubleshooting

| Symptom                                                 | Cause and remedy                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Database tests need MARIADB_ROOT_PASSWORD`             | No `.env`: run `pnpm env:init`, then `pnpm db:up`                                                                                                                                                         |
| `Cannot connect to MariaDB for tests`                   | MariaDB is not running: `pnpm db:up`                                                                                                                                                                      |
| API tests time out (`Test timed out in 30000ms`)        | MariaDB is shared or overloaded: run one suite at a time, and keep the default worker count (see "API test workers"). Each test applies every migration to a database of its own, and that DDL serializes |
| `Too many connections`                                  | Too many API test workers: lower `EMUCAT_API_TEST_WORKERS` (default 2 on Windows, 4 elsewhere)                                                                                                            |
| e2e: `Cannot connect to 127.0.0.1:<port>: Disconnected` | An SFTP test image built before `PerSourcePenalties no`: remove `emucat-sftp-test:local` (`docker image rm emucat-sftp-test:local`); the tests build it again                                             |
| e2e: `Build the agent first`                            | Run the suite with `pnpm test:e2e`, which builds the agent, or `cargo build --manifest-path agent/Cargo.toml` first                                                                                       |
| e2e: a browser element times out                        | Run again with `EMUCAT_E2E_ARTIFACTS` set, and read the saved page, DOM and console for that test                                                                                                         |
| `pnpm test:compose` or `test:deploy` fails to start     | Docker Desktop is not running, or Git Bash is not installed                                                                                                                                               |

Interrupted runs can leave `emucat_test_*` databases behind. They hold no connections and no test reads them again.

## Known environment limitations

- The e2e suite runs on Windows only: it drives the Windows agent, with DPAPI and Windows paths.
- On Windows, a file symbolic link cannot be created without Developer Mode, and Node has no `O_NOFOLLOW`, so the
  notes test that a file link is refused runs on Linux only.
- File permission bits do not exist on Windows; their exact values are checked on Linux only.
- The real-OVA tests (`archive-explorer-real-ova.test.ts`, and the real-OVA case of `tar-termination.test.ts`) run
  only when `EMUCAT_OVA_FIXTURE` names a local OVA file; no OVA is in the repository.
