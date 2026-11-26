# Runbook: deploying the Archive Explorer redesign and nested archives (decision 0058) on MARS

The compact Archive Explorer and browser-local nested archives ([decision 0058](decisions/0058-browser-local-nested-archives.md)),
deployed by hand on MARS, the test server: branch `develop`, `https://emucat-test.dfri.info`, web container on
`10.0.0.2:8095`, installation root `/opt/emucat`, Compose project `emucat` (containers `emucat-api-1`, `emucat-web-1`).
Everything below was checked against this release's `deploy/bin/emucatctl`, `deploy/compose.yaml` and
`deploy/docker/*`. Run it in order.

Placeholders: `<commit>` is the full commit ID you deploy (the tip of `develop`); `<previous>` is the one MARS runs now.

## 1. What this release changes on a host

Only the web application changed (`apps/web`). `git diff --stat 7c4542b <commit> -- deploy apps/api apps/deployer agent packages`
is empty.

| Component                                  | Change                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Web image                                  | **Rebuilt** by `update`: new interface, `lucide-react`, `fflate`, the archive worker  |
| API image                                  | Rebuilt by `update` from the same commit; **no code change**                          |
| Deployment tooling (`emucatctl`, deployer) | **None** since `a2e8988` (decision 0055)                                              |
| Docker Compose, volumes, directories       | **None**                                                                              |
| Configuration (`app.env`, `deploy.env`)    | **None**. The browser limits are compiled in (`apps/web/src/archive-local/limits.ts`) |
| Database                                   | **None**. No migration; the newest is still `0021_server_repository_access`           |
| nginx in the web container, reverse proxy  | **None**. The worker is a `.js` asset under `/assets/`, served as JavaScript          |
| SSH keys, repositories                     | **None**                                                                              |
| Windows agent, protocol                    | **None**. No agent update                                                             |
| Server temporary files                     | **None**. Nested archives are read in the browser; the server only streams one file   |

**Is `emucatctl update` alone enough?** Yes, if MARS runs any release from decision 0055 on with that release's
tooling, which the 0055 and 0056 runbooks required. Section 2 checks this with commands.

## 2. Pre-deployment checks

On the workstation, the target:

```bash
git fetch origin
```

```bash
git log -1 --format='%H %s' origin/develop
```

On MARS:

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Note the deployed commit as `<previous>` (for rollback).

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

`Latest:` must be `<commit>`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Every line ok.

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat <previous> refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml deploy/docker apps/deployer apps/api/migrations
```

- `tooling is current` and an empty diff: no tooling refresh. Go on with section 3.
- Otherwise MARS runs a release older than 0055: deploy 0055 first with [its runbook](runbook-0055-mars.md), which
  includes `emucatctl install`, then come back.

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
df -h /opt/emucat /var/lib/docker
```

The build needs room for two new images. Then take your own restore point (an `update` takes one too):

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

```bash
sudo ls -lt /opt/emucat/backups | head -3
```

## 3. Deployment

1. Repository checkout: **not needed**. `update` fetches `develop` into `/opt/emucat/repo.git` and builds from a
   `git archive` of the commit.
2. Tooling refresh, `emucatctl install`: **not needed** (section 2).
3. Configuration: **none**.
4. Update:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. With `EMUCAT_VERIFY=true` the web image's `verify` stage runs the web unit tests, including the new
   archive engine and interface tests (no browser is needed for them). It prints that no migration was applied. The
   same can be started from Admin › Application Updates.

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

The worker and PDF.js assets, and their types:

```bash
sudo docker exec emucat-web-1 sh -c 'ls /usr/share/nginx/html/assets | grep -E "worker"'
```

Two files, both `.js`: `archive.worker-….js` and `pdf.worker.min-….js`. No `.mjs`, no `.wasm` under `assets/`.

```bash
W=$(sudo docker exec emucat-web-1 sh -c 'ls /usr/share/nginx/html/assets | grep archive.worker'); curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' "https://emucat-test.dfri.info/assets/$W"
```

`200 application/javascript`.

```bash
curl -sI https://emucat-test.dfri.info/ | grep -iE 'x-frame-options|cache-control'
```

`X-Frame-Options: DENY` and `Cache-Control: no-cache`, unchanged.

