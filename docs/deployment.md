# Deploying EmuCat on a Linux server

This guide prepares a Linux server to run EmuCat in Docker, with the server's existing MariaDB, and to
update it on demand from a fixed Git branch. Two servers use the same mechanism:

| Host     | Role       | Branch    | Address                         | Updates from Settings  |
| -------- | ---------- | --------- | ------------------------------- | ---------------------- |
| **MARS** | test       | `develop` | `https://emucat-test.dfri.info` | enabled                |
| **MOON** | production | `main`    | configurable (`PUBLIC_ORIGIN`)  | disabled until enabled |

Everything EmuCat keeps on a server lives under **`/opt/emucat`**, with the same layout on every host.
Nothing in the configuration depends on a host's name: the MARS and MOON values are examples, all of them
configurable.

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
  │  api  (Fastify, UID 1000)  ── database network ──▶ host.docker.internal│
  └────┬───────────────────────────────┬──────────────────────────────────┘
       │ bind: media directory         │ bind (read-only): /run/emucat-deployer
       ▼                               ▼  deployer.sock, HTTP + bearer token
  /opt/emucat/data/media         emucat-deployer.service (systemd, emucat-deploy)
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

Host layout after installation. `emucatctl init` and `install` create all of it with these owners and
modes, and every `install` puts those of the directories and of `config/` back:

```
/opt/emucat/                 root:root                    0755
├── tooling/                 root:root                    0755  bin/emucatctl, systemd/ (the unit template) and
│                                                               deployer/: the deployment service, compiled to JavaScript
├── repo.git/                emucat-deploy:emucat-deploy  0750  bare mirror of the one configured branch
├── releases/                emucat-deploy:emucat-deploy  0750  each release's compose.yaml and migration list
├── config/                  root:emucat-deploy           0750
│   ├── deploy.env           root:emucat-deploy           0640  how this host deploys (branch, address, port)
│   ├── app.env              root:emucat-deploy           0640  the API's environment, including DB_PASSWORD
│   ├── deployer.token       root:emucat-socket           0640  shared secret of the API and the deployment service
│   ├── deploy_key           emucat-deploy:emucat-deploy  0600  read-only GitHub deploy key (and deploy_key.pub)
│   └── known_hosts          root:emucat-deploy           0640  the verified host key of github.com
├── state/                   emucat-deploy:emucat-deploy  0750  current release, operations and logs, lock
│   ├── operations/                                       0750  one .events and one .log file per update
│   ├── builds/                                           0750  temporary source exports during an update
│   └── home/                                             0700  the deployment account's home (Docker, Git)
├── data/                    root:root                    0755
│   └── media/               david:david (1000:1000)      0750  screenshots and other media (persistent)
└── backups/                 emucat-deploy:emucat-deploy  0750  database dumps, 0640 each
```

Only two things are outside `/opt/emucat`, both deliberately:

| Path                                          | Owner                              | Why there                                     |
| --------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| `/etc/systemd/system/emucat-deployer.service` | `root` 0644                        | systemd only loads units from its search path |
| `/run/emucat-deployer/`                       | `emucat-deploy:emucat-socket` 0750 | The socket (0660); transient, made by systemd |

The unit is a real file written by `install` (not a link), and what it runs is in
`/opt/emucat/tooling`. There are no EmuCat files in `/etc/emucat`, `/srv` or `/var/backups`, and nothing
needs to exist outside `/opt/emucat` before installing.

## 2. Host prerequisites

- A 64-bit Linux distribution with systemd (Debian 12 or Ubuntu 24.04 are the reference).
- **Docker Engine 24 or later** with the Compose v2 plugin (`docker compose version`) and BuildKit
  (`docker buildx version`, package `docker-buildx-plugin`).
- **Node.js 22** on the host, for the deployment service. Any build of it will do, the distribution's own
  `nodejs` package included: `install` compiles the service to plain JavaScript in a container, so the host
  needs no TypeScript support, no global npm packages and no `node_modules`. The containers bring their
  own Node.js.
