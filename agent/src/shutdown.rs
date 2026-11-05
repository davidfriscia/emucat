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

/// Reads one line from standard input, without showing it when that is a Windows console.
pub fn read_secret_line() -> std::io::Result<String> {
    #[cfg(windows)]
    let restore = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Console::{
            ENABLE_ECHO_INPUT, GetConsoleMode, SetConsoleMode,
        };
        let handle = std::io::stdin().as_raw_handle().cast();
        let mut mode = 0;
        // SAFETY: the handle is this process's standard input, and the pointer is valid. On a pipe
        // this fails, and there is no echo to turn off.
        let is_console = unsafe { GetConsoleMode(handle, &mut mode) } != 0;
        if is_console {
            // SAFETY: as above.
            unsafe { SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) };
        }
        is_console.then_some((handle, mode))
    };
    let mut line = String::new();
    let read = std::io::stdin().read_line(&mut line);
    #[cfg(windows)]
    if let Some((handle, mode)) = restore {
        use windows_sys::Win32::System::Console::SetConsoleMode;
        // SAFETY: as above, restoring the mode that was read.
        unsafe { SetConsoleMode(handle, mode) };
    }
    read?;
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}
