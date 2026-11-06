# Running the agent

The agent runs on a computer that holds virtual machines. It connects out to your EmuCat server, and never
listens on any port. It reports the VMs it finds when asked, and registers one when an administrator asks. It does not
launch emulators. It changes a VM directory in one case only: a transfer an administrator confirmed, after a verified master
is committed.

## Commands

| Command                                   | What it does                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `run`                                     | Connects, and stays connected until stopped. The default           |
| `pair`, `unpair`                          | Pairs with a server, or removes the local credential               |
| `discover`                                | Scans the configured directories, read-only, and prints the report |
| `media-status`                            | Prints what the screenshot queue holds, without connecting         |
| `repository-check --repository UUID`      | Tests a configured repository directly                             |
| `repository-passphrase --repository UUID` | Stores the passphrase of a repository's key, protected with DPAPI  |
| `check-config`, `info`                    | Validates the configuration, or prints versions and default paths  |

## Configuration

Copy [`agent/agent.example.toml`](../agent/agent.example.toml) to the path `emucat-agent info` shows, or pass
`--config`. Command-line options override the environment, and the environment overrides the file.

| Setting                     | Environment variable                          | Meaning                                        |
| --------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `[server] api_url`          | `EMUCAT_AGENT_API_URL`                        | The server. `https`, or `http` for this PC     |
| `[agent] name`              | `EMUCAT_AGENT_NAME`                           | The name to pair under. Default: computer name |
| `[emulators.86box]`         | `EMUCAT_AGENT_86BOX_BASE_PATH`, `_EXECUTABLE` | Base VM directory and executable               |
| `[emulators.qemu]`          | `EMUCAT_AGENT_QEMU_BASE_PATH`, `_EXECUTABLE`  | Base VM directory and executable               |
| `[state] dir`               | `EMUCAT_AGENT_STATE_DIR`                      | The agent's own data, including its credential |
| `[logging] level`, `format` | `EMUCAT_AGENT_LOG_LEVEL`, `_FORMAT`           | Filter, and `text` or `json`                   |

The base directory is the folder that _holds_ the VM folders. It is often not where the emulator is installed, and
the agent never guesses it from the executable's location.

```powershell
.\emucat-agent.exe check-config
```

## Pairing

On the agent's computer:

```powershell
.\emucat-agent.exe pair
```

It prints a code such as `ABCD-2345`, and waits. In the web app, signed in as an administrator:

1. Open **Agents**, enter the code, and choose **Review**.
2. Check that the name, platform and address are those of the computer you expect.
3. Choose **Approve**.

The agent collects its credential and exits. The code lasts 10 minutes. Then start the agent:

```powershell
.\emucat-agent.exe run
```

It stays connected until stopped, and reconnects by itself. Running it as a Windows service or at login is up to
you for now: the agent does not install itself.

## Credential storage

The credential is encrypted with **Windows DPAPI, scoped to the user running the agent**, and written to
`credential.dpapi` in the state directory. It is never in the configuration file, on the command line, or in a
log. Whatever the log level, the transport libraries that could print request headers stay at `info`.

The credential is tied to the server that issued it. Changing `api_url` does not send it somewhere new: the agent
refuses to start until you pair with the new server.

| What happened                                      | What you see          | What to do                                |
| -------------------------------------------------- | --------------------- | ----------------------------------------- |
| The agent runs under another Windows account       | "cannot be decrypted" | Revoke the old agent, then `pair --force` |
| The state directory was copied to another computer | "cannot be decrypted" | Revoke the old agent, then `pair --force` |
| The Windows profile was reset or damaged           | "cannot be decrypted" | Revoke the old agent, then `pair --force` |
| The state directory was deleted                    | "not paired"          | Revoke the old agent, then `pair`         |
| `api_url` changed                                  | "belongs to …"        | `pair --force`, or put the URL back       |

A credential that cannot be read is reported and left in place, and the agent never pairs again by itself. The
server cannot recover a credential, because it only has a digest. Pairing again always makes a new agent identity,
which you approve like the first.

Windows is the only platform with a store so far. Elsewhere, `pair` and `run` refuse to work rather than falling
back to a plaintext file. macOS Keychain and Linux Secret Service are meant to implement the `CredentialStore`
trait in [`agent/src/credentials.rs`](../agent/src/credentials.rs).

## Revoking

On the agent's page in the web app, choose **Revoke** and confirm. The agent is disconnected immediately, and it
stops with a message saying so. Its credential no longer works. Nothing on its computer changes, and catalog
history is kept.

