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

Measured on the Windows workstation for M0.2 (14 cores, 16 GB, Docker Desktop), as a guide to what a run costs:

| Suite                                    | Tests (passed, skipped or ignored)                                                             | Wall time    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| `pnpm test` (all packages and agent)     | contracts 456; deployer 51; web 657; API 1,245 passed, 2 skipped; agent 619 passed, 27 ignored | about 27 min |
| Agent alone (`cargo test`)               | 619 passed, 27 ignored                                                                         | 1.5–2.5 min  |
| `pnpm test:e2e`                          | 100 passed, 1 skipped                                                                          | 6–10 min     |
| `pnpm --filter @emucat/web test:browser` | 28 passed                                                                                      | about 40 s   |

The full counts of every suite are in the M0.2 report (`docs/reports/emucat-m0-2-cross-platform-test-baseline-stabilization-report.md`).

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

**An effect is awaited, not assumed.** What a React component does in an effect (an event it dispatches, a request it
makes) runs after the render that shows its result is committed, and Testing Library's `findBy…` can return in
between when the machine is busy. Wait for the effect itself (`await waitFor(() => expect(spy).toHaveBeenCalled())`),
then assert how often it happened.

**A fixture follows the product's sequence.** A test that calls a step of a larger operation sets the world up the
way that operation leaves it. For example, `MediaSync::detach_pending` is called just before a VM directory is
deleted, so a test that calls it deletes the directory too; otherwise the running synchronizer may also find the
screenshot there.

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

Each file builds what it serves first, with `runVite` from [`e2e/vite-build.ts`](../apps/web/e2e/vite-build.ts): the
Vite command line of this workspace's `node_modules`, run by the Node.js running the tests. No shell and no `npx` is
involved, so it starts the same way on Windows and Linux, nothing is downloaded, arguments keep their boundaries
(paths with spaces included), and a failed build fails the file. (`npx` is `npx.cmd` on Windows, which cannot be
started without a shell: the suite used to stop at `spawnSync npx ENOENT`.) `test/e2e-vite-build.test.ts`, part of
`pnpm test`, checks the launcher on both platforms.

The browser itself is not downloaded either: Playwright's `playwright-core` drives an installed one. No
`playwright install` is needed or used. It launches Edge, then Chrome. Elsewhere, name a Chromium binary:

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
account fails. Run them from the repository root in Git Bash (Windows PowerShell 5.1 drops the double quotes inside
the `bash -c` script, so the container runs something else), with `pnpm db:up` done and nothing else using MariaDB:
a MariaDB shared with another test run is slowed by every database's migrations, and tests then time out in their
setup.

The whole API suite, on the development MariaDB's network (`emucat_default`, where it is `emucat-mariadb-1:3306`). The
root password comes from the copied `.env`, and nothing is printed:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network emucat_default -v "$(pwd -W):/src:ro" -e DB_HOST=emucat-mariadb-1 -e DB_PORT=3306 -e CI=true node:22.22.3-bookworm-slim bash -c 'set -e; corepack enable; mkdir /work; tar -C /src --exclude=node_modules --exclude=target --exclude=.git -cf - . | tar -C /work -xf -; chown -R node:node /work; su node -c "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /work && pnpm install --frozen-lockfile && pnpm build:contracts && cd apps/api && npx vitest run"'
```

The whole agent suite. Its tests read the shared fixtures of `packages/contracts/fixtures` (`include_str!`), so
those are copied with `agent/`; `--cpus` keeps the build from starving anything else running:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --cpus=4 --memory=6g -v "$(pwd -W):/src:ro" rust:1-bookworm bash -c 'set -e; useradd -m -u 1000 t; mkdir /work; tar -C /src --exclude=node_modules --exclude=target --exclude=.git -cf - agent packages/contracts/fixtures | tar -C /work -xf -; chown -R t:t /work; su t -c "export PATH=/usr/local/cargo/bin:\$PATH CARGO_HOME=/usr/local/cargo; cd /work/agent && cargo test --locked --no-fail-fast"'
```

Add `--test packaging` (for example) after `--no-fail-fast` to run one file; `cargo build --examples` first if that
file starts `fake_vboxmanage` or `fake_emulator`, since only a whole-suite `cargo test` builds the examples.

### Agent tests that do not apply on Linux

The agent is a Windows program. On Linux it builds, and nearly all of its tests run there too, but
these are ignored off Windows, with the reason in the attribute, so that `cargo test` lists them as `ignored` rather
than hiding them. Each runs on Windows, and in CI's Windows job:

