//! File moves that also work in Windows encrypted application directories.

pub fn rename(
    from: impl AsRef<std::path::Path>,
    to: impl AsRef<std::path::Path>,
) -> std::io::Result<()> {
    let from = from.as_ref();
    let to = to.as_ref();
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if error.raw_os_error() == Some(17)
                && std::fs::symlink_metadata(from)?.file_type().is_file()
            {
                return windows_copy_move(from, to);
            }
            Err(error)
        }
    }
}

/// COPY_ALLOWED leaves the source available until the complete copy succeeds;
/// WRITE_THROUGH waits for that copy to reach disk. It is not an atomic rename.
/// Callers publishing verified files must validate a destination before accepting
/// it after interruption, and retain a journal/rollback for destructive swaps.
#[cfg(windows)]
fn windows_copy_move(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_COPY_ALLOWED, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    fn wide(path: &std::path::Path) -> std::io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }
    let source = wide(from)?;
    let target = wide(to)?;
    // Both buffers are NUL terminated and alive for the duration of the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    // Win32 may report a successful copy if deleting the source failed. Surface
    // that failure, rather than falsely claiming rename semantics to the caller.
    if from.is_file() {
        std::fs::remove_file(from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_qa_directory_moves_files() {
        let Some(base) = std::env::var_os("KOIPAGE_TEST_ENCRYPTED_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(base).join(format!(
            "file-ops-test-{}",
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.tmp");
        let target = root.join("target.txt");
        std::fs::write(&source, b"complete new contents").unwrap();
        std::fs::write(&target, b"old contents").unwrap();
        rename(&source, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"complete new contents");
        assert!(!source.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
