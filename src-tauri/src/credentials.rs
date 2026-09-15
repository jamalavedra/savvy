//! Transcription secrets stay in the signed-in user's native credential store.
const SERVICE: &str = "com.alamaslabs.savvy.transcription";

#[cfg(target_os = "macos")]
pub fn get(provider: &str) -> Result<Option<Vec<u8>>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, provider) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == -25_300 => Ok(None),
        Err(error) => Err(format!("could not read API key from Keychain: {error}")),
    }
}

#[cfg(target_os = "macos")]
pub fn set(provider: &str, secret: &[u8]) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, provider, secret)
        .map_err(|error| format!("could not save API key in Keychain: {error}"))
}

#[cfg(target_os = "macos")]
pub fn delete(provider: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, provider) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25_300 => Ok(()),
        Err(error) => Err(format!("could not delete API key from Keychain: {error}")),
    }
}

#[cfg(target_os = "windows")]
mod windows_store {
    use super::SERVICE;
    use windows::{
        core::{HRESULT, PCWSTR, PWSTR},
        Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*},
    };

    fn target(provider: &str) -> Vec<u16> {
        format!("{SERVICE}/{provider}\0").encode_utf16().collect()
    }

    pub fn get(provider: &str) -> Result<Option<Vec<u8>>, String> {
        let target = target(provider);
        let mut credential = std::ptr::null_mut();
        // The target is NUL-terminated and lives through the call. CredReadW
        // allocates the returned structure; copy its blob before freeing it.
        match unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        } {
            Ok(()) => {
                let value = unsafe {
                    let entry = &*credential;
                    let value = if entry.CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(
                            entry.CredentialBlob,
                            entry.CredentialBlobSize as usize,
                        )
                        .to_vec()
                    };
                    CredFree(credential.cast());
                    value
                };
                Ok(Some(value))
            }
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(None),
            Err(error) => Err(format!(
                "could not read API key from Windows Credential Manager: {error}"
            )),
        }
    }

    pub fn set(provider: &str, secret: &[u8]) -> Result<(), String> {
        if secret.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err("API key is too long for Windows Credential Manager".into());
        }
        let mut target = target(provider);
        let entry = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: secret.len() as u32,
            CredentialBlob: secret.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // CredWriteW copies the blob; both borrowed buffers outlive this call.
        unsafe { CredWriteW(&entry, 0) }.map_err(|error| {
            format!("could not save API key in Windows Credential Manager: {error}")
        })
    }

    pub fn delete(provider: &str) -> Result<(), String> {
        let target = target(provider);
        // The UTF-16 target remains alive and NUL-terminated for the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(error) => Err(format!(
                "could not delete API key from Windows Credential Manager: {error}"
            )),
        }
    }

    #[test]
    fn disposable_credential_can_be_replaced_and_deleted() {
        let provider = format!("test-{}", uuid::Uuid::new_v4());
        assert_eq!(get(&provider).unwrap(), None);
        set(&provider, b"synthetic-secret").unwrap();
        let first = get(&provider);
        let replacement = set(&provider, b"replacement");
        let second = get(&provider);
        delete(&provider).unwrap();
        assert_eq!(first.unwrap(), Some(b"synthetic-secret".to_vec()));
        replacement.unwrap();
        assert_eq!(second.unwrap(), Some(b"replacement".to_vec()));
        assert_eq!(get(&provider).unwrap(), None);
        delete(&provider).unwrap();
        assert!(set(
            &provider,
            &vec![0; CRED_MAX_CREDENTIAL_BLOB_SIZE as usize + 1]
        )
        .is_err());
    }
}

#[cfg(target_os = "windows")]
pub use windows_store::{delete, get, set};