| Tests                                                                                                                                                                                                                                       | Why they cannot run on Linux                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6 in `tests/ova_import.rs` `command_line` (pairing, credentials, exit codes 4, 5, 6)                                                                                                                                                        | They run the real `emucat-agent import-ova`, which must first read the agent's credential. The agent stores it with DPAPI, on Windows only (decision 0009); elsewhere `platform_store` refuses everything, so these commands cannot be paired. `without_a_credential_store_the_command_says_so_and_exits_4` (Linux only) proves what happens there instead  |
| `tests/registration.rs`: `a_replaced_directory_is_not_the_one_that_was_archived`, `a_substituted_directory_with_the_same_screenshot_is_refused`; `tests/restore.rs`: `a_directory_that_is_not_this_restores_is_never_touched_after_a_crash` | They delete a directory and create another one with the same name, and expect the agent to see that it is not the same directory. On Linux its identity is (device, inode), and a new directory often gets the inode just freed (13 times in 20 in a container), so the check cannot tell them apart; NTFS file IDs change. Root or not makes no difference |

Everything else passes on Linux, as UID 1000 and as root alike. Run it as an unprivileged user anyway: it is the
account the agent's permission checks are written for.

**Cargo's build-directory layout.** From Cargo 1.100, test executables are no longer in `target/<profile>/deps` but in
`target/<profile>/build/emucat-agent/<hash>/out`, while examples stay in `target/<profile>/examples`. Tests that start
an example find it with `example()` in [`agent/tests/support/mod.rs`](../agent/tests/support/mod.rs), which works with
either layout; never derive its path from `current_exe()` by a fixed number of `parent()` calls.

**Fakes run concurrently.** The agent starts several `fake_vboxmanage` commands at once, and each appends to the same
call log. A line must be written with one `write_all` of the whole line: `writeln!` writes its pieces separately, and
two processes then interleave them into one unreadable line.

## ZIP64 archives

`apps/api/test/zip64.test.ts` covers the server's ZIP64 reading and rewriting ([decision 0061](decisions/0061-zip64-duplicate-records.md)),
including archives beyond 4 GiB and files of 3.75 GiB or more. Those archives are virtual: their zeros are produced
only when read (`buildZip64Layout` in `test/archive-sources.ts`), so the suite writes no large file. It takes about 17
seconds, mostly computing the CRC and SHA-256 of 4 GiB of zeros, once per length.

To check a real, large archive through the same code, which the normal suite never does, run on a copy you can read:

```powershell
pnpm --filter @emucat/api exec tsx test/tools/validate-zip-archive.ts C:\path\to\archive.zip
```

It prints the resolved central directory, inspects the archive against its own manifest, and hashes every file up to
64 MiB (`--hash-max <bytes>` changes that; larger files have their first 4 MiB read through the extraction path).
`--rewrite <target.zip> <new VM name>` also writes a server clone of it and checks that too: the target must not
exist, and needs as much free space as the archive. The archive itself is only read.

The browser-local reader of nested archives follows the same policy (decision 0061, "The browser-local reader").
`apps/web/test/archive-local/zip64.test.ts` mirrors the server's cases one for one, and adds the browser's own limits
on resolved values (a small archive declaring 5 GiB, a size that lies, the memory budget, the depth limit, nested
ZIP64 inside ZIP and ZIP64). `zip64Layout` in `apps/web/test/archive-local/fixtures.ts` builds those archives in
memory with exactly the ZIP64 records asked for (`agent`: the placeholder record, then the real one; `single`; `none`;
or raw records from `zip64Data`), so they are a few KiB each. `test/archive-nested.test.tsx` opens one through the
interface. Both run with the rest of the web suite:

```bash
pnpm --filter @emucat/web exec vitest run test/archive-local/zip64.test.ts test/archive-nested.test.tsx
```

## Troubleshooting

