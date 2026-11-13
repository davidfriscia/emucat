//! Durable QEMU captures. Output never belongs to a VM directory or temporary workspace.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::discovery::is_link_like;
use crate::emulators::{EmulatorType, VmIdentity, VmName};
use crate::execution::ExecutionManager;
use crate::media::{MediaStamp, hash_media_file};
use crate::media_sync::MediaPreservation;
use crate::protocol::Message;

pub const MAX_CAPTURE_BYTES: u64 = 64 * 1024 * 1024;
// Reserve the full per-image allowance before execution: at most 512 MiB of unpublished captures.
const MAX_UNPUBLISHED: usize = 8;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CaptureFailure {
    pub message: String,
    pub uncertain: bool,
}
impl From<String> for CaptureFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            uncertain: false,
        }
    }
}
impl From<&str> for CaptureFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureCommand {
    pub operation_id: Uuid,
    pub session_id: Uuid,
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReport {
    #[serde(flatten)]
    pub request: CaptureCommand,
    pub state: String,
    pub sha256: Option<String>,
    pub uncertain: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureAck {
    pub operation_id: Uuid,
    pub sha256: String,
    pub media_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRetry {
    pub operation_id: Uuid,
    pub attempt: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    report: CaptureReport,
    published: bool,
    retry_attempt: u32,
}

pub fn source_label(id: Uuid) -> String {
    format!("emucat-capture-{id}.ppm")
}

pub fn checked_directory(state: &Path, id: Uuid) -> Result<PathBuf, String> {
    Ok(pin_directory(state, id)?.path)
}

pub struct DirectoryGuard {
    pub path: PathBuf,
    _handles: Vec<fs::File>,
}

/// Windows directory handles deny deletion/renaming while QEMU opens its output beneath them.
pub fn pin_directory(state: &Path, id: Uuid) -> Result<DirectoryGuard, String> {
    if !state.is_absolute() {
        return Err("Capture state directory must be absolute".to_owned());
    }
    let root = state.join("captures");
    #[allow(unused_mut)]
    let mut handles = Vec::new();
    for path in [state.to_path_buf(), root.clone(), root.join(id.to_string())] {
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if is_link_like(&metadata) || !metadata.is_dir() {
            return Err("Capture directory is not a plain directory".to_owned());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            };
            let handle = fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
                .map_err(|error| error.to_string())?;
            let opened = handle.metadata().map_err(|error| error.to_string())?;
            if is_link_like(&opened) || !opened.is_dir() {
                return Err("Capture directory changed".to_owned());
            }
            handles.push(handle);
        }
    }
    Ok(DirectoryGuard {
        path: root.join(id.to_string()),
        _handles: handles,
    })
}

/// Validate the complete P6 raster, not just its extension or an idle metadata stamp.
pub fn validate_ppm(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if is_link_like(&metadata) || !metadata.is_file() || metadata.len() > MAX_CAPTURE_BYTES {
        return Err("Capture is unsafe or exceeds 64 MiB".to_owned());
    }
    let mut file = crate::packaging::open_for_reading(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_CAPTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mut cursor = 0;
    let mut tokens = Vec::new();
    while tokens.len() < 4 {
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b'#') {
            while bytes.get(cursor).is_some_and(|byte| *byte != b'\n') {
                cursor += 1;
            }
            continue;
        }
        let start = cursor;
        while bytes
            .get(cursor)
            .is_some_and(|byte| !byte.is_ascii_whitespace())
        {
            cursor += 1;
        }
        if cursor == start || cursor > 4096 {
            return Err("Incomplete PPM header".to_owned());
        }
        tokens.push(std::str::from_utf8(&bytes[start..cursor]).map_err(|error| error.to_string())?);
    }
    let number = |index: usize| {
        tokens[index]
            .parse::<u64>()
            .map_err(|_| "Invalid PPM dimensions".to_owned())
    };
    let (width, height, max) = (number(1)?, number(2)?, number(3)?);
    if tokens[0] != "P6"
        || width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || width * height > 40_000_000
        || max != 255
        || !bytes.get(cursor).is_some_and(u8::is_ascii_whitespace)
    {
        return Err("Unsupported PPM capture".to_owned());
    }
    cursor += 1;
    if bytes.len() as u64 != cursor as u64 + width * height * 3 {
        return Err("Incomplete PPM raster".to_owned());
    }
    Ok(())
}

pub struct CaptureManager {
    state_dir: PathBuf,
    execution: Arc<ExecutionManager>,
    media: Option<Arc<dyn MediaPreservation>>,
    journals: Mutex<HashMap<Uuid, Journal>>,
    running: Mutex<HashSet<Uuid>>,
    outbound: OnceLock<tokio::sync::mpsc::Sender<Message>>,
}

impl CaptureManager {
    pub fn load(
        state_dir: PathBuf,
        execution: Arc<ExecutionManager>,
        media: Option<Arc<dyn MediaPreservation>>,
    ) -> Result<Arc<Self>, String> {
        let state_metadata = fs::symlink_metadata(&state_dir).map_err(|error| error.to_string())?;
        if !state_dir.is_absolute() || is_link_like(&state_metadata) || !state_metadata.is_dir() {
            return Err("Unsafe capture state directory".to_owned());
        }
        let root = state_dir.join("captures");
        if !root.exists() {
            fs::create_dir(&root).map_err(|error| error.to_string())?;
        }
        let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
        if is_link_like(&metadata) || !metadata.is_dir() {
            return Err("Unsafe capture spool".to_owned());
        }
        let manager = Arc::new(Self {
            state_dir,
            execution,
            media,
            journals: Mutex::default(),
            running: Mutex::default(),
            outbound: OnceLock::new(),
        });
        if let Some(media) = &manager.media {
            let weak = Arc::downgrade(&manager);
            media.set_capture_reporter(Arc::new(move || {
                let weak = weak.clone();
                tokio::task::spawn_blocking(move || {
                    if let Some(manager) = weak.upgrade() {
                        manager.publish_reports();
                    }
                });
            }));
        }
        for entry in fs::read_dir(root)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|text| Uuid::parse_str(text).ok())
            else {
                continue;
            };
            let directory = checked_directory(&manager.state_dir, id)?;
            let path = directory.join("capture.json");
            if !path.exists() {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if is_link_like(&metadata) || metadata.len() > 16384 {
                return Err("Unsafe capture journal".to_owned());
            }
            let mut journal: Journal =
                serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if journal.report.request.operation_id != id {
                return Err("Capture identity mismatch".to_owned());
            }
            if !journal.published
                && (journal.report.state != "failed"
                    || journal.report.uncertain
                    || journal.report.sha256.is_some())
            {
                // Recovery never reissues screendump. A closed, complete output can still be finalized.
                if let Err(error) = manager.finalize(&mut journal) {
                    journal.report.state = "failed".to_owned();
                    journal.report.code = Some("capture_interrupted".to_owned());
                    journal.report.message = Some(error);
                    journal.report.uncertain = true;
                }
                manager.persist(&journal)?;
            }
            manager
                .journals
                .lock()
                .expect("poisoned")
                .insert(id, journal);
        }
        Ok(manager)
    }

    pub fn set_outbound(&self, outbound: tokio::sync::mpsc::Sender<Message>) {
        let _ = self.outbound.set(outbound);
    }

    fn publish_reports(&self) {
        if let Some(outbound) = self.outbound.get() {
            for message in self.reports() {
                let _ = outbound.try_send(message);
            }
        }
    }

    fn persist(&self, journal: &Journal) -> Result<(), String> {
        let pinned = pin_directory(&self.state_dir, journal.report.request.operation_id)?;
        let directory = &pinned.path;
        let temporary = directory.join(format!("{}.tmp", Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec(journal).map_err(|error| error.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        let final_path = directory.join("capture.json");
        if fs::symlink_metadata(&final_path).is_ok_and(|metadata| is_link_like(&metadata)) {
            return Err("Unsafe capture journal".to_owned());
        }
        fs::rename(temporary, final_path).map_err(|error| error.to_string())
    }

    fn finalize(&self, journal: &mut Journal) -> Result<(), String> {
        let id = journal.report.request.operation_id;
        let pinned = pin_directory(&self.state_dir, id)?;
        let directory = &pinned.path;
        let ready = directory.join("ready.ppm");
        if !ready.exists() {
            let pending = directory.join("pending.ppm");
            validate_ppm(&pending)?;
            fs::OpenOptions::new()
                .write(true)
                .open(&pending)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
            fs::rename(pending, &ready).map_err(|error| error.to_string())?;
        }
        validate_ppm(&ready)?;
        let hashed =
            hash_media_file(directory, "ready.ppm").map_err(|error| format!("{error:?}"))?;
        if journal
            .report
            .sha256
            .as_ref()
            .is_some_and(|hash| *hash != hashed.sha256)
        {
            return Err("Capture content changed".to_owned());
        }
        journal.report.sha256 = Some(hashed.sha256);
        journal.report.state = "uploading".to_owned();
        journal.report.uncertain = false;
        journal.report.code = None;
        journal.report.message = None;
        Ok(())
    }

    pub fn start(self: &Arc<Self>, request: CaptureCommand) {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut running = this.running.lock().expect("poisoned");
            if !running.insert(request.operation_id) {
                return;
            }
            drop(running);
            if let Err(error) = this.capture(request.clone()) {
                tracing::error!(operation_id = %request.operation_id, %error, "Capture retained after failure");
                let mut journals = this.journals.lock().expect("poisoned");
                let journal = journals
                    .entry(request.operation_id)
                    .or_insert_with(|| Journal {
                        report: CaptureReport {
                            request: request.clone(),
                            state: "failed".to_owned(),
                            sha256: None,
                            uncertain: true,
                            code: None,
                            message: None,
                        },
                        published: false,
                        retry_attempt: 0,
                    });
                journal.report.state = "failed".to_owned();
                journal.report.code = Some("capture_spool_unavailable".to_owned());
                journal.report.message = Some("The capture spool could not be recorded. Check the agent log and free disk space; existing output was retained".to_owned());
                journal.report.uncertain = true;
                let _ = this.persist(journal);
            }
            this.running
                .lock()
                .expect("poisoned")
                .remove(&request.operation_id);
            this.publish_reports();
        });
    }

    fn capture(&self, request: CaptureCommand) -> Result<(), String> {
        let id = request.operation_id;
        let mut journals = self.journals.lock().expect("poisoned");
        if journals.contains_key(&id) {
            return Ok(());
        }
        let mut journal = Journal {
            report: CaptureReport {
                request: request.clone(),
                state: "capturing".to_owned(),
                sha256: None,
                uncertain: false,
                code: None,
                message: None,
            },
            published: false,
            retry_attempt: 0,
        };
        let reserved_bytes: u64 = journals
            .values()
            .map(|journal| {
                let actual: u64 =
                    checked_directory(&self.state_dir, journal.report.request.operation_id)
                        .ok()
                        .map(|directory| {
                            ["pending.ppm", "ready.ppm"]
                                .iter()
                                .filter_map(|name| fs::symlink_metadata(directory.join(name)).ok())
                                .map(|metadata| metadata.len())
                                .sum()
                        })
                        .unwrap_or(0);
                if !journal.published
                    && (journal.report.state != "failed"
                        || journal.report.uncertain
                        || journal.report.sha256.is_some())
                {
                    actual.max(MAX_CAPTURE_BYTES)
                } else {
                    actual
                }
            })
            .sum();
        let full = reserved_bytes.saturating_add(MAX_CAPTURE_BYTES)
            > MAX_CAPTURE_BYTES * MAX_UNPUBLISHED as u64;
        let directory = self.state_dir.join("captures").join(id.to_string());
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        let _pinned = pin_directory(&self.state_dir, id)?;
        self.persist(&journal)?; // Before a command could possibly execute.
        journals.insert(id, journal.clone());
        drop(journals);
        if let Some(outbound) = self.outbound.get() {
            let _ = outbound.try_send(Message::AgentQemuCapture(journal.report.clone()));
        }
        let outcome: Result<(), CaptureFailure> = if full {
            Err("Capture spool is full (512 MiB reserved); publish or retry existing captures first".into())
        } else if request.emulator_type != EmulatorType::Qemu {
            Err("Only QEMU sessions can capture".into())
        } else if self.media.is_none() {
            Err("Media synchronization is unavailable".into())
        } else {
            self.execution
                .capture_screen(&request, directory.join("pending.ppm"))
        };
        if let Err(error) = outcome.and_then(|_| {
            self.finalize(&mut journal)
                .map_err(|message| CaptureFailure {
                    message,
                    uncertain: true,
                })
        }) {
            journal.report.state = "failed".to_owned();
            journal.report.code = Some(
                if full {
                    "capture_spool_full"
                } else {
                    "capture_failed"
                }
                .to_owned(),
            );
            journal.report.message = Some(error.message.chars().take(1000).collect());
            journal.report.uncertain = error.uncertain;
        }
        self.persist(&journal)?;
        self.journals.lock().expect("poisoned").insert(id, journal);
        Ok(())
    }

    pub fn reports(&self) -> Vec<Message> {
        let journals = self.journals.lock().expect("poisoned");
        // A deduplication acknowledgement can race an in-flight reader. Retry confirmed-only cleanup
        // after that reader has released its Windows handle; unpublished output is never removed.
        for journal in journals.values().filter(|journal| journal.published) {
            if let Ok(pinned) = pin_directory(&self.state_dir, journal.report.request.operation_id)
            {
                let path = pinned.path.join("ready.ppm");
                if fs::symlink_metadata(&path)
                    .is_ok_and(|metadata| metadata.is_file() && !is_link_like(&metadata))
                {
                    let _ = fs::remove_file(path);
                }
            }
        }
        journals
            .values()
            .filter(|journal| !journal.published)
            .map(|journal| {
                let mut report = journal.report.clone();
                if report.state == "uploading"
                    && let (Some(hash), Some(media)) = (&report.sha256, &self.media)
                {
                    let vm = VmIdentity {
                        emulator_type: report.request.emulator_type,
                        vm_name: report.request.vm_name.clone(),
                    };
                    if let Ok(directory) =
                        checked_directory(&self.state_dir, report.request.operation_id)
                        && let Ok(metadata) = fs::symlink_metadata(directory.join("ready.ppm"))
                    {
                        media.enqueue_capture(
                            report.request.operation_id,
                            &vm,
                            hash,
                            MediaStamp::of(&metadata),
                        );
                        if let Some(error) = media.capture_error(report.request.operation_id, &vm) {
                            report.state = "failed".to_owned();
                            report.code = Some(error.code);
                            report.message = Some(error.message);
                        }
                    } else {
                        report.state = "failed".to_owned();
                        report.code = Some("capture_source_unavailable".to_owned());
                        report.message = Some("The retained capture cannot be read. Check the agent spool and retry recovery".to_owned());
                        report.uncertain = true;
                    }
                }
                Message::AgentQemuCapture(report)
            })
            .collect()
    }

    pub fn acknowledge(&self, ack: CaptureAck) {
        let mut journals = self.journals.lock().expect("poisoned");
        let Some(journal) = journals.get_mut(&ack.operation_id) else {
            return;
        };
        if journal.report.sha256.as_deref() != Some(&ack.sha256) {
            return;
        }
        journal.published = true;
        if self.persist(journal).is_err() {
            journal.published = false;
            return;
        }
        // Only the authenticated API can confirm committed media. Keep the journal as a tombstone.
        if let Ok(directory) = checked_directory(&self.state_dir, ack.operation_id) {
            let path = directory.join("ready.ppm");
            if fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_file() && !is_link_like(&metadata))
            {
                let _ = fs::remove_file(path);
            }
        }
        if let Some(media) = &self.media {
            media.forget_capture(
                ack.operation_id,
                &VmIdentity {
                    emulator_type: journal.report.request.emulator_type,
                    vm_name: journal.report.request.vm_name.clone(),
                },
            );
        }
    }

    pub fn retry(&self, retry: CaptureRetry) {
        let mut journals = self.journals.lock().expect("poisoned");
        let Some(journal) = journals.get_mut(&retry.operation_id) else {
            return;
        };
        if journal.published || retry.attempt <= journal.retry_attempt || retry.attempt > 3 {
            return;
        }
        journal.retry_attempt = retry.attempt;
        if let Err(error) = self.finalize(journal) {
            journal.report.state = "failed".to_owned();
            journal.report.code = Some("capture_recovery_failed".to_owned());
            journal.report.message = Some(error.chars().take(1000).collect());
        }
        if self.persist(journal).is_ok()
            && journal.report.state == "uploading"
            && let Some(media) = &self.media
        {
            media.retry_capture(
                retry.operation_id,
                &VmIdentity {
                    emulator_type: journal.report.request.emulator_type,
                    vm_name: journal.report.request.vm_name.clone(),
                },
            );
        }
        drop(journals);
        self.publish_reports();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{ExecutionConfig, ExecutionSettings};
    use crate::repository::CancelFlag;

    #[test]
    fn shared_commands_refuse_paths_and_raw_monitor_commands() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/fixtures/captures.json"
        ))
        .unwrap();
        serde_json::from_value::<CaptureCommand>(fixture["valid"].clone()).unwrap();
        for invalid in fixture["invalidFields"].as_array().unwrap() {
            let mut command = fixture["valid"].clone();
            for (key, value) in invalid.as_object().unwrap() {
                command[key] = value.clone();
            }
            assert!(serde_json::from_value::<CaptureCommand>(command).is_err());
        }
    }

    fn manager(state: &Path) -> Arc<CaptureManager> {
        let (sender, _) = tokio::sync::mpsc::channel(32);
        let execution = ExecutionManager::load(
            ExecutionConfig {
                state_dir: state.to_owned(),
                emulators: Arc::default(),
                settings: ExecutionSettings::default(),
            },
            sender,
            CancelFlag::new(),
        )
        .unwrap();
        CaptureManager::load(state.to_owned(), execution, None).unwrap()
    }

    fn journal() -> Journal {
        Journal {
            report: CaptureReport {
                request: CaptureCommand {
                    operation_id: Uuid::new_v4(),
                    session_id: Uuid::new_v4(),
                    emulator_type: EmulatorType::Qemu,
                    vm_name: VmName::new("disposable").unwrap(),
                },
                state: "capturing".to_owned(),
                sha256: None,
                uncertain: true,
                code: None,
                message: None,
            },
            published: false,
            retry_attempt: 0,
        }
    }

    #[test]
    fn validates_complete_ppm_and_refuses_partial_or_oversized_rasters() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("screen.ppm");
        fs::write(&path, b"P6\n2 1\n255\n\xff\0\0\0\xff\0").unwrap();
        validate_ppm(&path).unwrap();
        for bytes in [
            b"P6\n2 1\n255\n\xff".as_slice(),
            b"P6\n99999 99999\n255\n",
            b"P3\n1 1\n255\n1 2 3",
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(validate_ppm(&path).is_err());
        }
    }

    #[tokio::test]
    async fn recovers_complete_pending_output_without_reexecuting_and_requires_matching_ack() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        let journal = journal();
        let id = journal.report.request.operation_id;
        let root = directory.path().join("captures").join(id.to_string());
        fs::create_dir(&root).unwrap();
        manager.persist(&journal).unwrap();
        fs::write(root.join("pending.ppm"), b"P6\n1 1\n255\n\xff\0\0").unwrap();
        let recovered =
            CaptureManager::load(directory.path().to_owned(), manager.execution.clone(), None)
                .unwrap();
        let report = recovered.journals.lock().unwrap()[&id].report.clone();
        assert_eq!(report.state, "uploading");
        assert!(!root.join("pending.ppm").exists());
        assert!(root.join("ready.ppm").exists());
        recovered.capture(report.request.clone()).unwrap(); // A duplicate cannot execute QMP.
        recovered.acknowledge(CaptureAck {
            operation_id: id,
            sha256: "wrong".to_owned(),
            media_id: Uuid::new_v4(),
        });
        assert!(root.join("ready.ppm").exists());
        recovered.acknowledge(CaptureAck {
            operation_id: id,
            sha256: report.sha256.unwrap(),
            media_id: Uuid::new_v4(),
        });
        assert!(!root.join("ready.ppm").exists());
        assert!(root.join("capture.json").exists());
    }

    #[tokio::test]
    async fn interrupted_intent_and_capacity_exhaustion_are_explicit_and_retained() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        for _ in 0..MAX_UNPUBLISHED {
            let journal = journal();
            let id = journal.report.request.operation_id;
            fs::create_dir(directory.path().join("captures").join(id.to_string())).unwrap();
            manager.persist(&journal).unwrap();
        }
        let recovered =
            CaptureManager::load(directory.path().to_owned(), manager.execution.clone(), None)
                .unwrap();
        assert!(
            recovered
                .journals
                .lock()
                .unwrap()
                .values()
                .all(|entry| entry.report.uncertain && entry.report.state == "failed")
        );
        let next = journal();
        let id = next.report.request.operation_id;
        recovered.capture(next.report.request).unwrap();
        assert_eq!(
            recovered.journals.lock().unwrap()[&id]
                .report
                .code
                .as_deref(),
            Some("capture_spool_full")
        );
        assert_eq!(
            recovered.journals.lock().unwrap().len(),
            MAX_UNPUBLISHED + 1
        );
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_and_pins_valid_directories_against_replacement() {
        let state = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(state.path().join("captures")).unwrap();
        let id = Uuid::new_v4();
        let path = state.path().join("captures").join(id.to_string());
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&path)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(checked_directory(state.path(), id).is_err());
        fs::remove_dir(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let pinned = pin_directory(state.path(), id).unwrap();
        assert!(fs::rename(&path, path.with_extension("moved")).is_err());
        drop(pinned);
        fs::rename(&path, path.with_extension("moved")).unwrap();
    }
}
