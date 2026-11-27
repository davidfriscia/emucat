# Runbook: deploying operation visibility and the General redesign (decision 0060) on MARS

Snapshot and clone operations followed in Version History and General, and the Lucide-based General page
([decision 0060](decisions/0060-operation-visibility.md)), deployed by hand on MARS, the test server: branch `develop`,
`https://emucat-test.dfri.info`, installation root `/opt/emucat`, Compose project `emucat` (containers `emucat-api-1`,
`emucat-web-1`). Every command below exists in this release's `deploy/bin/emucatctl`; run them in order.

Placeholders: `<commit>` is the full commit ID you deploy (the tip of `develop`); `<previous>` is the one MARS runs
now (expected `6280823…`, decision 0059).

Nothing below was run against MARS from the development environment: the commands come from the repository, and every
check of the host is yours to make.

## 1. What this release changes on a host

Since `6280823` (decision 0059), `git diff --stat 6280823 <commit> -- deploy apps/deployer agent apps/api/migrations` is
empty.

| Component                                  | Change                                                                                      | Mandatory | Backward compatible                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| API image                                  | **Code change**: one read-only route, `GET /api/v1/admin/vms/:type/:name/operations`        | Yes       | Yes: additive; no existing route, response or message changed                            |
| Web image                                  | **Code change**: operation indicators, General redesign                                     | Yes       | Needs the API of this release (else "Operation status unavailable"; nothing else breaks) |
| Database                                   | **None**. No migration; the newest is still `0021_server_repository_access`                 | —         | —                                                                                        |
| Windows agent, agent protocol              | **None**. No agent update, no version increment; every deployed agent keeps working         | No        | Yes                                                                                      |
| Deployment tooling (`emucatctl`, deployer) | **None** since `a2e8988` (decision 0055): **no tooling refresh**, no `emucatctl install`    | No        | —                                                                                        |
| Docker Compose, volumes, directories       | **None**                                                                                    | —         | —                                                                                        |
| Configuration (`app.env`, `deploy.env`)    | **None**; no new environment variable                                                       | —         | —                                                                                        |
| nginx in the web container, reverse proxy  | **None**                                                                                    | —         | —                                                                                        |
| Background processes, resources            | **None** new. Each open VM page adds one `GET` every 2 s while an operation runs, else 15 s | —         | —                                                                                        |
| New dependencies                           | **None**                                                                                    | —         | —                                                                                        |

### Configuration matrix

| Variable | Existing or new | Required | Default | File | Example | Manual action | Restart |
| -------- | --------------- | -------- | ------- | ---- | ------- | ------------- | ------- |
| (none)   | —               | —        | —       | —    | —       | None          | —       |

No configuration change is required.

**Is `emucatctl update` alone enough?** Yes, when MARS runs a release from decision 0055 on with that release's tooling.
Section 2 checks this.

## 2. Pre-deployment checks

On the workstation, the target:

```bash
git fetch origin
```

```bash
git log -1 --format='%H %s' origin/develop
```

On MARS, the current release (note it as `<previous>`):

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

The available update (`Latest:` must be `<commit>`):

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

The host's prerequisites (every line ok):

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Tooling compatibility:

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat <previous> refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml deploy/docker apps/deployer apps/api/migrations
```

- `tooling is current` and an empty diff: no tooling refresh, no migration. Go on.
- Otherwise MARS runs a release older than 0055: deploy 0055 first with [its runbook](runbook-0055-mars.md), then
  come back.

Health and space:

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
df -h /opt/emucat /var/lib/docker
```

**Agents.** Admin › Agents: note each agent's version and that it is online. No agent needs updating; this inventory
is only for the post-deployment comparison.

**Active operations: deploy only when none runs.** The update restarts the API. Agent operations are durable and are
picked up again when the agent reconnects (decision 0015), but a **server-side clone** that is running starts again
from the beginning after a restart, and fails with `server_restarted` after three interrupted attempts (decision 0055).
Archive transfers through the relay are also interrupted and resumed. Before updating:

1. Admin › Registrations › view **Needs attention**: no operation in Queued, Validating, Archiving, Uploading,
   Verifying, Committing or Cleaning up. Wait for any to finish.
2. No Remote Snapshot session in "Publishing" on a VM's General page.

If you prefer SQL, with your usual MariaDB client for the EmuCat database (not part of this Compose project):

```sql
SELECT id, mode, state, emulator_type, vm_name, created_at
FROM registration_operations WHERE active_marker = 1;
```

An empty result means no registration, snapshot, remaster or clone is running.

Backup (an `update` takes one too; this is your own restore point):

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

```bash
sudo ls -lt /opt/emucat/backups | head -3
```

## 3. Deployment