- `git`, `flock` and `runuser` (util-linux), `curl`, `gzip`, and the MariaDB client tools `mariadb` and
  `mariadb-dump` (package `mariadb-client`).
- MariaDB 11.4 or later already running on the host (see below).
- An external reverse proxy terminating TLS, on the host or on another machine.
- About 4 GB of free disk for images and build cache, plus the media and backups.

Accounts, created once by root:

```bash
groupadd --system emucat-socket
useradd --system --user-group --no-create-home --home-dir /opt/emucat/state/home \
  --groups docker,emucat-socket --shell /usr/sbin/nologin emucat-deploy
```

`emucat-deploy` is in the `docker` group, **which is equivalent to root on this host**. No person logs in
as it. Its home is inside the layout and is created by `emucatctl init`, so `useradd` creates no directory.
`emucat-socket` exists only so that the API container (by GID) and the deployment service share the
socket.

**The application account** is an existing unprivileged host account, `david:david` (UID/GID 1000:1000)
on the homelab servers, set by `EMUCAT_APP_USER` and `EMUCAT_APP_GROUP`. The API container runs with its
IDs and it owns `data/media`; there is no separate EmuCat application account. It needs no group
membership and must **not** be added to `emucat-socket` or made `emucat-deploy`: the container joins the
socket group by GID on its own (`group_add`), so on the host only the deployment account and that one
container can use the socket and read the token. `emucatctl check` verifies this.

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

Once per server, as a MariaDB administrator (already done on MARS and MOON; skip this there):

```bash
openssl rand -base64 33          # the new DB_PASSWORD; it goes into /opt/emucat/config/app.env
sed "s/CHANGE_ME/<password>/" deploy/sql/bootstrap.sql | sudo mariadb
```

[`deploy/sql/bootstrap.sql`](../deploy/sql/bootstrap.sql) creates database `emucat-db` and account
`'emucat-usr'@'%'` with all privileges **on that database only** (no `*.*`, no `GRANT OPTION`, no `FILE`,
no `SUPER`). It uses `IF NOT EXISTS` and drops nothing, so running it again is harmless. It creates no
tables: the schema comes from the migrations, applied by `emucatctl update` as a controlled step.

The application never uses the root account, and nothing in this tooling resets, drops or recreates the
database.

## 5. Configuration files and environment variables

Two files in `/opt/emucat/config`, never committed. `emucatctl init` creates both from the examples
when they are missing and never overwrites them. Both are literal `KEY=VALUE` lines: no quotes, no
variables. They are parsed as data, never sourced by a shell.

**`deploy.env`**: how the host deploys. Starts from
[`deploy/config/deploy.env.example`](../deploy/config/deploy.env.example) (test server, MARS values) or,
with `init --template`, [`moon.deploy.env.example`](../deploy/config/moon.deploy.env.example) (production).

There are **no path settings** besides `EMUCAT_ROOT`: every file and directory derives from it, with the
layout in section 1. `deploy.env` must be `EMUCAT_ROOT/config/deploy.env`; for a root other than
`/opt/emucat`, set `EMUCAT_DEPLOY_CONFIG=<root>/config/deploy.env` when running `emucatctl`. The settings of
the earlier layout (`EMUCAT_APP_ENV_FILE`, `EMUCAT_DEPLOYER_TOKEN_FILE`, `EMUCAT_MEDIA_DIR`,
`EMUCAT_BACKUP_DIR`) are refused, so a stale file cannot point anywhere else.

