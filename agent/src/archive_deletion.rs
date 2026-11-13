//! Deleting one version's archive from a repository, when the server has recorded that the version is
//! deleted (decision 0041). The server never reaches a repository itself (decision 0012), so an agent
//! configured for it does this, through the same [`ArchiveRepository`] every other operation uses.
//!
//! Nothing here trusts the request for *what* to delete: the key is derived from the VM and the version
//! ID, as for every archive, and a request whose key differs is refused. An object of another size is not
//! the archive that was registered, and is left alone. Every step is idempotent, so this keeps no journal:
//! the server asks again until it has an answer, and an answer of `deleted` or `absent` is only given once
//! the agent has looked and found nothing at the key.

use std::sync::Arc;

use crate::archives::VersionId;
use crate::emulators::VmIdentity;
use crate::protocol::{ArchiveDelete, ArchiveDeleteOutcome, ArchiveDeleteResult};
use crate::registration::RepositoryProvider;
use crate::repository::{ArchiveRepository, RepositoryError, RepositoryKey};

fn failed(request: &ArchiveDelete, code: &str, message: impl Into<String>) -> ArchiveDeleteResult {
    let message: String = message.into();
    ArchiveDeleteResult {
        operation_id: request.operation_id,
        version_id: request.version_id,
        outcome: ArchiveDeleteOutcome::Failed,
        code: Some(code.to_owned()),
        message: Some(message.chars().take(1024).collect()),
    }
}

fn from_repository(request: &ArchiveDelete, error: &RepositoryError) -> ArchiveDeleteResult {
    failed(request, error.kind.code(), error.message.clone())
}

fn done(request: &ArchiveDelete, outcome: ArchiveDeleteOutcome) -> ArchiveDeleteResult {
    ArchiveDeleteResult {
        operation_id: request.operation_id,
        version_id: request.version_id,
        outcome,
        code: None,
        message: None,
    }
}

/// The key this agent would use for the requested version. Never the one the server sent.
pub fn derived_key(request: &ArchiveDelete) -> RepositoryKey {
    RepositoryKey::for_version(
        &VmIdentity {
            emulator_type: request.emulator_type,
            vm_name: request.vm_name.clone(),
        },
        VersionId(request.version_id),
    )
}

/// Deletes the archive, or says why not. Never deletes anything but the derived key.
pub async fn delete_archive(
    repositories: &Arc<dyn RepositoryProvider>,
    request: &ArchiveDelete,
) -> ArchiveDeleteResult {
    let key = derived_key(request);
    if key.as_str() != request.archive_key {
        return failed(
            request,
            "archive_key_mismatch",
            "The archive key does not belong to this version, so nothing was deleted",
        );
    }
    let repository: Arc<dyn ArchiveRepository> = match repositories.open(request.repository_id) {
        Ok(repository) => repository,
        Err(error) => return from_repository(request, &error),
    };
    match repository.stat(&key).await {
        Err(error) => return from_repository(request, &error),
        Ok(None) => return done(request, ArchiveDeleteOutcome::Absent),
        Ok(Some(found)) if found.size_bytes != request.archive_size_bytes => {
            return failed(
                request,
                "archive_mismatch",
                format!(
                    "The object at {} has {} bytes, not the {} that were registered, so it was left \
                     alone",
                    key.as_str(),
                    found.size_bytes,
                    request.archive_size_bytes
                ),
            );
        }
        Ok(Some(_)) => {}
    }
    if let Err(error) = repository.delete(&key).await {
        return from_repository(request, &error);
    }
    // Only what can be seen counts: a lost connection after the delete was sent is settled here, or by
    // the next attempt, which then finds nothing.
    match repository.stat(&key).await {
        Ok(None) => {
            tracing::info!(version_id = %request.version_id, key = key.as_str(), "Archive deleted");
            done(request, ArchiveDeleteOutcome::Deleted)
        }
        Ok(Some(_)) => failed(
            request,
            "archive_delete_unconfirmed",
            "The repository still lists the archive after deleting it",
        ),
        Err(error) => from_repository(request, &error),
    }
}
