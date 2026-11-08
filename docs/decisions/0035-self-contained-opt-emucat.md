# 0035: Everything a server keeps lives under /opt/emucat

**Status:** Accepted. Refines [0034](0034-deployment-and-admin-updates.md), before the first installation.

## Context

The first deployment layout spread EmuCat over `/etc/emucat` (configuration and secrets), `/srv/emucat`
(media), `/var/backups/emucat` (dumps), `/var/lib/emucat-deploy` (the account's home) and `/opt/emucat`
(tooling, mirror, releases, state). Custom applications in this homelab are kept self-contained under
`/opt/<name>`, so that one directory is what to back up, move or remove. Nothing was installed yet.

## Decision

- **One root, a fixed layout.** `EMUCAT_ROOT` (`/opt/emucat`) holds `tooling/`, `repo.git/`, `releases/`,
  `config/` (deploy.env, app.env, deployer.token, deploy_key, known_hosts), `state/` (including the
  account's home and build exports), `data/media/` and `backups/`. Every path derives from the root; the
  separate path settings are gone and are refused if a file still has them. `deploy.env` must be
  `EMUCAT_ROOT/config/deploy.env`.
- **Only two things stay outside,** because they must: the systemd unit, as a real file in
  `/etc/systemd/system` (its `ExecStart` points into `tooling/`), and the transient socket directory
  `/run/emucat-deployer`. No compatibility links.
- **`emucatctl init` bootstraps the layout** with its owners and modes, starting configuration files and a
  deploy key, and never overwrites a file; `install` re-applies the same owners and modes. Secrets keep
  their previous protection: `config/` is `root:emucat-deploy` 0750, the token `root:emucat-socket` 0640,
  the deploy key `emucat-deploy` 0600. The tooling stays root-owned.
- The deployment service additionally gets the account's own group (`SupplementaryGroups=`), since
  `Group=emucat-socket` would otherwise drop the group that can read `config/`.

## Consequences

- A fresh host needs only the packages, the two accounts and the database; nothing exists in `/etc`,
  `/srv` or `/var` for EmuCat.
- Compose has no default host paths, so a manual run without `emucatctl` fails instead of falling back.
- The security boundaries of 0034 are unchanged: the API mounts only media, the socket directory and the
  token; it never sees `config/`, the Docker socket or the tooling.
