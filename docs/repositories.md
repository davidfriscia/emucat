# Setting up an SSH repository

A repository is where VM archives are stored. Agents reach it directly over SSH and SFTP, so archives never pass through the
EmuCat server. Nothing here assumes a particular NAS. Replace `nas.example.lan`, `/srv/emucat` and the paths with your own.
The reasoning is in decisions [0012](decisions/0012-direct-agent-repository.md) and [0013](decisions/0013-ssh-provider.md).

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

## What ends up on the server

```
repo/
  archives/
    .staging/                         incomplete uploads, removed afterwards
    qemu/win98/{version_id}.zip       one verified, immutable archive per version
    86box/dos 6.22/{version_id}.zip
```

The directory is the lowercase VM name. The file name is the version's UUID, so nothing ever collides. Nothing overwrites or
modifies an archive once it is there. Never edit them by hand: the database holds their hashes.

## LAN use and security

SSH protects the transfer itself, so a LAN is fine. The EmuCat connection is separate, and its rules are in the
[agent guide](agent.md). The repository's account should have no other purpose. If an agent's computer is lost, remove the key
from `authorized_keys`, and [revoke the agent](agent.md#revoking).

A future HTTPS provider is planned for repositories without SSH. It would use the same keys, versions and verification.

## Troubleshooting

| What you see                   | What it means                                                  | What to do                                                              |
| ------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `repository_not_configured`    | The agent has no section with this UUID                        | Add it, and restart the agent                                           |
| `repository_config_mismatch`   | The agent's host, port, user or root differ from the web app's | Make them the same in both                                              |
| `host_key_unknown`             | The key is not in the agent's trusted set                      | Check the fingerprint on the server, then add it                        |
| `host_key_changed`             | The server has a different key than the one trusted            | **Find out why first.** After a reinstall, update the fingerprint       |
| `ssh_authentication_failed`    | The server refused the key                                     | Check `authorized_keys` and its permissions, and the server's log       |
| `repository_unreachable`       | No connection, or it timed out                                 | Check the host, the port, the firewall, and that `sshd` is running      |
| `repository_permission_denied` | The account cannot write there                                 | The remote root must be owned by the account, not the chroot's own root |
| `publication_unsupported`      | Hard links do not work there                                   | Use a filesystem that has them. FAT and some network mounts do not      |
| `insufficient_remote_space`    | The repository's disk or quota is full                         | Free up space. Registering again is safe                                |
| `insufficient_staging_space`   | The staging disk may be too small for this VM                  | Free up space, or point `storage.staging_dir` at a larger disk          |
| `hash_mismatch`                | What was stored differs from what was sent                     | Nothing was registered. Check the repository's disk                     |
| Cannot load the private key    | Wrong path, or a wrong or missing passphrase                   | Check `private_key_path`, and run `repository-passphrase` again         |

For problems with a VM's own files, and with Copy or Transfer, see the [agent guide](agent.md#registering-vms).
