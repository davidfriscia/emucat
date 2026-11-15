//! Screenshots of running VirtualBox machines (decision 0046): `controlvm <uuid> screenshotpng` into the agent's
//! own capture spool, checked, hashed, and uploaded to the server's media pipeline under the catalog VM. The image
//! belongs to the catalog VM, never to the machine: the UUID only says which machine was captured.
//!
//! Each capture has a durable journal, written before VBoxManage runs, so a restart never captures twice: an
//! unfinished capture is finalized from what is on disk, or reported as failed. The output is only removed once
//! the server confirmed it holds the image. Acknowledgements and retries are the QEMU ones, routed by operation.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::capture::{CaptureAck, CaptureRetry, MAX_CAPTURE_BYTES};
use crate::discovery::is_link_like;
use crate::emulators::VmName;
use crate::media_sync::ApiFailure;
use crate::protocol::{Message, VirtualBoxCaptureCommand, VirtualBoxCaptureReport};
use crate::repository::CancelFlag;
use crate::virtualbox::{self, CommandRunner, Inspection, VirtualBoxSettings, VirtualBoxVmState};

/// At most this many unpublished captures are kept, each up to 64 MiB.
const MAX_UNPUBLISHED: usize = 8;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
/// Between upload attempts, doubling up to the last.
const UPLOAD_BACKOFF: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(10),
    Duration::from_secs(30),
    Duration::from_secs(120),
    Duration::from_secs(300),
];

/// Uploads one capture to the server. The real one is the agent's media API; tests use a stand-in.
pub trait CaptureUploader: Send + Sync {
    fn upload<'a>(
        &'a self,
        vm_name: &'a VmName,
        capture_id: Uuid,
        sha256: &'a str,
        file: &'a Path,
    ) -> BoxFuture<'a, Result<(), ApiFailure>>;
}

/// The label the server stores a capture under. Mirrors the API's check.
pub fn source_label(id: Uuid) -> String {
    format!("emucat-capture-{id}.png")
}

