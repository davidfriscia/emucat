//! The terminal side of `emucat-agent import-ova`: arguments in, progress and a result out. The work itself is in
//! [`crate::ova_import`].

use std::io::{IsTerminal, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::ova_import::{
    Event, ImportError, ImportErrorKind, ImportReport, Outcome, Reporter, Step,
};

/// What the import's progress looks like on a terminal, or in a log when there is none.
struct Display {
    interactive: bool,
    /// Progress on standard error, leaving standard output to the JSON result.
    to_stderr: bool,
    current: Option<(Step, u8)>,
}

impl Display {
    fn write(&self, text: &str) {
        if self.to_stderr {
            let mut stream = std::io::stderr().lock();
            let _ = stream.write_all(text.as_bytes());
            let _ = stream.flush();
        } else {
            let mut stream = std::io::stdout().lock();
            let _ = stream.write_all(text.as_bytes());
            let _ = stream.flush();
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Started(step) => {
                self.current = Some((step, 0));
                if self.interactive {
                    self.write(&format!("{}...", step.label()));
                } else {
                    self.write(&format!("{}...\n", step.label()));
                }
            }
            Event::Bytes(step, done, total) => {
                // Nothing to transfer counts as done.
                let percent = done
                    .saturating_mul(100)
                    .checked_div(total)
                    .map_or(100, |percent| u8::try_from(percent).unwrap_or(100));
                let Some((current, shown)) = self.current else {
                    return;
                };
                if current != step || percent == shown {
                    return;
                }
                if self.interactive {
                    self.write(&format!("\r{}... {percent}%", step.label()));
                    self.current = Some((step, percent));
                } else if percent / 10 > shown / 10 {
                    // Without a terminal, a line every ten percent is enough for a log.
                    self.write(&format!("{}... {percent}%\n", step.label()));
                    self.current = Some((step, percent));
                }
            }
            Event::Done(step) => {
                let finished =
                    matches!(self.current, Some((current, shown)) if current == step && shown > 0);
                if self.interactive {
                    let suffix = if finished { "100% OK   " } else { "OK" };
                    self.write(&format!("\r{}... {suffix}\n", step.label()));
                } else {
                    self.write(&format!("{}... OK\n", step.label()));
                }
                self.current = None;
            }
            Event::Skipped(step, why) => {
                self.end_line();
                self.write(&format!("{}... skipped: {why}\n", step.label()));
            }
            Event::Note(note) => {
                self.end_line();
                self.write(&format!("Note: {note}\n"));
            }
        }
    }

    /// A step under way on an interactive line is cut off before anything else is printed.
    fn end_line(&mut self) {
        if self.interactive
            && let Some((step, _)) = self.current.take()
        {
            self.write(&format!("\r{}...\n", step.label()));
        }
    }
}

pub struct Terminal {
    display: Arc<Mutex<Display>>,
    json: bool,
}

impl Terminal {
    pub fn new(json: bool) -> Self {
        let interactive = if json {
            std::io::stderr().is_terminal()
        } else {
            std::io::stdout().is_terminal()
        };
        Self {
            display: Arc::new(Mutex::new(Display {
                interactive,
                to_stderr: json,
                current: None,
            })),
            json,
        }
    }

    pub fn reporter(&self) -> Reporter {
        let display = Arc::clone(&self.display);
        Arc::new(move |event| display.lock().expect("poisoned").event(event))
    }

    fn line(&self, text: &str) {
        self.display
            .lock()
            .expect("poisoned")
            .write(&format!("{text}\n"));
    }

    pub fn banner(&self, source: &Path, vm_name: &str, server: &str, dry_run: bool) {
        self.line("EmuCat Agent — OVA Repository Import");
        self.line("");
        self.line(&format!("Source: {}", source.display()));
        self.line(&format!("Catalog VM: {vm_name}"));
        self.line("Emulator: VirtualBox");
        self.line(&format!("Server: {server}"));
        if dry_run {
            self.line("Mode: dry run (nothing is reserved, uploaded or registered)");
        }
        self.line("");
    }

    /// The result, as text or JSON. JSON always goes to standard output, as one object.
    pub fn finish(&self, result: &Result<ImportReport, ImportError>) -> u8 {
        self.display.lock().expect("poisoned").end_line();
        if self.json {
            let value = match result {
                Ok(report) => serde_json::to_value(report).expect("serializes"),
                Err(error) => serde_json::json!({
                    "status": if error.kind == ImportErrorKind::Cancelled { "cancelled" } else { "failed" },
                    "error": error,
                    "exitCode": error.kind.exit_code(),
                }),
            };
            println!("{value}");
        }
        match result {
            Ok(report) => {
                if !self.json {
                    self.line("");
                    match report.status {
                        Outcome::DryRun => {
                            self.line("Dry run completed: the OVA can be imported under this name.")
                        }
                        Outcome::Completed => self.line("Import completed successfully."),
                    }
                    self.line(&format!("Size: {} bytes", report.size_bytes));
                    self.line(&format!("SHA-256: {}", report.sha256));
                    self.line(&format!(
                        "OVF: {} (OVF {}), {} virtual system(s), {} file(s){}",
                        report.ovf.descriptor,
                        report.ovf.version,
                        report.ovf.virtual_systems.len(),
                        report.ovf.files,
                        if report.ovf.virtualbox_machine {
                            ", exported by VirtualBox"
                        } else {
                            ""
                        }
                    ));
                    match &report.repository_name {
                        Some(name) => {
                            self.line(&format!("Repository: {name} ({})", report.repository_id))
                        }
                        None => self.line(&format!("Repository: {}", report.repository_id)),
                    }
                    if let (Some(operation), Some(version), Some(key)) =
                        (report.operation_id, report.version_id, &report.archive_key)
                    {
                        self.line(&format!("Operation: {operation}"));
                        self.line(&format!("Master version: {version}"));
                        self.line(&format!("Archive: {key}"));
                    }
                    if report.status == Outcome::Completed {
                        self.line("");
                        self.line(
                            "The VM is in the catalog with this OVA as its master. It is not in VirtualBox: \
                             import the master into VirtualBox from the VM's page to run it.",
                        );
                    }
                }
                0
            }
            Err(error) => {
                if !self.json {
                    eprintln!();
                    eprintln!("error: {}", error.message);
                    eprintln!("code: {}", error.code);
                    if let Some(operation) = error.operation_id {
                        eprintln!(
                            "operation: {operation} ({})",
                            error.operation_state.as_deref().unwrap_or("state unknown")
                        );
                    }
                }
                error.kind.exit_code()
            }
        }
    }
}

/// The description, checked as the server checks it, so that a mistake is found before anything else is done.
pub fn check_description(description: Option<&str>) -> Result<Option<String>, ImportError> {
    let Some(text) = description else {
        return Ok(None);
    };
    let invalid = |message: &str| {
        ImportError::new(
            ImportErrorKind::InvalidInput,
            "invalid_description",
            message,
        )
    };
    if text.trim().is_empty() {
        return Err(invalid("The description is empty"));
    }
    if text.chars().count() > 10_000 {
        return Err(invalid("The description is longer than 10000 characters"));
    }
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(invalid("The description contains control characters"));
    }
    Ok(Some(text.to_owned()))
}
