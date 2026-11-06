//! The durable record of what has to reach the server, and of what already has.
//!
//! One JSON file in the state directory, replaced atomically like a registration journal. The agent's
//! other state works the same way, so there is nothing new to operate. It holds no secret and no image.
//!
//! An entry's identity is its agent (the file is per agent), VM, source path and content hash. There is
//! one entry for each path: when a file changes, its new content replaces the entry. What the old content
//! became is the server's business, and a file that changed before it was uploaded no longer exists.
//!
//! This is a cache of what is known, and never the proof that a screenshot is safe. If the file is lost,
//! the next reconciliation asks the server about each hash, and uploads only what the server lacks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::emulators::{EmulatorType, VmName};
use crate::media::MediaStamp;
use crate::protocol::{MediaSyncError, MediaSyncVmStatus};

const QUEUE_FILE: &str = "queue.json";
const QUEUE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    Pending,
    Uploading,
    RetryWait,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub emulator_type: EmulatorType,
    pub vm_name: VmName,
    pub source_path: String,
    pub sha256: String,
    pub stamp: MediaStamp,
    pub state: EntryState,
    pub attempts: u32,
    /// When this may be tried again, in milliseconds since the epoch.
    pub next_attempt_ms: u64,
    pub last_error: Option<EntryError>,
}

impl QueueEntry {
    /// The first characters of the hash, which is enough to find a file in a log.
    pub fn short_hash(&self) -> &str {
        self.sha256.get(..12).unwrap_or(&self.sha256)
    }
}

/// A stable name for a VM, ignoring case like VM identity itself.
pub fn vm_key(emulator: EmulatorType, vm_name: &VmName) -> String {
    format!("{emulator}/{}", vm_name.key())
}

fn entry_key(emulator: EmulatorType, vm_name: &VmName, source_path: &str) -> String {
    format!("{}/{source_path}", vm_key(emulator, vm_name))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueFile {
    version: u32,
    agent_id: Uuid,
    entries: BTreeMap<String, QueueEntry>,
}

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub initial: Duration,
    pub ceiling: Duration,
}

/// Doubles from `initial`, up to `ceiling`, with half of each delay random. Agents that lost the same
/// server do not all come back at the same moment.
pub fn retry_delay(attempts: u32, initial: Duration, ceiling: Duration) -> Duration {
    let factor = 2u32.saturating_pow(attempts.saturating_sub(1).min(16));
    let delay = initial.saturating_mul(factor).min(ceiling);
    let half = delay / 2;
    half + half.mul_f64(fastrand::f64())
}

#[derive(Debug)]
pub struct MediaQueue {
    path: PathBuf,
    agent_id: Uuid,
    entries: BTreeMap<String, QueueEntry>,
    dirty: bool,
}

pub fn queue_path(state_dir: &Path) -> PathBuf {
    state_dir.join("media").join(QUEUE_FILE)
}