/// Whether a file is a complete PNG this agent will upload: the signature, a sane IHDR, chunks that fit, and an
/// IEND at the very end. The server decodes it again; this only keeps truncated or foreign files in the spool.
pub fn validate_png(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if is_link_like(&metadata) || !metadata.is_file() || metadata.len() > MAX_CAPTURE_BYTES {
        return Err("Capture is unsafe or exceeds 64 MiB".to_owned());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_CAPTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    validate_png_bytes(&bytes)
}

pub fn validate_png_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 + 25 + 12 || bytes[..8] != PNG_SIGNATURE {
        return Err("Not a PNG".to_owned());
    }
    let be32 = |at: usize| -> Option<u32> {
        bytes
            .get(at..at + 4)
            .map(|slice| u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
    };
    let mut cursor = 8;
    let mut first = true;
    loop {
        let length = be32(cursor).ok_or("Truncated PNG chunk")? as usize;
        let kind = bytes
            .get(cursor + 4..cursor + 8)
            .ok_or("Truncated PNG chunk")?;
        let end = cursor
            .checked_add(12)
            .and_then(|value| value.checked_add(length))
            .ok_or("Oversized PNG chunk")?;
        if end > bytes.len() {
            return Err("Truncated PNG chunk".to_owned());
        }
        if first {
            if kind != b"IHDR" || length != 13 {
                return Err("PNG does not start with its header".to_owned());
            }
            let width = be32(cursor + 8).ok_or("Truncated PNG header")?;
            let height = be32(cursor + 12).ok_or("Truncated PNG header")?;
            if width == 0
                || height == 0
                || width > MAX_DIMENSION
                || height > MAX_DIMENSION
                || u64::from(width) * u64::from(height) > MAX_PIXELS
            {
                return Err("Unsupported PNG dimensions".to_owned());
            }
            first = false;
        }
        if kind == b"IEND" {
            return if end == bytes.len() {
                Ok(())
            } else {
                Err("Data after the end of the PNG".to_owned())
            };
        }
        cursor = end;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    report: VirtualBoxCaptureReport,
    published: bool,
    retry_attempt: u32,
}

impl Journal {
    fn id(&self) -> Uuid {
        self.report.request.operation_id
    }

    /// Unpublished output that may still be uploaded: it holds a share of the spool.
    fn reserves_space(&self) -> bool {
        !self.published
            && (self.report.state != "failed"
                || self.report.uncertain
                || self.report.sha256.is_some())
    }
}

/// Whether a machine may be captured: the server asked to watch it, so it is linked to a catalog VM here.
pub type WatchProbe = Arc<dyn Fn(Uuid) -> bool + Send + Sync>;

pub struct VirtualBoxCaptures {
    settings: Option<VirtualBoxSettings>,
    runner: Option<Arc<dyn CommandRunner + Send + Sync>>,
    root: PathBuf,
    journals: Mutex<HashMap<Uuid, Journal>>,
    running: Mutex<HashSet<Uuid>>,
    uploading: Mutex<HashSet<Uuid>>,
    outbound: mpsc::Sender<Message>,
    uploader: OnceLock<Arc<dyn CaptureUploader>>,
    watched: OnceLock<WatchProbe>,
    stopping: CancelFlag,
}

impl VirtualBoxCaptures {
    pub fn load(
        settings: Option<VirtualBoxSettings>,
        state_dir: &Path,
        outbound: mpsc::Sender<Message>,
        stopping: CancelFlag,
    ) -> Result<Arc<Self>, String> {
        let root = state_dir.join("virtualbox-captures");
        fs::create_dir_all(&root)
            .map_err(|error| format!("Cannot create {}: {error}", root.display()))?;
        let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
        if is_link_like(&metadata) || !metadata.is_dir() {
            return Err("Unsafe VirtualBox capture spool".to_owned());
        }
        let runner = settings.as_ref().map(|settings| {
            let runner: Arc<dyn CommandRunner + Send + Sync> = Arc::new(settings.runner());
            runner
        });
        let captures = Arc::new(Self {
            settings,
            runner,
            root,
            journals: Mutex::default(),
            running: Mutex::default(),
            uploading: Mutex::default(),
            outbound,
            uploader: OnceLock::new(),
            watched: OnceLock::new(),
            stopping,
        });
        captures.recover()?;
        Ok(captures)
    }

    fn recover(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.root)
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
            let Ok(directory) = self.directory(id) else {
                continue;
            };
            let path = directory.join("capture.json");
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if is_link_like(&metadata) || metadata.len() > 16 * 1024 {
                tracing::error!(%id, "Ignored an unsafe VirtualBox capture journal");
                continue;
            }
            let Ok(mut journal) =
                fs::read(&path)
                    .map_err(|error| error.to_string())
                    .and_then(|bytes| {
                        serde_json::from_slice::<Journal>(&bytes).map_err(|error| error.to_string())
                    })
            else {
                tracing::error!(%id, "Ignored a VirtualBox capture journal that cannot be read");
                continue;
            };
            if journal.id() != id {
                continue;
            }
            if !journal.published && journal.report.state == "capturing" {
                // Never captured again: what is on disk is finished, or the capture failed.
                if let Err(error) = self.finalize(&mut journal) {
                    journal.report.state = "failed".to_owned();
                    journal.report.code = Some("capture_interrupted".to_owned());
                    journal.report.message = Some(error);
                    journal.report.uncertain = false;
                }
                let _ = self.persist(&journal);
            }
            self.journals.lock().expect("poisoned").insert(id, journal);
        }
        Ok(())
    }

    pub fn set_uploader(&self, uploader: Arc<dyn CaptureUploader>) {
        let _ = self.uploader.set(uploader);
    }

    pub fn set_watch_probe(&self, probe: WatchProbe) {
        let _ = self.watched.set(probe);
    }

    pub fn available(&self) -> bool {
        self.settings.is_some()
    }

    pub fn owns(&self, operation_id: Uuid) -> bool {
        self.journals
            .lock()
            .expect("poisoned")
            .contains_key(&operation_id)
    }

    /// A capture's directory, which must be a plain directory inside the spool.
    fn directory(&self, id: Uuid) -> Result<PathBuf, String> {
        let directory = self.root.join(id.to_string());
        let metadata = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
        if is_link_like(&metadata) || !metadata.is_dir() {
            return Err("Capture directory is not a plain directory".to_owned());
        }
        Ok(directory)
    }

    fn persist(&self, journal: &Journal) -> Result<(), String> {
        let directory = self.directory(journal.id())?;
        let temporary = directory.join("capture.json.tmp");
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec(journal).map_err(|error| error.to_string())?)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(temporary, directory.join("capture.json")).map_err(|error| error.to_string())
    }

    /// The PNG VBoxManage wrote, checked, moved to its final name and hashed.
    fn finalize(&self, journal: &mut Journal) -> Result<(), String> {
        let directory = self.directory(journal.id())?;
        let ready = directory.join("ready.png");
        if !ready.exists() {
            let pending = directory.join("pending.png");
            validate_png(&pending)?;
            fs::OpenOptions::new()
                .write(true)
                .open(&pending)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
            fs::rename(pending, &ready).map_err(|error| error.to_string())?;
        }
        validate_png(&ready)?;
        let (_, sha256) = crate::packaging::hash_file(&ready, &CancelFlag::new())
            .map_err(|error| error.message)?;
        if journal
            .report
            .sha256
            .as_ref()
            .is_some_and(|hash| *hash != sha256)
        {
            return Err("Capture content changed".to_owned());
        }
        journal.report.sha256 = Some(sha256);
        journal.report.state = "uploading".to_owned();
        journal.report.uncertain = false;
        journal.report.code = None;
        journal.report.message = None;
        Ok(())
    }

    fn send(&self, message: Message) {
        let _ = self.outbound.try_send(message);
    }

    /// A capture the server asked for. A repeated command only reports the capture's state again.
    pub fn start(self: &Arc<Self>, request: VirtualBoxCaptureCommand) {
        let captures = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let id = request.operation_id;
            if !captures.running.lock().expect("poisoned").insert(id) {
                return;
            }
            if !captures.owns(id) {
                captures.capture(&request);
            }
            captures.running.lock().expect("poisoned").remove(&id);
            captures.publish();
        });
    }

    /// Reports what a failed capture that never got a journal was.
    fn refuse(&self, request: &VirtualBoxCaptureCommand, code: &str, message: &str) {
        self.send(Message::AgentVirtualBoxCapture(VirtualBoxCaptureReport {
            request: request.clone(),
            state: "failed".to_owned(),
            sha256: None,
            uncertain: false,
            code: Some(code.to_owned()),
            message: Some(message.to_owned()),
        }));
    }

    /// This blocks.
    fn capture(&self, request: &VirtualBoxCaptureCommand) {
        let id = request.operation_id;
        let (Some(runner), Some(settings)) = (self.runner.clone(), self.settings.as_ref()) else {
            self.refuse(
                request,
                "virtualbox_unavailable",
                "VirtualBox is not configured on this agent",
            );
            return;
        };
        if self.uploader.get().is_none() {
            self.refuse(
                request,
                "media_unavailable",
                "Screenshot uploads are not available on this agent",
            );
            return;
        }
        if !self
            .watched
            .get()
            .is_some_and(|watched| watched(request.machine_uuid))
        {
            self.refuse(
                request,
                "machine_not_linked",
                "This machine is not one the server asked this agent to watch",
            );
            return;
        }
        let unpublished = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| journal.reserves_space())
            .count();
        if unpublished >= MAX_UNPUBLISHED {
            self.refuse(
                request,
                "capture_spool_full",
                "The capture spool is full; publish or retry the existing captures first",
            );
            return;
        }
        match virtualbox::inspect(&*runner, request.machine_uuid, settings.command_timeout) {
            Inspection::Found(vm)
                if matches!(
                    vm.state,
                    VirtualBoxVmState::Running | VirtualBoxVmState::Paused
                ) => {}
            Inspection::Found(_) => {
                self.refuse(request, "machine_not_running", "The machine is not running");
                return;
            }
            Inspection::Missing => {
                self.refuse(
                    request,
                    "machine_missing",
                    "VirtualBox does not list this machine",
                );
                return;
            }
            Inspection::Failed(_) => {
                self.refuse(
                    request,
                    "virtualbox_unavailable",
                    "VBoxManage could not inspect this machine",
                );
                return;
            }
        }

        // The journal exists before the command runs, so a restart never runs it again.
        let directory = self.root.join(id.to_string());
        if let Err(error) = fs::create_dir(&directory) {
            tracing::error!(%error, %id, "Cannot create a capture directory");
            self.refuse(
                request,
                "capture_spool_unavailable",
                "The capture spool cannot be written",
            );
            return;
        }
        let mut journal = Journal {
            report: VirtualBoxCaptureReport {
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
        if let Err(error) = self.persist(&journal) {
            tracing::error!(%error, %id, "Cannot write a capture journal");
            let _ = fs::remove_dir(&directory);
            self.refuse(
                request,
                "capture_spool_unavailable",
                "The capture spool cannot be written",
            );
            return;
        }
        self.journals
            .lock()
            .expect("poisoned")
            .insert(id, journal.clone());
        self.send(Message::AgentVirtualBoxCapture(journal.report.clone()));

        let pending = directory.join("pending.png");
        let outcome = virtualbox::screenshot(
            &*runner,
            request.machine_uuid,
            &pending,
            settings.command_timeout,
        );
        let failure = match outcome {
            Ok(output) if output.success => self.finalize(&mut journal).err().map(|message| {
                (
                    "capture_failed",
                    format!("VirtualBox wrote no usable screenshot: {message}"),
                )
            }),
            Ok(output) => Some((
                "capture_failed",
                match virtualbox::error_token(&output.stderr) {
                    Some(token) => format!("VirtualBox could not take the screenshot ({token})"),
                    None => "VirtualBox could not take the screenshot".to_owned(),
                },
            )),
            Err(_) => Some(("capture_failed", "VBoxManage could not be run".to_owned())),
        };
        if let Some((code, message)) = failure {
            journal.report.state = "failed".to_owned();
            journal.report.code = Some(code.to_owned());
            journal.report.message = Some(message);
            journal.report.uncertain = false;
            // Nothing usable: what VBoxManage left is this capture's own, and goes.
            let _ = fs::remove_file(&pending);
        }
        let _ = self.persist(&journal);
        self.journals.lock().expect("poisoned").insert(id, journal);
    }

    /// Every unpublished capture's state, sent again on each heartbeat. An image ready to upload is uploaded.
    pub fn reports(self: &Arc<Self>) -> Vec<Message> {
        let journals: Vec<Journal> = self
            .journals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| !journal.published)
            .cloned()
            .collect();
        for journal in &journals {
            if journal.report.state == "uploading" {
                self.spawn_upload(journal.id());
            }
        }
        journals
            .into_iter()
            .map(|journal| Message::AgentVirtualBoxCapture(journal.report))
            .collect()
    }

    fn publish(self: &Arc<Self>) {
        for message in self.reports() {
            self.send(message);
        }
    }

    fn spawn_upload(self: &Arc<Self>, id: Uuid) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let Some(uploader) = self.uploader.get().cloned() else {
            return;
        };
        if !self.uploading.lock().expect("poisoned").insert(id) {
            return;
        }
        let captures = Arc::clone(self);
        tokio::spawn(async move {
            captures.upload(id, uploader).await;
            captures.uploading.lock().expect("poisoned").remove(&id);
        });
    }

    /// Uploads until the server holds the image, or refuses it for good. A refusal is recorded; the file stays.
    async fn upload(self: &Arc<Self>, id: Uuid, uploader: Arc<dyn CaptureUploader>) {
        let mut attempt = 0;
        loop {
            let Some(journal) = self.journals.lock().expect("poisoned").get(&id).cloned() else {
                return;
            };
            if journal.published || journal.report.state != "uploading" {
                return;
            }
            let Some(sha256) = journal.report.sha256.clone() else {
                return;
            };
            let Ok(directory) = self.directory(id) else {
                return;
            };
            let file = directory.join("ready.png");
            match uploader
                .upload(&journal.report.request.vm_name, id, &sha256, &file)
                .await
            {
                Ok(()) => {
                    // The server acknowledges once its report says the image is there.
                    self.send(Message::AgentVirtualBoxCapture(journal.report));
                    return;
                }
                Err(ApiFailure::Transient { .. }) => {}
                Err(failure) => {
                    let error = failure.entry_error();
                    let mut journal = journal;
                    journal.report.state = "failed".to_owned();
                    journal.report.code = Some("upload_refused".to_owned());
                    journal.report.message = Some(format!(
                        "The server refused the screenshot: {}",
                        error.message
                    ));
                    let _ = self.persist(&journal);
                    self.journals
                        .lock()
                        .expect("poisoned")
                        .insert(id, journal.clone());
                    self.send(Message::AgentVirtualBoxCapture(journal.report));
                    return;
                }
            }
            let delay = UPLOAD_BACKOFF[attempt.min(UPLOAD_BACKOFF.len() - 1)];
            attempt += 1;
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = self.stopping.cancelled() => return,
            }
        }
    }

    /// The server holds the image. Only then is the local copy removed; the journal stays as the record.
    pub fn acknowledge(self: &Arc<Self>, ack: CaptureAck) {
        let mut journals = self.journals.lock().expect("poisoned");
        let Some(journal) = journals.get_mut(&ack.operation_id) else {
            return;
        };
        if journal.report.sha256.as_deref() != Some(ack.sha256.as_str()) {
            tracing::warn!(operation_id = %ack.operation_id, "Ignored an acknowledgement for other content");
            return;
        }
        journal.published = true;
        let journal = journal.clone();
        drop(journals);
        let _ = self.persist(&journal);
        if let Ok(directory) = self.directory(ack.operation_id) {
            let ready = directory.join("ready.png");
            if fs::symlink_metadata(&ready).is_ok_and(|metadata| metadata.is_file()) {
                let _ = fs::remove_file(ready);
            }
        }
    }

    /// An administrator asked to try a failed upload again. A capture is never taken again.
    pub fn retry(self: &Arc<Self>, retry: CaptureRetry) {
        let mut journal = {
            let journals = self.journals.lock().expect("poisoned");
            match journals.get(&retry.operation_id) {
                Some(journal) if !journal.published && retry.attempt > journal.retry_attempt => {
                    journal.clone()
                }
                _ => return,
            }
        };
        journal.retry_attempt = retry.attempt;
        if let Err(error) = self.finalize(&mut journal) {
            journal.report.state = "failed".to_owned();
            journal.report.code = Some("capture_unavailable".to_owned());
            journal.report.message = Some(format!("No complete screenshot is kept: {error}"));
        }
        let _ = self.persist(&journal);
        self.journals
            .lock()
            .expect("poisoned")
            .insert(retry.operation_id, journal);
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        let mut chunk = |kind: &[u8], data: &[u8]| {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
            bytes.extend_from_slice(&[0, 0, 0, 0]);
        };
        let mut header = Vec::new();
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(b"IHDR", &header);
        chunk(b"IDAT", &[1, 2, 3]);
        chunk(b"IEND", &[]);
        bytes
    }

    #[test]
    fn a_complete_png_is_accepted() {
        assert!(validate_png_bytes(&png(640, 480)).is_ok());
    }

    #[test]
    fn a_truncated_foreign_or_huge_image_is_refused() {
        let complete = png(640, 480);
        assert!(validate_png_bytes(&complete[..complete.len() - 4]).is_err());
        let mut trailing = complete.clone();
        trailing.push(0);
        assert!(validate_png_bytes(&trailing).is_err());
        assert!(validate_png_bytes(b"P6\n2 1\n255\n\0\0\0\0\0\0").is_err());
        assert!(validate_png_bytes(&png(0, 10)).is_err());
        assert!(validate_png_bytes(&png(16_385, 1)).is_err());
        assert!(validate_png_bytes(&png(10_000, 10_000)).is_err());
    }

    #[test]
    fn the_label_names_the_operation() {
        let id = Uuid::from_u128(5);
        assert_eq!(source_label(id), format!("emucat-capture-{id}.png"));
    }
}
