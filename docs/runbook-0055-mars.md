# Runbook: deploying decision 0055 on MARS

The server's own repository connection, the HTTPS relay, server-side clones and View Archive Contents
([decision 0055](decisions/0055-server-repository-access.md)), deployed by hand on MARS, the test server: branch
`develop`, `https://emucat-test.dfri.info`, web container on `10.0.0.2:8095`, application account `david:david`
(1000:1000), MariaDB `emucat-db` / `emucat-usr`. Everything below was written from the scripts in this release
(`deploy/bin/emucatctl`, `deploy/compose.yaml`); run it in order.

Placeholders: `<nas-host>` and `<nas-port>` are the address and SSH port **the EmuCat server** uses to reach the
repository (see Admin › Repositories; often the same as the agents'), `<repo-user>` is the restricted SFTP account
of [the repository guide](repositories.md) (`emucat` there), `<repo-id>` is the repository's UUID (shown on the
Repositories page and in the agents' `agent.toml`), `<commit>` is the full commit ID you deploy.

**`emucatctl update` alone is not enough for this release.** It runs the _installed_ tooling, and the tooling of
earlier releases neither creates `data/transfers` and `config/repository-ssh` nor passes them, or the key, to
Compose. Without the new tooling the new `compose.yaml` refuses to start (`EMUCAT_TRANSFERS_DIR` unset). So the
order is: new tooling (`install`), then key and directories, then `update`.

## 16.1 Git and tooling preparation

On the workstation:

```bash
git fetch origin
git log -1 --format='%H %s' origin/develop     # note the commit ID: this is <commit>
git archive --format=tar --prefix=emucat-src/ origin/develop | ssh mars 'rm -rf ~/emucat-src && tar -x -C ~'
```

`git archive` of `origin/develop` is the checkout: MARS gets exactly that commit's files, without a `.git`. To
deploy a specific commit instead of the branch tip, use `git archive ... <commit>`; `update` itself always deploys
the tip of `develop`, so check below that the tip is still `<commit>`.

On MARS:

```bash
cd ~/emucat-src
sudo /opt/emucat/tooling/bin/emucatctl status          # what runs now; note the commit, for 16.9
sudo deploy/bin/emucatctl install                      # new tooling from this checkout (required, see above)
sudo /opt/emucat/tooling/bin/emucatctl check           # every line must be ok; see 16.3 and 16.4 if not
sudo /opt/emucat/tooling/bin/emucatctl check-update    # must show <commit> as the target
```

`install` replaces `/opt/emucat/tooling` (emucatctl, the unit, the compiled deployment service), rewrites and
restarts `emucat-deployer`, and creates the two new directories (`data/transfers` 0750 and
`config/repository-ssh` 0711, both `david:david`). It changes nothing in `deploy.env`, `app.env`, the deploy key,
the token, the mirror, the releases, backups, media, notes or the database, and does not restart the application.

Do **not** run `update` yet: first provision the key (16.3), because the API reads it only when its container is
created. Then [16.7](#167-database-and-application-deployment). Remove the checkout at the end:
`cd ~ && rm -rf ~/emucat-src`.

## 16.2 Configuration changes

| Variable / setting                       | Purpose                                                             | Required                         | Default                                      | Example                                   | File                                                                 | Restart                 |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- | ----------------------- |
| `REPOSITORY_SSH_PRIVATE_KEY_PATH`        | The server's own SSH key                                            | For clones, inspection, relay    | unset                                        | `/run/secrets/repository-ssh/id_ed25519`  | Set by `compose.yaml` when `config/repository-ssh/id_ed25519` exists | API container recreated |
| `REPOSITORY_SSH_KNOWN_HOSTS_PATH`        | Trusted repository host keys                                        | With a key                       | unset                                        | `/run/secrets/repository-ssh/known_hosts` | Set by `compose.yaml` (same condition)                               | API container recreated |
| `REPOSITORY_SSH_PASSPHRASE_FILE`         | File holding the key's passphrase                                   | Only for a key with a passphrase | unset                                        | `/run/secrets/repository-ssh/passphrase`  | Set by `compose.yaml` when `config/repository-ssh/passphrase` exists | API container recreated |
| `REPOSITORY_SSH_CONNECT_TIMEOUT_SECONDS` | TCP and SSH handshake timeout (1–120)                               | Optional                         | `15`                                         | `20`                                      | `/opt/emucat/config/app.env`                                         | API container recreated |
| `REPOSITORY_SSH_REQUEST_TIMEOUT_SECONDS` | One SFTP request without progress (5–600)                           | Optional                         | `60`                                         | `120`                                     | `app.env`                                                            | API container recreated |
| `TRANSFER_STAGING_PATH`                  | Staging for relayed transfers and clones                            | Fixed in Docker                  | `var/transfers`; `/data/transfers` in Docker | `/data/transfers`                         | `compose.yaml` (host side: `/opt/emucat/data/transfers`)             | API container recreated |
| `TRANSFER_RELAY_ENABLED`                 | Whether agents may use the relay                                    | Optional                         | `true`                                       | `false`                                   | `app.env`                                                            | API container recreated |
| `TRANSFER_CHUNK_BYTES`                   | Size of one upload chunk (256 KiB – 64 MiB)                         | Optional                         | `8388608`                                    | `16777216`                                | `app.env`                                                            | API container recreated |
| `TRANSFER_MAX_STAGING_BYTES`             | Disk quota of staging in all (at least 64 MiB)                      | Optional                         | `107374182400` (100 GiB)                     | `53687091200`                             | `app.env`                                                            | API container recreated |
| `TRANSFER_MIN_FREE_BYTES`                | Free space staging leaves on its file system                        | Optional                         | `2147483648` (2 GiB)                         | `10737418240`                             | `app.env`                                                            | API container recreated |
| `TRANSFER_MAX_CONCURRENT`                | Relayed transfers and clones at once                                | Optional                         | `4`                                          | `2`                                       | `app.env`                                                            | API container recreated |
| `TRANSFER_INACTIVITY_TIMEOUT_SECONDS`    | An idle, unfinished transfer is discarded after this                | Optional                         | `86400`                                      | `43200`                                   | `app.env`                                                            | API container recreated |
| `TRANSFER_RETENTION_SECONDS`             | A finished transfer's bytes are kept this long                      | Optional                         | `3600`                                       | `600`                                     | `app.env`                                                            | API container recreated |
| `EMUCAT_REPOSITORY_SUBNET`               | Docker network the API uses to reach repositories                   | Optional                         | `172.31.251.0/24`                            | `172.31.250.0/24`                         | `/opt/emucat/config/deploy.env`                                      | Next `update`           |
| Server host / Server port                | Where the server reaches the SSH server, if not the agents' address | Optional                         | empty = the agents' host and port            | `nas.internal`, `22`                      | Admin › Repositories › Edit (database)                               | None                    |
| `[repositories."<id>"] transport`        | Agent: `auto`, `sftp` or `relay`                                    | Optional                         | `auto`                                       | `relay`                                   | The agent's `agent.toml`                                             | Agent restart           |

`EMUCAT_TRANSFERS_DIR`, `EMUCAT_REPOSITORY_SSH_DIR`, `EMUCAT_REPOSITORY_SSH_KEY`, `_KNOWN_HOSTS` and `_PASSPHRASE`
are derived by `emucatctl` from `EMUCAT_ROOT` and are not settings. Never put a key or a passphrase in `app.env`.

For MARS no `app.env` change is required: the defaults apply. To change one, `sudoedit /opt/emucat/config/app.env`
before `update`; after a deployment see 16.7 step 7.

## 16.3 SSH key provisioning

**Host authentication and user authentication are two different things.** The repository's _host key_, in
`known_hosts`, proves to the EmuCat server that it is talking to your NAS and not to something in between; the
server refuses an unknown or changed host key, always, and there is no setting that accepts one automatically. The
_user key_, `id_ed25519` and its line in the NAS's `authorized_keys`, proves to the NAS that the connection comes
from the EmuCat server. Both are needed, and neither replaces the other.

1. **The secrets directory** was created by `install` (16.1). Check it:

   ```bash
   sudo stat -c '%U:%G %a %n' /opt/emucat/config/repository-ssh     # david:david 711
   ```

2. **A dedicated key pair**, on MARS, for the server only (never an agent's key, never copied to an agent):

   ```bash
   sudo ssh-keygen -t ed25519 -N '' -C emucat-server@mars -f /opt/emucat/config/repository-ssh/id_ed25519
   ```

   With a passphrase instead: run it without `-N ''`, then
   `sudo install -o david -g david -m 0600 /dev/null /opt/emucat/config/repository-ssh/passphrase` and
   `sudoedit /opt/emucat/config/repository-ssh/passphrase` (the passphrase alone on one line).

3. **Owner and permissions:**

   ```bash
   sudo chown david:david /opt/emucat/config/repository-ssh/id_ed25519 /opt/emucat/config/repository-ssh/id_ed25519.pub
   sudo chmod 600 /opt/emucat/config/repository-ssh/id_ed25519
   sudo chmod 644 /opt/emucat/config/repository-ssh/id_ed25519.pub
   sudo cat /opt/emucat/config/repository-ssh/id_ed25519.pub      # the public key, for step 4
   ```

4. **Install the public key on the repository's SSH server**, in the restricted account's `authorized_keys`, as its
   own line next to the agents' keys, with the same restrictions ([repository guide](repositories.md), section 3).
   On the NAS, as root (path as in that guide for a chrooted account):

   ```bash
   echo 'restrict ssh-ed25519 AAAA...the key from step 3... emucat-server@mars' | sudo tee -a /home/emucat/.ssh/authorized_keys
   sudo chown emucat:emucat /home/emucat/.ssh/authorized_keys
   sudo chmod 600 /home/emucat/.ssh/authorized_keys
   ```

5. **Capture and verify the repository's host key.** On the NAS, the real fingerprint:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   On MARS, what the network shows, at the address the server will use:

   ```bash
   ssh-keyscan -p <nas-port> -t ed25519 <nas-host> > /tmp/nas-host-key
   ssh-keygen -lf /tmp/nas-host-key
   ```

   The two `SHA256:` fingerprints must be identical. They must also equal the `host_key_fingerprints` the agents
   already trust in their `agent.toml`. If they differ, stop: do not write `known_hosts` until you know why.

6. **Configure `known_hosts`:**

   ```bash
   sudo install -o david -g david -m 0644 /tmp/nas-host-key /opt/emucat/config/repository-ssh/known_hosts
   rm /tmp/nas-host-key
   sudo ssh-keygen -lf /opt/emucat/config/repository-ssh/known_hosts      # the fingerprint from step 5
   ```

   For a port other than 22 the line begins with `[<nas-host>]:<nas-port>`, as `ssh-keyscan -p` writes it; keep it
   so. Several repositories: append each one's line.

7. **How it reaches the API container.** Nothing to do by hand: when `id_ed25519` exists at the time the
   containers are created, `emucatctl` sets `REPOSITORY_SSH_PRIVATE_KEY_PATH`, `REPOSITORY_SSH_KNOWN_HOSTS_PATH`
   (and `REPOSITORY_SSH_PASSPHRASE_FILE` if `passphrase` exists), and `compose.yaml` mounts
   `/opt/emucat/config/repository-ssh` **read-only** at `/run/secrets/repository-ssh` in the API container only.
   The key is not in the image, the database, a log or Git. Check it once deployed (16.7):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check     # "repository key id_ed25519 is readable by david only: ok"
   sudo docker exec emucat-api-1 printenv REPOSITORY_SSH_PRIVATE_KEY_PATH REPOSITORY_SSH_KNOWN_HOSTS_PATH
   sudo docker exec emucat-api-1 ls -l /run/secrets/repository-ssh
   ```

8. **Test from the real runtime environment**, the API container, after 16.7: Admin › Repositories, the
   repository, **Test Server Connection**. Each step must be green: configuration, name resolution, TCP, host
   key, authentication, root access, write, read back, publication without overwrite, cleanup. A failure names its
   step and what to do. Optionally, from the MARS host (not the container), the same account and key, with strict
   checking against the same file:

   ```bash
   sudo sftp -i /opt/emucat/config/repository-ssh/id_ed25519 -P <nas-port> \
     -o UserKnownHostsFile=/opt/emucat/config/repository-ssh/known_hosts -o StrictHostKeyChecking=yes \
     <repo-user>@<nas-host> <<< 'ls'
   ```

   If the server reaches the NAS at another address than the agents, set it in Admin › Repositories › Edit
   (_Server host_, _Server port_) before testing.

## 16.4 Persistent storage

```bash
# Created by install; create by hand only if install could not (same owner and mode):
sudo install -d -o david -g david -m 0750 /opt/emucat/data/transfers
sudo stat -c '%U:%G %a %n' /opt/emucat/data/transfers          # david:david 750

# Free space where staging lives (the same file system as data/media, normally):
df -h /opt/emucat/data/transfers

# Container access, after 16.7: the API can write and remove in staging.
sudo docker exec emucat-api-1 sh -c 'f=/data/transfers/.probe-$$; touch "$f" && rm "$f" && echo writable'

# Usage while transfers or clones run:
sudo du -sh /opt/emucat/data/transfers
sudo ls -l /opt/emucat/data/transfers
sudo mariadb emucat-db -e "SELECT direction, state, COUNT(*) AS n, SUM(reserved_bytes) AS reserved
  FROM repository_transfers GROUP BY direction, state"
```

Size it for what runs at once: an upload or download reserves its whole object; a ZIP clone stages the source and
the clone (about twice the archive). The quota is `TRANSFER_MAX_STAGING_BYTES` (100 GiB), and staging always leaves
`TRANSFER_MIN_FREE_BYTES` (2 GiB) free; a request beyond either is refused with `transfer_staging_full` and nothing
is written.

**Cleanup and restarts.** Each transfer or clone has one directory named by a random UUID, and a row in
`repository_transfers` (clones: their registration operation). On start the API keeps the directories its rows
still need, removes every other directory, resumes uploads that were being published and downloads that were being
staged, and resumes clones (at most three attempts). A sweeper removes transfers idle for
`TRANSFER_INACTIVITY_TIMEOUT_SECONDS` (one day) and finished ones after `TRANSFER_RETENTION_SECONDS` (one hour). A
cancelled or failed clone removes what it staged and anything it published. Staged bytes never outlive their row,
so nothing needs deleting by hand; do not delete inside `data/transfers` while the API runs.

`data/transfers` is not backed up and needs no backup; `data/media`, `data/notes` and the database are unchanged.

## 16.5 Reverse proxy

MARS topology: browser and agents → HTTPS → nginx on the VPS ([`deploy/nginx/emucat.example.conf`](../deploy/nginx/emucat.example.conf))
→ `10.0.0.2:8095` → the web container's nginx ([`deploy/docker/web/emucat.conf`](../deploy/docker/web/emucat.conf), part of
the release) → API.

**Mandatory:** nothing changes if the VPS already has the settings of the example (they were required for
screenshots and the WebSocket). Check that its `server` block for `emucat-test.dfri.info` has:

```nginx
client_max_body_size 80m;        # above TRANSFER_CHUNK_BYTES (8 MiB) and screenshots (64 MiB)
location / {
    proxy_pass http://emucat_test;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_request_buffering off;
}
```

```bash
sudo nginx -T 2>/dev/null | grep -A3 -n 'emucat-test.dfri.info' | head
sudo nginx -T 2>/dev/null | grep -n 'client_max_body_size\|proxy_request_buffering\|proxy_read_timeout'
```

A `TRANSFER_CHUNK_BYTES` raised above 80 MB needs `client_max_body_size` raised on both proxies (the web container's
is fixed at 80m, so keep chunks below it).

**Optional, recommended:** stream relay downloads without nginx spooling them to disk on the VPS. Add, inside the
same `server` block, after `location /`:

```nginx
location /api/v1/agent/repositories/ {
    proxy_pass http://emucat_test;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`. Without it downloads still work: nginx buffers up to
`proxy_max_temp_file_size` (1 GB by default) and then reads at the client's speed. `Range` requests are passed
through unchanged in both cases.

**The web container** already has `client_max_body_size 80m`, `proxy_request_buffering off`, `proxy_buffering off`
and one-hour timeouts for `/api/`, and comes with the release: no action.

**Cloudflare**, if the name is proxied by it: no setting is required. Requests are limited to 100 MB on the Free
and Pro plans, which is why chunks are 8 MiB; keep `TRANSFER_CHUNK_BYTES` well below that. Responses must start
within 100 seconds: the relay never holds a request that long (completion, verification and staging are polled).
Relay responses are `Cache-Control: no-store`; do not add Cache Rules for `/api/`.

## 16.6 Agent update

Build on a Windows workstation with Rust (from the repository root, at `<commit>`):

```powershell
cd agent
cargo build --release
.\target\release\emucat-agent.exe --version
```

The executable is `agent\target\release\emucat-agent.exe`. On each agent PC:

1. Stop the agent (Ctrl+C in its window, or stop the service or task that runs it). Wait until no registration,
   restore or snapshot is running for it (Admin › Agents).
2. Keep the old executable: `Rename-Item emucat-agent.exe emucat-agent.previous.exe`, then copy the new one in its
   place. Its configuration (`agent.toml`), its credential (DPAPI, in its state directory), its staging, cache and
   journals are separate files and are kept: do not pair again.
3. `.\emucat-agent.exe check-config` must pass with the existing `agent.toml`. Nothing must be added to it:
   `transport` defaults to `auto`.
4. Start it again (`.\emucat-agent.exe run`, or the service or task).

**HTTP fallback configuration**, per repository in `agent.toml`: leave `transport` out (or `transport = "auto"`)
for SFTP first and the relay only when the repository cannot be reached; `transport = "sftp"` never uses the relay;
`transport = "relay"` never uses SFTP, and then `host`, `username`, `remote_root`, `private_key_path`,
`host_key_fingerprints` and `known_hosts_path` must be removed from that section (they are refused).

**Verify direct SFTP:**

```powershell
.\emucat-agent.exe repository-check --repository <repo-id>
```

It must end with `Transport used: sftp`. In Admin › Repositories, **Check** on that agent then says "Reached
directly over SFTP."

**Verify the fallback when SFTP is unreachable** (administrator PowerShell on the agent PC; this blocks only this
PC's SSH to the NAS):

```powershell
New-NetFirewallRule -DisplayName "EmuCat fallback test" -Direction Outbound -Action Block -Protocol TCP -RemoteAddress <nas-ip> -RemotePort <nas-port>
.\emucat-agent.exe repository-check --repository <repo-id>
Remove-NetFirewallRule -DisplayName "EmuCat fallback test"
```

With the rule, the check takes longer (its SFTP connection times out first, `connect_timeout_seconds` ×
`connect_retries`), then ends with `Transport used: relay`; the Repositories page shows "Reached through the server
relay." Remove the rule afterwards, always. An authentication or host-key failure must **not** fall back: that is
test 17 below and the automated tests.

## 16.7 Database and application deployment

On MARS, after 16.1, 16.3 and 16.4:

1. **Preflight:**

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl check
   sudo /opt/emucat/tooling/bin/emucatctl check-update      # target <commit>
   df -h /opt/emucat /var/lib/docker
   ```

   `check` must show ok for the transfer staging directory, the repository SSH directory, and (once 16.3 is done)
   the key and a non-empty `known_hosts`.

2. **Backup** (also taken by `update` itself before migrating; this one is your own restore point):

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl backup
   sudo ls -lt /opt/emucat/backups | head -3
   ```

3. **Tooling:** done in 16.1 (`sudo deploy/bin/emucatctl install` from the new checkout). Re-run it if `check`
   still reports a missing directory.

4. **Application update, with migration `0021_server_repository_access`:**

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl update
   ```

   Stages: fetching, building, testing, backing up, **applying_migrations** (0021: a nullable
   `registration_operations.agent_id`, `repository_transfers`, `repository_transfer_chunks`,
   `repository_server_checks`, `repositories.server_host`/`server_port`, `agent_repositories.last_transport`; all
   additive), starting, health checking, completed. Or from Admin › Application Updates, which runs the same.

5. **Containers:**

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl status
   sudo docker ps --filter label=com.docker.compose.project=emucat --format '{{.Names}} {{.Status}} {{.Image}}'
   sudo docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' emucat-api-1   # <commit>
   sudo docker exec emucat-api-1 printenv TRANSFER_STAGING_PATH REPOSITORY_SSH_PRIVATE_KEY_PATH
   ```

6. **Health:**

   ```bash
   curl -fsS https://emucat-test.dfri.info/api/v1/health
   curl -fsS https://emucat-test.dfri.info/api/v1/ready
   curl -fsS http://10.0.0.2:8095/healthz
   ```

7. **Logs:**

   ```bash
   sudo /opt/emucat/tooling/bin/emucatctl logs api --tail 200
   sudo ls -t /opt/emucat/state/operations | head -2           # the update's .log and .events
   sudo tail -n 50 /opt/emucat/state/operations/$(sudo ls -t /opt/emucat/state/operations | grep '\.log$' | head -1)
   journalctl -u emucat-deployer -n 50
   ```

   A configuration change after deployment (key added later, `app.env` edited): `sudo docker stop emucat-api-1`
   then `sudo /opt/emucat/tooling/bin/emucatctl update`. With the API stopped, `update` deploys the same commit
   again in full (cached build, backup, no migration, new containers), which reads the new settings.

## 16.8 Mars functional acceptance tests

Use a small test VM (86Box or QEMU, a few hundred MB) and one paired agent. "Repositories page" is
Admin › Repositories; "the VM" is Catalog › the VM › Manage.

| #   | Test                                 | How                                                                                                                        | Expected result                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Server-side repository connection    | Repositories page › **Test Server Connection**                                                                             | Every step green; the result and its time are kept on reload. `emucatctl check` ok for the key                                                                                                                                                                                                       |
| 2   | Direct SFTP upload                   | Agent without firewall rule; register a new VM                                                                             | Registration succeeds; agent log has no relay request; Repositories page shows the agent's transport as SFTP after a check; `repository_transfers` gets no upload row                                                                                                                                |
| 3   | HTTP fallback upload                 | Firewall rule of 16.6 on; register another VM (or snapshot)                                                                | Succeeds; agent log shows "The repository cannot be reached over SFTP; trying the server relay"; one upload row ends `published`; the version's SHA-256 equals the agent's                                                                                                                           |
| 4   | Interrupted HTTP upload and resume   | Rule on; during the upload of a VM of several chunks, `sudo docker restart emucat-web-1` on MARS                           | Agent logs "A chunk did not reach the server; sending it again", the upload continues from the next missing chunk (chunk rows are not reset) and the registration succeeds. An outage longer than the agent's retries (about 6 s) fails the operation cleanly; registering again starts a new upload |
| 5   | Direct SFTP download                 | Rule off; restore a version onto the agent                                                                                 | Restore succeeds; no download row in `repository_transfers`                                                                                                                                                                                                                                          |
| 6   | HTTP fallback download               | Rule on; restore a version                                                                                                 | Succeeds; one download row `ready`, then removed after an hour; the restored files verify                                                                                                                                                                                                            |
| 7   | Interrupted HTTP download and resume | Rule on; restore a large version; `sudo docker restart emucat-web-1` during the download                                   | Agent logs "The download through the server relay was interrupted; resuming" and continues with `Range` from the bytes it has, the whole-file SHA-256 matches, restore succeeds                                                                                                                      |
| 8   | Archive integrity verification       | After 3 and 6: compare in View Archive Contents the archive SHA-256 with the version's; **Verify local copy** on the agent | Same SHA-256 everywhere; the summary says the manifest is "the one verified when this version was registered"; verification reports no difference                                                                                                                                                    |
| 9   | Clone from master, no agent online   | Stop the agent; the VM › Version History › master › **Clone…**, new name                                                   | No agent chooser; "The EmuCat server makes the clone itself"; ends Succeeded; the new VM is in the catalog with its own master; the registration history shows "EmuCat server"                                                                                                                       |
| 10  | Clone from snapshot, no agent online | Agent still stopped; clone a snapshot                                                                                      | As 9; the new VM's master has the snapshot's files; the source is unchanged                                                                                                                                                                                                                          |
| 11  | Source deletion after cloning        | Delete the snapshot cloned in 10 (it must be a leaf nothing uses); restore the clone onto the agent                        | The snapshot is deleted; the clone is unaffected and restores (it is an independent archive, not a reference)                                                                                                                                                                                        |
| 12  | Archive contents modal               | Version History › a version › **View contents…**: switch VM files / Stored entries, open folders, search, page             | Summary, folders and files with sizes; search finds a known file; no download, no change; a non-administrator has no button and the API answers 403                                                                                                                                                  |
| 13  | Screenshots and media                | Take a screenshot on the agent of a registered VM; reorder and tag media                                                   | Synchronized and shown as before                                                                                                                                                                                                                                                                     |
| 14  | Existing VM transfer and restore     | With the agent on and no rule: snapshot, restore, replace, Remote Volatile                                                 | All as before; SFTP used                                                                                                                                                                                                                                                                             |
| 15  | Restart recovery                     | Start a clone (agent may be offline) and, while it says it is downloading or writing, `sudo docker restart emucat-api-1`   | After the restart the clone continues and succeeds (or, after three interrupted attempts, fails and removes what it staged); no orphan directory remains in `data/transfers` (`sudo ls /opt/emucat/data/transfers`)                                                                                  |
| 16  | Temporary storage cleanup            | After the tests: `sudo du -sh /opt/emucat/data/transfers` and the SQL of 16.4, an hour later again                         | Finished transfers' bytes are gone after `TRANSFER_RETENTION_SECONDS`; only active rows reserve bytes; the directory is empty when nothing runs                                                                                                                                                      |
| 17  | Unauthorized transfer rejection      | From any computer: the commands below                                                                                      | `401 unauthorized` without or with a wrong credential; never an archive's bytes. Cross-operation and non-staging keys are refused with 403 (covered by `apps/api/test/relay.test.ts`, which needs a real agent credential)                                                                           |

```bash
curl -si -X POST https://emucat-test.dfri.info/api/v1/agent/repositories/<repo-id>/downloads \
  -H 'content-type: application/json' -d '{"key":"archives/x.zip"}' | head -1          # 401
curl -si -X POST https://emucat-test.dfri.info/api/v1/agent/repositories/<repo-id>/downloads \
  -H 'authorization: Bearer not-a-credential' -H 'x-emucat-protocol-version: 1' \
  -H 'content-type: application/json' -d '{"key":"archives/x.zip"}' | head -1          # 401
```

Also for 17: an agent with a deliberately wrong `host_key_fingerprints` entry (a copy of `agent.toml`, run with
`--config`) must fail `repository-check` with a host-key error and **not** use the relay.

## 16.9 Rollback

Migrations are forward-only; never drop the new tables or columns. 0021 is additive, and the previous release
ignores what it adds, but `rollback-app` refuses a release older than the database's migrations (exit code 3),
so the way back is to fix forward or switch features off.

- **Failed tooling installation.** Run
  `sudo deploy/bin/emucatctl install` again from the same checkout after fixing the cause it printed
  (`journalctl -u emucat-deployer -n 50`). The application keeps running on the old release meanwhile. To go back to
  the earlier tooling, copy the earlier commit (`git archive <previous-commit>`) and run its `install`; it does not
  touch the application.
- **Failed application update.** Before migrations (build, test, backup stage): nothing changed, the previous
  release still runs (`status`). After start without a migration: `restored_previous` automatically. Read
  `state/operations/<id>.log`, fix, run `update` again.
- **Failed database migration** (result `unsafe`). The schema may be partly migrated and the new release is not
  running. Do not edit or drop tables. Read the log and `emucatctl logs api`; fix the cause (usually database
  privileges or space) and run `update` again: the runner applies what is missing. Only if the data itself is
  damaged, restore the dump that update took (`/opt/emucat/backups`, newest) as described in
  [deployment section 12](deployment.md#12-backups-and-recovery), which loses what was written since.
- **Interrupted transfer.** Nothing to clean. The agent retries chunks and ranges; a failed operation leaves its
  row `failed` or the sweeper expires it, and its staging directory is removed. Start the registration, restore or
  clone again. A clone interrupted by a restart resumes by itself.
- **Full staging file system.** New transfers are refused (`transfer_staging_full`), running ones continue.
  `df -h /opt/emucat/data`; wait for running transfers, or lower `TRANSFER_MAX_CONCURRENT`, or free disk space
  elsewhere, or set a smaller `TRANSFER_MAX_STAGING_BYTES` / larger disk. Never delete inside `data/transfers`
  while the API runs; if you must, `sudo docker stop emucat-api-1` first, and the next start drops what has no
  row.
- **Incorrect SSH credentials.** Test Server Connection names the step. Authentication: the public key is not in
  `authorized_keys`, or the wrong account. Host key: `known_hosts` lacks the address or port the server uses,
  or the NAS's key changed: verify the new fingerprint on the NAS (16.3 step 5) before replacing the line, never
  accept it blindly. To switch everything server-side off at once: `sudo mv
/opt/emucat/config/repository-ssh/id_ed25519 /opt/emucat/config/repository-ssh/id_ed25519.disabled`, stop the API
  and `update` (16.7 step 7); agents keep working directly, clones and inspection say the server has no
  connection. To revoke the key, remove its line from `authorized_keys` on the NAS.
- **Reverse-proxy misconfiguration.** `413` on chunks: `client_max_body_size` below the chunk size. Downloads
  stall or time out: timeouts below one hour, or buffering limits; add the optional location of 16.5. Restore the
  earlier VPS config and `sudo nginx -t && sudo systemctl reload nginx`. Agents fall back to SFTP errors only;
  nothing is lost.
- **Agent/server protocol mismatch.** Older agents keep working with this server (direct SFTP; they never use the
  relay). A new agent against an older server gets 404 on the relay, treats it as "no relay" and reports its SFTP
  error. To roll an agent back, stop it and rename `emucat-agent.previous.exe` back; its configuration works as
  long as it has no `transport = "relay"` section (remove `transport` lines first).

## 16.10 Production promotion

Only after every MARS test passed. Not done as part of this change.

1. **Merge `develop` into `main`**, on the workstation:

   ```bash
   git fetch origin
   git switch main && git pull --ff-only
   git merge --no-ff origin/develop -m "Merge develop: server repository access (decision 0055)"
   git push origin main
   ```

2. **Verify the production commit:** `git log -1 --format='%H %s' origin/main`; it must contain `<commit>`
   (`git merge-base --is-ancestor <commit> origin/main && echo ok`). On MOON,
   `sudo /opt/emucat/tooling/bin/emucatctl check-update` must name that commit.

3. **MOON configuration.** `/opt/emucat/config/deploy.env` (from `moon.deploy.env.example`) needs nothing new;
   `EMUCAT_REPOSITORY_SUBNET` defaults to `172.31.251.0/24`, change only on a collision. `app.env`: no required
   change; review the `TRANSFER_*` limits against MOON's disk (`df -h /opt/emucat/data`).

4. **MOON's own SSH key.** Repeat 16.3 on MOON with a **new** key (`-C emucat-server@moon`); never copy MARS's key.
   Add its own line to the production repository's `authorized_keys`, verify the host key fingerprint out of
   band, write MOON's `known_hosts`.

5. **Production tooling:** `git archive --format=tar --prefix=emucat-src/ origin/main | ssh moon 'rm -rf ~/emucat-src && tar -x -C ~'`, then on MOON `cd ~/emucat-src`,
   `sudo deploy/bin/emucatctl install`, `sudo /opt/emucat/tooling/bin/emucatctl check`.

6. **Application:** `sudo /opt/emucat/tooling/bin/emucatctl backup`, then
   `sudo /opt/emucat/tooling/bin/emucatctl update` (updates from the browser are normally disabled on MOON), then
   16.7 steps 5–7 with MOON's address.

7. **Production agents:** optional. Old agents keep working. Update them as in 16.6 where the relay is wanted.

8. **Verify:** health and readiness URLs, Test Server Connection on each production repository, one clone of a
   small version, View Archive Contents, one registration and one restore over SFTP, and, if an agent needs it,
   one relay check (16.6). Then remove `~/emucat-src`.