| Variable                                        | Meaning                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `EMUCAT_ENVIRONMENT`                            | Label shown in Settings: `test`, `production`                                  |
| `EMUCAT_BRANCH`                                 | The only branch this host deploys                                              |
| `EMUCAT_GIT_URL`                                | Repository URL, read-only (SSH with a deploy key recommended). Never a token   |
| `EMUCAT_GIT_SSH_KEY`                            | `/opt/emucat/config/deploy_key` (created by `init`), or empty for public HTTPS |
| `EMUCAT_PUBLIC_URL`                             | Informational                                                                  |
| `EMUCAT_ADMIN_UPDATES_ENABLED`                  | Exactly `true` enables the Install button; anything else disables it           |
| `EMUCAT_ROOT`                                   | `/opt/emucat`; everything persistent is under it                               |
| `EMUCAT_BACKUP_RETENTION_COUNT`                 | `0` keeps every dump; `N` keeps the newest N                                   |
| `EMUCAT_DEPLOY_USER`, `EMUCAT_SOCKET_GROUP`     | The accounts from section 2                                                    |
| `EMUCAT_APP_USER`, `EMUCAT_APP_GROUP`           | Account the API runs as and that owns the media; `david`, `david` by default   |
| `EMUCAT_SOCKET_DIR`                             | `/run/emucat-deployer`; must match the unit's `RuntimeDirectory`               |
| `EMUCAT_BIND_ADDRESS`, `EMUCAT_HTTP_PORT`       | Where the web container listens for the proxy (MARS: `10.0.0.2`, `8095`)       |
| `EMUCAT_TRUSTED_PROXIES`                        | Addresses whose `X-Forwarded-For` is believed, as the web container sees them  |
| `EMUCAT_*_SUBNET`                               | The three Docker networks; change only on a collision                          |
| `EMUCAT_DB_HOST_GATEWAY`, `EMUCAT_HOST_DB_HOST` | How containers and the host reach MariaDB                                      |
| `EMUCAT_VERIFY`                                 | Run type checks and database-free tests while building                         |
| `EMUCAT_KEEP_RELEASES`                          | Images of this many releases are kept for `rollback-app`                       |
| `EMUCAT_HEALTH_TIMEOUT_SECONDS`                 | How long a new release has to become healthy                                   |

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
  dependencies only) → `runtime` on `node:22-bookworm-slim`, as UID/GID 1000 (Compose sets the IDs
  of `EMUCAT_APP_USER`), with application files owned by root and a health check on
  `/api/v1/ready` and `EMUCAT_BUILD_COMMIT` and OCI revision labels.
- **Web** ([`web.Dockerfile`](../deploy/docker/web.Dockerfile)): Vite build → `verify` → `runtime` on
  `nginxinc/nginx-unprivileged` (UID 101, port 8080). Hashed `/assets/` are cached for a year; the app
  shell is `no-cache`, so a new release reaches browsers on their next load.

`emucatctl` builds the `verify` target first when `EMUCAT_VERIFY=true`, so a release whose checks fail is
never started.

File modes in the images do not depend on the build context. `emucatctl` extracts each release as
`emucat-deploy` under umask 027, so its files arrive as 0640 and its directories as 0750, and `COPY`
keeps those modes. Both Dockerfiles therefore set them: everything under `/app` (migrations included) and
the site and nginx configuration are root-owned, readable and traversable by all, and writable by root
only. `pnpm test:compose` builds from a context exported the same way.

## 7. Docker Compose

[`deploy/compose.yaml`](../deploy/compose.yaml) is the same file on every host; everything that differs is
an environment variable that `emucatctl` passes. It is copied into each release, so a rollback runs the
Compose file it was tested with.

- Services `api` and `web` only. **No MariaDB.**
- Networks: `edge` (the published port), `internal` (`internal: true`, web ↔ api only) and `database` (api
  → host).
- Both containers: read-only root file system, `cap_drop: ALL`, `no-new-privileges`, an init process,
  `tmpfs` for `/tmp`, memory and PID limits. Not privileged.
- The API mounts exactly: `/opt/emucat/data/media` (read-write), the socket directory (read-only) and
  `/opt/emucat/config/deployer.token` (a Compose secret). **No Docker socket, no host root, nothing else
  from `config/`.** These paths have no defaults in `compose.yaml`: `emucatctl` always passes them.
- The web container publishes `EMUCAT_BIND_ADDRESS:EMUCAT_HTTP_PORT` and waits for a healthy API.

Do not run `docker compose` by hand against it; use `emucatctl`, which sets the variables and the release.

## 8. First installation

Prerequisites: sections 2 to 4 (packages, the two accounts, MariaDB with the `emucat-db` database and
`emucat-usr` account). Nothing else needs to exist, in `/opt/emucat` or anywhere else.

