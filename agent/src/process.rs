//! Emulator processes: starting one without a shell, knowing it again, waiting for it, and ending it.
//!
//! A process is identified by its PID **and** its creation time. A PID alone names whatever process holds
//! it now, which after a restart may be anything, so nothing here acts on a PID without first checking that
//! the process it opens was created at the recorded instant from the recorded executable. While the agent
//! runs it also holds the process handle, which keeps the PID from being reused at all. See decision 0029.
//!
//! Only Windows is implemented. Elsewhere every operation reports [`ProcessError::Unsupported`].

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Who a process is: unique on one machine for as long as it runs, and never shared by a later process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    /// The creation time the operating system reports, in its own units (100 ns since 1601 on Windows).
    pub creation_time: u64,
    /// The image the process was started from, as the operating system reports it.
    pub image: PathBuf,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("launching emulators is only implemented on Windows")]
    Unsupported,
    #[error("cannot start the emulator: {0}")]
    Spawn(io::Error),
    #[error("cannot examine the process: {0}")]
    Query(io::Error),
}

/// What became of a recorded process when it was looked for again.
#[derive(Debug)]
pub enum Reattached {
    /// The very process that was started, still running.
    Running(ProcessHandle),
    /// Nothing with that identity exists any more. Its exit code cannot be known.
    Gone,
    /// The operating system would not say, for example because access was denied.
    Unknown(String),
}

/// How a process ended, if it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitOutcome {
    Running,
    Exited(i64),
}

/// What to start. The program is always a checked executable, and arguments are passed as a vector: no
/// shell ever parses them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub working_dir: PathBuf,
    /// Gives the process a QMP channel on its standard input and output, which only this agent holds.
    pub qmp_stdio: bool,
}

pub use crate::qmp::QmpChannel;
pub use platform::{ProcessHandle, close_windows, reattach, spawn};

/// Whether this build can launch emulators at all.
pub const fn supported() -> bool {
    cfg!(windows)
}

/// Waits a little at a time, so that a stopping agent is never held up by a running emulator.
pub const WAIT_SLICE: Duration = Duration::from_secs(2);

fn same_image(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let text = path.to_string_lossy().replace('/', "\\");
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned();
        text.to_lowercase()
    };
    normalize(left) == normalize(right)
}