Logs:

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl logs web --tail 100
```

No errors. The only archive requests while browsing nested archives are `GET …/archive/entry` and
`…/archive/entry/download` for the outermost nested archive.

**Browser cache.** `index.html` is served `no-cache` and assets are content-hashed, so a reload picks up the new
release. A tab left open from before the update keeps the old interface until it is reloaded: reload it
(Ctrl+Shift+R is not needed, a normal reload is enough).

## 5. Functional acceptance checklist (MARS)

"Archive Explorer" is Version History › a version › **View contents…**. Use the browser's developer tools (Network
and Console) for items 40–41.

**A test fixture, if no VM holds a nested archive.** Do not modify or re-import a production VM. Instead copy, on
the agent PC, a small throwaway VM directory (or make a new 86Box VM), and put in it a `utilities.zip` built like
this (PowerShell, in an empty folder; any small PDF and PNG of your own):

```powershell
New-Item -ItemType Directory docs, drivers | Out-Null
Set-Content README.TXT "Utilities test fixture"
Set-Content drivers\INSTALL.TXT "Run SETUP.EXE from drive A:"
Copy-Item <a small PDF> docs\manual.pdf; Copy-Item <a small PNG> docs\setup.png
Compress-Archive drivers\* drivers.zip
Compress-Archive README.TXT, docs, drivers.zip utilities.zip
Set-Content broken.zip "PK this is not an archive"
```

Put `utilities.zip` and `broken.zip` into the VM's directory and register it (or a snapshot) as usual. Record the
SHA-256 of `drivers\INSTALL.TXT` (`Get-FileHash`). For the size limit, also add any ZIP larger than 64 MiB.

| #   | Scenario                     | How                                                               | Expected                                                                                                              |
| --- | ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Deployed commit              | Section 4                                                         | `<commit>` in both images                                                                                             |
| 2   | Open on an 86Box master      | View contents…                                                    | Tree on the left, "Select a file to see its preview." on the right                                                    |
| 3   | Lucide icons                 | Look at the tree and toolbars                                     | Line icons (folders, file types, chevrons); no emoji or ▸ triangles                                                   |
| 4   | Compact header               | Top of the dialog                                                 | "Archive Explorer", one line "Master · ZIP · size · repository", an ⓘ and an ✕                                        |
| 5   | Contextual toolbar           | Select the `.cfg`                                                 | One toolbar: Text/Hex, Wrap, Highlight, Copy, encoding, Download, ⓘ; tooltips on hover and on keyboard focus          |
| 6   | Archive Info                 | Header ⓘ                                                          | Panel "This archive": file name, SHA-256, manifest, entries, views; Escape closes it, focus returns to ⓘ              |
| 7   | File Info                    | Toolbar ⓘ                                                         | Panel with path, size, stored as, type, CRC-32 (declared by the archive), SHA-256 (from the manifest), download limit |
| 8   | Metadata preserved           | Compare 7 with the previous release's panel                       | Every value is there                                                                                                  |
| 9   | Preview space                | Look at the file panel                                            | Text starts right below the toolbar; the preview fills down to the status bar                                         |
| 10  | Configuration file           | Select the `.cfg`                                                 | Highlighted; status bar "UTF-8, valid throughout" and "Verified: …matched its recorded checksum"                      |
| 11  | Word wrap                    | Wrap button                                                       | Toggles; pressed state visible                                                                                        |
| 12  | Highlighting                 | Highlight button                                                  | Colours off and on                                                                                                    |
| 13  | Encoding                     | Choose CP437, then UTF-8                                          | Text changes at once; no new network request                                                                          |
| 14  | Copy                         | Copy button                                                       | Icon becomes a check; pasted text matches                                                                             |
| 15  | Image                        | Select a PNG/BMP                                                  | Fitted; status "PNG, W × H pixels"                                                                                    |
| 16  | Image zoom                   | Fit, Actual size, −, +                                            | Zoom changes; percentage shown                                                                                        |
| 17  | PDF                          | Select a PDF                                                      | Page drawn; status "Page 1 of N"                                                                                      |
| 18  | PDF navigation               | ‹ › and the page box; Fit to width, −, +                          | Pages change; zoom changes                                                                                            |
| 19  | Hex                          | Hex mode on any file                                              | Rows; ⟪ ‹ › move; offset box and → go; ASCII/CP437                                                                    |
| 20  | Top-level download           | Download on a small file                                          | Saved; status "Downloaded and verified."                                                                              |
| 21  | Expand a nested ZIP          | Chevron (or Right arrow) on `utilities.zip`                       | "Downloading…" then its contents; Network shows one `entry/download?…path=utilities.zip`                              |
| 22  | Inner directories            | Expand `docs`                                                     | Its files appear, indented                                                                                            |
| 23  | Nested text                  | `README.TXT`                                                      | Text; status "matched the CRC-32 its archive records (this detects damage, not tampering)"; no new request            |
| 24  | Nested image                 | `docs/setup.png`                                                  | Shown; no new request                                                                                                 |
| 25  | Nested PDF                   | `docs/manual.pdf`                                                 | Page drawn; no new request                                                                                            |
| 26  | Second level                 | Expand `drivers.zip`                                              | Its contents; still no new request                                                                                    |
| 27  | Inner download               | `INSTALL.TXT` › Download                                          | Saved; `Get-FileHash`/`sha256sum` equals the fixture's; "Saved from the nested archive, after matching its CRC-32"    |
| 28  | Nested archive itself        | Select `utilities.zip` (click its name) › Download                | Saved through the server: "Downloaded and verified."                                                                  |
| 29  | Breadcrumb                   | With `INSTALL.TXT` shown, click `utilities.zip` in the breadcrumb | The tree focuses `utilities.zip`                                                                                      |
| 30  | Search scope                 | **Search in** › Opened archives, search `install`                 | One result "… › drivers.zip › INSTALL.TXT", "Archives not opened were not searched"; no network request               |
| 31  | Size limit                   | Expand the ZIP over 64 MiB                                        | Alert "…up to 64.0 MiB"; no download request                                                                          |
| 32  | Depth limit                  | Only with an archive nested more than five deep (optional)        | "…at most 5 levels deep"                                                                                              |
| 33  | Corrupted archive            | Expand `broken.zip`                                               | Alert "damaged or is not the format it appears to be"; everything else still works                                    |
| 34  | Close during loading         | Expand the large ZIP (under 64 MiB) and close at once             | Dialog closes; Network shows the download cancelled; no console error                                                 |
| 35  | Reopen                       | View contents… again                                              | Works; nested archives start collapsed                                                                                |
| 36  | VirtualBox OVA               | Open an OVA version                                               | Stored entries only; `.ovf` previews as XML; works as before                                                          |
| 37  | Master and snapshot          | Open a snapshot                                                   | "Snapshot · <name> · …"; nested archives work the same                                                                |
| 38  | Themes                       | Switch light/dark with a nested file shown                        | Both readable; icons, pressed buttons and status colours visible                                                      |
| 39  | Narrow window                | Make the window about 400 px wide                                 | One panel at a time; ← Back to files; toolbar wraps; no horizontal page scroll                                        |
| 40  | Console and network          | Developer tools during 21–30                                      | No console errors; every request to `emucat-test.dfri.info`; `archive.worker-….js` loaded once                        |
| 41  | No new backend endpoints     | Network filter `api/v1`                                           | Only `…/archive`, `…/archive/entries`, `…/archive/entry`, `…/entry/preview`, `…/entry/download`                       |
| 42  | No server temporary files    | Command below, before and after 21–27                             | Same output                                                                                                           |
| 43  | Clone and transfer unchanged | Clone a small version; run one small transfer or restore          | Succeed as before                                                                                                     |

For 42:

```bash
sudo find /opt/emucat/data/transfers -type f | wc -l; sudo docker exec emucat-api-1 sh -c 'find /tmp -type f 2>/dev/null | wc -l'
```

## 6. Rollback

There is no migration, so going back is safe and never needs a database restore.

```bash
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
```

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Then reload the browser tabs. To go forward again: `sudo /opt/emucat/tooling/bin/emucatctl update`. Nothing is stored
on the server or in the browser by this release, so there is nothing to clean up.

## 7. After MARS

As always, you promote `develop` to `main` yourself, then update MOON with `emucatctl update`. MOON needs the same
section 2 checks with `refs/remotes/origin/main`. Nothing was deployed to MARS or MOON as part of this change.
