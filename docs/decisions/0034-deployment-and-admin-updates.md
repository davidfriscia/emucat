# 0034: Images built on the server, updated on demand by a separate service

**Status:** Accepted. Deployment foundation (infrastructure, between Milestones 6 and 7).

## Context

EmuCat is to run on two Linux servers, MARS (test, `develop`) and MOON (production, `main`), each with its
own MariaDB already installed. Administrators want to install an update from Settings. Installing means
building images, migrating the database and replacing containers: work that needs Docker, which is
equivalent to root on the host. The API is exposed to the internet and must not hold that privilege.

## Decision

- **Images are built on the server** from a `git archive` of one commit of the one configured branch,
  and tagged by commit. No registry, no CI pipeline, no runner, no webhook, no timer. A push to GitHub
  changes nothing until someone asks for an update.
- **MariaDB stays outside Docker.** The API reaches the host's server through `host.docker.internal`; the
  bootstrap creates one database and one account limited to it. Migrations remain the existing
  forward-only runner, run by the new image before its containers start.
- **The privilege lives in a separate deployment service,** a dependency-free Node.js process run by
  systemd as a dedicated account. It listens on a Unix socket only, mounted read-only into the API
  container with a bearer token, and offers fixed operations: status, check, start an update to an
  expected commit, read an operation and its sanitized log. The API never gets the Docker socket, a host
  shell, host files or Git credentials.
- **One tool does the work,** `emucatctl`, for people and for the service alike, so the browser path and
  the command line cannot diverge. The tooling is installed root-owned, so the deployment account cannot
  change what it runs.
- **State is files, derived on every read.** `emucatctl` appends events to a file per operation; the
  service derives the status from those events and whether the process is still alive. An update
  survives restarts of the API, the service and the browser, and one whose process vanished is reported
  as interrupted. Success requires the recorded release, the running images' revision labels and the
  health checks to agree on the target commit.
- **The browser can only confirm what it was shown.** An update request carries the commit the
  administrator saw; if the branch moved, it is refused. There is no input for a branch, ref, URL or
  command.
- **Production is disabled by default.** Only `EMUCAT_ADMIN_UPDATES_ENABLED=true` in the host's own
  configuration enables the button, and the service enforces it.
- **Rollback is automatic only when it is safe:** when no migration was applied by the failed update.
  Otherwise the outcome is `unsafe` and the operator decides, with the verified dump that every update
  takes first.

## Consequences

- An update takes minutes (a full build on the server) and briefly interrupts the application while the
  containers are replaced.
- The deployment account is root-equivalent through Docker and must be guarded accordingly.
- There is no zero-downtime deployment and no automatic rollback across migrations.
- The deployment service needs Node.js 22.18 or later on the host.
- The tooling itself is updated only by running `emucatctl install` again from a newer checkout.
