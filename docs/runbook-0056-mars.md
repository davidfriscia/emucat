# Runbook: deploying Archive Explorer (decision 0056) on MARS

Archive Explorer and the archive inspection hardening ([decision 0056](decisions/0056-archive-explorer.md)), deployed
by hand on MARS, the test server: branch `develop`, `https://emucat-test.dfri.info`, web container on `10.0.0.2:8095`,
application account `david:david` (1000:1000), deployment account `emucat-deploy`, Compose project `emucat`
(containers `emucat-api-1` and `emucat-web-1`). Everything below was written from the scripts of this release
(`deploy/bin/emucatctl`, `deploy/compose.yaml`, `deploy/docker/*`); run it in order.

Placeholders: `<commit>` is the full commit ID you deploy (the tip of `develop`), `<previous>` the one MARS runs now.

## What this release changes on a host, and what it does not

| Component                  | Change                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deployment tooling         | **None.** `deploy/bin/emucatctl`, `apps/deployer` and `deploy/systemd` are unchanged since `a2e8988` |
| Docker Compose             | **None.** `deploy/compose.yaml` is unchanged                                                         |
| Persistent directories     | **None.** No new directory; Archive Explorer writes nothing to disk                                  |
| Docker volumes and mounts  | **None**                                                                                             |
| API container memory limit | **None required.** Defaults fit `EMUCAT_API_MEMORY_LIMIT=1g`; see 19.3                               |
| nginx in the web container | **None.** `deploy/docker/web/emucat.conf` is unchanged; `X-Frame-Options: DENY` stays everywhere     |
| VPS reverse proxy          | **None**                                                                                             |
| Cloudflare                 | **None**                                                                                             |
| MariaDB schema             | **None.** No migration: the newest is still `0021_server_repository_access`                          |
| SSH keys, `known_hosts`    | **None.** The server's repository key of decision 0055 is used as it is                              |
| Repository configuration   | **None**                                                                                             |
| Windows agent              | **None.** Neither the agent nor the protocol changed; Archive Explorer needs no agent                |
| `app.env`                  | **Optional** new `ARCHIVE_*` variables, all with defaults (19.2)                                     |
| `deploy.env`               | **None**                                                                                             |

**Is `emucatctl update` alone enough?** Yes, **if MARS already runs the release of decision 0055 with its tooling**
(installed by `emucatctl install` from that release, as its runbook required). Then the installed tooling is
identical to this release's, and `update` builds and starts the new images. If MARS is still on a release before
0055, deploy 0055 first with [its runbook](runbook-0055-mars.md) (its `install` is required there). 19.1 and 19.4 check
which case applies, with commands, rather than assuming it.

## 19.1 Repository and tooling preparation

No checkout is needed on MARS: `update` fetches `develop` into its own mirror (`/opt/emucat/repo.git`) and builds from a
`git archive` of the exact commit. A checkout is only needed if the tooling must be reinstalled (see the check below).

On the workstation, after this milestone is pushed:

```bash
git fetch origin
git log -1 --format='%H %s' origin/develop
```

That commit ID is `<commit>`.

On MARS, fetch `develop` into the deployment mirror and see the target:

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

