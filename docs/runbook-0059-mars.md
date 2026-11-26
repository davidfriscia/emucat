# Runbook: deploying the Version History redesign (decision 0059) on MARS

Compact Version History cards, icon toolbars, metadata on demand and the VM sidebar's icons
([decision 0059](decisions/0059-version-history-icon-toolbars.md)), deployed by hand on MARS, the test server: branch
`develop`, `https://emucat-test.dfri.info`, installation root `/opt/emucat`, Compose project `emucat` (containers
`emucat-api-1`, `emucat-web-1`). Every command below exists in this release's `deploy/bin/emucatctl`; run them in order.

Placeholders: `<commit>` is the full commit ID you deploy (the tip of `develop`); `<previous>` is the one MARS runs now.

## 1. What this release changes on a host

Only the web application changed (`apps/web`), plus documentation. Since the previous release (`79981c5`, decision
0058), `git diff --stat 79981c5 <commit> -- deploy apps/api apps/deployer agent packages` is empty.

| Component                                  | Change                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Web image                                  | **Rebuilt** by `update`: the new Version History and sidebar                |
| API image                                  | Rebuilt by `update` from the same commit; **no code change**                |
| Deployment tooling (`emucatctl`, deployer) | **None** since `a2e8988` (decision 0055): **no tooling refresh**            |
| Docker Compose, volumes, directories       | **None**                                                                    |
| Configuration (`app.env`, `deploy.env`)    | **None**; no new environment variable                                       |
| Database                                   | **None**. No migration; the newest is still `0021_server_repository_access` |
| nginx in the web container, reverse proxy  | **None**                                                                    |
| Windows agent, protocol                    | **None**. No agent update                                                   |
| New dependencies                           | **None**. `lucide-react` was added by 0058                                  |

**Is `emucatctl update` alone enough?** Yes, when MARS runs a release from decision 0055 on with that release's tooling
(the 0055, 0056 and 0058 runbooks required it). Section 2 checks this.

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
- Otherwise MARS runs a release older than 0055: deploy 0055 first with [its runbook](runbook-0055-mars.md), which
  includes the repository synchronization and `emucatctl install`, then come back.

Health and space:

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
df -h /opt/emucat /var/lib/docker
```

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
4. Update:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. With `EMUCAT_VERIFY=true` the web image's `verify` stage runs `tsc` and the web unit tests (614),
   including the new Version History and UI primitive tests. It reports that no migration was applied. Admin ›
   Application Updates starts the same update.

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

```bash
curl -sI https://emucat-test.dfri.info/ | grep -iE 'x-frame-options|cache-control'
```

`X-Frame-Options: DENY` and `Cache-Control: no-cache`, unchanged.

Logs (no errors):

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs web --tail 100
```

**Browser cache.** `index.html` is `no-cache` and assets are content-hashed: a normal reload shows the new interface.
A tab left open from before the update keeps the old one until it is reloaded.

## 5. Functional acceptance checklist (MARS)

Part A changes nothing. Part B runs operations: use a **disposable test VM** (for example a clone of a small VM made in
item B1, or a new small 86Box VM), never a valuable archive. Where only the dialog matters, open it and **Cancel**.
Keep the browser's developer tools open (Console, Network) for A.

### A. Non-destructive interface checks

