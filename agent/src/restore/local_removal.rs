//! Removing the persistent local copy of a VM, when an administrator asks (decision 0041).
//!
//! This lives with restores because it is their mirror image: it gives up the copy a restore published,
//! with the checks a replacement makes before giving one up, under the same operation slot, and it
//! forgets the lineage record and local manifest a restore wrote.
//!
//! The order is what makes it safe to stop anywhere:
//!
//! 1. `checking`: the journal exists, and nothing has moved. The VM's directory is found under the
//!    configured base path, never from anything the server sent, and checked: a plain directory, the copy
//!    the administrator saw, and unchanged unless its changes may be discarded.
//! 2. `moving`: its path and volume/file ID are recorded, then it is renamed to
//!    `.emucat-removing-{operation}` in the same base path, which refuses to replace anything and, on
//!    Windows, fails while a file inside is open. After that no emulator, discovery or restore can find it.
//! 3. `removing`: the lineage record and local manifest are forgotten, and what was moved aside is deleted,
//!    only once it is checked to be that very directory.
//! 4. `reported`: the answer is repeated until the server closes it.
//!
//! A retry, a repeated command or a restart only ever deletes `.emucat-removing-{operation}` with the
//! recorded identity: never the VM's path again, so never a copy restored since or a directory that took
//! the name.

use super::*;
use crate::protocol::{
    LocalCopyRemove, LocalCopyRemoveAck, LocalCopyRemoveResult, LocalRemovalPhase,
    LocalRemovalSyncEntry,
};
use crate::removal::{RemovalRefusal, hash_excluded_files, quarantine_path};

/// Deleting what was moved aside is tried this many times before leftovers are reported.
const DELETE_ATTEMPTS: u32 = 3;
const DELETE_RETRY_DELAY: Duration = Duration::from_millis(500);

fn removals_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("local-removals")
}

/// Everything needed to carry on after a restart. No secret, and no path the server chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemovalJournal {
    request: LocalCopyRemove,
    phase: LocalRemovalPhase,
    /// The VM's directory as it was found, recorded before it moves.
    directory: Option<PathBuf>,
    /// Its identity, so that what was moved aside is recognized, and nothing else is ever deleted.
    identity: Option<DirectoryIdentity>,
    report: Option<LocalCopyRemoveResult>,
    /// The server has closed the answer; only leftovers remain to delete.
    #[serde(default)]
    closed: bool,
}

impl RemovalJournal {
    fn vm(&self) -> VmIdentity {
        VmIdentity {
            emulator_type: self.request.emulator_type,
            vm_name: self.request.vm_name.clone(),
        }
    }

    fn is_working(&self) -> bool {
        self.phase != LocalRemovalPhase::Reported
    }
}

pub(super) fn load_removals(state_dir: &Path) -> Result<HashMap<Uuid, RemovalJournal>, String> {
    let directory = removals_directory(state_dir);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
    let mut journals = HashMap::new();
    for item in fs::read_dir(&directory)
        .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
        .flatten()
    {
        let path = item.path();
        if path.extension().and_then(|text| text.to_str()) != Some("journal") {
            continue;
        }
        // A damaged journal must not make the agent guess. Without it the server reports the operation
        // as lost, which deletes nothing, and the file is kept for inspection.
        let Some(journal) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RemovalJournal>(&bytes).ok())
        else {
            tracing::error!(path = %path.display(), "Ignored a removal journal that cannot be read");
            continue;
        };
        journals.insert(journal.request.operation_id, journal);
    }
    Ok(journals)
}

/// Why something could not be removed, before or after anything moved.
struct RemovalFailure {
    code: String,
    message: String,
}

