# Deploying EmuCat on a Linux server

This guide prepares a Linux server to run EmuCat in Docker, with the server's existing MariaDB, and to
update it on demand from a fixed Git branch. Two servers use the same mechanism:

| Host     | Role       | Branch    | Address                         | Updates from Settings  |
| -------- | ---------- | --------- | ------------------------------- | ---------------------- |
| **MARS** | test       | `develop` | `https://emucat-test.dfri.info` | enabled                |
| **MOON** | production | `main`    | configurable (`PUBLIC_ORIGIN`)  | disabled until enabled |

Nothing here has been run on MARS or MOON yet. The steps were exercised against disposable hosts and
containers only (see [Testing](#testing-this-tooling)).

**The GitHub side is set up by hand.** This repository contains no workflow, runner or webhook, and the
tooling never creates a repository, a branch or a remote. Before installing, create the GitHub repository,
push `main`, create `develop`, and add a **read-only deploy key** for each server. There is no GitHub
Actions, no container registry and no push-triggered deployment: images are built on the server itself.

## Contents

1. [Architecture](#1-architecture)
2. [Host prerequisites](#2-host-prerequisites)
3. [External MariaDB](#3-external-mariadb)
4. [Database bootstrap](#4-database-bootstrap)
5. [Configuration files and environment variables](#5-configuration-files-and-environment-variables)
6. [Docker images](#6-docker-images)
7. [Docker Compose](#7-docker-compose)
8. [First installation](#8-first-installation)
9. [The deployment service](#9-the-deployment-service)
10. [Updating from the command line](#10-updating-from-the-command-line)
11. [Updating from Settings](#11-updating-from-settings)
12. [Backups and recovery](#12-backups-and-recovery)
13. [Rolling back, and its limits](#13-rolling-back-and-its-limits)
14. [The external reverse proxy](#14-the-external-reverse-proxy)
15. [WebSocket](#15-websocket)
16. [MARS](#16-mars)
17. [MOON](#17-moon)
18. [Disabling updates in production](#18-disabling-updates-in-production)
19. [Security boundaries](#19-security-boundaries)
20. [Troubleshooting](#20-troubleshooting)

## 1. Architecture

```
 browser / agents ──HTTPS──▶ external reverse proxy (TLS, not in this repository)
                                   │ HTTP, EMUCAT_BIND_ADDRESS:EMUCAT_HTTP_PORT
                                   ▼
  ┌────────────── Docker (deploy/compose.yaml, no MariaDB) ───────────────┐
  │  web  (nginx, UID 101)  ── edge network (published port) ─────────────│
  │    │  /            the single-page app                                │
  │    │  /api/        REST and the agent WebSocket                       │
  │    ▼  internal network (no outside access)                            │
  │  api  (Fastify, UID 10001) ── database network ──▶ host.docker.internal│
  └────┬───────────────────────────────┬──────────────────────────────────┘
       │ bind: media directory         │ bind (read-only): /run/emucat-deployer
       ▼                               ▼  deployer.sock, HTTP + bearer token
  /srv/emucat/media              emucat-deployer.service (systemd, emucat-deploy)
                                       │ runs the root-owned emucatctl
                                       ▼
                         git mirror · docker build · migrate · compose up
                         MariaDB on the host (127.0.0.1:3306): emucat-db
```

- **Two application containers,** `api` and `web`, from images built on the server and tagged by commit
  (`emucat-api:<commit>`, `emucat-web:<commit>`). The API port is never published; only the web
  container listens, on the address the external proxy uses.
- **MariaDB stays on the host.** The API reaches it through `host.docker.internal`, mapped to Docker's host
  gateway. Compose has no database service.
- **`emucatctl`** is the one deployment tool, used by people on the command line and by the deployment
  service. It deploys only the configured branch.
- **The deployment service** (`apps/deployer`) is a small Node.js process run by systemd, outside Docker,
  listening on a Unix socket only. The API asks it, over that socket, for status and to start an update.
  It accepts nothing but fixed operations, and it keeps the state of every update on disk.

Host layout after installation:

| Path                         | Owner                              | Contents                                                 |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `/etc/emucat/deploy.env`     | `root:emucat-deploy` 0640          | How this host deploys (branch, paths, ports)             |
| `/etc/emucat/app.env`        | `root:emucat-deploy` 0640          | The API's environment, including `DB_PASSWORD`           |
| `/etc/emucat/deployer.token` | `root:emucat-socket` 0640          | Shared secret between the API and the deployment service |
| `/etc/emucat/deploy_key`     | `emucat-deploy` 0600               | Read-only GitHub deploy key                              |
| `/opt/emucat/tooling/`       | `root` 0755                        | `emucatctl`, the deployment service, the systemd unit    |
| `/opt/emucat/repo.git`       | `emucat-deploy`                    | Bare mirror of the one configured branch                 |
| `/opt/emucat/releases/<c>/`  | `emucat-deploy`                    | Each release's `compose.yaml` and migration list         |
| `/opt/emucat/state/`         | `emucat-deploy`                    | Current release, update operations and their logs, lock  |
| `/srv/emucat/media`          | UID/GID `10001` 0750               | Screenshots and other media (persistent)                 |
| `/var/backups/emucat`        | `emucat-deploy` 0750               | Database dumps                                           |
| `/run/emucat-deployer/`      | `emucat-deploy:emucat-socket` 0750 | The socket, mode 0660                                    |

## 2. Host prerequisites

- A 64-bit Linux distribution with systemd (Debian 12 or Ubuntu 24.04 are the reference).
- **Docker Engine 24 or later** with the Compose v2 plugin (`docker compose version`), and BuildKit.
- **Node.js 22.18 or later** on the host, for the deployment service (it runs TypeScript directly, with no
  dependencies). The containers bring their own Node.js.
- `git`, `flock` and `runuser` (util-linux), `curl`, `gzip`, and the MariaDB client tools `mariadb` and
  `mariadb-dump` (package `mariadb-client`).
- MariaDB 11.4 or later already running on the host (see below).
- An external reverse proxy terminating TLS, on the host or on another machine.
- About 4 GB of free disk for images and build cache, plus the media and backups.

Accounts, created once by root:

```bash
groupadd --system emucat-socket
useradd --system --create-home --home-dir /var/lib/emucat-deploy \
  --groups docker,emucat-socket --shell /usr/sbin/nologin emucat-deploy
```

`emucat-deploy` is in the `docker` group, **which is equivalent to root on this host**. No person logs in
as it. `emucat-socket` exists only so that the API container (by GID) and the deployment service share
the socket.

## 3. External MariaDB

The API container connects to MariaDB on the host through Docker's host gateway. MariaDB must listen on an
address the containers can reach **without being exposed to the network**:

- In the server configuration (for example `/etc/mysql/mariadb.conf.d/60-emucat.cnf`):

  ```ini
  [mysqld]
  # Loopback for the host itself, and the Docker host gateway for the containers.
  bind-address = 0.0.0.0
  ```

  then restrict it with the firewall: allow TCP 3306 from `127.0.0.1` and from the database network
  (`EMUCAT_DATABASE_SUBNET`, `172.31.252.0/24` by default), and drop it from everything else. For example,
  with nftables:

  ```
  table inet filter {
    chain input {
      tcp dport 3306 iifname "lo" accept
      tcp dport 3306 ip saddr 172.31.252.0/24 accept
      tcp dport 3306 drop
    }
  }
  ```

  Docker's own iptables rules do not apply to connections to the host itself, so this rule is what keeps
  MariaDB private. Check from another machine that port 3306 is closed.

- `emucatctl` (backups, checks) connects from the host to `EMUCAT_HOST_DB_HOST` (`127.0.0.1`).
- The character set is `utf8mb4` with `utf8mb4_uca1400_ai_ci`, set by the bootstrap below.

Other databases on the server are never touched: the application account can only see `emucat-db`.

## 4. Database bootstrap

Once per server, as a MariaDB administrator:

```bash
openssl rand -base64 33          # the new DB_PASSWORD; put it in /etc/emucat/app.env
sed "s/CHANGE_ME/<password>/" deploy/sql/bootstrap.sql | sudo mariadb
```

[`deploy/sql/bootstrap.sql`](../deploy/sql/bootstrap.sql) creates database `emucat-db` and account
`'emucat-usr'@'%'` with all privileges **on that database only** (no `*.*`, no `GRANT OPTION`, no `FILE`,
no `SUPER`). It uses `IF NOT EXISTS` and drops nothing, so running it again is harmless. It creates no
tables: the schema comes from the migrations, applied by `emucatctl update` as a controlled step.

The application never uses the root account, and nothing in this tooling resets, drops or recreates the
database.

## 5. Configuration files and environment variables

Two files under `/etc/emucat`, never committed. Both are literal `KEY=VALUE` lines: no quotes, no
variables. They are parsed as data, never sourced by a shell.

**`deploy.env`**: how the host deploys. Start from
[`deploy/config/deploy.env.example`](../deploy/config/deploy.env.example) (MARS) or
[`moon.deploy.env.example`](../deploy/config/moon.deploy.env.example) (MOON).

| Variable                                        | Meaning                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `EMUCAT_ENVIRONMENT`                            | Label shown in Settings: `test`, `production`                                 |
| `EMUCAT_BRANCH`                                 | The only branch this host deploys                                             |
| `EMUCAT_GIT_URL`                                | Repository URL, read-only (SSH with a deploy key recommended). Never a token  |
| `EMUCAT_GIT_SSH_KEY`                            | Private deploy key, or empty for a public HTTPS URL                           |
| `EMUCAT_PUBLIC_URL`                             | Informational                                                                 |
| `EMUCAT_ADMIN_UPDATES_ENABLED`                  | Exactly `true` enables the Install button; anything else disables it          |
| `EMUCAT_ROOT`                                   | `/opt/emucat`                                                                 |
| `EMUCAT_APP_ENV_FILE`                           | `/etc/emucat/app.env`                                                         |
| `EMUCAT_DEPLOYER_TOKEN_FILE`                    | `/etc/emucat/deployer.token`, generated by `install`                          |
| `EMUCAT_MEDIA_DIR`                              | Persistent media, owned by UID 10001                                          |
| `EMUCAT_BACKUP_DIR`                             | Database dumps                                                                |
| `EMUCAT_BACKUP_RETENTION_COUNT`                 | `0` keeps every dump; `N` keeps the newest N                                  |
| `EMUCAT_DEPLOY_USER`, `EMUCAT_SOCKET_GROUP`     | The accounts from section 2                                                   |
| `EMUCAT_BIND_ADDRESS`, `EMUCAT_HTTP_PORT`       | Where the web container listens for the proxy                                 |
| `EMUCAT_TRUSTED_PROXIES`                        | Addresses whose `X-Forwarded-For` is believed, as the web container sees them |
| `EMUCAT_*_SUBNET`                               | The three Docker networks; change only on a collision                         |
| `EMUCAT_DB_HOST_GATEWAY`, `EMUCAT_HOST_DB_HOST` | How containers and the host reach MariaDB                                     |
| `EMUCAT_VERIFY`                                 | Run type checks and database-free tests while building                        |
| `EMUCAT_KEEP_RELEASES`                          | Images of this many releases are kept for `rollback-app`                      |
| `EMUCAT_HEALTH_TIMEOUT_SECONDS`                 | How long a new release has to become healthy                                  |

**`app.env`**: the API container's environment. Start from
[`deploy/config/app.env.example`](../deploy/config/app.env.example):

```ini
DB_HOST=host.docker.internal
DB_PORT=3306
DB_NAME=emucat-db
DB_USER=emucat-usr
DB_PASSWORD=<32+ random characters>
PUBLIC_ORIGIN=https://emucat-test.dfri.info
COOKIE_SECURE=true
SETUP_TOKEN=
LOG_LEVEL=info
```

`NODE_ENV`, `API_HOST`, `API_PORT`, `STORAGE_PATH`, `TRUST_PROXY`, `EMUCAT_ENVIRONMENT` and the
deployment-service settings are fixed by `compose.yaml` and override anything in `app.env`.

Variables the API gained in this milestone (all optional outside Docker):

| Variable                                   | Meaning                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `EMUCAT_ENVIRONMENT`                       | Environment label (default `development`)                                          |
| `EMUCAT_BUILD_COMMIT`, `EMUCAT_BUILD_TIME` | Baked into the image at build time                                                 |
| `DEPLOYER_SOCKET`, `DEPLOYER_TOKEN_FILE`   | The deployment service. Both or neither; without them updates are "not configured" |

## 6. Docker images

Built on the server by `emucatctl update`, from a `git archive` of the exact commit (never a working
tree), and by hand with:

```bash
docker build -f deploy/docker/api.Dockerfile --target runtime \
  --build-arg EMUCAT_COMMIT=$(git rev-parse HEAD) --build-arg EMUCAT_BUILD_TIME=$(date -u +%FT%TZ) \
  -t emucat-api:dev .
docker build -f deploy/docker/web.Dockerfile --target runtime -t emucat-web:dev .
```

- **API** ([`api.Dockerfile`](../deploy/docker/api.Dockerfile)): `deps` (pnpm, frozen lockfile) → `build`
  → `verify` (type checks and database-free tests) → `prod` (`pnpm deploy --prod`, production
  dependencies only) → `runtime` on `node:22-bookworm-slim`, as UID/GID 10001, with a health check on
  `/api/v1/ready` and `EMUCAT_BUILD_COMMIT` and OCI revision labels.
- **Web** ([`web.Dockerfile`](../deploy/docker/web.Dockerfile)): Vite build → `verify` → `runtime` on
  `nginxinc/nginx-unprivileged` (UID 101, port 8080). Hashed `/assets/` are cached for a year; the app
  shell is `no-cache`, so a new release reaches browsers on their next load.

`emucatctl` builds the `verify` target first when `EMUCAT_VERIFY=true`, so a release whose checks fail is
never started.

## 7. Docker Compose

[`deploy/compose.yaml`](../deploy/compose.yaml) is the same file on every host; everything that differs is
an environment variable that `emucatctl` passes. It is copied into each release, so a rollback runs the
Compose file it was tested with.

- Services `api` and `web` only. **No MariaDB.**
- Networks: `edge` (the published port), `internal` (`internal: true`, web ↔ api only) and `database` (api
  → host).
- Both containers: read-only root file system, `cap_drop: ALL`, `no-new-privileges`, an init process,
  `tmpfs` for `/tmp`, memory and PID limits. Not privileged.
- The API mounts exactly: the media directory (read-write), the socket directory (read-only) and the
  deployment token (a Compose secret). **No Docker socket, no host root.**
- The web container publishes `EMUCAT_BIND_ADDRESS:EMUCAT_HTTP_PORT` and waits for a healthy API.

Do not run `docker compose` by hand against it; use `emucatctl`, which sets the variables and the release.

## 8. First installation

As root, from a checkout of the branch being installed (cloned with the deploy key, anywhere, for example
`/root/emucat`):

```bash
install -d -m 0755 /etc/emucat
install -m 0640 -g emucat-deploy deploy/config/deploy.env.example /etc/emucat/deploy.env
install -m 0640 -g emucat-deploy deploy/config/app.env.example /etc/emucat/app.env
editor /etc/emucat/deploy.env /etc/emucat/app.env      # fill in the values; DB_PASSWORD from section 4
install -m 0600 -o emucat-deploy deploy_key /etc/emucat/deploy_key
install -d -o emucat-deploy -m 0750 /opt/emucat/state
ssh-keyscan github.com > /opt/emucat/state/known_hosts  # then verify the fingerprints against GitHub's
chown emucat-deploy /opt/emucat/state/known_hosts

deploy/bin/emucatctl install       # directories, tooling, token, mirror, systemd unit
/opt/emucat/tooling/bin/emucatctl check
/opt/emucat/tooling/bin/emucatctl update
```

`install` is repeatable. It creates the directories (the media directory owned by 10001 if it does not
exist, and warns, without changing it, if it exists with another owner), generates the deployment token
once, copies `emucatctl` and the deployment service to `/opt/emucat/tooling` owned by root, clones the
bare mirror of the configured branch, and installs and starts `emucat-deployer.service`.

The first `update` builds, backs up the (empty) database, applies all migrations and starts the
containers. Then create the first administrator at the public address: the setup token is `SETUP_TOKEN`
or, when empty, printed by `emucatctl logs api`.

Moving existing media: copy it into `EMUCAT_MEDIA_DIR` and `chown -R 10001:10001` it, while the
application is stopped.

## 9. The deployment service

`emucat-deployer.service` runs `/opt/emucat/tooling/deployer/src/main.ts` as `emucat-deploy`, group
`emucat-socket`. It:

- listens on `/run/emucat-deployer/deployer.sock` only (mode 0660, no TCP port) and requires
  `Authorization: Bearer <deployer.token>` on every request;
- answers `GET /v1/status`, `POST /v1/check`, `POST /v1/updates {expectedCommit, requestedBy}`,
  `GET /v1/operations/:id` and `GET /v1/operations/:id/log`, and nothing else. There is no way to pass a
  command, a branch, a repository or a script;
- starts `emucatctl update --expect <commit>` as a detached process with a fixed environment, so a restart
  of the service never kills an update (`KillMode=process`);
- derives each operation's state from the files `emucatctl` writes under `state/operations/`, so the
  state survives restarts of the API, the service and the browser. An update whose process vanished
  without finishing is reported as **interrupted**, never as successful.

Reinstall it after changing `emucatctl` or the service by running `emucatctl install` again from a newer
checkout. Updates of the application do not change the tooling: the tooling is root-owned so that the
deployment account cannot change what it runs.

## 10. Updating from the command line

```bash
sudo /opt/emucat/tooling/bin/emucatctl check-update      # fetch and compare, changes nothing
sudo /opt/emucat/tooling/bin/emucatctl update            # asks for confirmation
sudo /opt/emucat/tooling/bin/emucatctl status
```

All commands run as `emucat-deploy` (they drop privileges). An update goes through these stages, each
recorded:

1. **checking_repository**: take the deployment lock (`flock`); a second update is refused with exit code 75.
2. **fetching_source**: fetch the configured branch into the mirror; with `--expect`, refuse if the
   branch moved to another commit since it was checked.
3. **building**: `git archive` the commit, build both images tagged with it.
4. **testing**: the images' `verify` stage.
5. **backing_up_database**: a verified dump (section 12). No backup, no update.
6. **applying_migrations**: the new image's migration runner, before the new containers start.
7. **starting_services**: `docker compose up` with the new release.
8. **health_checking**: readiness through the ingress, the app shell, the API, the agent WebSocket
   handshake, and the image revision labels of the running containers must equal the target commit.
9. **completed**: the release is recorded in `state/current-release.json`. Old images beyond
   `EMUCAT_KEEP_RELEASES` are removed only now.

The full log is in `state/operations/<id>.log`.

## 11. Updating from Settings

Administrators see **Application updates** in Settings (other users never see it, and the API refuses
them). It shows the environment, branch, deployed commit and time, the newest commit of the branch,
whether an update is available, the last success and failure, and whether the deployment service is
reachable.

- **Check for updates** fetches the branch (no deployment).
- **Install update** asks for confirmation, then asks the deployment service to deploy exactly the commit
  that was shown. If the branch moved in the meantime, it is refused: check again.
- Progress is shown by stage. While the API restarts the page says so and keeps polling, and after a
  browser refresh it finds the operation again. The result is only shown as succeeded once the
  deployment service has verified the running commit and its health.
- **View update log** shows the update's log with secrets removed (database password, tokens, URL
  credentials, private keys).

There is nothing to type: no command, branch, repository or script can be given from the browser.

## 12. Backups and recovery

Before every update `emucatctl` dumps `emucat-db` with `mariadb-dump --single-transaction --routines
--triggers --events`, using the application account through a temporary option file (the password never
appears in a process list). The dump is written to `.partial`, checked with `gzip -t` and for the
"Dump completed" trailer, and only then renamed to
`/var/backups/emucat/emucat-db-<time>-<label>.sql.gz`. A failed backup stops the update.

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup            # a manual dump, same checks
```

Retention: `EMUCAT_BACKUP_RETENTION_COUNT=0` (default) keeps everything. A positive value keeps the newest
N dumps written by `emucatctl`; nothing else in the directory is ever deleted.

Restoring a dump is deliberately manual, with the application stopped:

```bash
docker stop emucat-web-1 emucat-api-1
gunzip -c /var/backups/emucat/<dump>.sql.gz | mariadb -u emucat-usr -p emucat-db
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <the commit that matches the dump>
```

Media is not in the dumps: back up `EMUCAT_MEDIA_DIR` with the host's usual file backups.

## 13. Rolling back, and its limits

- **Automatic:** if an update fails after the containers were replaced, and **no migration was applied**,
  `emucatctl` starts the previous release again and verifies it. The result says `restored_previous`, or `failed`
  if the previous release did not come back healthy.
- **No automatic rollback across migrations.** Migrations are forward-only (see
  [decision 0005](decisions/0005-migrations.md)). If one was applied, the result is `unsafe`: the new
  schema stays, and the operator decides between fixing forward and restoring the dump taken by that
  update.
- **Manual:** `emucatctl rollback-app [--to <commit>]` runs a release whose images are still present. It
  refuses (exit code 3) if the database has migrations the target release does not know.

## 14. The external reverse proxy

TLS is terminated by a proxy outside this repository. [`deploy/nginx/emucat.example.conf`](../deploy/nginx/emucat.example.conf)
is an nginx example for MARS. The proxy must:

- send everything (`/` and `/api/`) to `EMUCAT_BIND_ADDRESS:EMUCAT_HTTP_PORT`;
- pass the browser's `Host` and set `X-Forwarded-Proto https`;
- **overwrite** `X-Forwarded-For` with the client address (`$remote_addr`), not append to it;
- allow request bodies of at least 80 MB (screenshot uploads);
- pass WebSocket upgrades (next section).

The web container believes `X-Forwarded-For` only from `EMUCAT_TRUSTED_PROXIES`. A proxy on the same host
connecting to `127.0.0.1` arrives from the edge network's gateway, `172.31.253.1` by default. The API in
turn trusts only the web container's network. Forwarded headers from anyone else are ignored.

`PUBLIC_ORIGIN` must be the exact public address (`https://emucat-test.dfri.info`): state-changing
requests whose `Origin` differs are refused.

## 15. WebSocket

Agents keep one WebSocket open on `/api/v1/agent/ws` for hours, with a heartbeat every 30 s. Both proxies
must forward `Upgrade` and `Connection` and use read and send timeouts above a minute (one hour in the
examples). The web container already does; the external proxy must too. Agents connecting to a remote
server must use `https://` (the agent enforces it), so they connect with `wss://`.

`emucatctl` checks after each update that the handshake reaches the API (it answers 401 without a
credential).

## 16. MARS

Test server, branch `develop`, `https://emucat-test.dfri.info`, updates from Settings enabled.
[`deploy.env.example`](../deploy/config/deploy.env.example) is the MARS configuration; set
`EMUCAT_GIT_URL` to the real repository, and in `app.env` set `PUBLIC_ORIGIN=https://emucat-test.dfri.info`.

## 17. MOON

Production, branch `main`. Start from
[`moon.deploy.env.example`](../deploy/config/moon.deploy.env.example): `EMUCAT_ENVIRONMENT=production`,
`EMUCAT_BRANCH=main`, `EMUCAT_ADMIN_UPDATES_ENABLED=false`, and set `EMUCAT_PUBLIC_URL` and `PUBLIC_ORIGIN`
to the chosen public address. Everything else is identical to MARS. Use a separate deploy key.

## 18. Disabling updates in production

`EMUCAT_ADMIN_UPDATES_ENABLED` must be exactly `true` for the Install button to work; any other value,
including a missing one, disables it. Settings then shows that updates are disabled on this host, and
the deployment service refuses a start request with `403 updates_disabled` whatever the browser sends.
Status and "Check for updates" still work. Updates remain possible from the command line.

To enable them on MOON, change the value and restart the service:

```bash
sudo systemctl restart emucat-deployer
```

Nothing ever updates by itself: there is no timer, schedule, webhook or reaction to a push, on either
host.

## 19. Security boundaries

| Component          | Can                                                                 | Cannot                                                      |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Browser (admin)    | Ask for status, a check, an update to the commit it was shown, logs | Choose a branch, ref, repository, command or script         |
| API container      | Talk to the socket with the token; read/write media; reach MariaDB  | Use Docker, a host shell, host files, Git credentials, sudo |
| Web container      | Serve files, proxy to the API                                       | Reach MariaDB or the socket                                 |
| Deployment service | Run `emucatctl update/check-update` for the configured branch       | Accept arbitrary commands; listen on the network            |
| `emucat-deploy`    | Docker (root-equivalent), its state, backups, the mirror            | Change the root-owned tooling or the configuration files    |

- The privilege to deploy lives only in the deployment service and `emucatctl`, which is why that
  account must be guarded like root. The application containers run unprivileged, as non-root users, with
  read-only file systems and no capabilities.
- The token is compared in constant time; the socket is reachable only by `emucat-socket` members.
- Values from the browser are validated twice (API and service) and never reach a shell: processes are
  started with argument arrays, and commit IDs must be 40 lowercase hex digits.
- Logs shown in Settings are sanitized; `/etc/emucat/*` is never readable by the application.
- Authentication, sessions, roles and agent pairing are unchanged. There is no OAuth or external
  identity provider.

## 20. Troubleshooting

| Symptom                                    | Look at                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Settings: "deployment service unavailable" | `systemctl status emucat-deployer`, `journalctl -u emucat-deployer`; socket and token permissions; the API's GID (`EMUCAT_SOCKET_GID`) |
| Settings: "not configured"                 | The API runs without `DEPLOYER_SOCKET` (not under `deploy/compose.yaml`)                                                               |
| `update` exits 75                          | Another update holds the lock; `emucatctl status`                                                                                      |
| "target_changed"                           | The branch moved after the check; check again                                                                                          |
| Build or test stage fails                  | `state/operations/<id>.log`; the running release is untouched                                                                          |
| Backup fails                               | MariaDB reachable from the host as `emucat-usr`? Disk space in `EMUCAT_BACKUP_DIR`                                                     |
| API unhealthy after start                  | `emucatctl logs api`: database address, firewall, `bind-address`, migrations                                                           |
| `cross_origin_rejected` at sign-in         | `PUBLIC_ORIGIN` must equal the browser's address; the proxy must pass `Host`                                                           |
| Client addresses are the proxy's           | `EMUCAT_TRUSTED_PROXIES` must contain the address the proxy connects from                                                              |
| Agents disconnect every minute             | Proxy WebSocket timeouts (section 15)                                                                                                  |
| Media permission errors                    | `EMUCAT_MEDIA_DIR` must be owned by 10001:10001                                                                                        |
| An update shows "interrupted"              | The update process died (reboot, OOM). Check `status`; run `update` again                                                              |
| `rollback-app` exits 3                     | The database is newer than that release; restore a dump or fix forward                                                                 |

`sudo /opt/emucat/tooling/bin/emucatctl check` verifies the configuration, tools, Docker, MariaDB, the
mirror and the socket without changing anything.

## Testing this tooling

| Command             | What it runs                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`         | Includes the deployment service's unit tests and the API's update routes                                                                                                   |
| `pnpm test:deploy`  | `emucatctl` and the real deployment service against disposable hosts, in a Linux container with fake `docker`, `curl` and MariaDB clients                                  |
| `pnpm test:compose` | Builds both images, runs `deploy/compose.yaml` against a disposable MariaDB outside Compose, and checks routing, caching, health, container security and media persistence |

Both Docker-based tests create only resources named `emucat-smoke-*` or `emucat-deploy-test`, and remove
them.
