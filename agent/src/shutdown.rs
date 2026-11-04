//! Waits for the operating system to ask the agent to stop.

use std::io;

/// Resolves with the signal's name when a stop is requested.
#[cfg(windows)]
pub async fn wait_for_signal() -> io::Result<&'static str> {
    use tokio::signal::windows;

    let mut ctrl_c = windows::ctrl_c()?;
    let mut ctrl_break = windows::ctrl_break()?;
    let mut ctrl_close = windows::ctrl_close()?;
    let mut ctrl_shutdown = windows::ctrl_shutdown()?;
    let mut ctrl_logoff = windows::ctrl_logoff()?;
    Ok(tokio::select! {
        _ = ctrl_c.recv() => "ctrl_c",
        _ = ctrl_break.recv() => "ctrl_break",
        _ = ctrl_close.recv() => "ctrl_close",
        _ = ctrl_shutdown.recv() => "ctrl_shutdown",
        _ = ctrl_logoff.recv() => "ctrl_logoff",
    })
}

/// Resolves with the signal's name when a stop is requested.
#[cfg(unix)]
pub async fn wait_for_signal() -> io::Result<&'static str> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(tokio::select! {
        _ = interrupt.recv() => "SIGINT",
        _ = terminate.recv() => "SIGTERM",
    })
}