| Symptom                                                 | Cause and remedy                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Database tests need MARIADB_ROOT_PASSWORD`             | No `.env`: run `pnpm env:init`, then `pnpm db:up`                                                                                                                                                                                            |
| `Cannot connect to MariaDB for tests`                   | MariaDB is not running: `pnpm db:up`                                                                                                                                                                                                         |
| API tests time out (`Test timed out in 30000ms`)        | MariaDB is shared or overloaded: run one suite at a time, and keep the default worker count (see "API test workers"). Each test applies every migration to a database of its own, and that DDL serializes                                    |
| `Too many connections`                                  | Too many API test workers: lower `EMUCAT_API_TEST_WORKERS` (default 2 on Windows, 4 elsewhere)                                                                                                                                               |
| e2e: `Cannot connect to 127.0.0.1:<port>: Disconnected` | An SFTP test image built before `PerSourcePenalties no`: remove `emucat-sftp-test:local` (`docker image rm emucat-sftp-test:local`); the tests build it again                                                                                |
| e2e: `Build the agent first`                            | Run the suite with `pnpm test:e2e`, which builds the agent, or `cargo build --manifest-path agent/Cargo.toml` first                                                                                                                          |
| e2e: a browser element times out                        | Run again with `EMUCAT_E2E_ARTIFACTS` set, and read the saved page, DOM and console for that test                                                                                                                                            |
| `pnpm test:compose` or `test:deploy` fails to start     | Docker Desktop is not running, or Git Bash is not installed, or `bash` is WSL's (`C:\Windows\system32\bash.exe`, error `failed to connect to the docker API at unix:///var/run/docker.sock`): put `C:\Program Files\Git\bin` first on `PATH` |

Interrupted runs can leave `emucat_test_*` databases behind. They hold no connections and no test reads them again.

## Targeted regression commands

Run from the repository root in PowerShell, with the fnm Node.js on `PATH`:

```powershell
# The ZIP64 regressions of decision 0061, server and browser
pnpm --filter @emucat/api exec vitest run test/zip64.test.ts test/archive-explorer.test.ts test/clones.test.ts
pnpm --filter @emucat/web exec vitest run test/archive-local/zip64.test.ts test/archive-nested.test.tsx
# The browser launcher and the screenshot announcement
pnpm --filter @emucat/web exec vitest run test/e2e-vite-build.test.ts test/capture.test.tsx
# The agent tests made deterministic in M0.2
cargo test --manifest-path agent/Cargo.toml --lib qmp::
cargo test --manifest-path agent/Cargo.toml --test media a_spooled_screenshot_the_server_no_longer_accepts_is_given_up
cargo test --manifest-path agent/Cargo.toml --test virtualbox_management
# One e2e file (it runs the file's whole scenario)
cd apps/api; npx vitest run --config e2e/vitest.config.ts e2e/restore.e2e.test.ts -t "public cover"
```

The full regression, one suite at a time (the API and e2e suites must not share MariaDB):

```powershell
pnpm lint
pnpm check
pnpm test
pnpm test:e2e
pnpm --filter @emucat/web test:browser
pnpm test:sftp
pnpm test:deploy
pnpm test:compose
pnpm build
```

## Test resources left behind

A complete run leaves nothing of its own: databases, containers (`emucat-e2e-*`, `emucat-smoke-*`), temporary
directories and browser processes are removed by the tests. What may remain, and is safe to remove by hand once no
suite is running:

| Resource                                       | Left by                                | Remove with                                                  |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `emucat_test_*` databases                      | An interrupted API or e2e run          | `DROP DATABASE` each one, after checking no suite is running |
| `apps/web/e2e/dist`, `apps/web/e2e/dist-app`   | `test:browser` (ignored by Git)        | Nothing needed; the next run replaces them                   |
| `emucat-sftp-test:local`, `emucat-deploy-test` | `test:sftp`, `test:e2e`, `test:deploy` | Kept on purpose, as a build cache                            |

Never use `docker system prune` or `docker volume prune` on the workstation: they would also remove the development
MariaDB volume (`emucat_mariadb-data`) and unrelated containers.

## Known environment limitations

- The e2e suite runs on Windows only: it drives the Windows agent, with DPAPI and Windows paths.
- The agent tests listed under "Agent tests that do not apply on Linux" are ignored off Windows.
- On Linux, building the agent's library warns that `process::same_image` is never used (it serves the Windows
  launcher only). `cargo clippy --all-targets -- -D warnings`, as CI's Ubuntu job runs it, turns that warning into an
  error. Left as a follow-up: the fix is in agent source, outside a test-only change.
- On Windows, a file symbolic link cannot be created without Developer Mode, and Node has no `O_NOFOLLOW`, so the
  notes test that a file link is refused runs on Linux only.
- File permission bits do not exist on Windows; their exact values are checked on Linux only.
- The real-OVA tests (`archive-explorer-real-ova.test.ts`, and the real-OVA case of `tar-termination.test.ts`) run
  only when `EMUCAT_OVA_FIXTURE` names a local OVA file; no OVA is in the repository.