`init` and `install` run as root **from a copy of the repository** (they install the tooling from it).
Any temporary copy of the branch being installed works; delete it afterwards. From a workstation that can
read the repository:

```bash
git archive --format=tar --prefix=emucat-src/ origin/develop | ssh <server> 'rm -rf ~/emucat-src && tar -x -C ~'
```

Then, on the server:

```bash
cd ~/emucat-src
sudo deploy/bin/emucatctl init        # layout, deploy.env, app.env, token, deploy key; lists what is left
```

`init` creates the whole layout of section 1, writes `config/deploy.env` from
`deploy/config/deploy.env.example` (or `--template <file>`), `config/app.env` from `app.env.example`,
generates `config/deployer.token`, and, when `ssh-keygen` is available and `EMUCAT_GIT_SSH_KEY` is
missing, a new ed25519 deploy key whose public half it prints. It never overwrites an existing file, so it
is safe to run again; it ends with the list of what still has to be filled in:

```bash
sudoedit /opt/emucat/config/deploy.env     # EMUCAT_GIT_URL; review branch, address, port, proxies
sudoedit /opt/emucat/config/app.env        # DB_PASSWORD (section 4); check DB_NAME, DB_USER, PUBLIC_ORIGIN
# GitHub > repository > Settings > Deploy keys: add the printed public key, write access OFF.
ssh-keyscan -t ed25519 github.com | sudo tee /opt/emucat/config/known_hosts >/dev/null
sudo ssh-keygen -lf /opt/emucat/config/known_hosts
#   must print SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU; compare with GitHub's published
#   fingerprints (docs.github.com, "GitHub's SSH key fingerprints") before going on.

sudo deploy/bin/emucatctl install     # tooling, mirror, systemd unit; refuses while anything is missing
sudo /opt/emucat/tooling/bin/emucatctl check
sudo /opt/emucat/tooling/bin/emucatctl update
rm -rf ~/emucat-src
```

To use an existing deploy key instead, put it at `/opt/emucat/config/deploy_key` before `init` (or
before `install`); its owner and mode are set for you.

`install` is repeatable. It checks the configuration and prerequisites, re-creates any missing
directory and puts owners and modes back. It never changes existing media: a `data/media` not owned by
the application account is handed over only while it is empty, otherwise it just warns. It builds the
deployment service from `deploy/docker/deployer.Dockerfile` (TypeScript compiled to JavaScript with the
lockfile's toolchain, then loaded once with Node's TypeScript support switched off), and only then
replaces `/opt/emucat/tooling` with `emucatctl`, that build and the unit template, owned by root. A failed
build leaves the installed tooling and the running service as they were. It clones the bare mirror of the
configured branch into `repo.git`, writes `/etc/systemd/system/emucat-deployer.service` from the
template, restarts the service (clearing an earlier failed state) and waits up to 30 seconds for it to
answer an authenticated request on its socket; if it does not, `install` fails and points at the journal.

The first `update` builds, backs up the (empty) database, applies all migrations and starts the
containers. Then create the first administrator at the public address: the setup token is `SETUP_TOKEN`
or, when empty, printed by `emucatctl logs api`.

Moving existing media: copy it into `/opt/emucat/data/media` and `chown -R david:david` it (the `EMUCAT_APP_USER:EMUCAT_APP_GROUP` account), while the
application is stopped.

## 9. The deployment service

