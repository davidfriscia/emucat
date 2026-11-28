# EmuCat — M0.2: Cross-platform test baseline stabilization — report

Markers used throughout: **[verified]** observed in this session by running it; **[source]** concluded from reading the
code; **[env]** specific to this workstation or container; **[proposed]** a mitigation not applied; **[unverified]**
deployment behaviour that cannot be run from here.

## 1. Executive summary

M0.2 makes the test baseline trustworthy again before M1 (Disk Image Explorer). No feature was developed, and **no
production code changed**: every change is in tests, test fixtures, the browser-test launcher or documentation.

- **E2E (decision 0060), 12 failures → 0.** Two stale assertions caused all twelve: one test found a sentence that
  General now shows twice (strict-mode violation), which left the VM private, so the ten tests after it that need a
  public VM failed too; the other expected General's former Details panel. Both now assert the intended behaviour
  through accessible roles and names, more strictly than before. Two full runs: 100 passed, 1 skipped, 0 failed.
- **Windows browser-test harness.** The launcher ran `execFileSync('npx', …)`, which cannot start `npx.cmd` without a
  shell (`spawnSync npx ENOENT`). It now runs the workspace's own Vite CLI with `process.execPath`: no shell, no
  `npx`, no download. The real browser suite then ran 28 of 28, three times on Windows (Edge) and twice on Linux
  (Chromium), and a new regression test covers the launcher on both platforms.
- **Intermittent tests.** The two M0.1 flakes were investigated: one has an established synchronization defect
  (corrected; not reproduced in 40 targeted runs), the other could not be reproduced (195 test executions under
  load) and is documented as such. Two **further** intermittent agent tests found during this session were
  reproduced or analysed and corrected: a fixture that did not follow the product's sequence (3 of 100 → 0 of 200
  under load) and a 30 ms scheduling assumption.
- **Linux agent.** M0.1's "12 failures" were re-run on today's container toolchain (Cargo 1.100) and became 38
  (non-root) and 39 (root). Every one was classified: 26 came from Cargo 1.100's new build-directory layout (which
  would also break CI's Windows job on stable 1.100), 3 from Windows path literals in unit tests, 2 from a test fake
  whose concurrent log writes interleaved, 6 from the agent's documented lack of a Linux credential store, and 3
  from inode reuse on Linux. M0.1's attribution of four of them to running as root is **not** supported: root and
  non-root give identical results. Now: **582 passed, 0 failed, 32 ignored, as UID 1000 and as root**; the 9
  Linux-inapplicable tests are ignored off Windows with their reason, and still run on Windows.
- **Windows agent**: 619 passed, 0 failed, 27 ignored, before and after.
- **ZIP64 (decision 0061)** coverage is unchanged and passes on both platforms.
- **Deployment:** M0.2 needs **no application deployment and no agent update**. The cumulative M0 + M0.1 changes
  (API ZIP64 parser and web nested-archive reader) are what Mars must run; §33 gives the runbook.
- **Test resources.** `pnpm test:compose` left one anonymous MariaDB volume per run; corrected (R1).
- **M1 readiness: CONDITIONAL GO** (§39): confirm CI on the pushed commit, notably the Linux clippy warning C1.

## 2. Milestone objectives

Restore a reliable, reproducible and validated baseline: correct the twelve E2E failures without weakening them, make
the browser suite start on Windows, investigate the intermittent web tests, validate the Windows agent suite,
classify every Linux agent failure, complete the validation M0.1 did not run, and document the result, the
deployment impact and the Mars and Moon procedures.

## 3. Implementation scope

In scope and done: E2E tests, browser-test launcher, web unit tests, agent tests and test fixtures (`agent/tests`,
`agent/examples`, `#[cfg(test)]` modules), `docs/testing.md`, this report. Out of scope and not touched: Disk Image
Explorer, decoders, archive formats, API endpoints, schema, migrations, UI, agent protocol, dependencies, decisions
0058/0060/0061.

## 4. Repository baseline [verified]

| Item                        | Value                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| Repository                  | `C:\Users\david\src\emucat`, remote `git@github.com:davidfriscia/emucat.git` |
| Branch                      | `develop`, clean, up to date with `origin/develop`                           |
| Baseline (`origin/develop`) | `3f5187d149d2ef9a44f148bddea19bcaac4a9e25`                                   |
| `origin/main`               | `79981c5f49c1fd820572bf3c28915a511533d9a4` (unchanged by this session)       |
| Git identity                | `david` / the established address, author and committer                      |
| Synchronization             | `git fetch origin`; local `develop` was already equal: no merge needed       |

## 5. M0 and M0.1 integration status [verified]

`git log 1c45e18..origin/develop` shows exactly M0.1's three commits on top of M0's `1c45e18`:

| Commit    | Subject                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `615d051` | fix(web): align nested ZIP64 parsing with decision 0061                    |
| `7b268d6` | test(web): ZIP64 duplicate-record layouts in the browser-local reader      |
| `3f5187d` | docs: browser-local ZIP64 (decision 0061 amended), report and MARS runbook |

Present: `apps/web/src/archive-local/zip.ts`, `apps/web/test/archive-local/zip64.test.ts` and `fixtures.ts`,
`apps/web/test/archive-nested.test.tsx`, `apps/web/test/tools/make-nested-zip64.mjs`, the amended decisions 0058 and
0061, `docs/testing.md` (ZIP64 section) and `docs/reports/emucat-browser-local-zip64-compatibility-report.md`. Nothing
else had been introduced. M0 (`bc03ece`, `1c45e18`) is below it.

## 6. Windows toolchain [verified, env]

| Tool                   | Version                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Operating system       | Windows 11 Home 10.0.26200                                                                  |
| Node.js                | 22.22.3 (fnm, `%APPDATA%\fnm\node-versions\v22.22.3\installation`, put on `PATH` per shell) |
| pnpm                   | 12.10.1                                                                                     |
| Rust                   | 1.99.0, `stable-x86_64-pc-windows-msvc`; cargo 1.99.0                                       |
| Docker                 | Docker Desktop, Engine 29.9.3, Compose 5.7.0                                                |
| MariaDB (dev and test) | 11.8.9 (`emucat-mariadb-1`, healthy, `127.0.0.1:3307`)                                      |
| Browser-test framework | `playwright-core` 1.56.1 under Vitest 5.1.0                                                 |
| Browsers               | Microsoft Edge 158.0.4370.45, Google Chrome 158.0.8127.37                                   |
| QEMU                   | installed (`C:\Program Files\qemu`)                                                         |
| VirtualBox, 7-Zip      | installed; `VBoxManage` not on `PATH` (the VirtualBox e2e file is opt-in and was skipped)   |
| Python                 | not installed (only the Store alias); nothing needs it                                      |
| CPU                    | 14 cores, 20 logical processors                                                             |
| Memory                 | 16 GB, about 2.3 GB free at the start                                                       |
| Disk                   | C: 54 GB free                                                                               |

Nothing was installed, upgraded or reconfigured on the workstation.

## 7. Linux validation environment [verified, env]

All Linux runs are **containers on Docker Desktop's WSL 2 kernel** (6.6.87.2-microsoft-standard-WSL2), not a native
Linux host. Each copied the checkout into the container (no Windows `node_modules` or `target`) and ran as an
unprivileged user, UID 1000, unless stated; the agent suite also ran as root, for comparison.

| Container                               | Image (local, not pulled)    | Toolchain                                                            | Limits       | Used for                                     |
| --------------------------------------- | ---------------------------- | -------------------------------------------------------------------- | ------------ | -------------------------------------------- |
| `emucat-m02-linux-agent*`               | `rust:1-bookworm`            | rustc/cargo **1.100.0**                                              | 4 CPUs, 6 GB | agent suite, non-root and root; repetitions  |
| `emucat-m02-linux-web`                  | `node:22.22.3-bookworm-slim` | Node 22.22.3, Chromium 156.0.8078.114 (Debian apt, in the container) | 4 CPUs, 6 GB | contracts, deployer, web, real browser suite |
| API container (docs/testing.md command) | `node:22.22.3-bookworm-slim` | Node 22.22.3                                                         | —            | whole API suite on the development MariaDB   |

Differences from production: the API runs in production as UID 1000 in the API image under Compose; here the suite
runs as `node` (UID 1000) in the plain Node image, with a WSL 2 overlay filesystem. Chromium was installed with
`apt-get` inside the disposable web container only. The Rust image is 1.100 while the workstation is 1.99, which is
how the Cargo layout change (§18) was found; the old layout is covered by the Windows runs.