To use that computer again, run `pair --force` and approve it as a new agent. `unpair` removes the local
credential by itself. It tells the server nothing, so revoke the agent too.

## Discovery

On the agent's page, choose **Discover virtual machines**. To try it without a server:

```powershell
.\emucat-agent.exe discover
```

**A discovered VM is an observation, not a catalog entry.** Nothing is stored, nothing is registered, and nothing
reaches the public catalog until you [register it](#registering-vms). Results last until the next scan of that agent
or the next API restart.

### What counts as a VM

Only **immediate child directories** of a base path are candidates, and the VM's name is exactly the directory's
name.

| Emulator | A candidate's root must contain, as a regular file                                               |
| -------- | ------------------------------------------------------------------------------------------------ |
| 86Box    | `86box.cfg`. An `nvr/` directory is not required                                                 |
| QEMU     | At least one of `run.bat`, `run.cmd`, `run-win.bat`, `run-win.cmd`, `run-mac.sh`, `run-linux.sh` |

Marker names are matched **exactly**, as the [domain rules](domain-model.md#virtual-machine-identity) say, even on
Windows. `RUN.BAT` is not a marker, and is reported as `marker_wrong_case` so that it is easy to spot. Other scripts,
such as `run.sh`, are not markers either. See [decision 0011](decisions/0011-qemu-launcher-markers.md).

### Host compatibility

Each QEMU VM reports all its launchers, and whether one suits the agent's own platform: `run.bat`, `run.cmd`, `run-win.bat` or
`run-win.cmd` on Windows, `run-mac.sh` on macOS, and `run-linux.sh` on Linux. Scripts are only looked at, never executed. 86Box VMs have no
such notion, so the value is `null`.

### Skipped directories

| Reason               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `invalid_name`       | Breaks the [VM name rules](domain-model.md#vm-names). `nameError` says which |
| `missing_marker`     | No marker in its root                                                        |
| `marker_wrong_case`  | A marker is there, with different capitalization                             |
| `reparse_point`      | A symlink, junction or other reparse point, which is never followed          |
| `not_accessible`     | The operating system refused access                                          |
| `vanished`           | It disappeared during the scan                                               |
| `duplicate_identity` | Same name as another VM apart from case. Only on case-sensitive filesystems  |
| `too_many_entries`   | More than 4096 entries in its root                                           |

A name that is not valid is reported, and left alone: it is never normalized or renamed. Loose files in a base path
are not candidates and are not mentioned.

### Security boundaries and limits

- **Read-only.** A scan lists directories and reads metadata. It opens no file, executes nothing, creates nothing,
  and changes nothing. It hashes nothing, and does not parse `86box.cfg`.
- **Inside the base path.** No recursion. Children that are reparse points are never entered, and a linked marker
  does not count. The configured base path itself may be a link, because you chose it. OneDrive placeholders are
  reparse points too, so a VM kept that way is skipped.
- **No paths leave the agent.** Reports hold names only, and a server cannot choose what is scanned.
- **Bounded.** 4096 entries per base path, 4096 per VM root, 256 VMs and 64 skipped entries per report, and a time
  budget of 20 seconds. Reaching a limit marks the report `truncated`, and the web app says it is incomplete.
- **Changing disks are normal.** Something that vanishes mid-scan is reported, not a failure. A missing base
  directory is reported as `base_path_missing`, and is not created. An agent also refuses to _start_ with a
  missing base directory, as `check-config` does.

## Registering VMs

First [set up a repository](repositories.md). Then, on the agent's page, run discovery and choose **Copy to remote** or **Transfer to
remote**. **Stop the VM first.** The agent builds the archive in `storage.staging_dir`, uploads it directly to the repository, reads it
back and hashes it, and publishes it so that it can never be overwritten. The server then records one private master. Nothing
passes through the server, and a registration carries on while the server is away.

|              | Copy               | Transfer                                                     |
| ------------ | ------------------ | ------------------------------------------------------------ |
| The local VM | Stays, unchanged   | Removed, once the master is committed and every check passed |
| Screenshots  | Stay, not archived | Removed only once the server holds every one of them         |
| Confirmation | One click          | An explicit checkbox                                         |

**What a transfer checks before deleting anything:** that the server committed this exact version, that the archive still reads back
correctly from the repository, that the directory is the same one that was archived, that every file still has the same hash, that no
file exists that is not in the archive, that the server holds every screenshot, and that nothing is in use. If any of that fails, the VM stays, the
master stays, and the operation is a **partial success** that says what to do. See
[decision 0015](decisions/0015-registration-state-machine.md#transfer).

**What is in an archive:** everything in the VM's directory, with no wrapper directory, including firmware, scripts, nested files and
empty directories, plus `.emucat-manifest.json` as the last entry. Not in it: `screenshots/` for 86Box and root-level `.ppm` files for
QEMU. A symlink, junction or other reparse point inside a VM fails the archive, rather than being skipped. See
[decision 0014](decisions/0014-archive-and-manifest.md), which also explains the limits of archiving something that might be running.

**If something is interrupted,** nothing is lost. Staging uses a separate key, so a partial upload can never be taken for an archive.
Restart whichever side stopped. An unfinished registration fails with `agent_restarted`, and you can start again. A published one
continues, and is committed once the server is back. Nothing is deleted by a restart alone. Local journals are in `registrations` in the
state directory, and hold no secrets and no VM contents.

## Screenshots

While it runs, the agent keeps the screenshots of the VMs it registered on the server, whether or not they are running. It needs nothing
but the `[media]` section's defaults. `emucat-agent media-status` shows what its queue holds. See [the media guide](media.md).

## Troubleshooting

| Symptom                                            | Likely cause and fix                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "refusing to send secrets … over unencrypted http" | The server is not on this computer. Use `https`                                                      |
| "this agent is not paired"                         | Run `pair`                                                                                           |
| "already paired"                                   | Deliberately protected. `pair --force` replaces the credential once a new one is issued              |
| "the pairing request expired"                      | Nobody approved in 10 minutes. Run `pair` again                                                      |
| "already completed, but the credential did not…"   | The response was lost. Revoke the unused agent and `pair` again                                      |
| "That pairing code is not valid"                   | Mistyped, or from another server. Check the code the agent printed                                   |
| "Too many attempts" (429)                          | Wrong codes are limited. Wait for the time in `Retry-After`. A restart of the API also clears counts |
| "does not accept this agent's credential"          | Revoked, or the server's database was reset. `pair --force`                                          |
| "another connection … took over"                   | Two copies are running with one credential. Stop one                                                 |
| "different protocol version"                       | Update the agent or the server so that they match                                                    |
| The agent logs "Connection lost; reconnecting"     | The server is down or restarting. It keeps trying, every 60 seconds at most                          |
| Always offline in the web app                      | Is `run` running? Does `api_url` match? Behind a proxy, `/api/v1/agent/ws` must allow WebSockets     |
| A VM is not listed                                 | See **Skipped directories**. It must be a direct child of the base path, with an exact marker        |
| A scan reports `base_path_missing`                 | The configured directory is not there, such as an unplugged drive                                    |
| `result_too_large` or `malformed_result`           | Should not happen with a matching agent. Check that the versions match, and report it                |

`--log-level debug` shows more. Secrets stay out of the logs at every level.

### Registration

| What you see                      | What it means                                                                              | What to do                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `source_in_use`, `cleanup_in_use` | Another program has a file open for writing, probably the emulator                         | Stop the VM, and try again                                                                        |
| `source_changed`                  | A file changed while it was being read                                                     | Stop whatever is writing, and try again                                                           |
| `source_unsafe`                   | The VM holds a symlink, junction or OneDrive placeholder                                   | Replace it with real files, or make the files available offline                                   |
| `source_invalid`                  | No marker, or a name an archive cannot hold, such as `.emucat-manifest.json`               | Fix what the message says, and run discovery again                                                |
| `transfer_blocked_media`          | The server does not hold every screenshot, or one cannot be uploaded. The message names it | See the VM's Media page, then choose **Retry removal**. See the [media guide](media.md#transfers) |
| `insufficient_staging_space`      | The staging disk may be too small. This assumes no compression at all                      | Free up space, or set `storage.staging_dir`                                                       |
| `discovery_stale`                 | The report is too old, or the agent reconnected since                                      | Run discovery again                                                                               |
| `agent_cannot_register`           | The agent is older than the server                                                         | Update the agent                                                                                  |
| Stuck in **Recording the master** | The server could not commit. The archive is safe, and the agent keeps repeating its report | Check the database. **Retry recording it** also works with the agent away                         |
| **Registered, with a problem**    | The master is safe, but the local files were kept                                          | Follow the guidance shown. If you do not need the files, delete them yourself                     |
| A `.emucat-removing-…` directory  | A removal stopped partway. Discovery reports it as skipped                                 | Its archive is verified in the repository, so it can be deleted by hand                           |

Problems reaching the repository are in the [repository guide](repositories.md#troubleshooting). The agent's log says more, and
`--log-level debug` adds detail. It never contains a private key, a passphrase or a credential.