`emucat-deployer.service` runs `node /opt/emucat/tooling/deployer/main.js` (the compiled service: plain
ES modules with no dependencies besides Node.js) as `emucat-deploy`, group
`emucat-socket` (plus the account's own group, which can read `config/`), with
`HOME=/opt/emucat/state/home`. systemd makes the whole file system read-only to it except `state/`,
`releases/`, `repo.git/` and `backups/`; `config/` and `tooling/` are read-only even to its account. It:

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

**Sandbox.** The unit keeps systemd's hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`
(writable only where `ReadWritePaths` says), `ProtectHome`, `ProtectKernelTunables`,
`ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`,
`RestrictAddressFamilies` and `SystemCallArchitectures=native`. They do not limit what the service can do
through Docker, which is root-equivalent anyway (section 19). They keep the service process itself from
writing outside its directories, changing kernel settings, or creating set-user-ID and set-group-ID files
that could outlive it. `RestrictSUIDSGID=yes` is a seccomp filter that also makes **every** `openat2()`
fail with `ENOSYS`, because a filter cannot read the mode inside `openat2()`'s arguments. GNU tar builds
hardened against CVE-2025-45582 open directories with `openat2()`, and those that do not fall back to
`openat()` then fail with `Cannot open: Function not implemented`. That stopped the deployment of
`198adf9` on MARS. So `emucatctl` exports each release with Git (`read-tree` and `checkout-index` into
`state/builds/<commit>`, with a throwaway index), not with `git archive | tar -x`. It writes the same
files with the same modes (0640 and 0750 under its umask 027). Keep `RestrictSUIDSGID=yes`. Programs that
`emucatctl` runs on the host under this unit must not depend on `openat2()`. What `docker build` runs is
not affected: it runs in the Docker daemon, outside this unit.

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
`/opt/emucat/backups/emucat-db-<time>-<label>.sql.gz` (mode 0640). A failed backup stops the update.

```bash
sudo /opt/emucat/tooling/bin/emucatctl backup            # a manual dump, same checks
```

Retention: `EMUCAT_BACKUP_RETENTION_COUNT=0` (default) keeps everything. A positive value keeps the newest
N dumps written by `emucatctl`; nothing else in the directory is ever deleted.

Restoring a dump is deliberately manual, with the application stopped:

```bash
docker stop emucat-web-1 emucat-api-1
sudo gunzip -c /opt/emucat/backups/<dump>.sql.gz | mariadb -u emucat-usr -p emucat-db
sudo /opt/emucat/tooling/bin/emucatctl rollback-app --to <the commit that matches the dump>
```

Media is not in the dumps. Back up `/opt/emucat/data/media` and `/opt/emucat/backups` (and, separately and
securely, `/opt/emucat/config`) with the host's usual file backups.

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
arrives from the edge network's gateway, `172.31.253.1` by default (Docker's userland proxy); a proxy on
another machine usually arrives with its own address, which must then be added. The API in turn trusts
only the web container's network. Forwarded headers from anyone else are ignored.

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

Test server, branch `develop`, `https://emucat-test.dfri.info`, updates from Settings enabled. The
default [`deploy.env.example`](../deploy/config/deploy.env.example) has the MARS values: the web container
listens on `10.0.0.2:8095` for the reverse proxy, and `app.env.example` has
`PUBLIC_ORIGIN=https://emucat-test.dfri.info`. Only `EMUCAT_GIT_URL` and `DB_PASSWORD` must be filled in.

Before installing, on MARS: `10.0.0.2` is an address of the host, port 8095 on it is reachable from the
reverse proxy only, and MariaDB accepts `emucat-usr` from `127.0.0.1` and the database network (section 3).

```bash
# On the workstation (after the tooling is on origin/develop):
git fetch origin
git archive --format=tar --prefix=emucat-src/ origin/develop | ssh mars 'rm -rf ~/emucat-src && tar -x -C ~'

# On MARS:
sudo groupadd --system emucat-socket
sudo useradd --system --user-group --no-create-home --home-dir /opt/emucat/state/home \
  --groups docker,emucat-socket --shell /usr/sbin/nologin emucat-deploy
cd ~/emucat-src
sudo deploy/bin/emucatctl init
sudo sed -i 's#^EMUCAT_GIT_URL=.*#EMUCAT_GIT_URL=git@github.com:davidfriscia/emucat.git#' /opt/emucat/config/deploy.env
sudoedit /opt/emucat/config/app.env      # DB_PASSWORD of emucat-usr
# Add the public key printed by init as a read-only deploy key of the GitHub repository.
ssh-keyscan -t ed25519 github.com | sudo tee /opt/emucat/config/known_hosts >/dev/null
sudo ssh-keygen -lf /opt/emucat/config/known_hosts   # verify the fingerprint (section 8)
sudo deploy/bin/emucatctl install
sudo /opt/emucat/tooling/bin/emucatctl check
sudo /opt/emucat/tooling/bin/emucatctl update
cd ~ && rm -rf ~/emucat-src
```