#[cfg(windows)]
mod platform {
    use std::io;
    use std::os::windows::io::IntoRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, HWND, LPARAM, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, GetExitCodeProcess, GetProcessTimes,
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
        WM_CLOSE,
    };

    use super::{
        ProcessError, ProcessIdentity, QmpChannel, Reattached, SpawnRequest, WaitOutcome,
        same_image,
    };

    /// An open handle to a process. Holding it keeps the PID from being given to anything else.
    #[derive(Debug)]
    pub struct ProcessHandle {
        handle: HANDLE,
        identity: ProcessIdentity,
    }

    // A process handle can be used from any thread, and every call made on it here is thread safe.
    unsafe impl Send for ProcessHandle {}
    unsafe impl Sync for ProcessHandle {}

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    fn creation_time(handle: HANDLE) -> io::Result<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn image_path(handle: HANDLE) -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut length)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PathBuf::from(String::from_utf16_lossy(
            &buffer[..length as usize],
        )))
    }

    impl ProcessHandle {
        fn from_raw(handle: HANDLE, pid: u32) -> io::Result<Self> {
            let mut this = Self {
                handle,
                identity: ProcessIdentity {
                    pid,
                    creation_time: 0,
                    image: PathBuf::new(),
                },
            };
            this.identity.creation_time = creation_time(handle)?;
            this.identity.image = image_path(handle)?;
            Ok(this)
        }

        pub fn identity(&self) -> &ProcessIdentity {
            &self.identity
        }

        /// Waits at most `timeout` for the process to end.
        pub fn wait(&self, timeout: Duration) -> io::Result<WaitOutcome> {
            let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
            match unsafe { WaitForSingleObject(self.handle, millis) } {
                WAIT_OBJECT_0 => {
                    let mut code = 0u32;
                    if unsafe { GetExitCodeProcess(self.handle, &mut code) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(WaitOutcome::Exited(i64::from(code)))
                }
                WAIT_TIMEOUT => Ok(WaitOutcome::Running),
                _ => Err(io::Error::last_os_error()),
            }
        }

        /// Whether it is still running, without waiting.
        /// A process can exit with code 259, which is also what "still active" reads as, so only the
        /// handle's own state is conclusive.
        pub fn poll(&self) -> io::Result<WaitOutcome> {
            self.wait(Duration::ZERO)
        }

        /// Ends the process at once. Through this handle, so it can only ever be this process.
        pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
            if unsafe { TerminateProcess(self.handle, exit_code) } == 0 {
                let error = io::Error::last_os_error();
                // Access is denied to a process that has already exited.
                if matches!(self.poll(), Ok(WaitOutcome::Exited(_))) {
                    return Ok(());
                }
                return Err(error);
            }
            Ok(())
        }
    }

    /// Starts the program directly, with no shell, in its own process group and with no console window, so
    /// that a Ctrl+C meant for the agent never reaches a VM.
    pub fn spawn(
        request: &SpawnRequest,
    ) -> Result<(ProcessHandle, Option<QmpChannel>), ProcessError> {
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(&request.working_dir)
            .stderr(Stdio::null())
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        if request.qmp_stdio {
            command.stdin(Stdio::piped()).stdout(Stdio::piped());
        } else {
            command.stdin(Stdio::null()).stdout(Stdio::null());
        }
        let mut child = command.spawn().map_err(ProcessError::Spawn)?;
        let pid = child.id();
        let channel = match (child.stdin.take(), child.stdout.take()) {
            (Some(input), Some(output)) => Some(QmpChannel::start(input, output)),
            _ => None,
        };
        let raw = child.into_raw_handle();
        let handle = ProcessHandle::from_raw(raw, pid).map_err(ProcessError::Query)?;
        if let Some(channel) = &channel
            && let Err(message) = channel.negotiate()
        {
            tracing::warn!(pid, %message, "QEMU's monitor did not answer; graceful stop is unavailable");
            return Ok((handle, None));
        }
        Ok((handle, channel))
    }

    /// Opens the process recorded as `identity`, and only if it is the same one: same creation time, same
    /// executable. A different process holding a reused PID is reported as gone, and never touched.
    pub fn reattach(identity: &ProcessIdentity) -> Reattached {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
        let handle = unsafe { OpenProcess(access, 0, identity.pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Reattached::Gone
            } else {
                Reattached::Unknown(format!("Cannot open process {}: {error}", identity.pid))
            };
        }
        let opened = match ProcessHandle::from_raw(handle, identity.pid) {
            Ok(opened) => opened,
            Err(error) => {
                return Reattached::Unknown(format!(
                    "Cannot examine process {}: {error}",
                    identity.pid
                ));
            }
        };
        if opened.identity.creation_time != identity.creation_time
            || !same_image(&opened.identity.image, &identity.image)
        {
            return Reattached::Gone;
        }
        match opened.poll() {
            Ok(super::WaitOutcome::Running) => Reattached::Running(opened),
            Ok(super::WaitOutcome::Exited(_)) => Reattached::Gone,
            Err(error) => Reattached::Unknown(format!("Cannot examine the process: {error}")),
        }
    }

    struct Search {
        pid: u32,
        windows: Vec<HWND>,
    }

    unsafe extern "system" fn collect(window: HWND, parameter: LPARAM) -> i32 {
        let search = unsafe { &mut *(parameter as *mut Search) };
        let mut owner_pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, &mut owner_pid) };
        let top_level = unsafe { GetWindow(window, GW_OWNER) }.is_null();
        if owner_pid == search.pid && top_level && unsafe { IsWindowVisible(window) } != 0 {
            search.windows.push(window);
        }
        1
    }

    /// Asks the process's visible top-level windows to close, as clicking their close button would. Only
    /// windows of this exact process, through its verified handle. Returns how many were asked.
    pub fn close_windows(process: &ProcessHandle) -> usize {
        let mut search = Search {
            pid: process.identity.pid,
            windows: Vec::new(),
        };
        unsafe { EnumWindows(Some(collect), &mut search as *mut Search as LPARAM) };
        // The windows belong to the process the handle names only while it runs.
        if !matches!(process.poll(), Ok(WaitOutcome::Running)) {
            return 0;
        }
        search
            .windows
            .iter()
            .filter(|window| unsafe { PostMessageW(**window, WM_CLOSE, 0, 0) } != 0)
            .count()
    }
}

#[cfg(not(windows))]
mod platform {
    use std::io;
    use std::time::Duration;

    use super::{ProcessError, ProcessIdentity, QmpChannel, Reattached, SpawnRequest, WaitOutcome};

    #[derive(Debug)]
    pub struct ProcessHandle {
        identity: ProcessIdentity,
    }

    impl ProcessHandle {
        pub fn identity(&self) -> &ProcessIdentity {
            &self.identity
        }
        pub fn wait(&self, _timeout: Duration) -> io::Result<WaitOutcome> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }
        pub fn poll(&self) -> io::Result<WaitOutcome> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }
        pub fn terminate(&self, _exit_code: u32) -> io::Result<()> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }
    }

    pub fn spawn(
        _request: &SpawnRequest,
    ) -> Result<(ProcessHandle, Option<QmpChannel>), ProcessError> {
        Err(ProcessError::Unsupported)
    }

    pub fn reattach(_identity: &ProcessIdentity) -> Reattached {
        Reattached::Unknown("Launching is only implemented on Windows".to_owned())
    }

    pub fn close_windows(_process: &ProcessHandle) -> usize {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::same_image;
    use std::path::Path;

    #[test]
    fn images_compare_without_case_or_verbatim_prefix() {
        assert!(same_image(
            Path::new(r"\\?\C:\Emu\86Box.exe"),
            Path::new(r"c:\emu\86box.EXE")
        ));
        assert!(!same_image(
            Path::new(r"C:\Emu\86Box.exe"),
            Path::new(r"C:\Other\86Box.exe")
        ));
    }
}
