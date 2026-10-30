//! The PAT is stored only in the current Windows user's Credential Manager.
//! Only the sync backend and official Bangumi metadata client use this token;
//! no command returns it to the frontend.
use crate::commands::error::{CmdError, CmdResult};

const TARGET: &str = "KoiPage/Bangumi/PersonalAccessToken";
const MAX_BLOB_SIZE: usize = 2560;

fn validate_token(token: &str) -> CmdResult<()> {
    if token.is_empty()
        || token.len() > MAX_BLOB_SIZE
        || token.bytes().any(|b| !b.is_ascii_graphic())
    {
        return Err(CmdError(
            "BGM_CREDENTIAL_INPUT: Bangumi 令牌格式无效".into(),
        ));
    }
    Ok(())
}
fn decode_blob(bytes: &[u8]) -> CmdResult<String> {
    let token = std::str::from_utf8(bytes).map_err(|_| {
        CmdError("BGM_CREDENTIAL_DATA: 已保存的 Bangumi 令牌损坏，请重新连接".into())
    })?;
    validate_token(token).map_err(|_| {
        CmdError("BGM_CREDENTIAL_DATA: 已保存的 Bangumi 令牌损坏，请重新连接".into())
    })?;
    Ok(token.to_owned())
}

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, GetLastError},
    Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    },
};

#[cfg(windows)]
fn os_error(operation: &str, code: u32) -> CmdError {
    // Numeric Win32 codes identify failures without including credentials or API response text.
    CmdError(format!(
        "BGM_CREDENTIAL_{operation}: Windows 凭据管理器操作失败（{code}）"
    ))
}
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn read_target(target: &str) -> CmdResult<Option<String>> {
    let target = wide(target);
    let mut credential = std::ptr::null_mut();
    // SAFETY: target is NUL terminated, and credential is a valid output pointer.
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_NOT_FOUND {
            return Ok(None);
        }
        return Err(os_error("READ", code));
    }
    struct Guard(*mut CREDENTIALW);
    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: this allocation was returned by CredReadW and is freed exactly once.
            unsafe {
                CredFree(self.0.cast());
            }
        }
    }
    if credential.is_null() {
        return Err(os_error("READ", 0));
    }
    let allocation = Guard(credential);
    // SAFETY: successful CredReadW owns a CREDENTIALW until Guard drops.
    let entry = unsafe { &*allocation.0 };
    if entry.CredentialBlob.is_null()
        || entry.CredentialBlobSize == 0
        || entry.CredentialBlobSize as usize > MAX_BLOB_SIZE
    {
        return Err(CmdError(
            "BGM_CREDENTIAL_DATA: 已保存的 Bangumi 令牌损坏，请重新连接".into(),
        ));
    }
    // SAFETY: Windows provides CredentialBlobSize bytes in this allocation.
    let bytes = unsafe {
        std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize)
    };
    decode_blob(bytes).map(Some)
}

#[cfg(windows)]
pub(crate) fn load() -> CmdResult<Option<String>> {
    read_target(TARGET)
}

#[cfg(windows)]
pub(super) fn save(token: &str) -> CmdResult<()> {
    validate_token(token)?;
    let mut target = wide(TARGET);
    let mut username = wide("Bangumi Personal Access Token");
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: token.len() as u32,
        CredentialBlob: token.as_ptr().cast_mut(),
        // Persists on this machine for the current Windows user, not other accounts.
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: pointers remain live for this synchronous call; CredWriteW copies the blob.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(os_error("WRITE", unsafe { GetLastError() }));
    }
    Ok(())
}

#[cfg(windows)]
fn delete_target(target: &str) -> CmdResult<()> {
    let target = wide(target);
    // SAFETY: target is NUL terminated and valid for this synchronous call.
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_NOT_FOUND {
            return Err(os_error("DELETE", code));
        }
    }
    Ok(())
}
#[cfg(windows)]
pub(super) fn delete() -> CmdResult<()> {
    delete_target(TARGET)
}

#[cfg(not(windows))]
fn unsupported<T>() -> CmdResult<T> {
    Err(CmdError(
        "BGM_CREDENTIAL_UNSUPPORTED: 此平台暂不支持安全保存 Bangumi 令牌".into(),
    ))
}
#[cfg(not(windows))]
pub(crate) fn load() -> CmdResult<Option<String>> {
    unsupported()
}
#[cfg(not(windows))]
pub(super) fn save(token: &str) -> CmdResult<()> {
    validate_token(token)?;
    unsupported()
}
#[cfg(not(windows))]
pub(super) fn delete() -> CmdResult<()> {
    unsupported()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_tokens_are_rejected_without_touching_user_credentials() {
        for token in ["", "bad\r\nsecret", "bad secret", &"x".repeat(2561)] {
            let error = save(token).unwrap_err().to_string();
            assert!(error.starts_with("BGM_CREDENTIAL_INPUT:"));
            assert!(!error.contains("secret"));
        }
    }
    #[test]
    fn credential_blob_decodes_exactly_and_rejects_corruption() {
        assert_eq!(decode_blob(b"test-token-only").unwrap(), "test-token-only");
        assert!(decode_blob(&[0xff]).is_err());
        assert!(decode_blob(b"test-token-only\0hidden").is_err());
        assert!(decode_blob(&[]).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn absent_is_none_and_deleting_absent_is_idempotent() {
        // Only an ephemeral, never-written target is read/deleted. Never the production target.
        let target = format!(
            "KoiPage/Test/Absent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        assert!(read_target(&target).unwrap().is_none());
        delete_target(&target).unwrap();
        delete_target(&target).unwrap();
    }
}