impl MediaQueue {
    /// Reads what an earlier run left behind. Anything that was being uploaded goes back to pending,
    /// since nobody can know how far it got and uploading again is harmless. A damaged file is kept for
    /// inspection and treated as empty: the server's answers rebuild everything that matters.
    pub fn load(state_dir: &Path, agent_id: Uuid) -> std::io::Result<Self> {
        let path = queue_path(state_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut entries = BTreeMap::new();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<QueueFile>(&bytes) {
                Ok(file) if file.version == QUEUE_VERSION && file.agent_id == agent_id => {
                    entries = file.entries;
                }
                Ok(_) => {
                    tracing::info!("The media queue belongs to another identity; starting afresh");
                }
                Err(error) => {
                    let kept = path.with_extension("damaged");
                    tracing::error!(%error, kept = %kept.display(), "Cannot read the media queue");
                    let _ = fs::rename(&path, &kept);
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let mut queue = Self {
            path,
            agent_id,
            entries,
            dirty: false,
        };
        for entry in queue.entries.values_mut() {
            if entry.state == EntryState::Uploading {
                entry.state = EntryState::Pending;
                queue.dirty = true;
            }
        }
        Ok(queue)
    }

    /// Replaces the file atomically and durably, if anything changed.
    pub fn save(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let file = QueueFile {
            version: QUEUE_VERSION,
            agent_id: self.agent_id,
            entries: self.entries.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
        let temporary = self.path.with_extension("tmp");
        {
            let mut output = fs::File::create(&temporary)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
        }
        fs::rename(&temporary, &self.path)?;
        self.dirty = false;
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn entries(&self) -> impl Iterator<Item = &QueueEntry> {
        self.entries.values()
    }

    pub fn get(
        &self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
    ) -> Option<&QueueEntry> {
        self.entries.get(&entry_key(emulator, vm_name, source_path))
    }

    /// Whether a scan can skip this file: the same size and time as the content already recorded.
    pub fn is_unchanged(
        &self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        stamp: MediaStamp,
    ) -> bool {
        self.get(emulator, vm_name, source_path)
            .is_some_and(|entry| entry.stamp == stamp)
    }

    /// Records what a file holds now. Returns true if that is new work. The same content under a new
    /// timestamp keeps its state, so touching a file uploads nothing. New content replaces the entry.
    pub fn record(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        sha256: &str,
        stamp: MediaStamp,
    ) -> bool {
        let key = entry_key(emulator, vm_name, source_path);
        if let Some(entry) = self.entries.get_mut(&key)
            && entry.sha256 == sha256
        {
            if entry.stamp != stamp {
                entry.stamp = stamp;
                self.dirty = true;
            }
            return false;
        }
        self.entries.insert(
            key,
            QueueEntry {
                emulator_type: emulator,
                vm_name: vm_name.clone(),
                source_path: source_path.to_owned(),
                sha256: sha256.to_owned(),
                stamp,
                state: EntryState::Pending,
                attempts: 0,
                next_attempt_ms: 0,
                last_error: None,
            },
        );
        self.dirty = true;
        true
    }

    /// Records a file that will never be uploaded as it is, for example because of its size.
    pub fn record_failed(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        sha256: &str,
        stamp: MediaStamp,
        error: EntryError,
    ) {
        self.record(emulator, vm_name, source_path, sha256, stamp);
        let key = entry_key(emulator, vm_name, source_path);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.state = EntryState::Failed;
            entry.last_error = Some(error);
            self.dirty = true;
        }
    }

    /// Forgets the entries of files that are no longer there. The server keeps its copy: a local deletion
    /// never reaches it, and this only stops the agent from tracking a file that does not exist.
    pub fn forget_missing(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        present: &BTreeSet<String>,
    ) -> Vec<QueueEntry> {
        let prefix = format!("{}/", vm_key(emulator, vm_name));
        let gone: Vec<String> = self
            .entries
            .iter()
            .filter(|(key, entry)| {
                key.starts_with(&prefix)
                    && entry.state != EntryState::Uploading
                    && !present.contains(&entry.source_path)
            })
            .map(|(key, _)| key.clone())
            .collect();
        let mut removed = Vec::with_capacity(gone.len());
        for key in gone {
            if let Some(entry) = self.entries.remove(&key) {
                removed.push(entry);
                self.dirty = true;
            }
        }
        removed
    }

    /// Forgets everything about VMs this agent is no longer responsible for.
    pub fn retain_vms(&mut self, registered: &BTreeSet<String>) {
        let before = self.entries.len();
        self.entries
            .retain(|_, entry| registered.contains(&vm_key(entry.emulator_type, &entry.vm_name)));
        if self.entries.len() != before {
            self.dirty = true;
        }
    }

    pub fn remove(&mut self, emulator: EmulatorType, vm_name: &VmName, source_path: &str) {
        if self
            .entries
            .remove(&entry_key(emulator, vm_name, source_path))
            .is_some()
        {
            self.dirty = true;
        }
    }

    pub fn set_state(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        state: EntryState,
    ) {
        if let Some(entry) = self
            .entries
            .get_mut(&entry_key(emulator, vm_name, source_path))
            && entry.state != state
        {
            entry.state = state;
            if state == EntryState::Completed {
                entry.last_error = None;
                entry.attempts = 0;
                entry.next_attempt_ms = 0;
            }
            self.dirty = true;
        }
    }

    /// An attempt failed, and another may succeed.
    pub fn mark_retry(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        error: EntryError,
        now_ms: u64,
        policy: RetryPolicy,
    ) -> Option<Duration> {
        let entry = self
            .entries
            .get_mut(&entry_key(emulator, vm_name, source_path))?;
        entry.attempts = entry.attempts.saturating_add(1);
        let delay = retry_delay(entry.attempts, policy.initial, policy.ceiling);
        entry.state = EntryState::RetryWait;
        entry.next_attempt_ms = now_ms.saturating_add(delay.as_millis() as u64);
        entry.last_error = Some(error);
        self.dirty = true;
        Some(delay)
    }

    /// The bytes themselves were refused. They will not get better by being sent again.
    pub fn mark_failed(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        source_path: &str,
        error: EntryError,
    ) {
        if let Some(entry) = self
            .entries
            .get_mut(&entry_key(emulator, vm_name, source_path))
        {
            entry.attempts = entry.attempts.saturating_add(1);
            entry.state = EntryState::Failed;
            entry.last_error = Some(error);
            self.dirty = true;
        }
    }

    /// The connection is back, so whatever was waiting for it can go now.
    pub fn retry_now(&mut self) {
        for entry in self.entries.values_mut() {
            if entry.state == EntryState::RetryWait && entry.next_attempt_ms != 0 {
                entry.next_attempt_ms = 0;
                self.dirty = true;
            }
        }
    }

    /// Back to the start, for content the agent believed was uploaded and the server says it does not
    /// have. The server's word is what counts.
    pub fn requeue_hashes(
        &mut self,
        emulator: EmulatorType,
        vm_name: &VmName,
        hashes: &BTreeSet<String>,
    ) {
        let prefix = format!("{}/", vm_key(emulator, vm_name));
        for (key, entry) in &mut self.entries {
            if key.starts_with(&prefix)
                && entry.state == EntryState::Completed
                && hashes.contains(&entry.sha256)
            {
                entry.state = EntryState::Pending;
                self.dirty = true;
            }
        }
    }

    pub fn failure_of(
        &self,
        emulator: EmulatorType,
        vm_name: &VmName,
        sha256: &str,
    ) -> Option<&EntryError> {
        let prefix = format!("{}/", vm_key(emulator, vm_name));
        self.entries
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, entry)| entry)
            .find(|entry| entry.state == EntryState::Failed && entry.sha256 == sha256)
            .and_then(|entry| entry.last_error.as_ref())
    }

    /// What can be uploaded now.
    pub fn due(&self, now_ms: u64) -> Vec<QueueEntry> {
        self.entries
            .values()
            .filter(|entry| {
                entry.state == EntryState::Pending
                    || (entry.state == EntryState::RetryWait && entry.next_attempt_ms <= now_ms)
            })
            .cloned()
            .collect()
    }

    /// Counts for each VM with an entry. `registered` VMs with none are included too, as all zeros.
    pub fn status(
        &self,
        registered: impl IntoIterator<Item = (EmulatorType, VmName)>,
    ) -> Vec<MediaSyncVmStatus> {
        let mut statuses: BTreeMap<String, MediaSyncVmStatus> = BTreeMap::new();
        let blank = |emulator: EmulatorType, vm_name: &VmName| MediaSyncVmStatus {
            emulator_type: emulator,
            vm_name: vm_name.clone(),
            pending: 0,
            uploading: 0,
            synchronized: 0,
            failed: 0,
            last_error: None,
        };
        for (emulator, vm_name) in registered {
            statuses.insert(vm_key(emulator, &vm_name), blank(emulator, &vm_name));
        }
        for entry in self.entries.values() {
            let status = statuses
                .entry(vm_key(entry.emulator_type, &entry.vm_name))
                .or_insert_with(|| blank(entry.emulator_type, &entry.vm_name));
            match entry.state {
                EntryState::Pending | EntryState::RetryWait => status.pending += 1,
                EntryState::Uploading => status.uploading += 1,
                EntryState::Completed => status.synchronized += 1,
                EntryState::Failed => status.failed += 1,
            }
            if let Some(error) = &entry.last_error
                && entry.state != EntryState::Completed
                // A refusal says more than a passing network problem, so it is the one that stays.
                && (status.last_error.is_none() || entry.state == EntryState::Failed)
            {
                status.last_error = Some(MediaSyncError {
                    code: error.code.chars().take(64).collect(),
                    message: error.message.chars().take(256).collect(),
                    source_path: Some(entry.source_path.chars().take(256).collect()),
                });
            }
        }
        statuses.into_values().collect()
    }
}