1. Repository checkout or download: **not needed**. `update` fetches `develop` into `/opt/emucat/repo.git` itself.
2. Tooling refresh, `emucatctl install`: **not needed** (section 2).
3. Configuration, environment variables, Compose, reverse proxy: **none**.
4. Migrations: **none**.
5. Update:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. With `EMUCAT_VERIFY=true` the web image's `verify` stage runs `tsc` and the web unit tests (627),
   and the API image's runs the contracts tests (456) and its database-free API tests. It reports that no migration
   was applied. Admin › Application Updates starts the same update.

6. Agents: **nothing to do**. Section 5 item 4 checks that every agent reconnected.

## 4. Post-deployment checks

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

`ready` with `migrations: ok`: the schema is unchanged and complete.

The new route exists and is protected (anonymous: `401`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://emucat-test.dfri.info/api/v1/admin/vms/86box/DOS622/operations
```

Logs (no errors):

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs web --tail 100
```

In the browser, signed in as an administrator, Developer tools › Network on a VM's page: `GET …/operations` answers
`200` with `{"operations":[…],"retentionHours":24,"serverTime":…}`. Console: no errors.

**Browser cache.** `index.html` is `no-cache` and assets are content-hashed: a normal reload shows the new interface.

## 5. Functional acceptance checklist (MARS)

Use a **disposable test VM** for everything that creates or changes versions: for example clone a small VM into
`TEST_0060` (item 29) and work on it. Never use a valuable archive. Where only the dialog matters, open it and
**Cancel**.

| #   | Scenario                               | How                                                                                                                | Expected                                                                                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Deployed commit                        | Section 4                                                                                                          | `<commit>` in both images                                                                                                                  |
| 2   | Application health                     | Section 4                                                                                                          | `health` and `ready` ok                                                                                                                    |
| 3   | Existing agent connectivity            | Admin › Agents                                                                                                     | Every agent online, same versions as before the update                                                                                     |
| 4   | Old-agent compatibility                | Use the existing agent for 15–28                                                                                   | Everything works with the agent you already run: no agent update exists for this release                                                   |
| 5   | Updated agent                          | —                                                                                                                  | Not applicable: no agent change                                                                                                            |
| 6   | Open General                           | Catalog › a VM › Manage this VM                                                                                    | General opens                                                                                                                              |
| 7   | Compact toolbar                        | Top of General                                                                                                     | One row: Private/Public chip, eye icon (Make public) or crossed eye (Make private), external-link icon if public, ⓘ at the right end       |
| 8   | VM Info                                | ⓘ (VM information)                                                                                                 | Panel titled with the VM's title; Publication, Identity, Contents, History                                                                 |
| 9   | All former Details facts               | Compare 8 with the previous release's Details panel                                                                | Visibility text, cover sentence, Emulator, VM name, Versions, Media, Cloned from (for a clone), Registered/Created, Updated, identity note |
| 10  | Metadata                               | Change the display name, then Save (top right of Metadata)                                                         | "Unsaved changes" appears while edited; Save shows "Saved"; the heading shows the new name                                                 |
| 11  | Tags                                   | Add and remove a tag                                                                                               | Saved immediately, as before; no Save needed                                                                                               |
| 12  | Publication controls                   | Make public, then Make private (test VM)                                                                           | Status chip changes; external-link icon only while public, opening the public page; a public VM without cover shows its warning            |
| 13  | Execution modes                        | Run and verify                                                                                                     | Local (drive), Remote Volatile (play), Remote Snapshot (camera), names visible; the selected mode's explanation below; ⓘ explains all      |
| 14  | Version History                        | Sidebar › Version History                                                                                          | As in 0059; no operation indicator when nothing runs                                                                                       |
| 15  | Snapshot from a local copy             | On a version with a local copy (test VM): upload icon › Create snapshot                                            | The dialog closes; an indicator appears at once beside that version's ⓘ                                                                    |
| 16  | Active spinner                         | Watch 15                                                                                                           | Turning circle, "Creating snapshot · Packaging", then "Transferring NN%", "Verifying NN%"; header "1 operation running"                    |
| 17  | Operation details                      | Click the indicator                                                                                                | Panel: operation, status, identifier, source version, reserved version, agent (online), repository, transport, timing, progress note       |
| 18  | General shows it                       | Sidebar › General                                                                                                  | Header "1 operation running"; Run and verify › Now › Archive operations lists it; "No VM session is running."                              |
| 19  | Same operation                         | Compare 17 and 18                                                                                                  | Same identifier and phase                                                                                                                  |
| 20  | Browser refresh                        | F5 while it runs                                                                                                   | The indicator returns with the current phase                                                                                               |
| 21  | Still visible                          | Close the tab, open the VM again                                                                                   | Still shown                                                                                                                                |
| 22  | Completion                             | Wait                                                                                                               | Spinner stops; green notice "Snapshot created: <name>" with ×                                                                              |
| 23  | Success feedback                       | Look at the card and header                                                                                        | Card shows "Snapshot created"; header "1 recent operation"; screen readers hear it once                                                    |
| 24  | New snapshot appears                   | Without reloading                                                                                                  | The new snapshot is in the tree under its parent; expanded/collapsed branches unchanged; version count in the page header updated          |
| 25  | Remote Snapshot run                    | Test VM: camera icon (Run and snapshot) › General › Start Remote Snapshot                                          | Now shows the remote session                                                                                                               |
| 26  | Execution is not synchronization       | While the emulator runs                                                                                            | No archive operation and no operation spinner; header shows no running operation                                                           |
| 27  | Synchronization after execution        | Shut the emulator down                                                                                             | "Publishing Remote Snapshot · …" appears on the chosen version and in Now                                                                  |
| 28  | Snapshot publication                   | Wait                                                                                                               | "Remote Snapshot published: <name>"; the new snapshot appears under the chosen version                                                     |
| 29  | Clone a Master                         | Copy-plus on the master › name `TEST_0060`                                                                         | Indicator "Cloning VM · …" on the **master** card                                                                                          |
| 30  | Clone indicator                        | Details                                                                                                            | Performed by "The EmuCat server", transport the server's own connection, destination "(reserved; created when the clone completes)"        |
| 31  | Clone completion                       | Wait                                                                                                               | "VM cloned: TEST_0060" with "Open TEST_0060"; you stay on the source VM                                                                    |
| 32  | Destination registered                 | Open TEST_0060                                                                                                     | It exists, private; VM information › History › Cloned from names the source                                                                |
| 33  | Clone a Snapshot                       | Copy-plus on a **snapshot** of the test VM › `TEST_0060B`                                                          | The indicator is on that snapshot's card, not on the master                                                                                |
| 34  | Source association                     | Details › Source version                                                                                           | That snapshot's label and short identifier                                                                                                 |
| 35  | Failure feedback (safe)                | Admin › Agents: stop the test agent's service during a snapshot of the test VM (item 15), wait for it to reconnect | First "Waiting for the agent" (no spinner); after reconnection either it resumes, or a red notice with the reason and what to do           |
| 36  | Browser network interruption           | Developer tools › Network › Offline for ~10 s while an operation runs, then Online                                 | "status unavailable" with the last phase, no spinner, no failure notice; back to the live phase by itself                                  |
| 37  | Agent reconnection                     | Restart the agent service during an operation                                                                      | "Waiting for the agent", then the phase again or an explained failure; never "completed" by itself                                         |
| 38  | Collapsed branch                       | Collapse the branch holding a version under operation                                                              | Header still counts it; its panel names the version                                                                                        |
| 39  | Multiple operations                    | Clone two versions of the test VM one after the other                                                              | Each on its own version; one card with two says "2 of 2 operations running"; header counts both                                            |
| 40  | Dark theme                             | Theme: Dark                                                                                                        | Indicators, notices and chips readable                                                                                                     |
| 41  | Light theme                            | Theme: Light                                                                                                       | Same                                                                                                                                       |
| 42  | Narrow window                          | ~400 px wide                                                                                                       | Toolbars wrap, no sideways scroll; panels open as a sheet at the bottom                                                                    |
| 43  | Archive Explorer                       | Folder icon on a version                                                                                           | Works as in 0058                                                                                                                           |
| 44  | No unexpected errors                   | API logs (section 4), the agent's log, the browser console                                                         | No errors other than those caused on purpose in 35–37                                                                                      |
| 45  | Archive integrity and transfer cleanup | Folder icon on the new snapshot and clone; repository staging                                                      | Contents open; no leftover `archives/.staging/…` objects of finished operations; relay staging empty after transfers                       |

Remove `TEST_0060`, `TEST_0060B` and the test snapshots afterwards as you usually handle test VMs.

## 6. Rollback

There is no migration, so going back never needs a database restore:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

- Do it with no operation running, as in section 2: the API restarts.
- Operation records are untouched by this release and by its rollback; the previous release reads them as before.
- Dismissed notices are kept only in each browser (`emucat.operations.dismissed` in local storage); the previous
  release ignores the key.
- Agents: nothing to roll back. Tooling and configuration: nothing to roll back.
- Archives, VMs and versions: never modified by this release.

Reload the browser tabs. Forward again with `sudo /opt/emucat/tooling/bin/emucatctl update`.

## 7. After MARS

You promote `develop` to `main` yourself, then update MOON with `emucatctl update`, after the same section 2 checks
against `refs/remotes/origin/main`, including **no operation running**. No production agent needs updating. Nothing
was deployed to MARS or MOON as part of this change.
