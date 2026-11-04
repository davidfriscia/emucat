//! EmuCat agent library. The executable in `main.rs` is a thin layer over these modules.
//!
//! Module boundaries, with what exists in Milestone 0:
//!
//! - [`config`]: configuration file, environment overrides and startup validation.
//! - [`protocol`]: versioned message envelope shared with the API.
//! - [`connectivity`]: outbound connection targets. No connection is made yet.
//! - [`emulators`]: emulator types, VM names and identity, VM root markers.
//! - [`filesystem`]: safe path construction. Nothing here writes to disk.
//! - [`archives`]: version and snapshot domain rules, archive exclusions, repository interface.
//! - [`media`]: which files are media, and their visibility. No watcher or upload yet.
//! - [`state`]: local state, operation types and execution states.
//!
//! The agent has no inbound listener, does not launch emulators, and does not change VM
//! directories.

pub mod archives;
pub mod cli;
pub mod config;
pub mod connectivity;
pub mod emulators;
pub mod filesystem;
pub mod logging;
pub mod media;
pub mod platform;
pub mod protocol;
pub mod shutdown;
pub mod state;