fn refused(code: &str, message: impl Into<String>) -> RemovalFailure {
    RemovalFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// What deleting the moved-aside directory came to.
enum Deleted {
    Gone,
    /// It is still there, for a reason that may pass. It will be tried again.
    Leftovers(String),
    /// It is not the directory that was moved aside, so it is never touched.
    NotOurs(String),
}

/// Deletes `.emucat-removing-{operation}`, if and only if it is a plain directory with the identity that
/// was recorded before it moved. `remove_dir_all` removes links and junctions inside it without following
/// them, so nothing outside it can be reached.
fn delete_moved_aside(aside: &Path, identity: DirectoryIdentity, attempts: u32) -> Deleted {
    let mut last = String::new();
    for attempt in 0..attempts.max(1) {
        match fs::symlink_metadata(aside) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Deleted::Gone,
            Err(error) => last = format!("Cannot examine {}: {error}", aside.display()),
            Ok(metadata) if crate::discovery::is_link_like(&metadata) || !metadata.is_dir() => {
                return Deleted::NotOurs(format!(
                    "{} is not a plain directory, so it was left alone",
                    aside.display()
                ));
            }
            Ok(_) => match directory_identity(aside) {
                Ok(found) if found != identity => {
                    return Deleted::NotOurs(format!(
                        "{} is not the directory that was moved aside, so it was left alone",
                        aside.display()
                    ));
                }
                Err(error) => last = format!("Cannot identify {}: {error}", aside.display()),
                Ok(_) => match fs::remove_dir_all(aside) {
                    Ok(()) => return Deleted::Gone,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Deleted::Gone;
                    }
                    Err(error) => last = format!("Deleting {} stopped: {error}", aside.display()),
                },
            },
        }
        if attempt + 1 < attempts {
            std::thread::sleep(DELETE_RETRY_DELAY);
        }
    }
    Deleted::Leftovers(last)
}

impl RestoreManager {
    fn removal_path(&self, operation_id: Uuid) -> PathBuf {
        removals_directory(&self.config.state_dir).join(format!("{operation_id}.journal"))
    }

