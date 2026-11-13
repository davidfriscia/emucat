//! EmuCat agent library. The executable in `main.rs` is a thin layer over these modules.
//!
//! Module boundaries:
//!
//! - [`config`]: configuration file, environment overrides and startup validation.
//! - [`credentials`]: where the agent's credential is kept. DPAPI on Windows.
//! - [`pairing`]: device-style pairing with a server.
//! - [`protocol`]: versioned message envelope shared with the API.
//! - [`connectivity`]: the outbound WebSocket, heartbeats and reconnection.
//! - [`discovery`]: read-only scanning of the configured base paths.
//! - [`emulators`]: emulator types, VM names and identity, VM root markers.
//! - [`filesystem`]: safe path construction. Nothing here writes to disk.
//! - [`archives`]: version and snapshot domain rules, archive exclusions.
//! - [`repository`]: the provider-independent archive store interface, and safe object keys.
//! - [`sftp`]: the archive store over SSH and SFTP, with mandatory host-key verification.
//! - [`packaging`]: builds a standalone ZIP and its manifest, without changing the source.
//! - [`zip_directory`]: reads a ZIP's central directory as written, which is what duplicates hide in.
//! - [`extraction`]: takes an archive apart safely, and puts the result in place without replacing.
//! - [`archive_cache`]: a local cache of verified master ZIPs.
//! - [`restore`]: the durable workflow that turns a master into a verified local VM.
//! - [`registration`]: the durable workflow that turns a discovered VM into a verified archive.
//! - [`removal`]: removes a local VM after a confirmed transfer, and fails closed.
//! - [`media`]: which files are media, finding them safely, and reading them completely.
//! - [`media_queue`]: the durable record of what has to reach the server.
//! - [`media_sync`]: the watcher, reconciliation and upload to the API over HTTP(S).
//! - [`state`]: local state, operation types and execution states.
//! - [`launcher`]: turns a VM into a checked emulator command line, without a shell.
//! - [`process`]: starts emulator processes, and knows them again by PID and creation time.
//! - [`execution`]: durable VM sessions: launch, watch, stop, and recovery after a restart.
//! - [`verification`]: compares a local VM with the manifest of its master, read-only.
//! - [`workspaces`]: Remote Snapshot working copies, outside every base path.
//!
//! The agent has no inbound listener. It starts an emulator only for a session an administrator asked for,
//! from a command line it built itself, and stops only a process whose identity it verified. It removes a
//! VM directory in one case only: a transfer an administrator confirmed, after the server has committed a
//! verified master. It creates one in one case only: a restore an administrator asked for, and never over
//! an existing one. Neither happens to a VM that is running.

pub mod archive_cache;
pub mod archive_deletion;
pub mod archives;
pub mod capture;
pub mod cli;
pub mod config;
pub mod connectivity;
pub mod credentials;
pub mod discovery;
pub mod emulators;
pub mod execution;
pub mod extraction;
pub mod filesystem;
pub mod launcher;
pub mod logging;
pub mod media;
pub mod media_queue;
pub mod media_sync;
pub mod packaging;
pub mod pairing;
pub mod platform;
pub mod process;
pub mod protocol;
pub mod qmp;
pub mod registration;
pub mod removal;
pub mod repository;
pub mod restore;
pub mod sftp;
pub mod shutdown;
pub mod state;
pub mod verification;
pub mod workspaces;
pub mod zip_directory;
