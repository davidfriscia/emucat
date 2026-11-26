# Setting up an SSH repository

A repository is where VM archives are stored. Agents reach it directly over SSH and SFTP whenever they can. The EmuCat
server can have its own connection to it too, for clones, Archive Explorer and a relay for agents that cannot
reach it ([section 8](#8-the-servers-own-connection)). Nothing here assumes a particular NAS. Replace
`nas.example.lan`, `/srv/emucat` and the paths with your own. The reasoning is in decisions
[0012](decisions/0012-direct-agent-repository.md), [0013](decisions/0013-ssh-provider.md) and
[0055](decisions/0055-server-repository-access.md).

**What you need on the server:** OpenSSH with SFTP, and a filesystem with hard links. EmuCat needs no shell, and uses no
`sudo`. **What you need on the agent's computer:** the `emucat-agent` executable, and OpenSSH's `ssh-keygen`, which Windows
includes.

## 1. Create a restricted SSH user

A dedicated account limited to SFTP in one directory, so that its key can do nothing else. On a typical Linux server:

```bash
sudo useradd --create-home --shell /usr/sbin/nologin emucat
sudo mkdir -p /srv/emucat-chroot/repo
sudo chown root:root /srv/emucat-chroot
sudo chmod 755 /srv/emucat-chroot
sudo chown emucat:emucat /srv/emucat-chroot/repo
```

Then, at the end of `/etc/ssh/sshd_config`:

```
Match User emucat
  ChrootDirectory /srv/emucat-chroot
  ForceCommand internal-sftp
  PasswordAuthentication no
  AllowTcpForwarding no
  X11Forwarding no
  PermitTTY no
```

Restart `sshd`. Inside the chroot the account sees `/repo`, and that is your **remote root**. A chroot's own directory has to
be owned by root, which is why the repository is one level down.

## 2. Generate a key pair

On the agent's computer, in PowerShell. Use a key for this purpose only, not your personal one:

```powershell
ssh-keygen -t ed25519 -C "emucat-agent" -f "$env:USERPROFILE\.ssh\emucat_ed25519"
```

Without a passphrase, anyone who can read that file can write to the repository, so keep it in your own profile. With one, see
step 6. Ed25519 and RSA keys work.

## 3. Install the public key on the repository

Copy the contents of `emucat_ed25519.pub`, **not** the file without an extension, to the server:

```bash
sudo mkdir -p /home/emucat/.ssh
sudo sh -c 'cat >> /home/emucat/.ssh/authorized_keys' < emucat_ed25519.pub
sudo chown -R emucat:emucat /home/emucat/.ssh
sudo chmod 700 /home/emucat/.ssh
sudo chmod 600 /home/emucat/.ssh/authorized_keys
```

The private key stays on the agent's computer. It is never sent to the EmuCat server, and no page asks for it.

## 4. Find the server's host key

Host keys are always verified: an unknown or changed key fails, and is never trusted automatically. So you have to tell the
agent which one is right, and you should get it **from the server itself**, for example through its console:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

That prints something like `256 SHA256:AbCdEf… root@nas (ED25519)`, and the part you want is `SHA256:AbCdEf…`. Scanning from your
own computer with `ssh-keyscan` shows you what the network says, which is only worth comparing with the above.

A `known_hosts` file works as well, or instead, through `known_hosts_path`. A line for a non-standard port looks like
`[nas.example.lan]:2222 ssh-ed25519 AAAA…`.

## 5. Describe the repository to EmuCat

In the web app, go to **Repositories** and enter a name, the host, the port, the SSH user and the remote root. Only one SSH
repository can be active for now. Copy the **UUID** it shows. Then, under **Agents allowed to use it**, choose your agent.

## 6. Configure the agent

Add this to the agent's configuration file, with the UUID as the section name:

```toml
[repositories."018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61"]
kind = "sftp"
host = "nas.example.lan"
port = 22
username = "emucat"
remote_root = "/repo"
private_key_path = 'C:\Users\me\.ssh\emucat_ed25519'
host_key_fingerprints = ["SHA256:AbCdEf…"]

[storage]
# Needs room for the largest VM you will register, and must be outside every VM directory.
staging_dir = 'D:\EmuCat\staging'
```

If the key has a passphrase, store it once. It is read from standard input without being shown, and is protected with
DPAPI for your Windows account:

```powershell
.\emucat-agent.exe repository-passphrase --repository 018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61
```

Then check the file, and restart the agent so that it reads the change:

```powershell
.\emucat-agent.exe check-config
```

## 7. Test the connection

From the agent's computer, with no server involved:

```powershell
.\emucat-agent.exe repository-check --repository 018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61
```

Or choose **Test connection** on the Repositories page, which runs the same check on the agent and stores the result. It
proves the connection, the host key, your key, that the root can be read and written, and that a hard link refuses to overwrite.
It uses a uniquely named test object under `archives/.staging`, removes it again, and never touches an archive.

## 8. The server's own connection

Optional, and separate from the agents' keys ([decision 0055](decisions/0055-server-repository-access.md)). Without it,
everything works as before except clones (which the server makes), Archive Explorer and the relay. With it:

1. **A dedicated key for the server.** Generate it on the EmuCat host, never on an agent, and never reuse an agent's:

   ```bash
   sudo ssh-keygen -t ed25519 -N '' -C emucat-server@mars -f /opt/emucat/config/repository-ssh/id_ed25519
   sudo chown david:david /opt/emucat/config/repository-ssh/id_ed25519 /opt/emucat/config/repository-ssh/id_ed25519.pub
   sudo chmod 600 /opt/emucat/config/repository-ssh/id_ed25519
   ```

   Its owner must be the application account the API runs as (`EMUCAT_APP_USER`, `david` here), mode `0600`. The
   directory is created by `emucatctl install`. With a passphrase, give it to `ssh-keygen` instead of `-N ''`, and
   put it alone on one line in `/opt/emucat/config/repository-ssh/passphrase`, same owner, mode `0600`.

2. **Authorize it** in the same restricted account's `authorized_keys` as the agents' keys (section 3), one line of its
   own, so that it can be revoked on its own. The `restrict` options of section 3 apply to it too.

3. **Trust the repository's host key** in `/opt/emucat/config/repository-ssh/known_hosts`, after checking the
   fingerprint out of band (section 4). Use the address the server will connect to:

   ```bash
   ssh-keyscan -p 22 -t ed25519 nas.example.lan | sudo tee /opt/emucat/config/repository-ssh/known_hosts >/dev/null
   sudo chown david:david /opt/emucat/config/repository-ssh/known_hosts
   sudo chmod 644 /opt/emucat/config/repository-ssh/known_hosts
   sudo ssh-keygen -lf /opt/emucat/config/repository-ssh/known_hosts   # must be the fingerprint you checked
   ```

   For a port other than 22, the line starts with `[nas.example.lan]:2222`, as `ssh-keyscan -p 2222` writes it.

4. **Tell EmuCat if the server reaches the NAS at another address.** On the Repositories page, **Edit**, then
   _Server host_ and _Server port_. Empty means the same as the agents' host and port. The user and remote root are
   always the same.

5. **Test Server Connection** on the Repositories page. It checks, step by step, the key and `known_hosts`, name
   resolution, the TCP connection, the host key, authentication, the remote root, writing, reading back, publication
   that cannot overwrite, and that its test objects are gone. Each failed step says what to do.

**Host authentication and user authentication are different things.** The host key (`known_hosts`) proves to the
EmuCat server that it is talking to _your_ NAS and not something in between; the server refuses an unknown or
changed one, always, and there is no setting to accept one automatically. The user key (`id_ed25519` and the NAS's
`authorized_keys`) proves to the NAS that the connection comes from the EmuCat server. Both are needed.

### Agents that cannot reach the repository

An agent tries its own SFTP connection first. If the repository cannot be reached at all (no route, refused, timed
out), it sends or fetches the archive through the EmuCat server instead, which needs the server's own connection
above. An authentication failure, a host-key problem, a permission or integrity failure is never sent around through
the server: it is reported, and needs fixing. To choose per repository, set `transport` in the agent's section:

```toml
[repositories."018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f61"]
transport = "auto"     # the default: SFTP, the relay only when SFTP cannot reach the repository
# transport = "sftp"   # never the relay
# transport = "relay"  # never SFTP: leave out host, username, remote_root, private_key_path and host keys
```

The Repositories page shows, for each agent, whether its last check reached the repository directly or through the
relay.

## What ends up on the server

```
repo/
  archives/
    .staging/                         incomplete uploads, removed afterwards
    qemu/win98/{version_id}.zip       one verified, immutable archive per version
    86box/dos 6.22/{version_id}.zip
    virtualbox/xenix-386/{version_id}.ova   a VirtualBox master or snapshot: the OVA VirtualBox exported
```

The directory is the lowercase VM name. The file name is the version's UUID, so nothing ever collides. A VirtualBox
master or snapshot is the OVA itself, uploaded and verified by size and SHA-256 like any archive, with no manifest of EmuCat's. Importing one
into VirtualBox downloads it into the agent's staging directory, checks its size and SHA-256 again, and removes only that
download afterwards ([decision 0046](decisions/0046-virtualbox-management.md)). Deleting a
machine from VirtualBox never touches the repository. An OVA imported with `emucat-agent import-ova`
([decision 0049](decisions/0049-ova-repository-import.md)) is stored the same way, as the file's own bytes, through the same
staging, verification and publication without overwrite. A remaster ([decision 0048](decisions/0048-master-and-snapshot-lifecycle.md))
reuses the promoted snapshot's object as it is, and deletes the objects of the versions it removes one exact key at a
time, through an agent, after the new master is safe. Nothing overwrites or modifies an archive once it is there. Never edit them by hand: the database holds their hashes.

Restoring only reads these. The agent downloads over the same connection, with the same host-key checks and the same key, and needs no more access than registration does. A damaged object is noticed by its hash, and fails the restore without changing anything on the agent.

## LAN use and security

SSH protects the transfer itself, so a LAN is fine. The EmuCat connection is separate, and its rules are in the
[agent guide](agent.md). The repository's account should have no other purpose. If an agent's computer is lost, remove the key
from `authorized_keys`, and [revoke the agent](agent.md#revoking).

The server's key ([section 8](#8-the-servers-own-connection)) is a file on the EmuCat host only: never in the
database, the web app, an image, a log or Git. If the host is compromised, remove its line from `authorized_keys`;
the agents' keys are unaffected. Relayed archives are protected by HTTPS between agent and server, and by SSH between
server and repository, and are verified by SHA-256 at every step.

A future HTTPS provider is planned for repositories without SSH. It would use the same keys, versions and verification.

## Troubleshooting

| What you see                    | What it means                                                  | What to do                                                              |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `repository_not_configured`     | The agent has no section with this UUID                        | Add it, and restart the agent                                           |
| `repository_config_mismatch`    | The agent's host, port, user or root differ from the web app's | Make them the same in both                                              |
| `host_key_unknown`              | The key is not in the agent's trusted set                      | Check the fingerprint on the server, then add it                        |
| `host_key_changed`              | The server has a different key than the one trusted            | **Find out why first.** After a reinstall, update the fingerprint       |
| `ssh_authentication_failed`     | The server refused the key                                     | Check `authorized_keys` and its permissions, and the server's log       |
| `repository_unreachable`        | No connection, or it timed out                                 | Check the host, the port, the firewall, and that `sshd` is running      |
| `repository_permission_denied`  | The account cannot write there                                 | The remote root must be owned by the account, not the chroot's own root |
| `publication_unsupported`       | Hard links do not work there                                   | Use a filesystem that has them. FAT and some network mounts do not      |
| `insufficient_remote_space`     | The repository's disk or quota is full                         | Free up space. Registering again is safe                                |
| `insufficient_staging_space`    | The staging disk may be too small for this VM                  | Free up space, or point `storage.staging_dir` at a larger disk          |
| `hash_mismatch`                 | What was stored differs from what was sent                     | Nothing was registered. Check the repository's disk                     |
| Cannot load the private key     | Wrong path, or a wrong or missing passphrase                   | Check `private_key_path`, and run `repository-passphrase` again         |
| `server_repository_unavailable` | The EmuCat server has no key or `known_hosts` of its own       | Set up [section 8](#8-the-servers-own-connection), then test it         |
| `relay_disabled`                | The server does not relay (`TRANSFER_RELAY_ENABLED=false`)     | Let the agent reach the repository, or enable the relay                 |
| `transfer_staging_full`         | The server's staging disk or quota is full                     | Wait for other transfers, or raise `TRANSFER_MAX_STAGING_BYTES`         |
| `transfer_busy`                 | The server is relaying as many transfers as it allows          | Try again shortly; the agent retries by itself                          |

For problems with a VM's own files, and with Copy or Transfer, see the [agent guide](agent.md#registering-vms).

Screenshots never go through a repository. See [the media guide](media.md).
