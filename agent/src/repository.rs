//! Storage for version archives, independent of how a provider reaches it.
//!
//! The registration workflow only sees [`ArchiveRepository`] and [`RepositoryKey`], so a future HTTPS
//! provider needs no change to VM identity, version identity, the manifest or the state machine. Every
//! key is relative to the repository's root and is validated by construction, and a final key is never
//! written directly: objects are uploaded to a staging key, verified, and then published with a
//! provider-specific operation that must refuse to overwrite. See decision 0012.

use std::path::Path;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use thiserror::Error;
use tokio::sync::watch;
use uuid::Uuid;

use crate::archives::{VersionId, archive_object_key};
use crate::emulators::VmIdentity;

pub const REPOSITORY_STAGING_PREFIX: &str = "archives/.staging";

/// A validated, repository-relative object key. It can never name something outside the repository
/// root, because it holds only plain segments of a conservative alphabet.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepositoryKey(String);

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[error("not a valid repository key")]
pub struct InvalidRepositoryKey;

impl RepositoryKey {
    pub fn new(key: impl Into<String>) -> Result<Self, InvalidRepositoryKey> {
        let key = key.into();
        if key.is_empty() || key.len() > 512 {
            return Err(InvalidRepositoryKey);
        }
        let valid_segment = |segment: &str| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._ -".contains(&byte))
        };
        if !key.split('/').all(valid_segment) {
            return Err(InvalidRepositoryKey);
        }
        Ok(Self(key))
    }

    /// Where a version's archive lives. Built from the version ID, never from a display name.
    pub fn for_version(identity: &VmIdentity, version: VersionId) -> Self {
        Self::new(archive_object_key(identity, version))
            .expect("VM names and UUIDs only produce valid keys")
    }

    /// Incomplete objects stay under this prefix, so nothing can mistake one for an archive.
    pub fn staging(operation_id: Uuid) -> Self {
        Self::new(format!("{REPOSITORY_STAGING_PREFIX}/{operation_id}.part"))
            .expect("a UUID only produces a valid key")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_staging(&self) -> bool {
        self.0.starts_with(REPOSITORY_STAGING_PREFIX)
    }

    /// The keys of the directories above this one, shortest first.
    pub fn parents(&self) -> Vec<&str> {
        self.0
            .match_indices('/')
            .map(|(index, _)| &self.0[..index])
            .collect()
    }
}

/// Cooperative cancellation, shared between async tasks and blocking work.
#[derive(Debug, Clone)]
pub struct CancelFlag {
    sender: Arc<watch::Sender<bool>>,
}

impl Default for CancelFlag {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelFlag {
    pub fn new() -> Self {
        Self {
            sender: Arc::new(watch::channel(false).0),
        }
    }

    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

/// Bytes done and bytes in total.
pub type ProgressFn = Arc<dyn Fn(u64, u64) + Send + Sync>;

pub fn no_progress() -> ProgressFn {
    Arc::new(|_, _| {})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepositoryErrorKind {
    NotConfigured,
    Unreachable,
    AuthenticationFailed,
    HostKeyUnknown,
    HostKeyChanged,
    PermissionDenied,
    InsufficientSpace,
    Interrupted,
    NotFound,
    AlreadyExists,
    PublicationUnsupported,
    HashMismatch,
    Cancelled,
    Protocol,
}

impl RepositoryErrorKind {
    /// Stable code, shared with `REGISTRATION_ERROR_CODES` in the contracts.
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotConfigured => "repository_not_configured",
            Self::Unreachable => "repository_unreachable",
            Self::AuthenticationFailed => "ssh_authentication_failed",
            Self::HostKeyUnknown => "host_key_unknown",
            Self::HostKeyChanged => "host_key_changed",
            Self::PermissionDenied => "repository_permission_denied",
            Self::InsufficientSpace => "insufficient_remote_space",
            Self::Interrupted => "upload_interrupted",
            Self::NotFound => "remote_object_missing",
            Self::AlreadyExists => "archive_exists",
            Self::PublicationUnsupported => "publication_unsupported",
            Self::HashMismatch => "hash_mismatch",
            Self::Cancelled => "cancelled",
            Self::Protocol => "repository_error",
        }
    }

    /// Whether trying again could help. A wrong key or a full disk will not fix itself.
    pub const fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::Unreachable | Self::Interrupted | Self::HashMismatch
        )
    }
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct RepositoryError {
    pub kind: RepositoryErrorKind,
    pub message: String,
}

impl RepositoryError {
    pub fn new(kind: RepositoryErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn cancelled() -> Self {
        Self::new(
            RepositoryErrorKind::Cancelled,
            "The operation was cancelled",
        )
    }
}

pub type RepositoryResult<T> = Result<T, RepositoryError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMetadata {
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedObject {
    pub size_bytes: u64,
    pub sha256: String,
}

/// What a health check established. Each field was tested, not assumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub host_key_fingerprint: Option<String>,
    pub root_readable: bool,
    pub root_writable: bool,
    pub no_overwrite_publication: bool,
    pub free_bytes: Option<u64>,
}

/// An archive store. Implementations hold their own configuration, which callers cannot override per
/// call: a request can name a repository, and never a host or a path.
pub trait ArchiveRepository: Send + Sync {
    /// Connects, authenticates, and proves read, write and no-overwrite publication with a uniquely
    /// named test object that it removes again. It never touches an existing archive.
    fn health_check<'a>(
        &'a self,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<HealthReport>>;

    fn stat<'a>(
        &'a self,
        key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<Option<ObjectMetadata>>>;

    /// Free space for new objects, when the provider can tell.
    fn free_space(&self) -> BoxFuture<'_, RepositoryResult<Option<u64>>>;

    /// Streams a local file to a staging key, replacing any earlier attempt at that key. Refuses any
    /// key that is not a staging key: final keys are only ever written by [`Self::publish`].
    fn upload<'a>(
        &'a self,
        key: &'a RepositoryKey,
        source: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<ObjectMetadata>>;

    /// Streams an object to a new local file, and returns what was received.
    fn download<'a>(
        &'a self,
        key: &'a RepositoryKey,
        destination: &'a Path,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>>;

    /// Reads the stored bytes back through the agent, and compares them with what was expected.
    fn verify<'a>(
        &'a self,
        key: &'a RepositoryKey,
        expected_size: u64,
        expected_sha256: &'a str,
        progress: ProgressFn,
        cancel: &'a CancelFlag,
    ) -> BoxFuture<'a, RepositoryResult<VerifiedObject>>;

    /// Makes a verified staging object visible at its final key, atomically, and fails with
    /// [`RepositoryErrorKind::AlreadyExists`] rather than ever replacing an object.
    fn publish<'a>(
        &'a self,
        staging: &'a RepositoryKey,
        final_key: &'a RepositoryKey,
    ) -> BoxFuture<'a, RepositoryResult<()>>;

    /// Removes an object. An object that does not exist is not an error.
    fn delete<'a>(&'a self, key: &'a RepositoryKey) -> BoxFuture<'a, RepositoryResult<()>>;
}