It must print `Latest:    <commit> …`. Then check that the installed tooling is this release's:

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git diff --stat "$(sudo sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' /opt/emucat/state/current-release.json | head -1)" refs/remotes/origin/develop -- deploy/bin deploy/systemd deploy/compose.yaml apps/deployer apps/api/migrations
```

- `tooling is current`, and the second command prints **nothing** (or nothing but whitespace): no tooling refresh is
  needed. Go on with 19.4.
- Otherwise (MARS runs a release older than 0055, or its tooling was never reinstalled): refresh the tooling from a
  checkout of `<commit>` first. On the workstation:

  ```bash
  git archive --format=tar --prefix=emucat-src/ origin/develop | ssh mars 'rm -rf ~/emucat-src && tar -x -C ~'
  ```

  On MARS:

  ```bash
  cd ~/emucat-src && sudo deploy/bin/emucatctl install && sudo /opt/emucat/tooling/bin/emucatctl check
  ```

  When upgrading from a release before 0055, follow [the 0055 runbook](runbook-0055-mars.md) from its 16.1 instead:
  it also provisions the server's SSH key, without which Archive Explorer reports that the server has no repository
  connection.

The `$(…)` reads the deployed commit as `emucatctl` itself does; `sudo /opt/emucat/tooling/bin/emucatctl status`
shows the same commit.

## 19.2 Configuration changes

All new variables are **optional**, go in `/opt/emucat/config/app.env`, have defaults applied by the API itself, and
need **no manual change** on an existing deployment. `emucatctl` does not add them; `deploy.env` gets nothing new.
They are read when the API container is created: set them **before** `update`. A change after deployment takes effect
when the API container is recreated (see 19.6 step 7).

| Variable                                 | Purpose                                                | Default     | Required | File      | Example    | Manual change on existing deployments | Restart                 |
| ---------------------------------------- | ------------------------------------------------------ | ----------- | -------- | --------- | ---------- | ------------------------------------- | ----------------------- |
| `ARCHIVE_INSPECTION_MAX_ENTRIES`         | Entries of an archive the server indexes (1000–500000) | `200000`    | Optional | `app.env` | `300000`   | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_DIRECTORY_BYTES` | ZIP central directory read into memory (1–128 MiB)     | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_MANIFEST_BYTES`  | Manifest inflated and parsed (1–128 MiB)               | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_MAX_CONCURRENT`      | Archives indexed at once (1–16)                        | `2`         | Optional | `app.env` | `1`        | No                                    | API container recreated |
| `ARCHIVE_INSPECTION_TIMEOUT_SECONDS`     | Deadline for indexing one archive (5–3600)             | `120`       | Optional | `app.env` | `300`      | No                                    | API container recreated |
| `ARCHIVE_CACHE_MAX_INDEXES`              | Archive indexes kept in memory (0–256)                 | `8`         | Optional | `app.env` | `4`        | No                                    | API container recreated |
| `ARCHIVE_CACHE_TTL_SECONDS`              | How long an index is kept (0–86400)                    | `600`       | Optional | `app.env` | `1800`     | No                                    | API container recreated |
| `ARCHIVE_CACHE_MAX_BYTES`                | Estimated memory of the kept indexes (0–4 GiB)         | `67108864`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_TEXT_BYTES`             | Text shown per file (4 KiB–16 MiB)                     | `262144`    | Optional | `app.env` | `524288`   | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_HEX_BYTES`              | One hex window (1 KiB–4 MiB)                           | `65536`     | Optional | `app.env` | `131072`   | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_IMAGE_BYTES`            | Largest image previewed (64 KiB–256 MiB)               | `20971520`  | Optional | `app.env` | `10485760` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_IMAGE_PIXELS`           | Most pixels of an image previewed                      | `16777216`  | Optional | `app.env` | `8388608`  | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_PDF_BYTES`              | Largest PDF previewed (64 KiB–512 MiB)                 | `26214400`  | Optional | `app.env` | `52428800` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_SEEK_BYTES`             | How far into a deflated entry hex may start (0–1 GiB)  | `16777216`  | Optional | `app.env` | `33554432` | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_MAX_CONCURRENT`         | Details and previews at once (1–16)                    | `2`         | Optional | `app.env` | `3`        | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_MAX_QUEUED`             | Previews that may wait up to 10 s for a slot (0–64)    | `8`         | Optional | `app.env` | `4`        | No                                    | API container recreated |
| `ARCHIVE_PREVIEW_TIMEOUT_SECONDS`        | Deadline of one preview (5–600)                        | `60`        | Optional | `app.env` | `120`      | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_BYTES`             | Largest single-file download; `0` turns them off       | `104857600` | Optional | `app.env` | `52428800` | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_CONCURRENT`        | Single-file downloads at once (1–16)                   | `2`         | Optional | `app.env` | `1`        | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_MAX_QUEUED`            | Downloads that may wait up to 10 s for a slot (0–64)   | `2`         | Optional | `app.env` | `0`        | No                                    | API container recreated |
| `ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS`       | Deadline of one download (10–86400)                    | `1800`      | Optional | `app.env` | `3600`     | No                                    | API container recreated |

PDF previews need no setting: PDF.js and its data files are part of the web image. There is no configuration
introduced by the deployment tooling in this release.

To see what is set now, without printing a secret:

```bash
sudo grep -E '^(ARCHIVE_|REPOSITORY_SSH_(CONNECT|REQUEST)_TIMEOUT|TRANSFER_)' /opt/emucat/config/app.env || echo "no ARCHIVE_ or TRANSFER_ settings: defaults apply"
```

```bash
sudo grep -vE '^(#|$)' /opt/emucat/config/deploy.env | grep -vE 'TOKEN|KEY|PASSWORD'
```

To change one (MARS needs none), before `update`:

```bash
sudoedit /opt/emucat/config/app.env
```

## 19.3 Infrastructure impact

- **Docker Compose, volumes, mounts, directories:** no change; nothing to do.
- **API container memory:** no change required. The worst case of the defaults is about 200 MiB for two concurrent
  image conversions, plus up to 64 MiB (estimated) of cached indexes and the listing transient of one large archive.
  If you raise `ARCHIVE_PREVIEW_IMAGE_*`, `ARCHIVE_PREVIEW_PDF_BYTES` or the concurrency, keep
  `EMUCAT_API_MEMORY_LIMIT` (in `deploy.env`, default `1g`) above roughly four times the largest preview limit times
  its concurrency, and apply it with `update`.
- **nginx (web container), VPS reverse proxy, Cloudflare:** no change. Previews and downloads are ordinary
  `GET /api/v1/...` responses; downloads are at most `ARCHIVE_DOWNLOAD_MAX_BYTES` (100 MiB) and stream with
  `proxy_buffering off`, already configured. Cloudflare's response size limits do not apply to responses this size.
- **MariaDB schema:** no migration. `update` still takes its backup.
- **SSH keys, repository configuration:** no change. Archive Explorer uses the server's existing repository
  connection (decision 0055). Without it, it says so (`server_repository_unavailable`), as View Archive Contents did.
- **Windows agent:** no update. No agent is involved in Archive Explorer.
- **Temporary storage:** none. Archive Explorer must not create files in `data/transfers` or `/tmp`; 20.1 checks it.

## 19.4 Pre-deployment checks

```bash
sudo /opt/emucat/tooling/bin/emucatctl status
```

Note the deployed commit: that is `<previous>`, for rollback.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update
```

