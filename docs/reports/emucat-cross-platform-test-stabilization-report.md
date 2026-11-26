# EmuCat — Cross-platform test suite stabilization: report

Branch `develop`, Windows 11 developer workstation, with Linux validation in Docker containers. Every failure of the
reference baseline was reproduced, given a root cause and resolved; five further defects that the work uncovered were
resolved too. One of the baseline failures was a real product defect, fixed in the API.

## 1. Executive summary

| Suite         | Baseline               | Final                        |
| ------------- | ---------------------- | ---------------------------- |
| API           | 1,209 passed, 5 failed | 1,216 passed, 0 failed       |
| Agent (Rust)  | 617 passed, 1 failed   | 619 passed, 0 failed         |
| E2E           | 84 passed, 16 failed   | 100 passed, 0 failed (twice) |
| Compose smoke | 47 passed, 1 failed    | 48 passed, 0 failed          |

- **One product defect** (R2, Archive Explorer): a request cancelled while its version record was read from the
  database started an archive load with nobody waiting for it. Nothing could abort it; it read the archive for no one
  and cached the result. Fixed with one check in `apps/api/src/archives/inspection.ts`, and covered by three
  deterministic tests that replace the timing-based one.
- **Platform differences** (5): directory links, file links, POSIX modes and the temporary directory on Windows, and
  the Compose ownership check. Each now makes the equivalent check on Windows; every Linux assertion is unchanged and
  was run on Linux.
- **Obsolete expectations** (14), plus 3 failures that only followed from them: tests written before decision 0051
  (screenshots are not VM state) and decision 0054 (one route per VM section), and gallery labels that changed with
  them. They were rewritten to prove the current behaviour, never deleted or loosened.
- **Fixture and synchronization defects** found on the way (4): OpenSSH's per-source penalties in the SFTP test image
  locking every later connection out after a `docker pause`; a registration test that could miss a fast upload; two
  web assertions that read an effect's result before React ran it; an ambiguous selector.
- **Production code** changed in one file, for the defect above. The agent, the web application, deployment tooling,
  Compose files, configuration and migrations are unchanged. Mars needs an `emucatctl update` (section 24); deployed
  Windows agents do **not** need an update.

## 2. Starting branch and commit

| Item          | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Branch        | `develop`, tracking `origin/develop`                          |
| Starting HEAD | `898dea0` docs: OVA Archive Explorer compatibility fix report |
| `origin/main` | `b695fea`, unchanged by this session                          |
| Git identity  | `david`, the established author and committer                 |

## 3. Development environment

| Item           | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| OS             | Windows 11 Home 10.0.26200, 20 logical CPUs                                           |
| Node.js        | 22.22.3 (fnm, not on the default `PATH`)                                              |
| pnpm           | 12.10.1                                                                               |
| Rust           | cargo/rustc 1.99.0 (Windows); rustc 1.100.0 in the `rust:1-bookworm` Linux container  |
| Docker         | Docker Desktop, engine 29.9.3, Compose 5.7.0, WSL 2 backend                           |
| MariaDB        | `emucat-mariadb-1` (`mariadb:11.8`), `127.0.0.1:3307`, network `emucat_default`       |
| Browser        | Microsoft Edge, headless, through `playwright-core`                                   |
| Emulators      | QEMU and 86Box installed (their e2e tests ran); VirtualBox installed (opt-in e2e ran) |
| Developer Mode | Off. Not needed: see section 13                                                       |

## 4. Reproduced baseline

All four reference results were reproduced exactly before any change: API 1,209 passed and 5 failed (2 skipped,
the opt-in real-OVA tests), agent 617 passed and 1 failed, e2e 84 passed, 16 failed and 1 skipped (the opt-in VirtualBox
file), Compose 47 passed and 1 failed. The contracts (448), web (556) and deployer (51) suites passed.

## 5. Complete inventory of failing tests

| #   | Suite   | Test                                                                                                                                 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | API     | `notes.test.ts` › VM notes › starts empty, then creates, reads, updates and clears one Markdown file                                 |
| A2  | API     | `notes.test.ts` › VM notes › never follows a link out of the notes root, for reads or writes                                         |
| A3  | API     | `notes.test.ts` › NotesStorage › refuses a notes root that is a link                                                                 |
| A4  | API     | `archive-explorer.test.ts` › resources › reads only what it needs from a large archive, and writes nothing anywhere                  |
| A5  | API     | `archive-explorer.test.ts` › index cache › shares one load between requests, which can each give up without stopping the others (R2) |
| R1  | Agent   | `packaging.rs` › `links::a_junction_inside_the_screenshots_directory_is_refused_too`                                                 |
| E1  | E2E     | `execution` › QEMU › launches real QEMU from the browser, and shows it running                                                       |
| E2  | E2E     | `execution` › 8. runs a historical snapshot in Remote Snapshot from the version history, and branches from it                        |
| E3  | E2E     | `execution` › 13. shows the restore history as a table with an accessible details dialog, at any width                               |
| E4  | E2E     | `media` › transfers a VM once the server holds its screenshots, deleting the local copy                                              |
| E5  | E2E     | `media` › keeps the VM when a screenshot cannot be preserved, and removes it after that is fixed                                     |
| E6  | E2E     | `media` › keeps the VM when its screenshot is rejected by the server                                                                 |
| E7  | E2E     | `media` › keeps the VM when the API is away at the moment of proof                                                                   |
| E8  | E2E     | `media` › sends no screenshot through the repository, and no archive through the API                                                 |
| E9  | E2E     | `registration` › keeps a VM whose screenshot cannot be preserved, and archives none in a copy                                        |
| E10 | E2E     | `restore` › browses with the keyboard, traps focus, and returns it                                                                   |
| E11 | E2E     | `restore` › shows an administrator every screenshot, with controls and the same viewer                                               |
| E12 | E2E     | `restore` › restores through the web interface, with progress and the result on screen                                               |
| E13 | E2E     | `restore` › removes the local copy from the real page, and nothing else                                                              |
| E14 | E2E     | `restore` › permanently deletes the leaf snapshot from SFTP through the real page, and keeps its history                             |
| E15 | E2E     | `restore` › records an archive that is already gone as already absent                                                                |
| E16 | E2E     | `restore` › keeps a deletion that the SFTP server interrupts, and finishes it on a retry                                             |
| C1  | Compose | notes files the API writes belong to UID/GID 1000                                                                                    |