| #   | Scenario                        | How                                                             | Expected                                                                                                                                                           |
| --- | ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Deployed commit                 | Section 4                                                       | `<commit>` in both images                                                                                                                                          |
| 2   | Open a VM                       | Catalog › a VM › Manage this VM                                 | General opens                                                                                                                                                      |
| 3   | Sidebar icons                   | Look at the VM sidebar                                          | ← Back to Catalog; gear General, history Version History, drive, notebook, images; labels unchanged                                                                |
| 4   | Version History                 | Sidebar › Version History                                       | Opens; active item highlighted; Admin sidebar and header unchanged                                                                                                 |
| 5   | Compact header                  | Top of the section                                              | History icon, "Version History", "N versions", ↻ (if a local copy exists) and ⓘ on one line                                                                        |
| 6   | Page Info                       | Header ⓘ                                                        | "About the version history" with the immutability/branching paragraph; Escape closes, focus returns                                                                |
| 7   | Remaster tooltip                | Hover or Tab to ↻                                               | "Remaster from local copy"                                                                                                                                         |
| 8   | Master card                     | Look at the master                                              | Layers icon, title, MASTER, short ID; date · size; chips; one toolbar row on a wide window                                                                         |
| 9   | Snapshot card                   | Look at a snapshot                                              | Camera icon, name (and label if titled), SNAPSHOT, short ID; Promote and Delete at the end                                                                         |
| 10  | Compact metadata                | Compare with the previous release                               | Created, size, status in one line; parent, source agent, description are no longer on the card                                                                     |
| 11  | Master Info                     | Master's ⓘ (right end of its toolbar)                           | Panel titled with the master's name: kind, full identifier, created, parent "None (root)", children…                                                               |
| 12  | Snapshot Info                   | A snapshot's ⓘ                                                  | Its parent's label and short ID, description, tags                                                                                                                 |
| 13  | All metadata preserved          | Compare 11–12 with the old card                                 | Created, parent, archive size, From, Promoted, description, tags, verification, local copies all present; plus repository, SHA-256 and manifest                    |
| 14  | Historical verification         | Chip "Verified when published"; hover; Info › Verification      | Tooltip "Verified by the agent when published: N files, …"; Info adds that it is not a current verification                                                        |
| 15  | Stale local copy                | A version whose copy reconnected unverified                     | Amber chip "Local · <agent> · not verified"; tooltip "Local copy on <agent> (not verified since it reconnected)"                                                   |
| 16  | Agent-specific tooltip          | Hover the upload icon on that version                           | "Create snapshot from the local copy on <agent>"                                                                                                                   |
| 17  | Restore availability            | Hover the download-drive icon                                   | "Restore version"; disabled only when no agent is online or the repository is disabled, with that reason                                                           |
| 18  | Run volatile                    | ▷ › click                                                       | General opens with Remote Volatile and this version chosen (do not start)                                                                                          |
| 19  | Run and snapshot                | Camera › click                                                  | General opens with Remote Snapshot and this version chosen (do not start)                                                                                          |
| 20  | Create snapshot from local copy | Upload icon › click                                             | "Create a snapshot from <agent>" dialog naming the parent; **Cancel**                                                                                              |
| 21  | Edit details                    | Pencil                                                          | Edit details dialog; **Cancel**                                                                                                                                    |
| 22  | Manage tags                     | Tag icon                                                        | Tag editor for this version; close without changes                                                                                                                 |
| 23  | Clone VM                        | Copy-plus icon                                                  | Clone dialog for this version; **Cancel**                                                                                                                          |
| 24  | View contents                   | Folder icon                                                     | Archive Explorer opens on this version                                                                                                                             |
| 25  | Archive Explorer                | Select files                                                    | Toolbars, File and Archive Info, text/image/PDF previews as in 0058                                                                                                |
| 26  | Nested archives                 | Expand a nested ZIP (0058 fixture)                              | Works as in 0058                                                                                                                                                   |
| 27  | Promote dialog                  | ⤒ on a snapshot                                                 | Hover turns it red; the preview dialog with Kept/Permanently deleted; **Cancel**                                                                                   |
| 28  | Delete dialog                   | Trash on a leaf snapshot                                        | Hover turns it red; "Permanently delete this snapshot" naming the ID; **Cancel**                                                                                   |
| 29  | Disabled explanations           | Hover, then Tab to, Trash on a snapshot with children           | Faded icon; tooltip "Delete snapshot unavailable" and "Other versions were created from this snapshot…"; Enter does nothing; same reason in Info › Unavailable now |
| 30  | Keyboard                        | Tab through a card; Left/Right inside a toolbar; Escape in Info | Visible focus ring; tooltips on focus; arrows move between icons; focus returns to ⓘ                                                                               |
| 31  | Expand and collapse             | Chevron left of a version with children                         | Its branch hides and returns; the others stay                                                                                                                      |
| 32  | Multiple branches               | A VM with branches                                              | Guide lines and elbows show each child under its parent; "N branches" chip                                                                                         |
| 33  | Dark theme                      | Theme: Dark                                                     | Neutral icons, no coloured button borders; chips and tooltips readable                                                                                             |
| 34  | Light theme                     | Theme: Light                                                    | Same, readable                                                                                                                                                     |
| 35  | Narrow window                   | ~400 px wide                                                    | Toolbars wrap, names readable, no sideways scroll; Info opens as a sheet at the bottom                                                                             |
| 36  | Browser zoom                    | 200%                                                            | Usable; nothing overlaps                                                                                                                                           |
| 37  | Console                         | Developer tools › Console                                       | No errors                                                                                                                                                          |
| 38  | No unexpected requests          | Network › `api/v1` while doing 5–17, 29–36                      | Only `GET` of `…/versions`, `…/workspaces`, `…/restore-options`, `…/remasters` (and polling); no POST/PATCH/DELETE                                                 |
| 39  | Progress indicators             | Start a clone in B1 and come back                               | Clone progress shows above the tree as before                                                                                                                      |
| 40  | Other Manage pages              | General, Local copies and restore, Notes, Screenshots           | Unchanged content                                                                                                                                                  |

### B. Operations (disposable VM only)

| #   | Scenario              | How                                           | Expected                                                    |
| --- | --------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| B1  | Clone                 | Clone a small version into `TEST_0059`        | Clone progress, then the new VM in the catalog              |
| B2  | Run and snapshot      | On `TEST_0059`, Run and snapshot, start, stop | A child snapshot appears under that version                 |
| B3  | Edit details and tags | Give the snapshot a title and a tag           | Title shown on the card, tag chip shown; Info shows both    |
| B4  | Promote               | Promote the snapshot, confirm                 | Remaster progress; the snapshot becomes the master          |
| B5  | Delete                | Make another snapshot, delete it, confirm     | "Being deleted" chip and status, then it leaves the history |

Keep or remove `TEST_0059` afterwards as you usually handle test VMs.

## 6. Rollback

There is no migration, so going back never needs a database restore:

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Reload the browser tabs. Forward again with `sudo /opt/emucat/tooling/bin/emucatctl update`. This release stores
nothing on the server or in the browser, so there is nothing to clean up.

## 7. After MARS

You promote `develop` to `main` yourself, then update MOON with `emucatctl update`, after the same section 2 checks
against `refs/remotes/origin/main`. Nothing was deployed to MARS or MOON as part of this change.