`Latest:` must be `<commit>`.

```bash
sudo /opt/emucat/tooling/bin/emucatctl check
```

Every line must be ok (including the transfer staging directory and the repository SSH directory of 0055).

```bash
sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/develop:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
```

Must print `tooling is current` (see 19.1 otherwise).

```bash
free -h
```

```bash
df -h /opt/emucat /var/lib/docker
```

```bash
sudo docker inspect -f '{{.Name}} memory limit {{.HostConfig.Memory}} bytes' emucat-api-1 emucat-web-1
```

The API's limit is `1073741824` by default.

```bash
sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' emucat-api-1 emucat-web-1
```

```bash
curl -fsS https://emucat-test.dfri.info/api/v1/ready
```

```bash
curl -fsS http://10.0.0.2:8095/healthz
```

Backup (an `update` takes one too; this is your own restore point):

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup
```

```bash
sudo ls -lt /opt/emucat/backups | head -3
```

## 19.5 Deployment

1. Repository checkout: **not needed** when 19.1 said the tooling is current.
2. Tooling bootstrap: **not needed** in that case (otherwise 19.1).
3. Configuration changes: **none required** (19.2). If you want to change a limit, `sudoedit /opt/emucat/config/app.env`
   now.
4. Installer: **not needed** (`emucatctl install` only when 19.1 said so).
5. Application update:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Answer `y`. Stages: checking repository, fetching source, building (API and web images), testing
   (`EMUCAT_VERIFY=true`: type checks, contracts tests, database-free API tests, the web tests), backing up the
   database, applying migrations (prints that none were applied), starting services, health checking, completed. The
   same can be started from Admin › Application Updates.

6. Container recreation and service restart: done by `update` (`compose up` recreates both containers with the new
   images). Nothing else to restart; `emucat-deployer` is not touched.

## 19.6 Post-deployment verification

1. Running release:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl status
   ```

   ```bash
   sudo docker inspect -f '{{.Name}} {{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1 emucat-web-1
   ```

   Both must show `<commit>`.

