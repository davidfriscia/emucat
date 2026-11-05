//! Where the agent keeps its credential.
//!
//! [`CredentialStore`] is the portable interface. Windows implements it with DPAPI, scoped to the
//! user running the agent. macOS Keychain and Linux Secret Service are meant to implement the same
//! trait; until they exist, [`platform_store`] on those systems returns a store that refuses to work,
//! rather than one that falls back to plaintext. The credential is never in the configuration file,
//! a log, or a command-line argument.

use std::fmt;
use std::path::Path;
#[cfg(any(windows, test))]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

/// A bearer token. It can only be read through [`Secret::expose`], and never prints itself.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret(***)")
    }
}

/// What pairing produced. The server's origin is kept alongside the credential, so that changing
/// `server.api_url` cannot send a credential to a server that never issued it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCredential {
    pub server_origin: String,
    pub agent_id: Uuid,
    pub credential: Secret,
}

impl StoredCredential {
    pub fn belongs_to(&self, api_url: &Url) -> bool {
        self.server_origin == server_origin(api_url)
    }
}

/// The part of a server's address that identifies it: scheme, host and port.
pub fn server_origin(api_url: &Url) -> String {
    api_url.origin().ascii_serialization()
}

#[derive(Debug, Error)]
pub enum CredentialError {
    /// The store exists but cannot be read: a different Windows account, a damaged profile, or a file
    /// that was tampered with. Nothing is deleted; the user decides what happens next.
    #[error(
        "the stored credential cannot be decrypted by this account: {0}. If the agent moved to \
         another account or computer, revoke it in the web app and run `emucat-agent pair --force`"
    )]
    Unreadable(String),
    #[error("the credential store is not available: {0}")]
    Unavailable(String),
    #[error("cannot access the credential file {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
}

pub trait CredentialStore: Send + Sync {
    /// `Ok(None)` means the agent has never been paired, or has been unpaired.
    fn load(&self) -> Result<Option<StoredCredential>, CredentialError>;
    /// Replaces any existing credential atomically.
    fn save(&self, credential: &StoredCredential) -> Result<(), CredentialError>;
    /// Removes the credential. Removing one that does not exist is not an error.
    fn delete(&self) -> Result<(), CredentialError>;
}

/// Holds a credential in memory only. For tests of what uses a store.
#[derive(Default)]
pub struct MemoryCredentialStore {
    value: std::sync::Mutex<Option<StoredCredential>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn load(&self) -> Result<Option<StoredCredential>, CredentialError> {
        Ok(self.value.lock().expect("poisoned").clone())
    }

    fn save(&self, credential: &StoredCredential) -> Result<(), CredentialError> {
        *self.value.lock().expect("poisoned") = Some(credential.clone());
        Ok(())
    }

    fn delete(&self) -> Result<(), CredentialError> {
        *self.value.lock().expect("poisoned") = None;
        Ok(())
    }
}

/// Refuses everything, on platforms that have no secure store implemented yet.
pub struct UnsupportedCredentialStore;

impl CredentialStore for UnsupportedCredentialStore {
    fn load(&self) -> Result<Option<StoredCredential>, CredentialError> {
        Err(unsupported())
    }

    fn save(&self, _credential: &StoredCredential) -> Result<(), CredentialError> {
        Err(unsupported())
    }

    fn delete(&self) -> Result<(), CredentialError> {
        Err(unsupported())
    }
}

fn unsupported() -> CredentialError {
    CredentialError::Unavailable(format!(
        "no secure credential store is implemented for {} yet",
        std::env::consts::OS
    ))
}

/// Turns plaintext into something only the right user can read back.
#[cfg(any(windows, test))]
trait Protector: Send + Sync {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, CredentialError>;
    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, CredentialError>;
}

/// A credential in a file of its own, protected by a [`Protector`].
#[cfg(any(windows, test))]
struct ProtectedFileStore<P> {
    path: PathBuf,
    protector: P,
}