    /// Replaces the journal atomically and durably, then the copy in memory.
    fn persist_removal(&self, journal: RemovalJournal) -> std::io::Result<()> {
        let operation_id = journal.request.operation_id;
        let path = self.removal_path(operation_id);
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&journal).expect("a journal always serializes");
        {
            use std::io::Write;
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &path)?;
        self.removals
            .lock()
            .expect("poisoned")
            .insert(operation_id, journal);
        Ok(())
    }

    fn removal(&self, operation_id: Uuid) -> Option<RemovalJournal> {
        self.removals
            .lock()
            .expect("poisoned")
            .get(&operation_id)
            .cloned()
    }

    fn forget_removal(&self, operation_id: Uuid) {
        self.removals
            .lock()
            .expect("poisoned")
            .remove(&operation_id);
        let _ = fs::remove_file(self.removal_path(operation_id));
    }

    /// Why `vm` must not be touched now, if its persistent copy is being removed.
    pub(super) fn removing(&self, vm: &VmIdentity) -> Option<String> {
        self.removals
            .lock()
            .expect("poisoned")
            .values()
            .find(|journal| journal.is_working() && journal.vm() == *vm)
            .map(|_| format!("The local copy of {} is being removed", vm.vm_name))
    }

    pub(super) fn removal_sync_entries(&self) -> Vec<LocalRemovalSyncEntry> {
        let mut entries: Vec<LocalRemovalSyncEntry> = self
            .removals
            .lock()
            .expect("poisoned")
            .values()
            .map(|journal| LocalRemovalSyncEntry {
                operation_id: journal.request.operation_id,
                phase: journal.phase,
            })
            .collect();
        entries.sort_by_key(|entry| entry.operation_id);
        entries.truncate(256);
        entries
    }

    /// Answers the server has not closed yet. Sent again on each heartbeat, as every other report is.
    pub(super) fn removal_reports(&self) -> Vec<Message> {
        self.removals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| !journal.closed)
            .filter_map(|journal| journal.report.clone())
            .map(Message::AgentLocalCopyRemoveResult)
            .collect()
    }

    /// Records the answer, then sends it. It is repeated until the server closes it.
    fn report_removal(&self, mut journal: RemovalJournal, report: LocalCopyRemoveResult) {
        let operation_id = journal.request.operation_id;
        journal.phase = LocalRemovalPhase::Reported;
        journal.report = Some(report.clone());
        journal.closed = false;
        if let Err(error) = self.persist_removal(journal) {
            tracing::error!(%error, %operation_id, "Cannot record a removal's answer");
        }
        // The slot is free before the answer leaves: a server that sends the next operation as soon as
        // it hears this one must not find the agent busy with it.
        self.running.lock().expect("poisoned").remove(&operation_id);
        self.send(Message::AgentLocalCopyRemoveResult(report));
    }

    fn report_refusal(&self, journal: RemovalJournal, failed: RemovalFailure) {
        tracing::warn!(
            operation_id = %journal.request.operation_id,
            code = %failed.code,
            message = %failed.message,
            "Local copy kept"
        );
        let report = LocalCopyRemoveResult {
            operation_id: journal.request.operation_id,
            removed: false,
            cleanup_pending: false,
            local_directory: journal
                .directory
                .as_ref()
                .map(|path| bounded(&path.display().to_string())),
            code: Some(failed.code),
            message: Some(bounded(&failed.message)),
        };
        self.report_removal(journal, report);
    }

    /// A command that failed validation still deserves an answer, if it can be identified. Nothing is
    /// journaled, since nothing can be done for it.
    pub fn refuse_invalid_removal(&self, operation_id: Uuid) {
        self.send(Message::AgentLocalCopyRemoveResult(LocalCopyRemoveResult {
            operation_id,
            removed: false,
            cleanup_pending: false,
            local_directory: None,
            code: Some("invalid_request".to_owned()),
            message: Some("The request failed validation".to_owned()),
        }));
    }

    pub(super) fn start_removal(self: &Arc<Self>, request: LocalCopyRemove) {
        let operation_id = request.operation_id;
        if let Some(existing) = self.removal(operation_id) {
            if existing.request != request {
                tracing::error!(%operation_id, "Refused a repeated removal with other identities");
            } else if let Some(report) = existing.report.filter(|_| !existing.closed) {
                // The answer may have been lost: say it again. Nothing is done twice.
                self.send(Message::AgentLocalCopyRemoveResult(report));
            }
            return;
        }
        let journal = RemovalJournal {
            request,
            phase: LocalRemovalPhase::Checking,
            directory: None,
            identity: None,
            report: None,
            closed: false,
        };
        let vm = journal.vm();
        // Every refusal is journaled too, so that it is repeated until the server has it.
        if let Some(reason) = self.vm_activity(&vm) {
            return self.report_refusal(
                journal,
                refused("vm_running", format!("{reason}. Nothing was removed")),
            );
        }
        if let Some(reason) = self.working_on(&vm) {
            return self.report_refusal(
                journal,
                refused(
                    "operation_in_progress",
                    format!("{reason}. Nothing was removed"),
                ),
            );
        }
        let cancel = CancelFlag::new();
        {
            let mut running = self.running.lock().expect("poisoned");
            if !running.is_empty() {
                drop(running);
                return self.report_refusal(
                    journal,
                    refused(
                        "agent_busy",
                        "This agent is busy with another operation. Nothing was removed",
                    ),
                );
            }
            // Claimed before anything is checked: no restore, registration, snapshot, verification or
            // discard can begin until this has finished, and a launch of this VM finds it being removed.
            running.insert(operation_id, cancel.clone());
        }
        if let Err(error) = self.persist_removal(journal.clone()) {
            self.running.lock().expect("poisoned").remove(&operation_id);
            tracing::error!(%error, %operation_id, "Cannot create a removal journal");
            self.send(Message::AgentLocalCopyRemoveResult(LocalCopyRemoveResult {
                operation_id,
                removed: false,
                cleanup_pending: false,
                local_directory: None,
                code: Some("internal_error".to_owned()),
                message: Some("The agent cannot write to its state directory".to_owned()),
            }));
            return;
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            tracing::info!(%operation_id, vm_name = %vm.vm_name, "Removing a local copy");
            let media = this.config.media.clone();
            let outcome = this.run_removal(operation_id, &cancel).await;
            if let Some(media) = &media {
                media.hold(&vm, false);
            }
            this.running.lock().expect("poisoned").remove(&operation_id);
            if this.stopping.is_cancelled() {
                // Left exactly as a crash would leave it. The next start deals with it.
                return;
            }
            let Some(journal) = this.removal(operation_id) else {
                return;
            };
            match outcome {
                Ok(()) => {}
                Err(failed) => this.report_refusal(journal, failed),
            }
        });
    }

    /// Everything up to and including the move aside. Success means the answer is recorded.
    async fn run_removal(
        self: &Arc<Self>,
        operation_id: Uuid,
        cancel: &CancelFlag,
    ) -> Result<(), RemovalFailure> {
        let journal = self
            .removal(operation_id)
            .ok_or_else(|| refused("internal_error", "The removal journal disappeared"))?;
        let request = journal.request.clone();
        let vm = journal.vm();
        let base = self.base_path(request.emulator_type).ok_or_else(|| {
            refused(
                "restore_emulator_not_configured",
                "This emulator is not configured on this agent, so it has no local copy to remove",
            )
        })?;

        // Found and checked as a replacement would be (decision 0040), and more strictly: a lineage
        // recorded for another directory is a stale request, whatever may be discarded.
        let (state_dir, check_base, check_cancel) =
            (self.config.state_dir.clone(), base.clone(), cancel.clone());
        let check_request = request.clone();
        let found = tokio::task::spawn_blocking(move || {
            check_base_path(&check_base)
                .map_err(|error| refused("local_copy_unsafe", error.message))?;
            check_disposable(
                &state_dir,
                &check_base,
                check_request.emulator_type,
                &check_request.vm_name,
                check_request.expected_version_id,
                check_request.discard_local_changes,
                true,
                &check_cancel,
            )
            .map_err(|failed| match failed.code.as_str() {
                "restore_destination_unsafe" | "restore_ambiguous_directory" => {
                    refused("local_copy_unsafe", failed.message)
                }
                _ => RemovalFailure {
                    code: failed.code,
                    message: failed.message,
                },
            })
        })
        .await
        .map_err(|_| refused("internal_error", "The check stopped unexpectedly"))??;

        // Screenshots are not in any archive, so removing the directory would lose any the server does not
        // hold. They are changes like any other: kept unless the administrator agreed to discard them.
        if !request.discard_local_changes {
            self.check_media_preserved(&vm, &found.path).await?;
        }
        if cancel.is_cancelled() {
            return Err(refused(
                "agent_restarted",
                "Stopped before anything was removed",
            ));
        }

        let aside = quarantine_path(&base, operation_id);
        let mut moving = journal.clone();
        moving.phase = LocalRemovalPhase::Moving;
        moving.directory = Some(found.path.clone());
        moving.identity = Some(found.identity);
        self.persist_removal(moving.clone()).map_err(|error| {
            refused(
                "internal_error",
                format!("Cannot record the removal before moving anything: {error}"),
            )
        })?;

        if let Some(media) = &self.config.media {
            // The watcher must not be reading a screenshot while the directory moves.
            media.hold(&vm, true);
        }
        let (from, to) = (found.path.clone(), aside.clone());
        let renamed = tokio::task::spawn_blocking(move || rename_no_replace(&from, &to))
            .await
            .map_err(|_| refused("internal_error", "The move stopped unexpectedly"))?;
        if let Err(error) = renamed {
            let code = if crate::packaging::is_in_use(&error)
                || error.kind() == std::io::ErrorKind::PermissionDenied
            {
                "local_copy_in_use"
            } else {
                "internal_error"
            };
            return Err(refused(
                code,
                format!(
                    "The local copy could not be moved aside, so a file in it may be in use: {error}. \
                     Nothing was removed"
                ),
            ));
        }
        let this = Arc::clone(self);
        tokio::task::spawn_blocking(move || this.finish_removal(moving, DELETE_ATTEMPTS))
            .await
            .map_err(|_| refused("internal_error", "The removal stopped unexpectedly"))?;
        Ok(())
    }

    async fn check_media_preserved(
        &self,
        vm: &VmIdentity,
        root: &Path,
    ) -> Result<(), RemovalFailure> {
        let (scan_root, emulator) = (root.to_path_buf(), vm.emulator_type);
        let excluded =
            tokio::task::spawn_blocking(move || hash_excluded_files(&scan_root, emulator))
                .await
                .map_err(|_| refused("internal_error", "The check stopped unexpectedly"))?
                .map_err(|error| {
                    let code = match error.refusal {
                        RemovalRefusal::InUse => "local_copy_in_use",
                        RemovalRefusal::Unsafe => "local_copy_unsafe",
                        _ => "local_copy_unsynced_media",
                    };
                    refused(code, format!("{}. Nothing was removed", error.message))
                })?;
        let Some(first) = excluded.first() else {
            return Ok(());
        };
        let Some(media) = &self.config.media else {
            return Err(refused(
                "local_copy_unsynced_media",
                format!(
                    "{} is a screenshot that is in no archive, and this agent cannot synchronize \
                     screenshots. Nothing was removed",
                    first.path
                ),
            ));
        };
        let hashes: Vec<String> = excluded.iter().map(|file| file.sha256.clone()).collect();
        let held = media.acknowledged(vm, &hashes).await.map_err(|_| {
            refused(
                "local_copy_unsynced_media",
                "The server could not confirm that it holds this copy's screenshots. Nothing was \
                 removed",
            )
        })?;
        if let Some(missing) = excluded.iter().find(|file| !held.contains(&file.sha256)) {
            media.request_sync(vm);
            return Err(refused(
                "local_copy_unsynced_media",
                format!(
                    "{} has not reached the server yet ({} screenshot(s) in total). Nothing was removed",
                    missing.path,
                    excluded.len()
                ),
            ));
        }
        Ok(())
    }

    /// From `moving`, once the rename has happened, or `removing`: forgets the copy, deletes what was moved
    /// aside, and records the answer. Blocking. Safe to repeat.
    fn finish_removal(&self, mut journal: RemovalJournal, attempts: u32) {
        let operation_id = journal.request.operation_id;
        let (Some(identity), Some(base)) = (
            journal.identity,
            self.base_path(journal.request.emulator_type),
        ) else {
            return self.report_refusal(
                journal,
                refused(
                    "restore_emulator_not_configured",
                    "This emulator is no longer configured, so the agent cannot find what it moved \
                     aside. Nothing more was removed",
                ),
            );
        };
        if journal.phase != LocalRemovalPhase::Removing {
            journal.phase = LocalRemovalPhase::Removing;
            if let Err(error) = self.persist_removal(journal.clone()) {
                tracing::error!(%error, %operation_id, "Cannot record that a local copy was moved aside");
            }
        }
        // The copy is no longer under the base path, so nothing must say there is one: no lineage that a
        // directory taking the name later could inherit, and no manifest to compare it with.
        let request = &journal.request;
        if let Err(error) = crate::state::forget_local_source(
            &self.config.state_dir,
            request.emulator_type,
            &request.vm_name,
        ) {
            tracing::error!(%error, %operation_id, "Cannot forget a removed copy's lineage");
        }
        let _ = fs::remove_file(local_manifest_path(
            &self.config.state_dir,
            request.emulator_type,
            &request.vm_name,
        ));

        let aside = quarantine_path(&base, operation_id);
        let (cleanup_pending, message) = match delete_moved_aside(&aside, identity, attempts) {
            Deleted::Gone => (false, None),
            Deleted::Leftovers(reason) => {
                tracing::warn!(%operation_id, %reason, "Leftovers of a removed copy remain; retrying later");
                (
                    true,
                    Some(format!(
                        "The local copy was removed. Some of its files, moved to {}, could not be \
                         deleted yet ({reason}); the agent keeps trying",
                        aside.display()
                    )),
                )
            }
            Deleted::NotOurs(reason) => {
                tracing::error!(%operation_id, %reason, "Left alone what is not the moved-aside copy");
                (false, Some(reason))
            }
        };
        tracing::info!(%operation_id, cleanup_pending, "Local copy removed");
        let report = LocalCopyRemoveResult {
            operation_id,
            removed: true,
            cleanup_pending,
            local_directory: journal
                .directory
                .as_ref()
                .map(|path| bounded(&path.display().to_string())),
            code: None,
            message: message.map(|text| bounded(&text)),
        };
        self.report_removal(journal, report);
    }

    pub(super) fn removal_acknowledged(&self, ack: &LocalCopyRemoveAck) {
        let Some(mut journal) = self.removal(ack.operation_id) else {
            return;
        };
        if journal.is_working() {
            // Nothing has been reported yet. A stray answer changes nothing.
            return;
        }
        let pending = journal
            .report
            .as_ref()
            .is_some_and(|report| report.removed && report.cleanup_pending);
        if pending {
            journal.closed = true;
            if let Err(error) = self.persist_removal(journal) {
                tracing::warn!(%error, "Cannot record that a removal was closed");
            }
        } else {
            self.forget_removal(ack.operation_id);
        }
    }

    /// Settles what a crash interrupted. The disk decides; nothing here touches a directory that this
    /// agent cannot prove it moved aside.
    pub(super) fn recover_removals(&self) {
        let journals: Vec<RemovalJournal> = self
            .removals
            .lock()
            .expect("poisoned")
            .values()
            .cloned()
            .collect();
        for journal in journals {
            match journal.phase {
                LocalRemovalPhase::Checking => self.report_refusal(
                    journal,
                    refused(
                        "agent_restarted",
                        "The agent restarted before it moved the local copy aside. Nothing was removed",
                    ),
                ),
                LocalRemovalPhase::Moving => self.resolve_moving(journal),
                LocalRemovalPhase::Removing => self.finish_removal(journal, 1),
                LocalRemovalPhase::Reported => {}
            }
        }
        self.retry_leftovers(1);
    }

    /// The agent stopped around the rename. Moved aside with the recorded identity: it finishes. Still in
    /// place with that identity: nothing happened. Anything else is left alone, and said.
    fn resolve_moving(&self, journal: RemovalJournal) {
        let (Some(identity), Some(base)) = (
            journal.identity,
            self.base_path(journal.request.emulator_type),
        ) else {
            return self.report_refusal(
                journal,
                refused(
                    "restore_emulator_not_configured",
                    "This emulator is no longer configured, so the agent cannot tell whether the copy \
                     was moved aside. Check its base path",
                ),
            );
        };
        let aside = quarantine_path(&base, journal.request.operation_id);
        let is = |path: &Path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| {
                !crate::discovery::is_link_like(&metadata) && metadata.is_dir()
            }) && directory_identity(path).ok() == Some(identity)
        };
        if is(&aside) {
            return self.finish_removal(journal, 1);
        }
        let still_in_place = journal.directory.as_deref().is_some_and(is);
        if still_in_place {
            return self.report_refusal(
                journal,
                refused(
                    "agent_restarted",
                    "The agent restarted before it moved the local copy aside. Nothing was removed",
                ),
            );
        }
        self.report_refusal(
            journal,
            refused(
                "local_copy_missing",
                "The agent restarted while moving the local copy aside, and finds it neither in place \
                 nor moved aside. Nothing was deleted; check the base path",
            ),
        );
    }

    /// Deletes leftovers of removals that already answered. Repeated at each start and connection until
    /// they are gone; the answer is then updated, so that the server stops showing them.
    pub(super) fn retry_leftovers(&self, attempts: u32) {
        let pending: Vec<RemovalJournal> = self
            .removals
            .lock()
            .expect("poisoned")
            .values()
            .filter(|journal| {
                !journal.is_working()
                    && journal
                        .report
                        .as_ref()
                        .is_some_and(|report| report.removed && report.cleanup_pending)
            })
            .cloned()
            .collect();
        for journal in pending {
            let (Some(identity), Some(base)) = (
                journal.identity,
                self.base_path(journal.request.emulator_type),
            ) else {
                continue;
            };
            let aside = quarantine_path(&base, journal.request.operation_id);
            match delete_moved_aside(&aside, identity, attempts) {
                Deleted::Gone | Deleted::NotOurs(_) => {
                    let Some(mut report) = journal.report.clone() else {
                        continue;
                    };
                    report.cleanup_pending = false;
                    report.message = None;
                    tracing::info!(operation_id = %journal.request.operation_id, "Leftovers of a removed copy deleted");
                    self.report_removal(journal, report);
                }
                Deleted::Leftovers(_) => {}
            }
        }
    }
}