2. Container health:

   ```bash
   sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}} {{.Image}}'
   ```

   Both `(healthy)`.

3. API health:

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/health
   ```

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/ready
   ```

4. Frontend and its new assets:

   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' https://emucat-test.dfri.info/
   ```

   ```bash
   curl -fsS -o /dev/null -w '%{http_code} %{content_type}\n' https://emucat-test.dfri.info/vendor/pdfjs/6.5.438/wasm/openjpeg.wasm
   ```

   `200 application/wasm`.

   ```bash
   sudo docker exec emucat-web-1 sh -c 'ls /usr/share/nginx/html/assets | grep pdf.worker'
   ```

   One `pdf.worker.min-….js` (a `.js`, not `.mjs`).

   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' https://emucat-test.dfri.info/vendor/pdfjs/6.5.438/wasm/quickjs-eval.wasm
   ```

   `404`: PDF scripting is not shipped.

   ```bash
   curl -sI https://emucat-test.dfri.info/ | grep -i x-frame-options
   ```

   `X-Frame-Options: DENY`, unchanged.

5. Configuration values in effect (only those set in `app.env` appear; the rest are defaults):

   ```bash
   sudo docker exec emucat-api-1 printenv | grep -E '^ARCHIVE_' || echo "defaults"
   ```

6. Logs:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
   ```

   No `Invalid configuration`. After opening an archive: `Archive indexed` with `entries` and `estimatedBytes`.

   ```bash
   sudo ls -t /opt/emucat/state/operations | head -2
   ```

   ```bash
   journalctl -u emucat-deployer -n 50
   ```

7. Repository connectivity: Admin › Repositories › **Test Server Connection**: every step green. A configuration
   change after deployment: `sudo docker stop emucat-api-1`, then `sudo /opt/emucat/tooling/bin/emucatctl update`
   (with the API stopped, `update` redeploys the same commit in full and the new container reads `app.env`).

8. Staging cleanup diagnostics:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 2000 | grep -E 'Staging cleanup|staging area|not UUID-named' || echo "no staging warnings"
   ```

   Normally `no staging warnings`. A warning names the files that EmuCat did not create in `data/transfers`; they are
   left alone (20, item 35).

## 20. Mars functional acceptance checklist

Prepare: one 86Box VM with a master and a snapshot, one QEMU VM with a snapshot, one VirtualBox OVA version, and in
at least one ZIP version the files listed below. If a VM lacks such files, register a snapshot after copying them
into its directory (for example a `docs/` folder): an extensionless `README`, a UTF-8 `notes.txt` with accents, a
Windows-1252 `win.txt` (curly quotes, `é`), a DOS `MENU.TXT` with box characters (CP437), `notes.md` containing a
table, a `<script>`, an image link to `https://example.com/x.png` and a web link, `page.html`, `logo.svg`, a PNG or
JPEG, a BMP, a PPM (QEMU screendumps are PPM), a PCX or TGA, a multi-page PDF, a ROM or `.nvr` file, and a file larger
than 100 MiB (a disk image is). "Archive Explorer" is Version History › a version › **View contents…**.