## 8. Initial test baseline [verified]

At `3f5187d`, before any change (the E2E files under test were the committed ones; see note):

| Suite                                | Command                                                      | Result                                                                  | Duration                   |
| ------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------- |
| E2E                                  | `pnpm test:e2e`                                              | **12 failed**, 88 passed, 1 skipped (101)                               | 720 s                      |
| Browser                              | `pnpm --filter @emucat/web test:browser`                     | **3 suites failed** in `beforeAll` (`spawnSync npx ENOENT`), 28 skipped | 2 s                        |
| Agent, Windows                       | `cargo test --manifest-path agent/Cargo.toml --no-fail-fast` | 619 passed, 0 failed, 27 ignored                                        | 153 s                      |
| Agent, Linux, UID 1000 (Cargo 1.100) | `cargo test --locked --no-fail-fast`                         | 552 passed, **38 failed**, 23 ignored                                   | 38 s (after a 129 s build) |
| Agent, Linux, root (Cargo 1.100)     | same                                                         | 551 passed, **39 failed**, 23 ignored                                   | 35 s                       |
| Web, M0.1 intermittent tests         | see §16                                                      | not reproduced on demand                                                |                            |

Note on the E2E baseline: I edited the two E2E files about two minutes into this run and restored them within
minutes, before any file had reported; the run used the committed versions, as its failure locations prove
(`execution.e2e.test.ts:1368`, `restore.e2e.test.ts:627`, the original lines) and its messages (below).

Lint, type check, `test:sftp`, `test:deploy`, `test:compose` and `build` were not re-run at the baseline: their
code is unchanged since M0, which ran them all with success (§23 of the M0 report). They were run after the changes
(§26).

## 9. Complete initial failure inventory

| ID  | Suite                            | Test(s)                                                                                                                                      | Failure                                                                                                                     | Classification (§29)                             | Status                              |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| E1  | E2E restore                      | `publishes the VM and all of its screenshots in one step, from the administrator’s page`                                                     | `strict mode violation: getByText('Making it public publishes all of its screenshots.')`, 976 ms                            | Corrected test defect                            | Fixed, 2 runs                       |
| E2  | E2E restore                      | the 10 later tests of "the public cover and the VM detail page"                                                                              | 30 s timeouts waiting for the public card, `expected 404 to be 200`: the VM stayed private                                  | Cascade of E1                                    | Fixed, 2 runs                       |
| E3  | E2E execution                    | `13. shows the restore history as a table…`                                                                                                  | `expected [ 'Metadata', 'Run and verify' ] to deeply equal [ 'Metadata', 'Details', …(1) ]`                                 | Corrected test defect                            | Fixed, 2 runs                       |
| B1  | Browser                          | all 3 files                                                                                                                                  | `Error: spawnSync npx ENOENT` in `beforeAll`                                                                                | Corrected test harness defect                    | Fixed                               |
| B2  | Browser                          | `serves its worker and bundles…`                                                                                                             | (latent) `execFileSync('ls', …)` needs a POSIX `ls` on `PATH`                                                               | Corrected platform portability defect            | Fixed                               |
| W1  | Web                              | `capture.test.tsx` › `captures, uploads, and announces publication in local`                                                                 | M0.1: `expected "vi.fn()" to be called 1 times, but got 0 times`, once                                                      | Corrected test defect (synchronization)          | Fixed; not reproduced before        |
| W2  | Web                              | `archive-nested.test.tsx` › `opens a nested ZIP with one download…`                                                                          | M0.1: failed once; no message recorded                                                                                      | Non-reproducible observation                     | Unchanged                           |
| A1  | Agent, Linux                     | 26 tests in `virtualbox` (3), `virtualbox_management` (9), `virtualbox_operations` (14 failing + 1 passing file-wide)                        | `build the example first: …/build/emucat-agent/<hash>/examples/fake_vboxmanage`                                             | Corrected test harness defect (Cargo 1.100)      | Fixed                               |
| A2  | Agent, Linux                     | `launcher::tests`: `executable_names_are_checked`, `the_launch_keeps_the_vm_arguments_…`, `the_launch_adds_no_monitor_…`                     | `assertion failed: expected_name(…, Path::new("C:\\e\\86Box.exe"))`; `This VM needs qemu-system-i386.exe…`                  | Corrected platform portability defect            | Fixed                               |
| A3  | Agent, Linux                     | 6 in `ova_import` `command_line`                                                                                                             | `Unavailable("no secure credential store is implemented for linux yet")`; `credential_unreadable` ≠ `not_paired`            | Legitimate platform-specific test                | Ignored off Windows; new Linux test |
| A4  | Agent, Linux                     | `registration`: `a_replaced_directory_is_not_the_one_that_was_archived`, `a_substituted_directory_with_the_same_screenshot_is_refused`       | `left: None, right: Some("cleanup_identity_mismatch")`                                                                      | Legitimate platform-specific test (inode reuse)  | Ignored off Windows                 |
| A5  | Agent, Linux                     | `restore`: `a_directory_that_is_not_this_restores_is_never_touched_after_a_crash`                                                            | `assertion failed: matches!(…, … "restore_destination_exists")`                                                             | Legitimate platform-specific test (inode reuse)  | Ignored off Windows                 |
| A6  | Agent, Linux and both users      | `virtualbox_management`: `captures_a_watched_running_machine_…`, `refuses_a_machine_that_is_not_watched_…` (hidden by A1 until it was fixed) | `invalid type: sequence, expected a string at line 1 column 1`                                                              | Corrected test defect (fixture)                  | Fixed                               |
| A7  | Agent, Windows (found here)      | `qmp::tests::a_timed_out_reply_cannot_satisfy_the_next_command`                                                                              | `assertion failed: matches!(…, Err(QmpError::Refused { … }) if description == "second failed")`, once                       | Corrected test defect (synchronization)          | Fixed; not reproduced before        |
| A8  | Agent, Windows (found here)      | `media::a_spooled_screenshot_the_server_no_longer_accepts_is_given_up`                                                                       | `left: (0, 1, 0, 0) right: (0, 0, 0, 0)`, once; then 3 of 100 under load                                                    | Corrected test defect (fixture)                  | Fixed, 0 of 200                     |
| C1  | CI, Linux (found here)           | `cargo clippy --all-targets -- -D warnings` on Ubuntu                                                                                        | `warning: function same_image is never used` (Linux build of the library)                                                   | Unresolved (follow-up, agent source)             | Documented                          |
| R1  | `pnpm test:compose` (found here) | cleanup of the disposable MariaDB                                                                                                            | `docker rm -f` without `-v`: each run left one anonymous `/var/lib/mysql` volume (seen: one new volume after a passing run) | Corrected test harness defect (resource cleanup) | Fixed; rerun left none              |

## 10. Decision 0060 behaviour analysis [source]

Decision 0060 §5 makes General "one 'VM actions' toolbar (status chip, Make public/private with `Eye`/`EyeOff`, View
public page as an `IconLink`, the operations summary, VM information); the permanent Details panel moved into VM
information, every fact preserved". In `apps/web/src/pages/admin/vm/VmGeneralPage.tsx`:

- The **Private** `StatusChip` carries `VISIBILITY_TEXT.private` as its detail ("Only signed-in administrators… Making
  it public publishes all of its screenshots."), rendered once as the chip's tooltip text, read by assistive
  technology.
- `VisibilityControl` renders **Make public** (`IconButton`, accessible name "Make public") with
  `aria-describedby` pointing at a visually hidden span holding the same sentence: the consequence is the button's
  description.
- After publication the toolbar shows **Make private**, and a **Cover shown** chip whose detail is "The main screenshot
  is the public catalog’s cover."
- `VmInfo`, inside the **VM information** `InfoPopover` (a non-modal `role="dialog"`), holds the former Details:
  sections Publication, Identity (emulator, VM name in `code.vm-identity`), Contents, History.
- The page's level-2 headings are now **Metadata** and **Run and verify** only.

The product behaviour is as decided. Both failures were tests pinning the layout before 0060. No product defect, and
no missing accessible name: every control used has its own.

## 11. E2E failure root causes [verified]

- **E1/E2.** `getByText('Making it public publishes all of its screenshots.')` is a substring match; it now matches
  two elements (the chip's detail and the button's description), and Playwright's strict mode refuses an ambiguous
  locator. The test failed before clicking **Make public**, so the VM stayed private: the next ten tests, which read
  the public catalog and detail page, timed out or got 404. One cause, eleven failures.
- **E3.** The test asserted the first three level-2 headings as `Metadata, Details, Run and verify`.

## 12. E2E corrections

`apps/api/e2e/restore.e2e.test.ts`, "publishes the VM and all of its screenshots in one step":

- locates the **Publication** group of the **VM actions** toolbar, and in it the **Make public** button by role and
  exact name;
- asserts that the button's accessible description (a new `accessibleDescription` helper: the text of its
  `aria-describedby` targets) contains the consequence sentence — the thing the old test meant to check;