**If `init` stopped halfway** (as the first MARS attempt did, at `install: invalid user: '10001'`, before
the application account was configurable): copy a newer `origin/develop` the same way and run
`sudo deploy/bin/emucatctl init` again. It keeps the existing `deploy.env` (one without
`EMUCAT_APP_USER`/`EMUCAT_APP_GROUP` means `david:david`), and any deploy key, `app.env` or token already
there; it creates only what is missing, and gives an empty `data/media` to `david:david`. Then continue
with the steps after `init`.

**If the deployment service keeps restarting** with `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file
extension ".ts" for /opt/emucat/tooling/deployer/src/main.ts` in `journalctl -u emucat-deployer`, and
`check` fails only at `deployment service socket` (the first MARS installation): that tooling ran the
TypeScript sources directly, which needs a Node.js with TypeScript support, and Ubuntu's `nodejs` package
is built without it. Copy a newer `origin/develop` the same way and run `sudo deploy/bin/emucatctl install`
again. It builds the compiled service, replaces the tooling, rewrites the unit, restarts the service and
waits for its socket. Configuration, deploy key, token, mirror, releases, backups, media and the database
are left as they are; `init` is not needed again.

**If the first `update` failed with** `Error: EACCES: permission denied, open
'/app/migrations/0001_initial_schema.sql'` (the first MARS update): the API image kept the 0640 modes of
the exported release, which UID 1000 cannot read. The migration runner reads every file before it
connects, so nothing reached the database, and no release was recorded. Once a `develop` with fixed
images is pushed, run `update` again (from Settings or `sudo /opt/emucat/tooling/bin/emucatctl update`):
it is again a first deployment on an empty database, builds new images and applies all migrations.
The failure message's "Restore before retrying" does not apply: there was no backup to restore and
nothing to undo. Nothing on the host needs a permission change.

**If an update failed at "fetching source" with** `Cannot export commit` and, in its log, `tar:
./subdir/...: Cannot open: Function not implemented` (the deployment of `198adf9` on MARS): the installed
`emucatctl` extracts with GNU tar, and this host's tar cannot do that under the unit's
`RestrictSUIDSGID=yes` (section 9). Nothing was built, backed up, migrated or restarted, and the previous
release is still running. The failed attempt left at most a partial copy in `state/builds/<commit>`. Only
an update of that same commit removes it, so once `develop` has moved on, remove it by hand while no
update runs: `sudo rm -rf -- /opt/emucat/state/builds/<commit>`. Updates from Settings run the
_installed_ tooling, so deploying a fixed `develop` does not fix this by itself. Copy a newer
`origin/develop` the same way as above and run `sudo deploy/bin/emucatctl install` again. It replaces
`emucatctl`, rewrites the unit (with `RestrictSUIDSGID=yes` still in it) and restarts the service. Then
run `update` again, from Settings or with `sudo /opt/emucat/tooling/bin/emucatctl update`. Configuration,
mirror, releases, backups, media and the database are left as they are.

## 17. MOON

Production, branch `main`, the same `/opt/emucat` layout and the same steps as MARS (copy from
`origin/main`), except that `init` starts from the production example:

```bash
sudo deploy/bin/emucatctl init --template deploy/config/moon.deploy.env.example
```

[`moon.deploy.env.example`](../deploy/config/moon.deploy.env.example) has
`EMUCAT_ENVIRONMENT=production`, `EMUCAT_BRANCH=main`, `EMUCAT_ADMIN_UPDATES_ENABLED=false`, and a loopback
binding until the production proxy is known. Set `EMUCAT_PUBLIC_URL`, `PUBLIC_ORIGIN`,
`EMUCAT_BIND_ADDRESS` and `EMUCAT_HTTP_PORT` to the production values. `init` generates a separate deploy
key on each host.

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
- Logs shown in Settings are sanitized; `/opt/emucat/config` is never mounted into or readable by the
  application, except the one token file, passed as a Compose secret.