| #   | Scenario                      | How                                                                                                         | Expected outcome                                                                                                                                                                                      |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 86Box master                  | Open Archive Explorer on the 86Box master                                                                   | Title "Archive Explorer"; master, date, ZIP, size, repository; tree with folders first; placeholder on the right; **Archive details** show the SHA-256 and "the one verified when … registered"       |
| 2   | QEMU snapshot                 | Open it on a QEMU snapshot                                                                                  | "Snapshot: …"; same features as a master; its own files                                                                                                                                               |
| 3   | VirtualBox OVA                | Open it on an OVA version                                                                                   | Only **Stored entries**; `.ovf`, `.vmdk`, `.mf`; `.ovf` previews as XML; the `.vmdk` shows hex at any offset                                                                                          |
| 4   | Nested directories            | Expand several levels; collapse; expand again                                                               | Children appear under their parent, indented; collapsing and re-expanding does not reload; a folder of more than 200 entries shows **Show more**                                                      |
| 5   | Logical / physical            | Switch **VM files** ↔ **Stored entries**                                                                    | Physical shows `.emucat-manifest.json`; each view keeps its expanded folders                                                                                                                          |
| 6   | Search                        | Search a file name part                                                                                     | Flat list of matching paths; selecting one previews it; a folder result opens it in the tree                                                                                                          |
| 7   | Configuration file            | Select the `.cfg` (86Box) or a `.ini`                                                                       | Text mode, highlighted (sections, keys, values in colour); "UTF-8, valid throughout"; "matched its recorded checksum"                                                                                 |
| 8   | Extensionless README          | Select `README`                                                                                             | Detected as text from its contents; plain text, wrapped                                                                                                                                               |
| 9   | UTF-8 text                    | Select `notes.txt`                                                                                          | Accents correct; UTF-8 (detected)                                                                                                                                                                     |
| 10  | Windows-1252                  | Select `win.txt`                                                                                            | Windows-1252 (detected), "a guess from the bytes"; curly quotes and `é` correct                                                                                                                       |
| 11  | CP437 DOS text                | Select `MENU.TXT`                                                                                           | CP437 (detected); box lines drawn as `╔═╗ ║`                                                                                                                                                          |
| 12  | Manual encoding               | On `MENU.TXT` choose Windows-1252, then CP850, then CP437                                                   | Characters change at once; no new request in the browser's network panel                                                                                                                              |
| 13  | Syntax highlighting           | `AUTOEXEC.BAT`, a `.ps1`, `.xml`/`.ovf`, `.json`; toggle **Highlight**                                      | Colours per language; off shows plain text; nothing else changes                                                                                                                                      |
| 14  | PNG or JPEG                   | Select it                                                                                                   | Image fitted; "PNG, W × H pixels"; **100%**, **+**, **−** zoom; pixelated when enlarged                                                                                                               |
| 15  | BMP                           | Select it                                                                                                   | Shown by the browser; "BMP, W × H"                                                                                                                                                                    |
| 16  | PPM                           | Select a `.ppm`                                                                                             | Shown; "PPM, …, converted to PNG by the server for display"                                                                                                                                           |
| 17  | Legacy format                 | Select a `.pcx`, `.tga` or `.tif`                                                                           | Shown, converted to PNG; an unsupported variant says "not supported" without breaking the explorer                                                                                                    |
| 18  | PDF                           | Select the PDF; **Next page**, **Previous page**, type a page, **Fit width**, **+**/**−**                   | Page drawn; "Page n of N"; links in the PDF are not clickable; "Drawn as an image: links, forms, attachments and scripts in the PDF are not active"                                                   |
| 19  | Markdown                      | Select `notes.md`; **Rendered**, then **Text**                                                              | Rendered: headings, table; no script runs; the image shows "[image: …, not loaded]"; the link shows its target on hover but does not navigate. Text: the source                                       |
| 20  | HTML as inert source          | Select `page.html`                                                                                          | Source code with highlighting; nothing rendered or executed                                                                                                                                           |
| 21  | SVG as inert source           | Select `logo.svg`                                                                                           | XML source; never drawn as an image                                                                                                                                                                   |
| 22  | ROM / NVR in hex              | Select `*.bin` or `*.nvr`                                                                                   | "No preview is available"; hex rows `offset  hex  chars`; **CP437** toggle; **Next**, **Go** to `0x100`                                                                                               |
| 23  | Download                      | On a small file, **Download file**                                                                          | Browser saves it with its own name; "Downloaded and verified."                                                                                                                                        |
| 24  | Verify the download           | `sha256sum` the downloaded file                                                                             | Equals the SHA-256 shown in the details (from the manifest), or, for an OVA file, the source file's                                                                                                   |
| 25  | Oversized preview             | Select a large image or PDF over its limit (or lower `ARCHIVE_PREVIEW_PDF_BYTES` to test)                   | Only Hex offered, with "PDF files are previewed up to …"                                                                                                                                              |
| 26  | Oversized download            | Select the disk image (> 100 MiB)                                                                           | No **Download file** button; "Files larger than 100.0 MiB cannot be downloaded one at a time … Restore the version"                                                                                   |
| 27  | Rapid switching               | Click quickly through ten files                                                                             | The last clicked file is shown; never an earlier one; at most a short wait                                                                                                                            |
| 28  | Close during a preview        | Open the PDF or a large hex window and press **Escape** at once                                             | Dialog closes; no error                                                                                                                                                                               |
| 29  | Repository resources released | After 28: the command below                                                                                 | No SSH connection from the API remains after a few seconds                                                                                                                                            |
| 30  | Repository unreachable        | Block the NAS from the API (or stop its SSH) and open a version not opened in the last 10 minutes           | A clear message ("cannot be reached…"); the explorer stays usable; after unblocking, it works again                                                                                                   |
| 31  | Unauthorized access           | The `curl` commands below; and signed in as a non-administrator, if one exists                              | `401` without a session; `403` for a non-administrator; never file bytes                                                                                                                              |
| 32  | Light and dark                | Switch the theme in the header while a highlighted file is shown                                            | Both readable; highlight colours adapt                                                                                                                                                                |
| 33  | Clone still works             | Version History › **Clone…** a small version                                                                | Succeeds as before (decision 0055)                                                                                                                                                                    |
| 34  | HTTP relay still works        | An agent with `transport = "relay"`: run its repository check, or a small registration                      | Succeeds as before                                                                                                                                                                                    |
| 35  | Staging diagnostics           | `sudo touch /opt/emucat/data/transfers/transfers/stray.txt`; wait two minutes; read the log; then remove it | Log: "The staging area holds files EmuCat did not create … left in place" naming `stray.txt`, once; the file is **not** deleted by EmuCat; after `sudo rm` it logs that the area no longer holds them |

For 29 (repository connections; the NAS's SSH port, usually 22):

```bash
sudo nsenter -t "$(sudo docker inspect -f '{{.State.Pid}}' emucat-api-1)" -n ss -tn state established '( dport = :22 )'
```

Only the header line remains a few seconds after the last preview.

For 31, from any computer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://emucat-test.dfri.info/api/v1/admin/vms/86box/<vm>/versions/<version-id>/archive/entry/download?view=logical&path=README"
```

`401`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'sec-fetch-site: cross-site' "https://emucat-test.dfri.info/api/v1/admin/vms/86box/<vm>/versions/<version-id>/archive/entry?path=README"
```

`401` (no session; with an administrator's session cookie it would be `403`).

### 20.1 Diskless architecture validation

These commands only read. Container names are those of the Compose project `emucat`; to discover them:

```bash
sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}}'
```

Pick a version whose archive is several GiB and holds a small file (an 86Box or QEMU VM with a large disk image and
its `.cfg`). Note its size on the Version History card. Unrelated activity (agents, transfers, clones, screenshot
processing, other administrators) changes network and memory counters: measure when the server is otherwise quiet,
and repeat a measurement if a number looks wrong.

1. Baseline, before opening the explorer:

   ```bash
   START=$(date '+%Y-%m-%d %H:%M:%S')
   ```

   ```bash
   api_rx() { sudo docker exec emucat-api-1 node -e 'const t=require("fs").readFileSync("/proc/net/dev","utf8").split("\n").slice(2).map(l=>l.trim().split(/[:\s]+/)).filter(p=>p[0]&&p[0]!=="lo").reduce((s,p)=>s+Number(p[1]),0);console.log(t)'; }
   ```

   ```bash
   api_rx
   ```

   ```bash
   sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.NetIO}}' emucat-api-1
   ```

   ```bash
   sudo ls -la /opt/emucat/data/transfers/transfers /opt/emucat/data/transfers/clones
   ```

   ```bash
   sudo docker exec emucat-api-1 sh -c 'find /tmp -mindepth 1 | head; df -k /tmp | tail -1'
   ```

   ```bash
   sudo docker ps --size --filter name=emucat-api-1 --format '{{.Names}} writable layer: {{.Size}}'
   ```

   ```bash
   sudo docker diff emucat-api-1
   ```

   The API's root filesystem is read-only (`read_only: true`), so `docker diff` prints nothing and the writable layer
   is `0B`; `/tmp` is a 64 MiB tmpfs.

2. **Listing.** Open Archive Explorer on that version (first time in 10 minutes, so it is not cached). Run `api_rx`
   again. The difference is what the listing read: expected tens of KiB to a few MiB (the end of the archive, the
   central directory, the manifest), whatever the archive's size.

3. **Preview.** Select the small `.cfg`. Run `api_rx`. Expected difference: a few KiB to tens of KiB (4 KiB to detect
   its type, then the file, plus SSH and database overhead).

4. **Individual download.** **Download file** on the same `.cfg`. Run `api_rx`. Expected: about the file's size plus
   overhead, never the archive's.

5. **Large file bounds.** Select the disk image: Hex at offset 0 and **Next**. Expected per window: about 64 KiB plus
   overhead.

6. Afterwards, the same commands as in step 1: `data/transfers` unchanged (nothing new since `$START`), `/tmp` still
   empty, `docker diff` empty, writable layer `0B`, memory back near its baseline within a minute (an index stays
   cached, at most `ARCHIVE_CACHE_MAX_BYTES`, estimated):

   ```bash
   sudo find /opt/emucat/data/transfers -newermt "$START" -mindepth 1 | head
   ```

   Prints nothing.

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 300 | grep -E 'Archive indexed|Archive file downloaded'
   ```

   `Archive indexed` with `entries` and `estimatedBytes`; `Archive file downloaded` with `bytes` and
   `integrity: verified`.

Expected relation: archive size (GiB) ≫ listing traffic (KiB–MiB) ≫ preview traffic (KiB) ≈ download traffic (the
file's size). For reference, the automated test measured, on a 25,166,537-byte archive: listing 66,127 bytes read from
the repository, text preview 61 bytes, single-file download 61 bytes, a 64 KiB hex window of the 24 MiB disk 65,580
bytes (SFTP payload only, without SSH and database overhead).

## 21. Rollback and recovery

No database migration is part of this release, so `rollback-app` to the previous release is safe, and no database
restore is ever needed for it. Do not restore a backup to undo this release. VM data, repository archives, notes,
screenshots and settings are untouched by it.

- **Restore the previous working release** (both containers, from images still present):

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <previous>
  ```

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl status
  ```

  To go forward again later: `sudo /opt/emucat/tooling/bin/emucatctl update`.

- **Failed deployment tooling update** (only if 19.1 made you run `install`): the application keeps running.
  `journalctl -u emucat-deployer -n 50`, fix what `install` printed, run it again from the same checkout. To return
  to the earlier tooling, `git archive <previous>` to MARS and run that checkout's `install`.

- **Failed application update:** before the containers were replaced, nothing changed (`status` shows `<previous>`).
  After a failed start without a migration, `update` restores the previous release by itself (`restored_previous`).
  Read `/opt/emucat/state/operations/<id>.log`, fix, run `update` again.

- **Incorrect configuration** (the API does not start; its log says `Invalid configuration` and names the variable):

  ```bash
  sudoedit /opt/emucat/config/app.env
  ```

  Fix or remove the named `ARCHIVE_*` line (an empty value means the default), then:

  ```bash
  sudo docker stop emucat-api-1
  ```

  ```bash
  sudo /opt/emucat/tooling/bin/emucatctl update
  ```

- **Preview limits too restrictive** (`preview_too_large`, `image_too_large`, "only the hexadecimal view" for files you
  expect to see, or `preview_busy` under normal use): raise `ARCHIVE_PREVIEW_PDF_BYTES`, `ARCHIVE_PREVIEW_IMAGE_BYTES`,
  `ARCHIVE_PREVIEW_IMAGE_PIXELS`, `ARCHIVE_PREVIEW_TEXT_BYTES` or `ARCHIVE_PREVIEW_MAX_QUEUED` in `app.env`, then stop
  the API and `update` as above. Mind 19.3.

- **API memory pressure** (`docker stats` near the limit, the container restarted with `OOMKilled`):

  ```bash
  sudo docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' emucat-api-1
  ```

  Lower `ARCHIVE_PREVIEW_MAX_CONCURRENT` to `1`, `ARCHIVE_PREVIEW_IMAGE_PIXELS` to `8388608`, `ARCHIVE_CACHE_MAX_BYTES`
  to `33554432` and `ARCHIVE_INSPECTION_MAX_CONCURRENT` to `1`; or raise `EMUCAT_API_MEMORY_LIMIT` in
  `/opt/emucat/config/deploy.env` (for example `1536m`). Then stop the API and `update`.

- **PDF rendering failures** ("This PDF could not be read" for every PDF, or nothing drawn): check that the worker and
  data files are served (19.6 step 4). The browser's console names a blocked or failed `/vendor/pdfjs/…` or
  `/assets/pdf.worker…` request. A single damaged or encrypted PDF failing is expected; it can still be downloaded.
  Everything else in the explorer keeps working. If PDF previews must be avoided, lower `ARCHIVE_PREVIEW_PDF_BYTES` to
  `65536`: PDFs then offer only hex and download.

- **Repository connection failures** (`repository_unreachable`, `host_key_*`, `ssh_authentication_failed`): Admin ›
  Repositories › **Test Server Connection** names the failing step; follow the 0055 runbook's rollback section for SSH
  credentials. The explorer reports it and nothing else is affected.

- **Frontend asset loading failures** (blank page, errors about `/assets/…` or `/vendor/…`): reload with the cache
  bypassed; check `curl -I https://emucat-test.dfri.info/` and the 19.6 asset checks; `sudo docker logs emucat-web-1
--tail 100`. If the web image is broken, `rollback-app --to <previous>`.

- **Reverse-proxy problems** (downloads cut off early on a healthy server): a proxy timeout or response size limit in
  front of the web container. Downloads are at most 100 MiB by default; `proxy_read_timeout` of one hour is already
  configured in the web container; check the VPS proxy's timeouts. Lower `ARCHIVE_DOWNLOAD_MAX_BYTES` if a proxy limit
  cannot be changed. No proxy change is needed by this release.

## 22. Production promotion (MOON)

Only after every MARS check passed. Not done as part of this change.

1. Synchronize the local repository:

   ```bash
   git fetch origin
   ```

   ```bash
   git switch main
   ```

   ```bash
   git pull --ff-only
   ```

2. Merge `develop` into `main`:

   ```bash
   git merge --no-ff origin/develop -m "Merge develop: Archive Explorer (decision 0056)"
   ```

3. Push `main`:

   ```bash
   git push origin main
   ```

4. Verify the production commit:

   ```bash
   git log -1 --format='%H %s' origin/main
   ```

   ```bash
   git merge-base --is-ancestor <commit> origin/main && echo "contains <commit>"
   ```

   On MOON:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check-update
   ```

   It must name the merge commit as `Latest:`.

5. MOON configuration: `deploy.env` needs nothing new; `app.env` needs nothing new (19.2). Review the limits against
   MOON's memory: `free -h`, `sudo docker inspect -f '{{.HostConfig.Memory}}' emucat-api-1`.

6. MOON deployment tooling: same check as 19.1, on MOON, with `refs/remotes/origin/main`:

   ```bash
   sudo -u emucat-deploy git --git-dir=/opt/emucat/repo.git show refs/remotes/origin/main:deploy/bin/emucatctl | sudo diff -q /opt/emucat/tooling/bin/emucatctl - && echo "tooling is current"
   ```

   If MOON is not yet on decision 0055, promote that first with its runbook (16.10 there), including MOON's own SSH key.

7. Deploy:

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl backup
   ```

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

8. Verify production health: 19.6 steps 1–6 with MOON's public address and web container address.

9. Limited production smoke test: open Archive Explorer on one small version; preview one text file and one image;
   download one small file and compare its `sha256sum` with the details; check that no file appeared in
   `/opt/emucat/data/transfers`. Leave the rest to normal use.
