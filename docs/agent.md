# Running the agent

The agent runs on a computer that holds virtual machines. It connects out to your EmuCat server, and never
listens on any port. This version reports the VMs it finds when asked. It does not launch emulators, transfer
anything, or change VM directories.

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
reaches the public catalog. Registration arrives in Milestone 3. Results last until the next scan of that agent
or the next API restart.

### What counts as a VM

Only **immediate child directories** of a base path are candidates, and the VM's name is exactly the directory's
name.

| Emulator | A candidate's root must contain, as a regular file          |
| -------- | ----------------------------------------------------------- |
| 86Box    | `86box.cfg`. An `nvr/` directory is not required            |
| QEMU     | At least one of `run-win.cmd`, `run-mac.sh`, `run-linux.sh` |

Marker names are matched **exactly**, as the [domain rules](domain-model.md#virtual-machine-identity) say, even on
Windows. `86BOX.CFG` is not a marker, and is reported as `marker_wrong_case` so that it is easy to spot. Other
scripts, such as `run.bat`, are not markers either.

### Host compatibility

Each QEMU VM reports whether it has a launch script for the agent's own platform: `run-win.cmd` on Windows,
`run-mac.sh` on macOS, and `run-linux.sh` on Linux. Scripts are only looked at, never executed. 86Box VMs have no
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