- Authentication, sessions, roles and agent pairing are unchanged. There is no OAuth or external
  identity provider.

## 20. Troubleshooting

| Symptom                                              | Look at                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Settings: "deployment service unavailable"           | `systemctl status emucat-deployer`, `journalctl -u emucat-deployer`; socket and token permissions; the API's GID (`EMUCAT_SOCKET_GID`) |
| Settings: "not configured"                           | The API runs without `DEPLOYER_SOCKET` (not under `deploy/compose.yaml`)                                                               |
| `update` exits 75                                    | Another update holds the lock; `emucatctl status`                                                                                      |
| "target_changed"                                     | The branch moved after the check; check again                                                                                          |
| Build or test stage fails                            | `state/operations/<id>.log`; the running release is untouched                                                                          |
| Backup fails                                         | MariaDB reachable from the host as `emucat-usr`? Disk space in `/opt/emucat/backups`                                                   |
| API unhealthy after start                            | `emucatctl logs api`: database address, firewall, `bind-address`, migrations                                                           |
| `cross_origin_rejected` at sign-in                   | `PUBLIC_ORIGIN` must equal the browser's address; the proxy must pass `Host`                                                           |
| Client addresses are the proxy's                     | `EMUCAT_TRUSTED_PROXIES` must contain the address the proxy connects from                                                              |
| Agents disconnect every minute                       | Proxy WebSocket timeouts (section 15)                                                                                                  |
| Service restarts, `ERR_UNKNOWN_FILE_EXTENSION` `.ts` | Tooling from before the compiled service; run `install` again from a current checkout (section 16)                                     |
| Update: `Cannot open: Function not implemented`      | Tooling from before the Git export (section 9); run `install` again from a current checkout (section 16)                               |
| `install`: "did not answer on its socket"            | `journalctl -u emucat-deployer -n 50`; `check`; is `node` on root's `PATH` the one in the unit's `ExecStart`?                          |
| Media permission errors                              | `/opt/emucat/data/media` must be owned by `EMUCAT_APP_USER:EMUCAT_APP_GROUP` (david:david, 1000:1000)                                  |
| An update shows "interrupted"                        | The update process died (reboot, OOM). Check `status`; run `update` again                                                              |
| `rollback-app` exits 3                               | The database is newer than that release; restore a dump or fix forward                                                                 |

`sudo /opt/emucat/tooling/bin/emucatctl check` verifies the configuration, tools, Docker, MariaDB, the
mirror, the installed service program and that the service answers an authenticated request on its
socket, without changing anything.

## Testing this tooling

| Command             | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`         | Includes the deployment service's unit tests and the API's update routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test:deploy`  | `emucatctl` and the real deployment service against disposable hosts, in a Linux container with fake `docker`, `curl` and MariaDB clients; then, as root in a fresh container, `init`, `install`, `check`, `update`, `backup` and `rollback-app` into the real `/opt/emucat`, checking every owner and mode. That installation builds the service with the real `deployer.Dockerfile`, and a stand-in `systemctl` starts it from the installed unit with the unit's identity and Node's TypeScript support off; the test checks its socket, an authenticated request, a failed build and the repair of a pre-compiled installation. `sandbox.test.ts` checks the unit's hardening, runs updates with a `tar` that fails as on MARS and with an export that fails halfway, and runs the export and a whole update under `restrict-suid-sgid` (built into the test image from `deploy/test/restrict-suid-sgid.c`), which installs the seccomp rules of `RestrictSUIDSGID=yes`. Run as root on a host booted with systemd, it also runs the export and GNU tar under `systemd-run` with the unit's hardening; anywhere else, that test is skipped |
| `pnpm test:compose` | Builds both images from a context exported as `emucatctl` exports it (umask 027), runs migrations as UID/GID 1000:1000, runs `deploy/compose.yaml` against a disposable MariaDB outside Compose, and checks routing, caching, health, container security and media persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Both Docker-based tests create only resources named `emucat-smoke-*` or `emucat-deploy-test`, and remove
them.