#[cfg(any(windows, test))]
const CREDENTIAL_FILE: &str = "credential.dpapi";

#[cfg(any(windows, test))]
impl<P: Protector> ProtectedFileStore<P> {
    fn io_error(&self, source: std::io::Error) -> CredentialError {
        CredentialError::Io {
            path: self.path.display().to_string(),
            source,
        }
    }
}

#[cfg(any(windows, test))]
impl<P: Protector> CredentialStore for ProtectedFileStore<P> {
    fn load(&self) -> Result<Option<StoredCredential>, CredentialError> {
        let protected = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(self.io_error(error)),
        };
        let plaintext = self.protector.unprotect(&protected)?;
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| CredentialError::Unreadable("its contents are not valid".to_owned()))
    }

    fn save(&self, credential: &StoredCredential) -> Result<(), CredentialError> {
        let plaintext = serde_json::to_vec(credential)
            .map_err(|error| CredentialError::Unavailable(error.to_string()))?;
        let protected = self.protector.protect(&plaintext)?;
        if let Some(directory) = self.path.parent() {
            std::fs::create_dir_all(directory).map_err(|error| self.io_error(error))?;
        }
        // Rename replaces atomically, so a crash leaves the old credential or the new one, not half.
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, protected).map_err(|error| self.io_error(error))?;
        std::fs::rename(&temporary, &self.path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            self.io_error(error)
        })
    }

    fn delete(&self) -> Result<(), CredentialError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(self.io_error(error)),
        }
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ptr;

    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    use super::{CredentialError, Protector};

    /// Binds a blob to this use, so that another program's DPAPI data cannot be swapped in.
    const ENTROPY: &[u8] = b"emucat-agent-credential-v1";

    /// Scoped to the current user: without `CRYPTPROTECT_LOCAL_MACHINE`, another account on this
    /// computer cannot decrypt the data. No flag asks for UI, so this cannot block a headless agent.
    pub struct Dpapi;

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        }
    }

    /// Copies out and frees what DPAPI allocated with `LocalAlloc`.
    ///
    /// # Safety
    /// `output` must have been filled in by a successful DPAPI call.
    unsafe fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success, DPAPI returns a valid allocation of `cbData` bytes that we now own.
        unsafe {
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData.cast());
            bytes
        }
    }

    impl Protector for Dpapi {
        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, CredentialError> {
            let input = blob(plaintext);
            let entropy = blob(ENTROPY);
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: ptr::null_mut(),
            };
            // SAFETY: every pointer is valid for the call, and DPAPI does not write through the
            // input blobs despite their mutable pointer type.
            let succeeded = unsafe {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if succeeded == 0 {
                // SAFETY: no preconditions.
                let code = unsafe { GetLastError() };
                return Err(CredentialError::Unavailable(format!(
                    "DPAPI could not encrypt (error {code})"
                )));
            }
            // SAFETY: the call succeeded.
            Ok(unsafe { take(output) })
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, CredentialError> {
            let input = blob(protected);
            let entropy = blob(ENTROPY);
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: ptr::null_mut(),
            };
            // SAFETY: as for `CryptProtectData`.
            let succeeded = unsafe {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if succeeded == 0 {
                // SAFETY: no preconditions.
                let code = unsafe { GetLastError() };
                return Err(CredentialError::Unreadable(format!("DPAPI error {code}")));
            }
            // SAFETY: the call succeeded.
            Ok(unsafe { take(output) })
        }
    }
}

/// The store for this platform.
#[cfg(windows)]
pub fn platform_store(state_dir: &Path) -> Box<dyn CredentialStore> {
    Box::new(ProtectedFileStore {
        path: state_dir.join(CREDENTIAL_FILE),
        protector: dpapi::Dpapi,
    })
}

