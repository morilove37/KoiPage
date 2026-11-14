//! API keys are stored only in the current Windows user's Credential Manager.
//! Credentials are isolated by normalized endpoint;
//! no command returns a key to the frontend.
use crate::commands::error::{CmdError, CmdResult};

fn target(endpoint: &str) -> String { use sha2::{Digest, Sha256}; format!("KoiPage/AI/{:x}", Sha256::digest(endpoint)) }
const MAX_BLOB_SIZE: usize = 2560;

fn validate_token(token: &str) -> CmdResult<()> {
    if token.is_empty()
        || token.len() > MAX_BLOB_SIZE
        || token.bytes().any(|b| !b.is_ascii_graphic())
    {
        return Err(CmdError(
            "AI_CREDENTIAL_INPUT: AI 密钥格式无效".into(),
        ));
    }
    Ok(())
}
fn decode_blob(bytes: &[u8]) -> CmdResult<String> {
    let token = std::str::from_utf8(bytes).map_err(|_| {
        CmdError("AI_CREDENTIAL_DATA: 已保存的 AI 密钥损坏，请重新连接".into())
    })?;
    validate_token(token).map_err(|_| {
        CmdError("AI_CREDENTIAL_DATA: 已保存的 AI 密钥损坏，请重新连接".into())
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
        "AI_CREDENTIAL_{operation}: Windows 凭据管理器操作失败（{code}）"
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
            "AI_CREDENTIAL_DATA: 已保存的 AI 密钥损坏，请重新连接".into(),
        ));
    }
    // SAFETY: Windows provides CredentialBlobSize bytes in this allocation.
    let bytes = unsafe {
        std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize)
    };
    decode_blob(bytes).map(Some)
}

#[cfg(windows)]
pub(crate) fn load(endpoint: &str) -> CmdResult<Option<String>> {
    read_target(&target(endpoint))
}

#[cfg(windows)]
pub(super) fn save(endpoint: &str, token: &str) -> CmdResult<()> {
    validate_token(token)?;
    let mut target = wide(&target(endpoint));
    let mut username = wide("KoiPage AI API Key");
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
pub(super) fn delete(endpoint: &str) -> CmdResult<()> {
    delete_target(&target(endpoint))
}

#[cfg(not(windows))]
fn unsupported<T>() -> CmdResult<T> {
    Err(CmdError(
        "AI_CREDENTIAL_UNSUPPORTED: 此平台暂不支持安全保存 AI 密钥".into(),
    ))
}
#[cfg(not(windows))]
pub(crate) fn load(endpoint: &str) -> CmdResult<Option<String>> {
    unsupported()
}
#[cfg(not(windows))]
pub(super) fn save(endpoint: &str, token: &str) -> CmdResult<()> {
    validate_token(token)?;
    unsupported()
}
#[cfg(not(windows))]
pub(super) fn delete(endpoint: &str) -> CmdResult<()> {
    unsupported()
}
