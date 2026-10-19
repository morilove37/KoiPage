//! Shared command error type.
//!
//! Tauri commands must return something that serialises into the rejected
//! promise value, so this is a transparent string newtype.

use std::fmt;

#[derive(Debug)]
pub struct CmdError(pub String);

pub type CmdResult<T> = Result<T, CmdError>;

impl fmt::Display for CmdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CmdError {}

impl From<sqlx::Error> for CmdError {
    fn from(e: sqlx::Error) -> Self {
        CmdError(e.to_string())
    }
}

impl From<tauri::Error> for CmdError {
    fn from(e: tauri::Error) -> Self {
        CmdError(e.to_string())
    }
}

impl serde::Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        crate::logging::record("ERROR", "command", &self.0);
        serializer.serialize_str(&self.0)
    }
}