Found during the work, not in the baseline:

| #   | Suite | Test or component                                                                                               |
| --- | ----- | --------------------------------------------------------------------------------------------------------------- |
| N1  | E2E   | `restore` › interruptions: after a `docker pause`, every later SFTP connection failed with `Disconnected`       |
| N2  | E2E   | `registration` › survives an API restart during an upload, without any false success (missed a fast upload)     |
| N3  | Web   | `notes-clone.test.tsx` › shows an empty document, then edits, saves… (read the editor's teardown too early)     |
| N4  | API   | `archive-explorer.test.ts` › keeps indexes within their count and byte budget (an exact `stats()` shape, see 7) |
| N5  | API   | Timeouts of unrelated tests in one full run: worker count and database contention, see 17 and 18                |

## 6. Root cause of each failure

| #       | Category                         | Root cause                                                                                                                                                                                                                                                                                           |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1      | Platform difference              | Asserted mode `0o640`; Windows has no permission bits (Node reports `0o666`)                                                                                                                                                                                                                         |
| A2, A3  | Platform difference              | Created directory and file symbolic links: `EPERM` without Developer Mode. Junctions work for any account and `lstat` reports them as links; Node has no `O_NOFOLLOW` on Windows                                                                                                                     |
| A4      | Environment / platform           | Redirected `TMPDIR` only. `os.tmpdir()` reads `TEMP`/`TMP` on Windows, so the "writes nothing" check looked at the wrong directory                                                                                                                                                                   |
| A5      | **Product defect**               | An abort that landed while `inspected()` awaited the version record was not re-checked, so a load started with no waiter: unabortable, a full read for no one, then cached. The old test raced it by timing                                                                                          |
| R1      | Obsolete expectation             | Decision 0051 sets the 86Box `screenshots` tree aside before archive rules; `f851975` updated the Unix test but not this Windows one, which still expected a refusal                                                                                                                                 |
| E1      | Obsolete expectation             | The gallery moved to the VM's Screenshots section (0054); the test waited for it on General                                                                                                                                                                                                          |
| E2      | Obsolete expectation             | Version cards are on `…/versions` (0054); choosing Run there opens General                                                                                                                                                                                                                           |
| E3      | Obsolete expectation             | General holds Metadata, Details, Run and verify only; copies and the restore history are on `…/copies`; "Manage media" became the sidebar's Screenshots                                                                                                                                              |
| E4–E7   | Obsolete expectation             | Decision 0051: transfers no longer wait for, or are refused by, screenshots; pending ones are spooled and uploaded after the directory is removed                                                                                                                                                    |
| E8      | Follow-on                        | E7 failed with the API stopped, so the next test met a closed Fastify instance                                                                                                                                                                                                                       |
| E9      | Obsolete expectation             | As E4–E7: the transfer succeeds, and no screenshot is archived                                                                                                                                                                                                                                       |
| E10     | Obsolete expectation             | Selected a thumbnail by position (`Screenshot 2 of`); the main cover is labelled by its role and is not first                                                                                                                                                                                        |
| E11     | Obsolete expectation (+ fixture) | A public VM opens on its public page; **Manage this VM** then the sidebar lead to Screenshots. `/c-third/` also matched the newer `Tags of …` button                                                                                                                                                 |
| E12–E14 | Obsolete expectation             | Restore and copy removal are on `…/copies`, version deletion on `…/versions`                                                                                                                                                                                                                         |
| E15–E16 | Follow-on                        | `409 local_copy_exists`, left by E13                                                                                                                                                                                                                                                                 |
| C1      | Platform difference              | Read the owner with the host's `stat`; on Windows that reports the Windows account, never a container UID                                                                                                                                                                                            |
| N1      | Fixture defect                   | OpenSSH ≥ 9.8 `PerSourcePenalties`: freezing the container crashed a pre-auth child (signal 31), and sshd then refused the Docker gateway address, from which every host connection comes, for the rest of the file                                                                                  |
| N2      | Timing defect                    | Polled for `uploading`; a 128 MiB upload to a local container can finish between two polls                                                                                                                                                                                                           |
| N3      | Timing defect                    | The editor is destroyed in an effect cleanup, which React runs after the commit the test waited for                                                                                                                                                                                                  |
| N4      | Defect introduced, then fixed    | This session added `waiting` to `CacheStats`; one `toEqual` still listed the old shape. Found by the Linux run                                                                                                                                                                                       |
| N5      | Environment / timing             | With the default of 4 API test workers, about 50 tests ran within a factor of two of the 30 s timeout on this workstation: each test creates a database and applies every migration, and that DDL serializes. In one run, 9 unrelated tests timed out. Measured with 4, 2 and 1 workers (section 17) |

## 7. API corrections

- `apps/api/test/platform.ts` (new): `linkDirectory` (a junction on Windows, a symbolic link elsewhere, checked to be
  a link), `fileLinksRefusable`, `expectFileMode` (exact bits on POSIX; a regular writable file on Windows),
  `redirectTemporaryDirectory` (`TMPDIR`, `TEMP` and `TMP`, checked through `os.tmpdir()`, restored afterwards).
- `notes.test.ts`: A1–A3 use the helpers. The notes-file-link sub-case runs where a file link can be refused (POSIX),
  with a comment saying why; the directory-link cases run on both.
- `archive-explorer.test.ts` and `archive-explorer-real-ova.test.ts`: the temporary directory is redirected for all
  three variables, inside `try`/`finally`.
- `archive-explorer.test.ts`: the R2 test is replaced by three (section 12); the budget test lists `waiting` (N4).
- `sftp-server.ts`: `holdReads(after)` and `heldReads()` hold the server's READ answers until released.

## 8. Rust agent corrections

`agent/tests/packaging.rs`, `#[cfg(windows)] mod links`: R1 is replaced by two tests that state decision 0051 for
junctions:

- `junctions_among_the_screenshots_are_set_aside_and_never_followed`: a junction inside `screenshots`, and
  `Screenshots` itself as a junction; `scan_tree` archives one file, the archive holds exactly
  `.emucat-manifest.json` and `86box.cfg`, and the file the junction points at is untouched.
- `a_junction_in_a_directory_that_is_not_the_screenshots_tree_still_fails_the_archive`: `media/screenshots/more`,
  `screenshots-old/more` and `screenshot/more` each fail with `SourceErrorKind::Unsafe`, with empty staging.

The agent's source is unchanged, and so are the OVA import tests (decisions 0049 and 0057): `ova_import` passes on
Windows.

## 9. E2E corrections

Every failure was diagnosed from the page itself: `apps/api/e2e/artifacts.ts` (new) saves, for each failed test, every
open page's full screenshot, DOM, URL, console, page errors, failed requests and 4xx/5xx responses, when
`EMUCAT_E2E_ARTIFACTS` is set. Corrections:

- **Navigation (0054):** `restore` E11 goes Catalog › VM › **Manage this VM** › sidebar `navigation "VM"` ›
  Screenshots, waiting for each URL; E12–E14 open `…/copies` and `…/versions`. `execution` E1 reaches the gallery by
  the sidebar, E2 runs from `…/versions` and waits for General, E3 checks General's three headings and the sidebar,
  then opens Local copies and restore by the sidebar and checks the history there, at full width and on a phone.
- **Selectors:** E10 selects the main cover by its accessible name (`, the main cover`) and checks that focus returns
  to it; E11 matches the thumbnail by its full label.
- **Screenshot lifecycle (0051):** section 11.
- **Deterministic synchronization:** N2's hold (below); no sleep was added. The 12-second sleep of the old E7 is gone:
  the new test waits for the removal itself.
- **Isolation:** each test uses its own VM names, closes its contexts in `finally`, and restarts what it stopped; the
  registration file now always releases a held upload in `afterEach`.

N1: `infra/docker/sftp-test/entrypoint.sh` sets `PerSourcePenalties no` in the test image only, with the reason. The
sshd log showed `mm_reap: preauth child terminated by signal 31` and then `drop connection … penalty: caused crash`
for each later attempt.

N2: `registration.e2e.test.ts` gains `holdUploads()`: a watcher inside the container stops the SFTP sessions (SIGSTOP)
as soon as the staging archive has its first bytes, and `releaseUploads()` lets them go on (SIGCONT). It is started
before the registration, so it cannot miss the upload. The seven tests that act during an upload use it, and release
it right after their action (closing the API, killing the agent or its sessions, cancelling, revoking).

**Archive Explorer coverage** has no browser e2e test; it is the API integration suite against a real SFTP server
(ZIP and OVA inspection, text, image, PDF and hex previews, single-file download, cancellation, resource limits,
read-only access), the web component tests, and the opt-in real-OVA tests, all run in section 17.

## 10. Docker Compose corrections

`deploy/test/compose-smoke.sh`: on Linux the notes owner is still read on the host with `stat -c %u:%g`. On Windows
(Git Bash, detected by `cygpath`, the script's existing test), it is read with `stat` inside the replaced API
container. Docker Desktop records a bind-mounted file's Linux owner as metadata (drvfs `metadata` option), so that
value is the one the API wrote. A control proved the check can fail: a file written as root through the same kind of
mount reads `0:0` from a later container.

## 11. Screenshot lifecycle test alignment

Decision 0051 removed every screenshot gate on transfers and removals, and added the spool. The old tests pinned the
gates; the new ones prove what replaced them:

| Old test (pinned before 0051)                                  | New test (proves 0051)                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| transfers a VM once the server holds its screenshots           | transfers at once; both screenshots still arrive from the spool, byte-identical, and the spool empties; the archive holds the other file and no `.ppm`                   |
| keeps the VM when a screenshot cannot be preserved             | an 86Box VM whose tree holds a non-image transfers; the master exists; nothing of the tree is archived; the image arrives, the non-image is never offered                |
| keeps the VM when its screenshot is rejected by the server     | transfers; the spooled copy is offered, refused, and ended: the spool empties and the catalog shows nothing                                                              |
| keeps the VM when the API is away at the moment of proof       | with the API stopped after the commit, the removal finishes, the screenshot is held in the spool (exactly one file), and once the API is back it arrives, byte-identical |
| keeps a VM whose screenshot cannot be preserved (registration) | the transfer succeeds, its archive holds the VM files and no screenshot; a copy also archives no screenshot and leaves the source unchanged                              |

## 12. Cancellation race resolution

The old R2 test aborted one of two requests after a delay and hoped the load was still running. It now uses held
reads, and three tests cover every point the task names:

| Point                           | Test and evidence                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Before repository access        | Test 3: an already-aborted signal rejects; an abort during the record read rejects, with no load, no read, no connection |
| During repository access        | Test 2, held at read 0                                                                                                   |
| During index construction       | Test 2, held halfway and at the last read (the manifest the index is built from)                                         |
| After completion                | Test 1: aborting after the answer changes nothing; the index stays cached                                                |
| One of the coalesced requesters | Test 1: `loading 1, waiting 1` after one leaves; the other gets its answer                                               |
| All coalesced requesters        | Test 2: both reject at once, the load stops while its read is still held, nothing is cached, no connection is left       |

Every step waits on a state (`stats().waiting`, `heldReads()`), with a deadline; none waits on time. Without the
product fix, test 3 fails (an orphan load). Repetitions: section 18.

## 13. Windows-specific filesystem handling

| Subject           | Linux (unchanged)                      | Windows                                                                     |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Directory link    | Symbolic link                          | Junction; `lstat().isSymbolicLink()` is true, as the code under test checks |
| File link         | Symbolic link, refused by `O_NOFOLLOW` | Not created: needs Developer Mode, and Node has no `O_NOFOLLOW`             |
| Mode bits         | Exactly `0o640`                        | A regular, writable file                                                    |
| Temporary dir     | `TMPDIR`                               | `TEMP`, `TMP`                                                               |
| Agent links       | `#[cfg(unix)]` symbolic links          | `#[cfg(windows)]` junctions through `mklink /J`                             |
| Compose ownership | Host `stat`                            | `stat` in the container, of Docker Desktop's recorded owner                 |

Developer Mode is not required by any test.

## 14. Linux validation and preserved assertions

Run in Linux containers from this checkout, as an unprivileged user (UID 1000), with the commands of
`docs/testing.md`:

| What                                                                | Result                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole API suite (`node:22.22.3-bookworm-slim`, development MariaDB) | 1,215 passed, 1 failed (N4, then fixed), 2 skipped (opt-in real OVA). After the N4 fix, `archive-explorer`, `notes`, `tar-termination` and `archive-inspection` again: 62 passed, 1 skipped (opt-in) |
| Notes: exact `0o640`, file link refused, directory links            | 16 of 16 passed                                                                                                                                                                                      |
| Archive Explorer, R2, temporary directory                           | passed                                                                                                                                                                                               |
| Agent `packaging` (`rust:1-bookworm`)                               | 26 passed, 1 ignored (the > 4 GiB test, run by `pnpm test:sftp`)                                                                                                                                     |
| Agent `ova_import`                                                  | 47 passed, 6 failed: the agent has no Linux credential store (section 22)                                                                                                                            |
| Compose ownership, host `stat` branch                               | Reviewed, unchanged; not executed: this workstation's Docker Engine is Docker Desktop                                                                                                                |

No Linux assertion was changed: the POSIX branches run exactly what ran before.

## 15. Test infrastructure improvements

`apps/api/test/platform.ts`; `holdReads`/`heldReads` on the in-process SFTP server; `holdUploads`/`releaseUploads` on
the e2e OpenSSH container; `apps/api/e2e/artifacts.ts`; `PerSourcePenalties no` in the test image; and
`docs/testing.md`, the developer testing guide (suites, prerequisites, rules for a test, platform semantics,
diagnosis, Linux commands, troubleshooting, limitations).

## 16. Production code changes

One file, `apps/api/src/archives/inspection.ts`:

```ts
const record = await this.record(vm, versionId);
// Cancelled while the record was read: start and join nothing. …
if (signal?.aborted) throw cancelledError();
```

and a `waiting` count in `CacheStats`, which only tests read (`stats()` has no caller in `src/`). Nothing else under
`apps/api/src`, `apps/web/src`, `agent/src`, `deploy/` (except the smoke test script), `apps/deployer` or the
migrations changed.

## 17. Before-and-after test results

### API test workers (N5)

The task asked for this to be settled by measurement, before any change to the test database lifecycle or to the
timeouts. The whole API suite, alone on an idle MariaDB, with `EMUCAT_API_TEST_WORKERS`:

| Workers           | Wall time | Median per test | p95 per test | p99 per test | Tests over 15 s | Timeouts |
| ----------------- | --------- | --------------- | ------------ | ------------ | --------------- | -------- |
| 4, run 1          | 1,286 s   | 81 ms           | 14.1 s       | 16.1 s       | 44              | 0        |
| 4, run 2          | 1,281 s   | 56 ms           | 14.5 s       | 16.7 s       | 50              | 0        |
| 4, in `pnpm test` | 1,400 s   | —               | —            | —            | —               | **9**    |
| 2                 | 1,380 s   | 37 ms           | 8.2 s        | 10.1 s       | 2               | 0        |
| 1                 | 1,616 s   | 25 ms           | 4.7 s        | 6.5 s        | 1               | 0        |

Wall time barely moves with the number of workers: the database's DDL is the bottleneck, and more workers mostly make
each test wait. With 4, the slowest five per cent of tests come within a factor of two of the 30 s test timeout, which
is why a run under a little more load lost 9. **2 workers is the Windows default from now on**
(`apps/api/vitest.config.ts`): 7% slower than 4, with p99 a third of the timeout. 1 worker gains little more margin for
26% more time. Linux keeps 4. The per-test database, every migration, and the 30 s timeout are unchanged. The tests over
25 s in the table are tests with timeouts of their own, slow at any worker count (24 s with 1 worker).

### Final runs

| Suite                    | Command                                                           | Result                                                                                                      |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Type checking            | `pnpm check`                                                      | Pass                                                                                                        |
| Linting                  | `pnpm lint` (ESLint, Prettier, `cargo fmt`, clippy `-D warnings`) | Pass (once this report was formatted)                                                                       |
| Contracts                | `pnpm test`                                                       | 448 passed                                                                                                  |
| Deployer                 | `pnpm test`                                                       | 51 passed                                                                                                   |
| Web                      | `pnpm test`                                                       | 556 passed                                                                                                  |
| API                      | `pnpm test` (2 workers)                                           | 1,216 passed, 2 skipped (opt-in real OVA)                                                                   |
| Agent                    | `pnpm test`, and `cargo test --no-fail-fast`                      | 619 passed, 0 failed, 27 ignored (opt-in or long; `test:sftp` runs those of `sftp`, `packaging`, `restore`) |
| SFTP, packaging, restore | `pnpm test:sftp` (ignored tests included)                         | 30, 100 and 21 passed                                                                                       |
| E2E                      | `pnpm test:e2e`, twice                                            | 100 passed, 1 skipped (opt-in VirtualBox), each time                                                        |
| E2E VirtualBox (opt-in)  | `EMUCAT_E2E_VBOXMANAGE` set                                       | 1 passed                                                                                                    |
| Real OVA (opt-in)        | `EMUCAT_OVA_FIXTURE` set                                          | 14 passed                                                                                                   |
| Deployment tooling       | `pnpm test:deploy`                                                | 46 and 3 passed, 0 failed                                                                                   |
| Compose                  | `pnpm test:compose`                                               | 48 passed, 0 failed                                                                                         |
| Linux API                | Section 14                                                        | 1,215 passed + N4 fixed and rerun: pass                                                                     |
| Linux agent packaging    | Section 14                                                        | 26 passed                                                                                                   |

## 18. Repeated execution and flakiness validation

| What                                | Repetitions                                            | Result                                                                                                           |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| R2 cancellation tests               | 20 runs on an idle MariaDB (final), 10 during the work | All passed, every run                                                                                            |
| R2 under load                       | 15 + 12 runs while the Linux suite also used MariaDB   | Some timed out in `serverWorld()` (database setup), never in the cancellation logic; traced with step timestamps |
| Whole API suite                     | 5 full runs (4, 4, 2, 1 workers, then `pnpm test`)     | 0 failures in every run on an idle MariaDB                                                                       |
| Whole e2e suite                     | 3 full runs (the first found N2), then 2 final         | Final two: 100 of 100                                                                                            |
| `registration` e2e after N2         | 1 file run, then the 2 full runs                       | 18 of 18 each time                                                                                               |
| `restore` e2e after N1              | The 2 full runs, the interruption group alone          | All passed                                                                                                       |
| Web `notes-clone.test.tsx` after N3 | 5 file runs, then `pnpm test`                          | 17 of 17 each time                                                                                               |

The R2 tests depend on no timing: they wait on states, each with a deadline. A run fails only if the database cannot
create a test's database within the 30 s test timeout, which is what N5 is about.

## 19. Production build results

| Build                 | Command                                                  | Result                                                              |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Workspace             | `pnpm build` (contracts, API, web, deployer)             | Pass                                                                |
| Windows release agent | `cargo build --release --manifest-path agent/Cargo.toml` | Pass, `agent\target\release\emucat-agent.exe`, `emucat-agent 0.1.0` |

The agent's source is unchanged (`git diff` of `agent/src`, `Cargo.toml` and `Cargo.lock` is empty), so the build is
the same program deployed agents run: **no agent update is required**.

## 20. Docker image build results

`pnpm test:compose` builds the production `api` and `web` images (`deploy/docker/*.Dockerfile`, target `runtime`) from
the working tree as `emucatctl` exports it, with the `inspection.ts` fix, runs them under `deploy/compose.yaml` against
a disposable MariaDB, checks them (48 checks) and removes them. Both built and passed. The SFTP test image
(`emucat-sftp-test:local`) was rebuilt with `PerSourcePenalties no` by the e2e and SFTP suites.

## 21. Important files changed

| File                                              | Kind       | Change                            |
| ------------------------------------------------- | ---------- | --------------------------------- |
| `apps/api/src/archives/inspection.ts`             | Production | R2 fix; `waiting` in `CacheStats` |
| `apps/api/test/platform.ts`                       | Test       | New: platform helpers             |
| `apps/api/test/notes.test.ts`                     | Test       | A1–A3                             |
| `apps/api/test/archive-explorer.test.ts`          | Test       | A4, R2 tests, N4                  |
| `apps/api/test/archive-explorer-real-ova.test.ts` | Test       | Temporary directory on Windows    |
| `apps/api/test/sftp-server.ts`                    | Test       | Held reads                        |
| `agent/tests/packaging.rs`                        | Test       | R1                                |
| `apps/api/e2e/artifacts.ts`                       | Test       | New: failure artifacts            |
| `apps/api/e2e/execution.e2e.test.ts`              | Test       | E1–E3                             |
| `apps/api/e2e/media.e2e.test.ts`                  | Test       | E4–E8                             |
| `apps/api/e2e/registration.e2e.test.ts`           | Test       | E9, N2                            |
| `apps/api/e2e/restore.e2e.test.ts`                | Test       | E10–E16                           |
| `apps/web/test/notes-clone.test.tsx`              | Test       | N3                                |
| `infra/docker/sftp-test/entrypoint.sh`            | Test image | N1                                |
| `deploy/test/compose-smoke.sh`                    | Test       | C1                                |
| `docs/testing.md`                                 | Docs       | New: testing guide                |
| `docs/reports/…-stabilization-report.md`          | Docs       | This report                       |

## 22. Known limitations

- On Linux, six command-line tests of `agent/tests/ova_import.rs` fail before any import code runs, because the agent
  has no Linux credential store ("no secure credential store is implemented for linux yet"). The agent is a Windows
  program; these tests are not gated to Windows. This predates the session, is outside the Windows baseline, and was
  left unchanged since the task preserves the OVA import tests; gating them is a small separate change.
- The Compose host-`stat` branch was reviewed, not executed: the workstation has no native Linux Docker Engine.
- The e2e suite runs on Windows only, by design.
- Interrupted or timed-out runs leave `emucat_test_*` databases; 65 such databases exist on the workstation. They were
  left in place, since some may predate the session, and no test reads them.
- The e2e tests are one scenario per file and depend on order within a file by design (the Vitest configuration says so); files are independent of each other, and of existing data.
- With more than 2 API test workers on this workstation, or with two suites sharing MariaDB, tests can time out in their database setup. The timeout and the per-test database were kept, as instructed.

## 23. Exact Windows test execution runbook

PowerShell, from the repository root, unless stated.

1. Repository synchronization and branch:

   ```powershell
   git fetch origin
   git switch develop
   git pull --ff-only
   git status
   ```

2. Node.js on `PATH` (each new shell), and toolchain:

   ```powershell
   $env:PATH = "$env:APPDATA\fnm\node-versions\v22.22.3\installation;$env:PATH"
   node -v; pnpm -v; cargo -V; docker version --format '{{.Server.Version}}'
   ```

3. Dependencies: `pnpm install`.
4. MariaDB, and `.env` once:

   ```powershell
   pnpm env:init
   pnpm db:up
   docker ps --filter name=emucat-mariadb --format '{{.Names}} {{.Status}}'
   ```

5. Configuration: none beyond `.env`. The API suite runs 2 test files at a time on Windows by default (section 17); `$env:EMUCAT_API_TEST_WORKERS` overrides it.
6. Docker Desktop running, Linux containers; Git for Windows installed (Git Bash). Developer Mode is **not** required.
7. Individual suites:

   ```powershell
   pnpm --filter @emucat/contracts test
   pnpm --filter @emucat/api test
   pnpm --filter @emucat/web test
   pnpm --filter @emucat/deployer test
   cargo test --manifest-path agent/Cargo.toml --no-fail-fast
   pnpm test:sftp
   pnpm test:e2e
   pnpm test:deploy
   pnpm test:compose
   ```

   `test:deploy` and `test:compose` run their scripts with `bash`, which is Git Bash on Windows.

8. Complete sequence, one suite at a time (two suites on one MariaDB slow each other's migrations):

   ```powershell
   pnpm check
   pnpm lint
   pnpm test
   pnpm test:sftp
   pnpm test:e2e
   pnpm test:deploy
   pnpm test:compose
   ```

9. Opt-in suites:

   ```powershell
   $env:EMUCAT_OVA_FIXTURE = "$env:USERPROFILE\Downloads\Xenix_386.ova"
   pnpm --filter @emucat/api exec vitest run test/archive-explorer-real-ova.test.ts test/tar-termination.test.ts
   Remove-Item Env:EMUCAT_OVA_FIXTURE
   $env:EMUCAT_E2E_VBOXMANAGE = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
   pnpm --filter @emucat/api exec vitest run --config e2e/vitest.config.ts e2e/virtualbox.e2e.test.ts
   Remove-Item Env:EMUCAT_E2E_VBOXMANAGE
   ```

   The OVA test only reads the file. The VirtualBox test only reads VirtualBox, and checks that every machine is in the
   same state afterwards.

10. Production builds:

    ```powershell
    pnpm build
    cargo build --release --manifest-path agent/Cargo.toml
    .\agent\target\release\emucat-agent.exe --version
    ```

11. Troubleshooting: `docs/testing.md`, "Troubleshooting".
12. Artifacts and logs: set `$env:EMUCAT_E2E_ARTIFACTS` to a directory for e2e failure artifacts; test output is the
    console's (redirect it with `*> file.log`); the SFTP container's sshd log is `docker logs <container>` while a test
    runs.

## 24. Mars deployment impact and instructions

| Question                                  | Answer                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Does the API runtime change?              | **Yes**: `inspection.ts` (the R2 fix)                                                   |
| Does the frontend runtime change?         | No (`apps/web/src` unchanged; only a web test changed)                                  |
| Does the Rust agent runtime change?       | No (`agent/src` unchanged; only `agent/tests/packaging.rs`)                             |
| Does deployment tooling change?           | No (`deploy/bin`, `deploy/systemd`, `apps/deployer` unchanged; `deploy/test` is a test) |
| Does Docker Compose configuration change? | No (`deploy/compose.yaml` unchanged)                                                    |
| New environment variables?                | No                                                                                      |
| Database migrations?                      | No (newest is still `0021_server_repository_access`)                                    |
| Existing deployment artifacts affected?   | The API image is rebuilt; the web image is rebuilt identical in content                 |
| Windows agent update?                     | **No.** Deployed agents keep working unchanged: no agent code or protocol changed       |

**Deployment is required** for the API fix, by `emucatctl update`. Mars: branch `develop`,
`https://emucat-test.dfri.info`, installation root `/opt/emucat`, Compose project `emucat`. `<commit>` is the tip of
`origin/develop` after this push (section 26); `<previous>` is what Mars runs now.

### 24.1 Before

On the workstation: `git fetch origin; git log -1 --format='%H %s' origin/develop` gives `<commit>`.

On Mars:

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Note the deployed commit as `<previous>`, for rollback (expected `898dea0…` or another commit of 0056/0057).

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

`Latest:` must be `<commit>`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Every line ok. Then confirm that the installed tooling is this release's, and that nothing the tooling installs
changed since the deployed commit:

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat "$(sudo sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' /opt/emucat/state/current-release.json | head -1)" refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml apps/deployer apps/api/migrations
```

- Expected: `tooling is current`, and the second command prints nothing. `emucatctl update` alone is then enough.
- Otherwise Mars runs a release older than 0055/0056: follow [runbook-0056-mars.md](../runbook-0056-mars.md) 19.1
  (which leads to the 0055 runbook if needed) first, and come back.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

### 24.2 Deployment

1. Repository checkout: not required (`update` fetches into `/opt/emucat/repo.git`).
2. Tooling refresh or `emucatctl install`: not required when 24.1 says the tooling is current.
3. Configuration, environment variables, Compose, reverse proxy, Cloudflare, SSH keys: no change.
4. Migrations: none.
5. Windows agents: no change, no rebuild, no update.
6. Update, the only required step:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. It builds the images, verifies, backs up the database, applies (no) migrations, recreates the
   containers and health-checks them. Admin › Application Updates does the same.

### 24.3 After

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

```bash
sudo docker inspect -f '{{.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1 emucat-web-1
```

Both `<commit>`.

```bash
sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}}'
```

Both `(healthy)`.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/health
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

No `Invalid configuration`, no unexpected errors.

### 24.4 Functional acceptance on Mars

| #   | Step                                 | How                                                                                                                         | Expected                                                                  |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Deployed commit                      | 24.3                                                                                                                        | `<commit>` on both containers                                             |
| 2   | Archive Explorer still works         | Catalog › a VM › Manage this VM › Version History › a version › **View contents…**; preview a text file; download one       | Listing, preview and download as before                                   |
| 3   | OVA still works (0057)               | The same on the Xenix 386 master                                                                                            | `Xenix 386.ovf`, `-disk001.vmdk`, `.mf` listed; the OVF previews          |
| 4   | Cancelling right away leaves nothing | On a large version not yet opened since the update, open **View contents…** and close the dialog immediately; open it again | The second opening lists normally; no error                               |
| 5   | Agents                               | Admin › Agents                                                                                                              | Every agent online as before, with its existing version: none was updated |
| 6   | Logs                                 | `sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 300 \| grep -E '"level":(50\|60)'`                                  | Nothing new                                                               |

Step 4 exercises the fixed path; its effect (no orphan load) is internal, and the automated tests prove it.

## 25. Rollback instructions

No migration, configuration or tooling change, so returning to the previous release is safe and needs no database
restore:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

`status` and the 24.3 `docker inspect` must show `<previous>`. Forward again: `sudo /opt/emucat/tooling/bin/emucatctl
update`. After a rollback, the R2 defect is back: a request cancelled at the wrong moment can make the API read one
archive for no one. No data is affected either way, since Archive Explorer only reads. A failed `update` leaves
`<previous>` running (it rolls back by itself when no migration was applied, the case here). Windows agents are not
involved in either direction.

## 26. Git commits and push confirmation

| Commit    | Subject                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `e39c41d` | fix(api): start no archive load for a request cancelled during its record read |
| `dfe8917` | test: stabilize the agent, e2e, web and Compose suites on Windows 11           |
| (next)    | docs: testing guide and cross-platform test stabilization report (this file)   |

All three are on `develop`, on top of `898dea0`, by the established `david` identity, and pushed to `origin/develop`.
`<commit>` for the Mars runbook is the tip of `origin/develop` after the push:
`git log -1 --format=%H origin/develop`. No feature branch was created, `main` (`b695fea`) is unchanged, and nothing
was deployed to Mars or Moon. The OVA fixture was only read: its size (23,498,240 bytes), modification time and SHA-256
(`881648a1…`) are as before, and neither it nor any extracted content is in the repository.

## Per-test resolution matrix

| Suite   | Test | Root cause                      | Correction                                                  | Windows result | Linux result or verification status                   |
| ------- | ---- | ------------------------------- | ----------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| API     | A1   | Platform difference (modes)     | `expectFileMode`                                            | Pass           | Pass, exact `0o640` (executed)                        |
| API     | A2   | Platform difference (links)     | Junctions; file-link case POSIX-only                        | Pass           | Pass, symbolic links incl. the file link (executed)   |
| API     | A3   | Platform difference (links)     | `linkDirectory`                                             | Pass           | Pass (executed)                                       |
| API     | A4   | Environment (temporary dir)     | `redirectTemporaryDirectory`                                | Pass           | Pass (executed)                                       |
| API     | A5   | **Product defect** + racy test  | Re-check after the record read; three deterministic tests   | Pass           | Pass (executed)                                       |
| Agent   | R1   | Obsolete expectation (0051)     | Two tests: set aside in the tree; refused elsewhere         | Pass           | Windows-only test; Unix counterparts pass (executed)  |
| E2E     | E1   | Obsolete expectation (0054)     | Sidebar › Screenshots                                       | Pass           | Windows-only suite                                    |
| E2E     | E2   | Obsolete expectation (0054)     | `…/versions`, then General                                  | Pass           | Windows-only suite                                    |
| E2E     | E3   | Obsolete expectation (0054)     | General headings, sidebar, `…/copies`                       | Pass           | Windows-only suite                                    |
| E2E     | E4   | Obsolete expectation (0051)     | Proves spooled upload                                       | Pass           | Windows-only suite                                    |
| E2E     | E5   | Obsolete expectation (0051)     | Proves tree set aside, image arrives                        | Pass           | Windows-only suite                                    |
| E2E     | E6   | Obsolete expectation (0051)     | Proves refused copy ends                                    | Pass           | Windows-only suite                                    |
| E2E     | E7   | Obsolete expectation (0051)     | Proves removal without the API, upload after                | Pass           | Windows-only suite                                    |
| E2E     | E8   | Follow-on of E7                 | None needed                                                 | Pass           | Windows-only suite                                    |
| E2E     | E9   | Obsolete expectation (0051)     | Proves success and no archived screenshot                   | Pass           | Windows-only suite                                    |
| E2E     | E10  | Obsolete selector               | Main cover by accessible name                               | Pass           | Windows-only suite                                    |
| E2E     | E11  | Obsolete navigation + selector  | Manage this VM, sidebar; full thumbnail label               | Pass           | Windows-only suite                                    |
| E2E     | E12  | Obsolete expectation (0054)     | `…/copies`                                                  | Pass           | Windows-only suite                                    |
| E2E     | E13  | Obsolete expectation (0054)     | `…/copies`                                                  | Pass           | Windows-only suite                                    |
| E2E     | E14  | Obsolete expectation (0054)     | `…/versions`                                                | Pass           | Windows-only suite                                    |
| E2E     | E15  | Follow-on of E13                | None needed                                                 | Pass           | Windows-only suite                                    |
| E2E     | E16  | Follow-on of E13                | None needed                                                 | Pass           | Windows-only suite                                    |
| Compose | C1   | Platform difference (ownership) | Container-side `stat` on Windows; host `stat` kept on Linux | Pass           | Host branch unchanged; reviewed, not executed         |
| E2E     | N1   | Fixture defect (sshd penalties) | `PerSourcePenalties no` in the test image                   | Pass           | Windows-only suite                                    |
| E2E     | N2   | Timing defect                   | `holdUploads` / `releaseUploads`                            | Pass           | Windows-only suite                                    |
| Web     | N3   | Timing defect                   | Wait for the effect's teardown                              | Pass           | Platform-independent (jsdom)                          |
| API     | N4   | Defect introduced, then fixed   | Assertion lists `waiting`                                   | Pass           | Found by the Linux run; pass after the fix (executed) |
| API     | N5   | Environment: worker count       | Windows default 2 workers, from measurements                | Pass, 4 runs   | Linux default unchanged (4); passed                   |

## Final test matrix

| Suite                      | Baseline passed | Baseline failed | Final passed              | Final failed | Skipped                        | Execution environment                             |
| -------------------------- | --------------- | --------------- | ------------------------- | ------------ | ------------------------------ | ------------------------------------------------- |
| API                        | 1,209           | 5               | 1,216                     | 0            | 2 (opt-in real OVA)            | Windows 11, MariaDB 11.8 in Docker Desktop        |
| API (Linux)                | —               | —               | 1,215 + 1 fixed and rerun | 0            | 2 (opt-in real OVA)            | `node:22.22.3-bookworm-slim`, UID 1000            |
| Contracts                  | 448             | 0               | 448                       | 0            | 0                              | Windows 11                                        |
| Web                        | 556             | 0               | 556                       | 0            | 0                              | Windows 11 (jsdom)                                |
| Deployer                   | 51              | 0               | 51                        | 0            | 0                              | Windows 11                                        |
| Agent (Rust)               | 617             | 1               | 619                       | 0            | 27 ignored (opt-in or long)    | Windows 11                                        |
| Agent packaging (Linux)    | —               | —               | 26                        | 0            | 1 ignored (run by `test:sftp`) | `rust:1-bookworm`, unprivileged user              |
| Agent `ova_import` (Linux) | —               | —               | 47                        | 6            | 0                              | `rust:1-bookworm`: no Linux credential store (22) |
| SFTP suites                | not in baseline | —               | 151                       | 0            | 0                              | Windows 11, OpenSSH container                     |
| E2E                        | 84              | 16              | 100                       | 0            | 1 (opt-in VirtualBox)          | Windows 11, Edge, QEMU, 86Box, OpenSSH            |
| E2E VirtualBox (opt-in)    | skipped         | —               | 1                         | 0            | 0                              | Windows 11, VirtualBox                            |
| Real OVA (opt-in)          | not run         | —               | 14                        | 0            | 0                              | Windows 11, local `Xenix_386.ova`                 |
| Deployment tooling         | 49              | 0               | 49                        | 0            | 0                              | Disposable Linux hosts in Docker                  |
| Compose                    | 47              | 1               | 48                        | 0            | 0                              | Docker Desktop                                    |

## Mandatory questions

| Question                                               | Answer                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Were all five API failures resolved?                   | **Yes** (A1–A5)                                                                                                                                                            |
| Was the Rust packaging junction failure resolved?      | **Yes** (R1)                                                                                                                                                               |
| Were all sixteen E2E failures resolved?                | **Yes** (E1–E16), and two found on the way (N1, N2)                                                                                                                        |
| Was the Docker Compose ownership failure resolved?     | **Yes** (C1): host `stat` on Linux, container-side `stat` on Windows, with a negative control                                                                              |
| Were any tests deleted?                                | No test without an equivalent. The obsolete R1 was replaced by two; the R2 test by three; the media and registration tests by tests of 0051                                |
| Were any tests skipped?                                | No new skip. The opt-in skips are as before (real OVA, VirtualBox), and both were run. One sub-case (a file link) runs on POSIX only, with a comment, and was run on Linux |
| Were any assertions weakened?                          | No. Assertions of removed behaviour (0051, 0054) were replaced by assertions of the current behaviour; no timeout was raised                                               |
| Were Linux-specific assertions preserved?              | **Yes**, unchanged, and executed on Linux                                                                                                                                  |
| Which Linux tests were actually executed?              | The whole API suite (including notes, Archive Explorer, R2, the temporary directory), the agent's `packaging` and `ova_import` tests                                       |
| Was the archive cancellation test made deterministic?  | **Yes**: held reads, state-based waits, no sleeps; 20 of 20 idle runs passed                                                                                               |
| Were screenshot tests aligned with decision 0051?      | **Yes** (section 11)                                                                                                                                                       |
| Were any actual product defects discovered?            | **One**: R2, the orphan load (A5), fixed                                                                                                                                   |
| Was production code modified?                          | **Yes**, `apps/api/src/archives/inspection.ts` only                                                                                                                        |
| Is a Mars deployment required?                         | **Yes**, `emucatctl update` (section 24)                                                                                                                                   |
| Is a Windows agent update required?                    | **No**: the agent's source is unchanged                                                                                                                                    |
| Is a deployment tooling refresh required?              | **No**, when Mars runs the 0055/0056 tooling, which 24.1 checks                                                                                                            |
| Are all production builds successful?                  | **Yes**: `pnpm build`, the release agent, and the API and web images                                                                                                       |
| Is the complete test suite now reliable on Windows 11? | **Yes**, with the documented conditions: one suite at a time on MariaDB, and the default 2 API workers. Every suite passed twice or more                                   |