/// The store for this platform.
#[cfg(not(windows))]
pub fn platform_store(_state_dir: &Path) -> Box<dyn CredentialStore> {
    Box::new(UnsupportedCredentialStore)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Reversing;

    impl Protector for Reversing {
        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, CredentialError> {
            Ok(plaintext.iter().rev().copied().collect())
        }
        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>, CredentialError> {
            Ok(protected.iter().rev().copied().collect())
        }
    }

    fn sample() -> StoredCredential {
        StoredCredential {
            server_origin: "https://emucat.example".to_owned(),
            agent_id: Uuid::nil(),
            credential: Secret::new("emucat_agent_very_secret_value"),
        }
    }

    #[test]
    fn a_secret_never_prints_itself() {
        let text = format!("{:?}", sample());
        assert!(!text.contains("very_secret"), "{text}");
    }

    #[test]
    fn a_credential_is_tied_to_its_server() {
        let credential = sample();
        assert!(credential.belongs_to(&"https://emucat.example/base/".parse().unwrap()));
        assert!(!credential.belongs_to(&"https://other.example".parse().unwrap()));
        assert!(!credential.belongs_to(&"http://emucat.example".parse().unwrap()));
        assert!(!credential.belongs_to(&"https://emucat.example:8443".parse().unwrap()));
    }

    #[test]
    fn the_file_store_round_trips_and_replaces_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let store = ProtectedFileStore {
            path: directory.path().join("nested").join(CREDENTIAL_FILE),
            protector: Reversing,
        };
        assert_eq!(store.load().unwrap(), None);
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));

        let mut other = sample();
        other.agent_id = Uuid::from_u128(7);
        store.save(&other).unwrap();
        assert_eq!(store.load().unwrap(), Some(other));

        let names: Vec<_> = std::fs::read_dir(store.path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [CREDENTIAL_FILE], "no temporary file is left behind");

        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn a_damaged_file_is_reported_and_kept() {
        let directory = tempfile::tempdir().unwrap();
        let store = ProtectedFileStore {
            path: directory.path().join(CREDENTIAL_FILE),
            protector: Reversing,
        };
        std::fs::write(&store.path, b"not json").unwrap();
        assert!(matches!(store.load(), Err(CredentialError::Unreadable(_))));
        assert!(store.path.exists());
    }

    #[test]
    fn the_unsupported_store_refuses_rather_than_falling_back() {
        assert!(UnsupportedCredentialStore.load().is_err());
        assert!(UnsupportedCredentialStore.save(&sample()).is_err());
        assert!(UnsupportedCredentialStore.delete().is_err());
    }

    #[cfg(windows)]
    mod windows {
        use super::*;

        #[test]
        fn dpapi_round_trips_and_stores_no_plaintext() {
            let directory = tempfile::tempdir().unwrap();
            let store = platform_store(directory.path());
            store.save(&sample()).unwrap();
            assert_eq!(store.load().unwrap(), Some(sample()));

            let file = std::fs::read(directory.path().join(CREDENTIAL_FILE)).unwrap();
            let needle = b"very_secret";
            assert!(!file.windows(needle.len()).any(|part| part == needle));
            assert!(!file.windows(6).any(|part| part == b"emucat"));
        }

        #[test]
        fn dpapi_refuses_a_tampered_file() {
            let directory = tempfile::tempdir().unwrap();
            let store = platform_store(directory.path());
            store.save(&sample()).unwrap();
            let path = directory.path().join(CREDENTIAL_FILE);
            let mut bytes = std::fs::read(&path).unwrap();
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0xff;
            std::fs::write(&path, bytes).unwrap();
            assert!(matches!(store.load(), Err(CredentialError::Unreadable(_))));
        }

        #[test]
        fn dpapi_refuses_a_blob_made_for_another_purpose() {
            // A different entropy value stands in for another program's, or another account's, data.
            let directory = tempfile::tempdir().unwrap();
            let store = platform_store(directory.path());
            std::fs::write(directory.path().join(CREDENTIAL_FILE), [1u8; 64]).unwrap();
            assert!(matches!(store.load(), Err(CredentialError::Unreadable(_))));
        }
    }
}
