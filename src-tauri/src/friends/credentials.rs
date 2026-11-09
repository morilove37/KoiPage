//! Current user's Windows vault only. No tokens in the library, backup or frontend.
use super::model::Tokens;
use crate::commands::error::{CmdError, CmdResult};
use sha2::{Digest, Sha256};
fn target(server: &str) -> String {
    format!("KoiPage/Friends/{:x}", Sha256::digest(server))
}
fn encode(tokens: &Tokens) -> CmdResult<Vec<u8>> {
    let data = serde_json::to_vec(tokens).map_err(|_| error())?;
    if data.len() > 2560 {
        return Err(error());
    }
    Ok(data)
}
fn decode(data: &[u8]) -> CmdResult<Tokens> {
    let tokens: Tokens = serde_json::from_slice(data).map_err(|_| error())?;
    if tokens.access_token.is_empty()
        || tokens.refresh_token.is_empty()
        || tokens.access_token.bytes().any(|b| !b.is_ascii_graphic())
        || tokens.refresh_token.bytes().any(|b| !b.is_ascii_graphic())
    {
        return Err(error());
    }
    Ok(tokens)
}
fn error() -> CmdError {
    CmdError("FRIENDS_CREDENTIAL: 无法读取或保存 Windows 登录凭据，请重新登录".into())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{ERROR_NOT_FOUND, GetLastError},
        Security::Credentials::{
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
            CredReadW, CredWriteW,
        },
    };
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    pub fn load(server: &str) -> CmdResult<Option<Tokens>> {
        let name = wide(&target(server));
        let mut ptr = std::ptr::null_mut();
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(error())
            };
        }
        if ptr.is_null() {
            return Err(error());
        }
        struct Guard(*mut CREDENTIALW);
        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe {
                    CredFree(self.0.cast());
                }
            }
        }
        let guard = Guard(ptr);
        let entry = unsafe { &*guard.0 };
        if entry.CredentialBlob.is_null()
            || entry.CredentialBlobSize == 0
            || entry.CredentialBlobSize > 2560
        {
            return Err(error());
        }
        decode(unsafe {
            std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize)
        })
        .map(Some)
    }
    pub fn save(server: &str, tokens: &Tokens) -> CmdResult<()> {
        let data = encode(tokens)?;
        let mut name = wide(&target(server));
        let mut user = wide("KoiPage Friends Session");
        let entry = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            CredentialBlobSize: data.len() as u32,
            CredentialBlob: data.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: user.as_mut_ptr(),
            ..Default::default()
        };
        if unsafe { CredWriteW(&entry, 0) } == 0 {
            Err(error())
        } else {
            Ok(())
        }
    }
    pub fn delete(server: &str) -> CmdResult<()> {
        let name = wide(&target(server));
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
            && unsafe { GetLastError() } != ERROR_NOT_FOUND
        {
            Err(error())
        } else {
            Ok(())
        }
    }
}
#[cfg(windows)]
pub use platform::{delete, load, save};
#[cfg(not(windows))]
pub fn load(_server: &str) -> CmdResult<Option<Tokens>> {
    Ok(None)
}
#[cfg(not(windows))]
pub fn save(_server: &str, _tokens: &Tokens) -> CmdResult<()> {
    Err(error())
}
#[cfg(not(windows))]
pub fn delete(_server: &str) -> CmdResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_credentials_are_rejected_without_echoing_the_blob() {
        let message = decode(b"token=private").err().unwrap().0;
        assert!(!message.contains("private"));
    }
    #[test]
    fn different_project_origins_have_separate_credential_targets() {
        assert_ne!(
            target("https://a.supabase.co"),
            target("https://b.supabase.co")
        );
    }
}
