//! A stand-in for 86Box and QEMU in the agent's lifecycle tests. It is never shipped.
//!
//! Copied as `86Box.exe` it opens a window that closes when asked; copied as `qemu-system-*.exe` and
//! given `-qmp stdio` it speaks enough QMP to be negotiated with, powered down and quit. What else it
//! does comes from `fake-behavior.txt` in its working directory, one `key=value` per line:
//!
//! - `exit_after_ms=N` exits by itself after N milliseconds, with `exit_code`.
//! - `exit_code=N` the code it exits with by itself, or when closed. Default 0.
//! - `ignore_close=true` ignores WM_CLOSE, `ignore_powerdown=true` ignores `system_powerdown`.
//!
//! It records its arguments and working directory in `<working directory>.launch.json`, next to it,
//! so that a test can check what was run without changing the VM.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::Duration;

struct Behavior {
    exit_after: Option<Duration>,
    exit_code: i32,
    ignore_close: bool,
    ignore_powerdown: bool,
}

fn behavior() -> Behavior {
    let text = std::fs::read_to_string("fake-behavior.txt").unwrap_or_default();
    let values: HashMap<&str, &str> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    Behavior {
        exit_after: values
            .get("exit_after_ms")
            .and_then(|value| value.parse().ok())
            .map(Duration::from_millis),
        exit_code: values
            .get("exit_code")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        ignore_close: values.get("ignore_close") == Some(&"true"),
        ignore_powerdown: values.get("ignore_powerdown") == Some(&"true"),
    }
}

fn record_launch() {
    let directory = std::env::current_dir().unwrap();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let record = serde_json::json!({
        "program": std::env::current_exe().unwrap(),
        "arguments": arguments,
        "workingDirectory": directory,
        "pid": std::process::id(),
    });
    let name = format!(
        "{}.launch.json",
        directory.file_name().unwrap().to_string_lossy()
    );
    if let Some(parent) = directory.parent() {
        let _ = std::fs::write(parent.join(name), record.to_string());
    }
}

fn speak_qmp(behavior: &Behavior) {
    let stdout = std::io::stdout();
    let say = |value: serde_json::Value| {
        let mut out = stdout.lock();
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    };
    say(
        serde_json::json!({"QMP": {"version": {"qemu": {"major": 0, "minor": 0, "micro": 0}}, "capabilities": []}}),
    );
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            say(serde_json::json!({"error": {"class": "GenericError", "desc": "bad json"}}));
            continue;
        };
        match value.get("execute").and_then(|command| command.as_str()) {
            Some("qmp_capabilities") => say(serde_json::json!({"return": {}})),
            Some("system_powerdown") => {
                say(serde_json::json!({"return": {}}));
                if !behavior.ignore_powerdown {
                    std::thread::sleep(Duration::from_millis(200));
                    std::process::exit(0);
                }
            }
            Some("quit") => {
                say(serde_json::json!({"return": {}}));
                std::process::exit(0);
            }
            _ => say(serde_json::json!({"error": {"class": "CommandNotFound", "desc": "unknown"}})),
        }
    }
    // As QEMU does, it keeps running when nobody holds its monitor any more.
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(windows)]
mod window {
    use std::sync::atomic::{AtomicBool, Ordering};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, MSG,
        PostQuitMessage, RegisterClassW, TranslateMessage, WM_CLOSE, WM_DESTROY, WNDCLASSW,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    static IGNORE_CLOSE: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CLOSE if IGNORE_CLOSE.load(Ordering::SeqCst) => 0,
            WM_CLOSE => {
                unsafe { DestroyWindow(window) };
                0
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                0
            }
            _ => unsafe { DefWindowProcW(window, message, w, l) },
        }
    }

    /// A visible top-level window, placed off screen, until it is closed.
    pub fn run(ignore_close: bool) {
        IGNORE_CLOSE.store(ignore_close, Ordering::SeqCst);
        let class: Vec<u16> = "EmuCatFakeEmulator\0".encode_utf16().collect();
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let definition = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(procedure),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&definition);
            CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                -4000,
                -4000,
                160,
                120,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
}

fn main() {
    record_launch();
    let behavior = behavior();
    if let Some(after) = behavior.exit_after {
        let code = behavior.exit_code;
        std::thread::spawn(move || {
            std::thread::sleep(after);
            std::process::exit(code);
        });
    }
    let program = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
        })
        .unwrap_or_default();
    let arguments: Vec<String> = std::env::args().collect();
    let qmp = arguments
        .windows(2)
        .any(|pair| pair[0] == "-qmp" && pair[1] == "stdio");
    if program.starts_with("qemu-system-") {
        if qmp {
            speak_qmp(&behavior);
        }
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    #[cfg(windows)]
    window::run(behavior.ignore_close);
    std::process::exit(behavior.exit_code);
}