- keeps the check that no **Publish** button exists, clicks **Make public**, waits for **Make private** (the page
  reflects the server's answer) and for the cover statement inside the Publication group;
- **adds** an authoritative check: `GET /admin/vms/86box/Cover VM` answers `visibility: 'public'` and
  `publicCover: 'shown'`; the existing `isMain` check stays.

`apps/api/e2e/execution.e2e.test.ts`, test 13: the page's sections are asserted as `Metadata, Run and verify`; the
test then **opens VM information** from the toolbar and asserts its four sections (`Publication, Identity, Contents,
History`) and that its VM name is the VM's, closes it with Escape and waits for it to go. The Details facts are thus
still covered, where they now are.

No assertion was removed, no timeout raised, no sleep, retry or skip added.

## 13. Windows browser-test launcher root cause [verified]

All three browser files built what they serve with
`execFileSync('npx', ['vite', 'build', …], { cwd: WEB, stdio: 'inherit' })`. Without a shell, Node on Windows starts
a program by `CreateProcess`, which appends only `.exe`/`.com`; npm installs `npx` as `npx.cmd`, so the spawn fails
with `ENOENT` before any test. `shell: true` would work but routes every argument through `cmd.exe`'s re-parsing
(quoting, `%`, `^`, injection), and `npx` may also download a package it does not find locally. Separately,
`archive-explorer.browser.test.ts` listed `dist/assets` with `execFileSync('ls', …)`, which works only where a POSIX
`ls` is on `PATH` (Git Bash), not from PowerShell.

## 14. Browser-test launcher correction

`apps/web/e2e/vite-build.ts` (new):

- `viteCli()` resolves `vite/package.json` from `apps/web` with `createRequire` and returns its `bin.vite`: the
  lockfile's Vite, from this workspace's `node_modules`;
- `viteCommand(args)` is `[process.execPath, [cli, ...args]]`;
- `runVite(args, stdio = 'inherit')` runs it with `execFileSync` in `apps/web`: no shell, no `PATH` lookup, argument
  boundaries kept, the exit status thrown on failure, synchronous (nothing to clean up after a failure).

The three browser files call `runVite([...])`; the `ls` became `readdirSync`. Considered and rejected: `shell: true`
(re-parsing, injection), resolving `npx.cmd` (still `cmd.exe`, still may download), `pnpm exec` (a second `.cmd`).

Regression coverage, `apps/web/test/e2e-vite-build.test.ts` (in `pnpm test`, so on both platforms): the command is
this Node.js and an absolute `vite/bin/vite.js`; it starts without a shell and prints the locked Vite version; a
`--config` path with spaces reaches Vite as one argument (Vite names it in its error); a failing build throws.
4 passed on Windows and on Linux.

## 15. Real-browser validation [verified]

| Platform                  | Browser                                                | Runs | Result per run | Durations        |
| ------------------------- | ------------------------------------------------------ | ---- | -------------- | ---------------- |
| Windows (PowerShell)      | Microsoft Edge 158                                     | 3    | 28 passed      | 38 s, 59 s, 31 s |
| Linux container, UID 1000 | Chromium 156 (`EMUCAT_BROWSER_PATH=/usr/bin/chromium`) | 2    | 28 passed      | 57 s, 72 s       |

Each run built the harness and the whole application, served them with nginx's MIME table, launched the browser,
ran the files serially, closed browser and server (`afterAll`), and exited 0. No Edge process remained after the
Windows runs (counted before and after). The 28 tests cover: Archive Explorer (8: worker and PDF.js worker as module
workers from this origin, compact toolbar and on-demand metadata, nested ZIP and TAR navigation, preview — text,
canvas, PDF, legacy images, hex — and exact-byte download, no request off-origin, no console error, responsiveness
while indexing 1–64 MiB), Version History (11, decision 0059) and operations (9, decision 0060).

**ZIP64 in a real browser.** The browser suite has no ZIP64 case. The browser-local reader is pure TypeScript
running in the archive worker: the browser suite proves the worker loads and opens nested archives in a real
browser, and `test/archive-local/zip64.test.ts` (24) and `test/archive-nested.test.tsx` (13, through the worker's
real message handler) prove the ZIP64 parsing on both platforms. Adding a real-browser ZIP64 case would test the same
parser again in another engine; it was not added, to keep the milestone test-stabilization only. [proposed] It is a
reasonable addition to M1's browser tests, with `zip64Layout` from `test/archive-local/fixtures.ts`. The manual Mars
check (§34) covers it on the real deployment.

## 16. Intermittent web-test investigation

**W1 — `capture.test.tsx` › `captures, uploads, and announces publication in local`.** M0.1 saw, once, in a full web
run: `expected "vi.fn()" to be called 1 times, but got 0 times`, at `expect(published).toHaveBeenCalledTimes(1)` right
after `await screen.findByText('Screenshot published.')`.

- [source] `CaptureScreenshot` dispatches `emucat:media-published` in a `useEffect` keyed on the completed capture,
  i.e. in the passive effects of the render that shows "Screenshot published.". Testing Library's `asyncWrapper`
  (`@testing-library/react` 16.3, `dist/pure.js`) turns React's act environment **off** while `findBy…` waits, so the
  update is scheduled by React's Scheduler (`setImmediate` under Node), and the wrapper resolves after a
  `setTimeout(0)` once the DOM matched. Passive effects run in the same Scheduler slice as the commit unless the 5 ms
  slice expires right after it, in which case they run in a later `setImmediate` — and a ≥1 ms timer can fire first.
  The assertion then runs before the effect. This needs a stall of several milliseconds at commit: rare, and
  consistent with one failure in a full parallel suite.
- [verified] A temporary instrumented copy (not committed) recorded the spy's count at the old assertion point: 0 of
  20 runs idle, 0 of 20 under 24 busy threads on 20 logical CPUs. **Not reproduced.**
- Classification: test synchronization defect (established by source), product behaviour correct (the gallery's
  listener is called once, a moment later). Correction: `await waitFor(() => expect(published).toHaveBeenCalled())`,
  then `toHaveBeenCalledTimes(1)` (still exactly once) and a new check of the event's detail (`qemu`, `Test VM`);
  the listener is removed with `onTestFinished`, also when the test fails. Repeated 20 of 20 on Windows after the
  change, and passed in the Linux web suite. Because the failure was not reproduced, this is reported as a
  correction of an established defect, **not** as a demonstrated fix of the observed failure.

**W2 — `archive-nested.test.tsx` › `opens a nested ZIP with one download, browses it, and previews its files`.** M0.1
recorded only that it failed once in an early run and then passed three times; no message or stack survived.

- [verified] 15 runs of the whole file under 24 busy threads: 15 passed (195 test executions, 0 failures); it also
  passed in every full web run of this session (Windows and Linux).
- [source] The test chains several default 1 s `findBy…`/`waitFor` windows over an in-thread worker that answers
  with `setTimeout` hops; any of them could be exceeded by a stall, but without the failing assertion no specific
  cause can be named, and raising timeouts without evidence was excluded.
- Classification: **non-reproducible observation**. Unchanged. If it recurs, the failing assertion will say which
  step was slow.

## 17. Windows agent validation [verified]

| Run                         | Passed | Failed | Ignored | Duration | Note                                                     |
| --------------------------- | ------ | ------ | ------- | -------- | -------------------------------------------------------- |
| Baseline                    | 619    | 0      | 27      | 153 s    | idle                                                     |
| After the first corrections | 618    | 1 (A7) | 27      | 330 s    | after clippy                                             |
| After A7                    | 618    | 1 (A8) | 27      | 502 s    | concurrent with the Linux container (load)               |
| Final                       | 619    | 0      | 27      | 84 s     | idle; `cargo fmt --check` and clippy `-D warnings` clean |

The 27 ignored tests are opt-in by design, each with its reason: 21 SFTP/ZIP64 tests that need Docker or more than
4 GiB (run by `pnpm test:sftp`), 4 real-QEMU and 1 real-86Box test (`EMUCAT_REAL_QEMU`, `EMUCAT_REAL_86BOX`), and the

> 4 GiB packaging test. OVA import, VirtualBox integration (through `fake_vboxmanage`), launcher, registration,
> restore, credentials (DPAPI), path handling, ZIP64 packaging and server-clone compatibility (`tests/clone.rs`) all
> ran and passed. M0 reported "579 passed, 2 ignored" for the agent; that figure does not match today's 619 + 27 and
> was not a complete count (the agent code is unchanged since M0, `git diff --stat 1c45e18 -- agent` was empty).

**A7 — `qmp::tests::a_timed_out_reply_cannot_satisfy_the_next_command`.** [source] `QmpChannel` writes through a
one-slot queue (`sync_channel(1)`) drained by a writer thread. The test's first command times out after 30 ms; if
the writer thread was not scheduled within those 30 ms, the second `execute` finds the slot still full and
`try_send` returns `Timeout` at once, never reaching the reply the test is about. [verified] Not reproduced: 0 of
100 single runs idle, 0 of 100 under 40 busy threads, 0 of 120 runs of the whole library binary. The product
behaviour is the intended one (a command never waits on a QEMU that stops reading stdin). Correction: the test's
fake QEMU signals when it has received the first request, and the test sends the second only then; both assertions
are unchanged. 50 of 50 afterwards. Test-only (`#[cfg(test)]`).

**A8 — `media::a_spooled_screenshot_the_server_no_longer_accepts_is_given_up`.** [verified] Reproduced: **3 of
100** single runs under load. [source] The test calls `MediaSync::detach_pending` — which production calls only
just before deleting a VM directory (`registration.rs`, `before_delete`) or on a directory already set aside
(`restore.rs`) — but left the directory in place. The running synchronizer's scan could then find `shot.ppm` there
and start uploading it as an ordinary file; when that happened before the check, the queue showed one upload in
progress, `(0, 1, 0, 0)`. A fixture defect, not a product one. Correction: the test deletes the directory after
detaching, as production does (its sibling test already did). **0 of 200** under the same load afterwards.

## 18. Linux agent failure analysis [verified]

M0.1 ran as root in a container and reported 578 passed, 12 failed (`ova_import` 6, `launcher` 3, `registration` 2,
`restore` 1). Its toolchain is not recorded. Today's `rust:1-bookworm` is **Cargo 1.100**, and gives more:

| Group  | Tests | Root cause (evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Classification                      | Correction                                                                                                                                                                                                                                    |
| ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1     | 26    | Cargo 1.100 moved test executables to `target/debug/build/emucat-agent/<hash>/out/` (no `deps/`); examples stay in `target/debug/examples` (listed in the container). The tests derived the example's path as `current_exe()/../../examples`. Not Linux-specific: CI's Windows job on stable 1.100 would fail the same way                                                                                                                                                              | Test harness defect                 | `agent/tests/support/mod.rs`: `example(name)` takes the nearest `examples/<name><EXE_SUFFIX>` above the test executable, which is right for both layouts; used by `virtualbox`, `virtualbox_management`, `virtualbox_operations`, `execution` |
| A2     | 3     | Unit tests passed Windows literals (`"C:\\e\\86Box.exe"`); on Linux that is one file name with backslashes, and `expected_name`/`qemu_system_executable` read only the file name                                                                                                                                                                                                                                                                                                        | Platform portability defect (tests) | Native absolute paths (`temp_dir().join(dir).join(name)`); identical assertions; now pass on both                                                                                                                                             |
| A3     | 6     | `import-ova` reads the agent's credential first; `platform_store` is DPAPI on Windows and `UnsupportedCredentialStore` elsewhere (`credentials.rs`), so pairing a subprocess is impossible on Linux                                                                                                                                                                                                                                                                                     | Legitimate platform-specific test   | `#[cfg_attr(not(windows), ignore = "…")]` on exactly those 6; new Linux-only `without_a_credential_store_the_command_says_so_and_exits_4` asserts exit 4, `credential_unreadable`, no request                                                 |
| A4, A5 | 3     | `DirectoryIdentity` on Unix is `(st_dev, st_ino)` (`packaging.rs`). The tests delete a directory and create another with the same name; Linux often gives it the same inode (13 of 20 in a container), so the agent cannot tell them apart. NTFS file IDs include a sequence number. Alone, each test fails 20 of 20 as UID 1000 **and** as root; in the full parallel run the restore one passed as UID 1000 by chance (other tests consumed the inode), which is why M0.1 blamed root | Legitimate platform-specific test   | `#[cfg_attr(not(windows), ignore = "…")]` with that reason; they run on Windows                                                                                                                                                               |
| A6     | 2     | `fake_vboxmanage` appended `writeln!(calls, "[{}]", …)`: several `write` calls per line; the agent runs commands concurrently, so lines interleaved (captured: `[["list","runningvms""showvminfo",…]`). Root and non-root alike; hidden by A1 until A1 was fixed                                                                                                                                                                                                                        | Test defect (fixture)               | One `write_all` of the whole line (also for `deleted.txt`); 0 of 30 runs as root and 0 of 30 as UID 1000 afterwards (at least 5 of 60 before; the exact count was truncated in my output)                                                     |

**Support boundary.** The agent is a Windows program: launching emulators is `process::supported() == cfg!(windows)`,
the credential store is DPAPI only. Nothing in M0.2 changes that; the Linux runs prove the code that is portable is
correct there, and the exclusions mark what is Windows-only by design. A future Linux agent would need a credential
store and a directory identity robust to inode reuse ([proposed], not M0.2).

Final Linux agent runs (all fixes): **582 passed, 0 failed, 32 ignored** as UID 1000 (57 s) and as root (64 s). The
32 = the 23 opt-in tests that also exist on Windows minus the Windows-only ones, plus the 9 exclusions above. (The
Windows-only `execution.rs` is compiled out on Linux; the Linux-only credential-store test is new.)

## 19. Platform-specific test policy

A test is excluded on a platform only when the behaviour it proves does not exist there by design, and then with
`#[cfg_attr(not(windows), ignore = "<reason>")]`, never `#[cfg]`, so that `cargo test` lists it as ignored with the
reason, and it still runs on Windows (locally and in CI's Windows job). Exactly 9 tests were excluded this way (A3,
A4, A5). Every other Linux failure was corrected instead: 31 tests. No assertion was changed in any excluded test.
The same policy is in `docs/testing.md` ("Agent tests that do not apply on Linux").

## 20. Root versus non-root validation [verified]

| Run              | UID 1000               | root                   |
| ---------------- | ---------------------- | ---------------------- |
| Baseline (1.100) | 552 / 38 failed / 23   | 551 / 39 failed / 23   |
| Final            | 582 / 0 / 32           | 582 / 0 / 32           |
| A4/A5 alone, ×20 | 20 of 20 failed (each) | 20 of 20 failed (each) |
| A6 before, ×30   | failures               | failures               |

The only root/non-root difference at baseline was A5, and it is inode-reuse chance, not privilege. No agent test
depends on root. The API and web suites ran only as UID 1000 (`node`), as `docs/testing.md` prescribes.

## 21. Preservation of previous cross-platform stabilization [verified, source]

Reviewed `emucat-cross-platform-test-stabilization-report.md` and kept everything it established: API test workers
(2 on Windows, 4 elsewhere, `EMUCAT_API_TEST_WORKERS`) unchanged; per-test `emucat_test_<random>` databases; the
`platform.ts` helpers (junctions, `O_NOFOLLOW`, modes, temporary directory); the SFTP image without
`PerSourcePenalties`; `holdReads` for deterministic cancellation; the Archive Explorer R2 fix; the Compose ownership
check; the junction tests of `packaging.rs`. No timeout, worker count or retry was changed anywhere.

## 22. ZIP64 regression validation [verified]

| Coverage                                                                                                        | Where                                                                       | Result                                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| API ZIP64 parsing, duplicate placeholder, contradictory, truncated, safe numbers, ZIP32 and ZIP64, server clone | `apps/api/test/zip64.test.ts`, `clones.test.ts`, `archive-explorer.test.ts` | pass in `pnpm test` (Windows) and in the Linux API run (§27) |
| Browser-local ZIP64 (24 cases mirroring the server's), limits, nesting                                          | `apps/web/test/archive-local/zip64.test.ts`                                 | 24 passed, Windows and Linux                                 |
| Archive Explorer with nested ZIP64 through the worker handler                                                   | `apps/web/test/archive-nested.test.tsx`                                     | 13 passed, Windows and Linux; 15 runs under load             |
| Nested archives, workers, limits in a real browser                                                              | `apps/web/e2e/archive-explorer.browser.test.ts`                             | 8 passed ×5 (3 Windows, 2 Linux)                             |
| Agent ZIP64 packaging and restore (> 4 GiB)                                                                     | `pnpm test:sftp`                                                            | pass (§26)                                                   |

No ZIP64 code, fixture or assertion was modified. The assessment workspace
(`C:\Users\david\emucat-assessments\seekable-deflate`) was not used, read or modified; no interoperability question
required it. `make-nested-zip64.mjs` was run once into the session scratch directory: it wrote
`zip64-agent-layout.zip` (1,569 bytes), `zip64-contradictory.zip` (265) and `zip64-oversized.zip` (1,283).

## 23. Production code changes

**None.** `agent/src/launcher.rs` and `agent/src/qmp.rs` changed only inside their `#[cfg(test)] mod tests`
(lines from 1126 and 184 respectively; every hunk is in `mod tests`). `agent/examples/fake_vboxmanage.rs` is a test
fake built by `cargo test`, not shipped. `deploy/test/compose-smoke.sh` is the `pnpm test:compose` script, run on a
workstation or in CI only; `emucatctl` neither installs nor runs anything under `deploy/test`. No file under
`apps/api/src`, `apps/web/src`, `packages`, `deploy/bin`, `deploy/config`, `deploy/docker`, `deploy/nginx`, `deploy/sql`, `deploy/systemd`, `deploy/compose.yaml`,
`apps/deployer`, `infra` or any Compose file changed.

## 24. Test infrastructure changes

| File                                                                                | Change                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/e2e/restore.e2e.test.ts`                                                  | E1: role-based publication test, accessible description, API visibility check                                                        |
| `apps/api/e2e/execution.e2e.test.ts`                                                | E3: sections of General, and the Details facts in VM information                                                                     |
| `apps/web/e2e/vite-build.ts` (new)                                                  | B1: cross-platform Vite launcher                                                                                                     |
| `apps/web/e2e/{archive-explorer,operations,version-history}.browser.test.ts`        | B1/B2: `runVite`, `readdirSync`                                                                                                      |
| `apps/web/test/e2e-vite-build.test.ts` (new)                                        | Launcher regression test (4)                                                                                                         |
| `apps/web/test/capture.test.tsx`                                                    | W1: wait for the effect; exactly once; event detail; listener removed on failure                                                     |
| `agent/tests/support/mod.rs` (new)                                                  | A1: layout-independent `example()`                                                                                                   |
| `agent/tests/{execution,virtualbox,virtualbox_management,virtualbox_operations}.rs` | A1: use `support::example`                                                                                                           |
| `agent/src/launcher.rs` (`mod tests`)                                               | A2: native paths                                                                                                                     |
| `agent/tests/ova_import.rs`                                                         | A3: 6 ignored off Windows; new Linux-only boundary test                                                                              |
| `agent/tests/registration.rs`, `agent/tests/restore.rs`                             | A4/A5: 3 ignored off Windows                                                                                                         |
| `agent/examples/fake_vboxmanage.rs`                                                 | A6: one write per log line                                                                                                           |
| `agent/src/qmp.rs` (`mod tests`)                                                    | A7: wait until the fake QEMU has the first request                                                                                   |
| `agent/tests/media.rs`                                                              | A8: delete the directory after detaching, as production does                                                                         |
| `deploy/test/compose-smoke.sh`                                                      | R1: remove the disposable MariaDB's anonymous volume with its container (`docker rm -f -v`)                                          |
| `docs/testing.md`                                                                   | Timings, launcher, synchronization rules, Linux commands (Git Bash), Linux exclusions, targeted commands, leftovers, troubleshooting |

## 25. Before-and-after test results

| Suite                                | Before (`3f5187d`)                      | After                                             |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------- |
| `pnpm test:e2e` (Windows)            | 12 failed, 88 passed, 1 skipped — 720 s | 100 passed, 1 skipped, 0 failed — 616 s and 375 s |
| `test:browser` (Windows, Edge)       | 3 files failed to start, 28 skipped     | 28 passed ×3                                      |
| `test:browser` (Linux, Chromium)     | not run (M0.1)                          | 28 passed ×2                                      |
| Web (Windows)                        | 653 (M0.1)                              | 657 passed (31 files; +4 launcher tests) — 31 s   |
| API (Windows)                        | 1,245 passed, 2 skipped (M0)            | 1,245 passed, 2 skipped (46 files, 1 skipped)     |
| Web (Linux, UID 1000)                | not run in M0.1 as such                 | 657 passed (31 files) — 46 s                      |
| Contracts / deployer (Linux)         | —                                       | 456 / 51 passed                                   |
| Agent (Windows)                      | 619 passed, 27 ignored — 153 s          | 619 passed, 27 ignored — 84 s                     |
| Agent (Linux, UID 1000, Cargo 1.100) | 552 passed, 38 failed, 23 ignored       | 582 passed, 0 failed, 32 ignored — 57 s           |
| Agent (Linux, root, Cargo 1.100)     | 551 passed, 39 failed, 23 ignored       | 582 passed, 0 failed, 32 ignored — 64 s           |

The per-failure resolution is §9's table.

## 26. Complete Windows regression results [verified]

With the final M0.2 changes, from PowerShell 5.1 with fnm's Node.js 22.22.3 (and Git Bash first on `PATH` for the
two Bash suites):

| Command                                                                  | Result                                                                                                                                            | Duration     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `pnpm lint`                                                              | passed                                                                                                                                            | 24 s         |
| `pnpm check`                                                             | passed                                                                                                                                            | 14 s         |
| `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (agent) | clean                                                                                                                                             | —            |
| `pnpm test`                                                              | exit 0: contracts 456; deployer 51; web 657 (31 files); API 1,245 passed, 2 skipped (46 files, 1 skipped); agent 619 passed, 0 failed, 27 ignored | 1,618 s      |
| `pnpm test:e2e`, run 1                                                   | 100 passed, 1 skipped, 0 failed                                                                                                                   | 616 s        |
| `pnpm test:e2e`, run 2                                                   | 100 passed, 1 skipped, 0 failed                                                                                                                   | 375 s        |
| `pnpm --filter @emucat/web test:browser` ×3                              | 28 passed each (Edge 158)                                                                                                                         | 38, 59, 31 s |
| `pnpm test:sftp`                                                         | 151 passed, 0 failed (packaging 30, restore 100, sftp 21; the opt-in ZIP64 > 4 GiB cases included)                                                | 142 s        |
| `pnpm test:deploy`                                                       | 46 passed, 1 skipped as non-root ("needs root"), then its root pass 3 of 3; 0 failed                                                              | 58 s         |
| `pnpm test:compose`                                                      | 48 passed, 0 failed — twice (before and after R1)                                                                                                 | 96 s, 85 s   |
| `pnpm build`                                                             | exit 0 (contracts, web, deployer, API, release agent)                                                                                             | 60 s         |

`pnpm lint` and `pnpm check` were run after the code changes and before the documentation-only edits that followed;
Prettier was run again on the two Markdown files before committing (§40). The first `test:deploy` attempt did not
start: `bash` resolved to WSL's `C:\Windows\system32\bash.exe`, which cannot reach Docker Desktop's socket; with Git
Bash first on `PATH` it ran. `docs/testing.md`'s troubleshooting table now names that case.

## 27. Linux regression results [verified]

All in containers (§7), as UID 1000 unless stated, with the final M0.2 changes:

| Suite                     | Result                                        | Duration   | Note                                                          |
| ------------------------- | --------------------------------------------- | ---------- | ------------------------------------------------------------- |
| Contracts                 | 456 passed                                    | —          |                                                               |
| Deployer                  | 51 passed                                     | —          |                                                               |
| Web                       | 657 passed (31 files)                         | 46 s       | includes the launcher regression test                         |
| Browser (Chromium 156)    | 28 passed, twice                              | 57 s, 72 s |                                                               |
| API (development MariaDB) | 1,245 passed, 2 skipped (45 files, 1 skipped) | 1,409 s    | includes `zip64` (20), `clones` (15), `archive-explorer` (27) |
| Agent, UID 1000           | 582 passed, 0 failed, 32 ignored              | 57 s       | Cargo 1.100                                                   |
| Agent, root               | 582 passed, 0 failed, 32 ignored              | 64 s       | for comparison only                                           |

The API suite runs at 4 workers on Linux, against a MariaDB on Docker Desktop: it takes longer than on Windows
(2 workers) because every test database is migrated on the same shared server. A first attempt from Windows
PowerShell 5.1 printed an environment listing and ran no test: PowerShell 5.1 strips the double quotes inside the
`bash -c` script it passes to `docker`, so `su node -c` received only `export`. `docs/testing.md` showed these
commands as PowerShell; they are now Git Bash commands (`MSYS_NO_PATHCONV=1`, `$(pwd -W)`), the form actually used.

## 28. Repeatability and flakiness results [verified]

| What                                                                | Where                | Runs                      | Failures             |
| ------------------------------------------------------------------- | -------------------- | ------------------------- | -------------------- |
| Full E2E suite                                                      | Windows              | 2 complete (616 s, 375 s) | 0                    |
| Full browser suite                                                  | Windows / Linux      | 3 / 2 complete            | 0                    |
| `capture.test.tsx` (W1), whole file                                 | Windows              | 20                        | 0                    |
| `archive-nested.test.tsx` (W2), whole file, under CPU load          | Windows              | 15 (195 test executions)  | 0                    |
| W1 instrumented repro (old assertion point)                         | Windows, idle / load | 20 / 20                   | 0 / 0 (race not hit) |
| `qmp` A7 before / after                                             | Windows              | 320 / 50                  | 0 / 0                |
| `media` A8 before / after, under load                               | Windows              | 100 / 200                 | **3** / 0            |
| `virtualbox_management` A6 after, root / UID 1000                   | Linux                | 30 / 30                   | 0 / 0                |
| `launcher::` (A2)                                                   | Linux, UID 1000      | 20                        | 0                    |
| `virtualbox`, `virtualbox_management`, `virtualbox_operations` (A1) | Linux, UID 1000      | 20 each                   | 0                    |
| `ova_import`, `registration`, `restore` (A3–A5 files)               | Linux, UID 1000      | 20 each                   | 0                    |

"Under load" means a Node.js process busy-looping 24 or 40 threads on the 20 logical processors. No suite has an
automatic retry; every failure observed is reported above, including the ones that appeared only once.

## 29. Test performance and resource measurements [verified, env]

| Suite                 | Before            | After                                                         | Note                                          |
| --------------------- | ----------------- | ------------------------------------------------------------- | --------------------------------------------- |
| E2E                   | 720 s             | 616 s (with the Linux agent container running), 375 s (alone) | the baseline spent 30 s per cascaded failure  |
| Browser (Windows)     | 2 s (did not run) | 31–59 s                                                       | builds two Vite bundles first                 |
| Agent (Windows)       | 153 s             | 84 s idle; 502 s under load                                   | no change in test count                       |
| Agent (Linux)         | 38 s              | 57 s                                                          | 30 more tests run                             |
| Web (Linux)           | —                 | 46 s                                                          |                                               |
| `pnpm test` (Windows) | 31 min (M0)       | 27 min (1,618 s)                                              | API suite dominates; packages run in parallel |

Linux containers were limited to 4 CPUs and 6 GB (`--cpus=4 --memory=6g`); none was killed for memory. API test
workers stayed at 2 on Windows and 4 on Linux. No regression from the stabilization: the changes add no waiting,
only synchronization on events that already happen.

## 30. Test resource cleanup [verified]

| Resource       | Before / after                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test databases | 65 `emucat_test_*` databases exist, all created between 13 and 26 November (grouped by their data directories' dates); none from today's runs. Left in place: they predate this session                                                                                                                                                                             |
| Containers     | Snapshots before and after `test:sftp`, `test:deploy` and both `test:compose` runs are identical. My Linux containers ran with `--rm` or were removed (`emucat-m02-linux-agent`, `-fixed`, `-final`, `-repeat`, `-web`, `-api`). Remaining: `emucat-mariadb-1` (development) and the six stopped `seek-sftp-*` assessment containers, untouched                     |
| Images         | Unchanged across the suites (the smoke test removes its `smoke-<id>` tags). `emucat-m02-linux-agent:inspect`, which I committed for inspection, was removed. Pre-existing images untouched                                                                                                                                                                          |
| Volumes        | **R1**: the first `test:compose` run left one anonymous volume (the disposable MariaDB's `/var/lib/mysql`). Fixed (`docker rm -f -v`) and removed; the second run left none. 21 older anonymous volumes (8–28 November), consistent with earlier smoke runs, were **not** removed: their origin cannot be proved, and removing volumes that look unused is excluded |
| Networks       | Unchanged                                                                                                                                                                                                                                                                                                                                                           |
| Processes      | No Edge, QEMU, agent, fake or Node.js test process remained after the runs (checked by name and start time)                                                                                                                                                                                                                                                         |
| Files          | `apps/web/e2e/dist` and `dist-app` (browser builds) are git-ignored; temporary directories are removed by the tests; the session's logs are outside the repository. Nothing in the assessment workspace was touched                                                                                                                                                 |

`docker system prune`, `docker volume prune` or any other broad prune was not used.

## 31. Remaining skipped or unexecuted tests

| Test(s)                                     | Why                                                                               | Covered elsewhere             |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| `virtualbox.e2e.test.ts` (1 skipped in e2e) | Opt-in: `EMUCAT_E2E_VBOXMANAGE`; it reads a real VirtualBox                       | `fake_vboxmanage` agent tests |
| 86Box e2e                                   | 86Box not installed on this workstation (the e2e says so and skips)               | fake emulator tests, QEMU e2e |
| Real QEMU/86Box agent tests (5 ignored)     | Opt-in (`EMUCAT_REAL_QEMU`, `EMUCAT_REAL_86BOX`)                                  | e2e real QEMU                 |
| API real-OVA tests (2 skipped)              | Opt-in (`EMUCAT_OVA_FIXTURE`); no OVA in the repository                           | synthetic OVA tests           |
| 9 agent tests on Linux                      | §18–19, Windows-only by design                                                    | Windows runs                  |
| Linux `cargo clippy -- -D warnings`         | The local Rust image has no clippy component; not installed (would be a download) | C1, §38                       |
| Native Linux host                           | Only Docker Desktop containers are available here                                 | —                             |

## 32. Deployment impact matrix [verified by `git diff --stat 3f5187d`]

| Component                        | M0.2 impact                                                                                         | Classification |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| API production code              | None                                                                                                | —              |
| Web production code              | None                                                                                                | —              |
| Shared contracts                 | None                                                                                                | —              |
| Windows agent production code    | None (`#[cfg(test)]` modules and `examples/` only)                                                  | Test-only      |
| Windows agent executable         | None (see §35 for the binary comparison)                                                            | —              |
| Agent protocol                   | None                                                                                                | —              |
| Database schema / migrations     | None (newest is still `0021_server_repository_access`)                                              | —              |
| Compose production configuration | None                                                                                                | —              |
| Reverse proxy                    | None                                                                                                | —              |
| Deployment tooling               | None (`deploy/bin`, `apps/deployer` unchanged; only the test script `deploy/test/compose-smoke.sh`) | Test-only      |
| Environment variables            | None                                                                                                | —              |
| Test infrastructure              | Changed (§24)                                                                                       | Test-only      |
| Documentation                    | `docs/testing.md`, this report                                                                      | Documentation  |
| Existing repository archives     | Unchanged                                                                                           | —              |

**M0.2 alone requires no application deployment.** Deploying its commit changes nothing at runtime: the images it
builds have the same application code as `3f5187d`. The image `verify` stage runs the web suite, which now includes
`e2e-vite-build.test.ts` (build-time only).

**Cumulative M0 + M0.1 + M0.2** (relative to what Mars runs if it is older than `1c45e18`): runtime changes in the
API (`apps/api/src`, the ZIP64 central-directory resolution of decision 0061, used by Archive Explorer and server
clones) and in the web application (`apps/web/src/archive-local/zip.ts`, the browser-local nested reader). No
schema, configuration, Compose, tooling, environment or agent change in any of the three. One `emucatctl update`
deploys all of it.

## 33. Mars deployment runbook [unverified on Mars: not executed]

Mars: branch `develop`, `https://emucat-test.dfri.info`, installation root `/opt/emucat`, Compose project `emucat`.
The commands were checked in this release's `deploy/bin/emucatctl`: `install`, `check`, `status`, `check-update`,
`update`, `backup`, `rollback-app [--to COMMIT] [--yes]` and `logs` all exist (lines 1302–1309, usage at 571).
`update` fetches the branch into the bare repository `/opt/emucat/repo.git` (there is no `/opt/emucat/repo`
checkout), builds the API and web images with their `verify` stages, backs up the database, applies migrations
(none), recreates the containers and health-checks them.

Placeholders: `<commit>` = the final `develop` commit of §40; `<previous>` = what Mars runs now (`Deployed:` in
`status`). Expected `<previous>`: `3f5187d` if M0.1 was deployed, `1c45e18` if only M0, or older.

### 33.1 Pre-deployment (on Mars, in any directory)

1. Target, on any machine with the repository: `git fetch origin && git log -1 --format='%H %s' origin/develop`
   must print `<commit>`.
2. Installation layout:

   ```bash
   ls -d /opt/emucat/tooling/bin/emucatctl /opt/emucat/repo.git /opt/emucat/state/current-release.json
   ```

   If `/opt/emucat/tooling` is missing, the host is not installed with this tooling: stop and follow
   `docs/deployment.md` (`emucatctl install`) first.

3. Current release, note `Deployed:` as `<previous>` (the rollback target):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl status
   ```

4. Update available (`Latest:` must be `<commit>`; this also fetches `develop` into `repo.git`):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check-update
   ```

5. Prerequisites (every line ok):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check
   ```

6. Tooling current, nothing the tooling installs changed, no migration:

   ```bash
   sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
   ```

   ```bash
   sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat <previous> refs/remotes/origin/develop -- deploy apps/deployer apps/api/migrations compose.yaml
   ```

   - `tooling is current` and the diff prints only `deploy/test/…` lines or nothing: no tooling refresh, no
     `emucatctl install`, no migration, no configuration change. Continue.
   - Otherwise Mars runs a release older than decision 0055: deploy that first with `docs/runbook-0055-mars.md`
     (then `docs/runbook-0056-mars.md` if needed), and come back.

7. Health and space:

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/ready
   ```

   ```bash
   df -h /opt/emucat /var/lib/docker
   ```

   At least the space of two API and web image builds (a few GB) free.

8. Active work (`update` restarts the API): Admin › Registrations › **Needs attention** shows nothing Queued,
   Validating, Archiving, Uploading, Verifying, Committing or Cleaning up; no Remote Snapshot is publishing; no
   server-side clone runs; Admin › Sessions shows no running session you need. In SQL, if preferred:

   ```sql
   SELECT id, mode, state, emulator_type, vm_name, created_at FROM registration_operations WHERE active_marker = 1;
   ```

9. Note each agent's version and status in Admin › Agents. Optional extra backup (`update` takes its own):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl backup
   ```

10. Note the web bundle served now, to see it change:

    ```bash
    curl -fsS https://emucat-test.dfri.info/ | grep -o 'assets/index-[^"]*\.js' | head -1
    ```

### 33.2 Deployment

1. Repository synchronization: none by hand (`update` fetches `develop`).
2. Tooling refresh / `emucatctl install`: not required when 33.1.6 says so.
3. Configuration, environment variables, Compose, reverse proxy: none.
4. Migrations: none.
5. Agents: no update (§35).
6. Update (answer `y`):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

Expected: the API and web containers are rebuilt and recreated; MariaDB is not. Downtime is the API's restart and
health check, typically under a minute; agents reconnect by themselves. If M0.1 (`3f5187d`) is already deployed, the
new images carry no application change at all.

### 33.3 Post-deployment

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

`Deployed:` is `<commit>`.

```bash
sudo docker inspect -f '{{.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1 emucat-web-1
```

Both `<commit>`.

```bash
sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}}'
```

All `(healthy)`.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/health
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
curl -fsS https://emucat-test.dfri.info/ | grep -o 'assets/index-[^"]*\.js' | head -1
```

Differs from 33.1.10 only if the web code changed since `<previous>` (it does when `<previous>` predates M0.1).

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

No `Invalid configuration`, no unexpected `"level":50` or `60`. In the browser, reload with Ctrl+F5 so that the new
bundle and its archive worker are used. Admin › Agents: every agent online, same version as before.

## 34. Cumulative Mars functional acceptance checklist (M0, M0.1, M0.2)

Use a disposable VM or version as the destination of every operation that writes; never delete or replace a
production master.

| #   | Area                          | Step                                                                                                                                                                                                                    | Expected                                                                                                                                                                                                                                                                      |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authentication                | Sign out, sign in                                                                                                                                                                                                       | Session works; the catalog loads                                                                                                                                                                                                                                              |
| 2   | Catalog                       | Public catalog, then a public VM's page; back and forward                                                                                                                                                               | Covers, detail page and screenshots as before                                                                                                                                                                                                                                 |
| 3   | VM management                 | Catalog › a VM › **Manage this VM**                                                                                                                                                                                     | General opens; the VM sidebar lists General, Version History, Local copies and restore, Notes, Screenshots                                                                                                                                                                    |
| 4   | General                       | **VM actions** toolbar: status chip, Make public/private (hover: its consequence), View public page, **VM information**                                                                                                 | VM information lists Publication, Identity, Contents, History; Metadata and Run and verify are the page's sections                                                                                                                                                            |
| 5   | Publication (disposable VM)   | Make public, then private again                                                                                                                                                                                         | Chip and button follow; the public catalog shows, then hides, the VM                                                                                                                                                                                                          |
| 6   | Metadata                      | Change the description, **Save**, reload                                                                                                                                                                                | "Unsaved changes", then "Saved"; the value persists                                                                                                                                                                                                                           |
| 7   | Version History               | Open it; expand branches; hover and focus toolbar icons; Info of a master and a snapshot                                                                                                                                | Compact cards, tooltips, Info inside the window                                                                                                                                                                                                                               |
| 8   | Local copies and restore      | Restore a version to an agent (disposable destination)                                                                                                                                                                  | Completes; restore history row with its details dialog                                                                                                                                                                                                                        |
| 9   | Notes, Screenshots            | Open both sections                                                                                                                                                                                                      | As before                                                                                                                                                                                                                                                                     |
| 10  | Local execution               | Run and verify › local mode on an agent holding a copy                                                                                                                                                                  | The emulator starts and stops                                                                                                                                                                                                                                                 |
| 11  | Remote volatile / snapshot    | Run and verify › Run remotely, then Run and snapshot (disposable)                                                                                                                                                       | Session in General › Now; for the snapshot, "Publishing Remote Snapshot" on the chosen version, then the ending                                                                                                                                                               |
| 12  | Snapshot synchronization      | Snapshot a local copy from Version History                                                                                                                                                                              | Spinner on the parent version with its phase; header "1 operation running"; survives a page reload; completion notice; tree read again                                                                                                                                        |
| 13  | Server-side clone             | Copy-plus a master or snapshot to a new disposable VM                                                                                                                                                                   | "Cloning VM", performed by the server; "VM cloned" with a link; the new VM's master is published and its archive opens in Archive Explorer                                                                                                                                    |
| 14  | Archive Explorer, ZIP         | **View contents…** on an ordinary 86Box version and a QEMU version                                                                                                                                                      | Listing, text, image and hex preview, download                                                                                                                                                                                                                                |
| 15  | Archive Explorer, OVA         | The same on a VirtualBox (OVA) master                                                                                                                                                                                   | `.ovf`, disk and `.mf` listed; the OVF previews                                                                                                                                                                                                                               |
| 16  | Archive Explorer, agent ZIP64 | A version written by the agent with a file of 4 GiB or more (ZIP64)                                                                                                                                                     | Lists, inspection complete; the large entry shows its real size; a file after it (beyond the 4 GiB offset) previews and downloads                                                                                                                                             |
| 17  | Browser-local nested archives | A version containing an ordinary `.zip`: expand it                                                                                                                                                                      | One download; browse, preview and download inside it                                                                                                                                                                                                                          |
| 18  | Nested ZIP64 (synthetic)      | On a workstation: `node apps/web/test/tools/make-nested-zip64.mjs <empty directory>`; put `zip64-agent-layout.zip`, `zip64-contradictory.zip`, `zip64-oversized.zip` into a disposable VM directory, register a version | `zip64-agent-layout.zip` opens with its inner ZIP64 archive; `zip64-contradictory.zip` says it is damaged and the explorer stays usable; `zip64-oversized.zip` lists at 5 GiB, hex of its start works, download and opening as an archive are refused by the browser's limits |
| 19  | Limits and recovery           | After 18, open another nested archive                                                                                                                                                                                   | Works without reloading the page                                                                                                                                                                                                                                              |
| 20  | Agents                        | Admin › Agents; one archive inspection, one restore, one snapshot (12) with an existing agent                                                                                                                           | Agents online, versions unchanged; all three work                                                                                                                                                                                                                             |
| 21  | Logs                          | `sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 300 \| grep -E '"level":(50\|60)'`                                                                                                                              | Nothing new                                                                                                                                                                                                                                                                   |

## 35. Agent deployment requirements [verified]

No agent production file and no distribution artifact changed in M0.2 (§23); M0 and M0.1 did not change the agent
either. **No agent update is required**; installed agents remain compatible, the protocol being unchanged. As a
check, `pnpm build` rebuilt the release agent (`emucat-agent 0.1.0`). Its SHA-256 differs from the previous release
binary (26 November), but so do two consecutive builds of identical source (`AFCA5095…`, then `F6F0DF11…` after only
touching `main.rs`): an MSVC build embeds a per-build debug-information identifier, so the binary hash cannot show
equivalence. The evidence is the source: `git diff 3f5187d -- agent/src` contains only hunks inside `#[cfg(test)]`
modules, which a release build does not compile, and `agent/examples` and `agent/tests` are not part of the binary.

## 36. Rollback runbook [unverified on Mars]

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

`<previous>` is the `Deployed:` value noted in 33.1.3 (also in `/opt/emucat/state/current-release.json` before the
update). Then verify as in 33.3 (`status`, `docker inspect` showing `<previous>`, `ready`). Forward again:
`emucatctl update`.

- Database restoration: not required (no migration in M0, M0.1 or M0.2). Configuration restoration: not required.
  Agent rollback: not required. Reload the browser (Ctrl+F5) after a rollback so that the older bundle is used.
- **M0.2 alone:** rolling back to `3f5187d` changes nothing at runtime.
- **Cumulative:** rolling back to before `1c45e18` (M0) restores the old ZIP64 reading: archives written by the agent
  with duplicate ZIP64 records become unreadable again in Archive Explorer and as clone sources. Rolling back to
  before `615d051` (M0.1) does the same for nested ZIP64 archives opened in the browser. No archive in the repository
  is modified by any of the three milestones; archives produced by a server clone after M0 were written by the
  corrected writer of decision 0061 and remain readable by both the new and the old reader (the M0 report, §24,
  verified the rewritten records are standard).

## 37. Moon production deployment guidance

Moon: branch `main`, installation root `/opt/emucat`. Only after M0.2 is complete, Mars acceptance (§34) has passed,
the limitations of §38 are accepted, and you have promoted `develop` into `main` yourself.

1. Preconditions: `git log -1 origin/main` is the promoted commit, containing `1c45e18`, `3f5187d` and this
   milestone's commits; on Moon no operation is active (33.1.8).
2. On Moon, in order: `sudo /opt/emucat/tooling/bin/emucatctl status` (note `<previous>`), `check-update` (`Latest:` =
   the promoted commit), `check`, then the tooling and migration checks of 33.1.6 with `refs/remotes/origin/main`.
   No repository checkout by hand, no tooling refresh, no `install`, no configuration change are expected.
3. `sudo /opt/emucat/tooling/bin/emucatctl update` (answer `y`).
4. Verify as in 33.3 with Moon's URL; reload browsers. Agents: no update; check they are online.
5. Rollback: `sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>`, as in §36.

## 38. Remaining limitations and risks

- **C1 (follow-up).** On Linux the agent library warns that `process::same_image` is never used; CI's Ubuntu job
  runs `cargo clippy --all-targets -- -D warnings`, which makes that warning an error. Not verified (no clippy in the
  local image; `gh` is not installed to read CI). The fix (a `cfg` on the function) is in agent source, outside this
  test-only milestone. [proposed]
- **Cargo 1.100 in CI.** CI uses `dtolnay/rust-toolchain@stable`. Before this change its agent jobs would have failed
  26 VirtualBox/execution tests on 1.100; after it they should pass. CI was not observed.
- **W2** remains a non-reproducible observation; **W1** and **A7** are corrections of established defects whose
  failure was not reproduced.
- The real-browser suite still has no ZIP64 case (§15). [proposed for M1]
- The Linux agent limits (credential store, inode-based identity) are product support boundaries, not defects of a
  supported platform.
- Linux validation ran in Docker Desktop containers (WSL 2 kernel), not on a native Linux host; Mars and Moon are
  the first native Linux hosts that will run these images.
- E2E: 86Box and the VirtualBox e2e file are not covered on this workstation (opt-in).

## 39. M1 readiness assessment

**CONDITIONAL GO.**

Met: the twelve E2E failures are corrected without weakening (two full runs clean); the browser suite runs on
Windows and Linux (5 complete runs); every Linux agent failure is classified and either corrected (31) or excluded
off Windows with its reason (9); Windows and Linux agent suites pass, as UID 1000 and as root; the whole Windows
regression (`lint`, `check`, `test`, `test:e2e`, `test:browser`, `test:sftp`, `test:deploy`, `test:compose`, `build`)
and the Linux API, web, contracts, deployer and agent suites pass; ZIP64 coverage is intact; four further
intermittent or leaking tests found on the way were corrected (A7, A8, A6, R1); no production code changed.

The condition, before M1's first change is merged: **confirm GitHub Actions on the pushed `develop` commit** — in
particular the Ubuntu agent job's `cargo clippy --all-targets -- -D warnings` (C1) and the agent jobs on stable Cargo
1.100 — and, if C1 fails there, land its one-line `cfg` fix first. Neither could be observed from this workstation.

Accepted, not blocking: W2 is a non-reproducible observation; W1 and A7 were corrected without being reproduced;
Linux validation was containerized; the real-browser suite has no ZIP64 case.

## 40. Final repository status and commit references

Committed on `develop` on top of `3f5187d`, in this order, and pushed to `origin/develop` (fast-forward, no force);
`main` was not touched. The commit hashes are those of `git log 3f5187d..origin/develop`; this report is in the last
commit and cannot name its own hash.

| #   | Subject                                                                                 | Files                                                                                               |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `test(e2e): assert General's VM actions and VM information (decision 0060)`             | `apps/api/e2e/restore.e2e.test.ts`, `execution.e2e.test.ts`                                         |
| 2   | `fix(test): build the browser tests' bundles without npx or a shell`                    | `apps/web/e2e/vite-build.ts`, the three `*.browser.test.ts`, `apps/web/test/e2e-vite-build.test.ts` |
| 3   | `test(web): wait for the publication event in the capture test`                         | `apps/web/test/capture.test.tsx`                                                                    |
| 4   | `test(agent): find test examples in either Cargo layout; native launcher test paths`    | `agent/tests/support/mod.rs`, `execution.rs`, `virtualbox*.rs`, `agent/src/launcher.rs` (tests)     |
| 5   | `test(agent): run Windows-only credential and directory-identity tests on Windows only` | `agent/tests/ova_import.rs`, `registration.rs`, `restore.rs`                                        |
| 6   | `test(agent): synchronize the QMP and media tests; write fake log lines whole`          | `agent/src/qmp.rs` (tests), `agent/tests/media.rs`, `agent/examples/fake_vboxmanage.rs`             |
| 7   | `test(deploy): remove the compose smoke test's MariaDB volume`                          | `deploy/test/compose-smoke.sh`                                                                      |
| 8   | `docs: M0.2 test baseline, testing guide and report`                                    | `docs/testing.md`, this report                                                                      |

The working tree is clean after the push; no file outside these was staged.
