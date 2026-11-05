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
//! - [`registration`]: the durable workflow that turns a discovered VM into a verified archive.
//! - [`removal`]: removes a local VM after a confirmed transfer, and fails closed.
//! - [`media`]: which files are media, and their visibility. No watcher or upload yet.
//! - [`state`]: local state, operation types and execution states.
//!
//! The agent has no inbound listener and does not launch emulators. It changes a VM directory in one
//! case only: a transfer an administrator confirmed, after the server has committed a verified master.

pub mod archives;
pub mod cli;
pub mod config;
pub mod connectivity;
pub mod credentials;
pub mod discovery;
pub mod emulators;
pub mod filesystem;
pub mod logging;
pub mod media;
pub mod packaging;
pub mod pairing;
pub mod platform;
pub mod protocol;
pub mod registration;
pub mod removal;
pub mod repository;
pub mod sftp;
pub mod shutdown;
pub mod state;
