//! Copy only application-owned resource directories, retaining every source.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const DIRECTORIES: &[&str] = &[
    "covers",
    "custom-covers",
    "society-logos",
    "birthday-avatars",
    "restored-assets",
];

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn same_bytes(left: &Path, right: &Path) -> io::Result<bool> {
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut a = [0; 65536];
    let mut b = [0; 65536];
    loop {
        let size = left.read(&mut a)?;
        if size == 0 {
            return Ok(right.read(&mut b)? == 0);
        }
        right.read_exact(&mut b[..size])?;
        if a[..size] != b[..size] {
            return Ok(false);
        }
    }
}

fn copy_tree(source: &Path, target: &Path, files: &mut Vec<(PathBuf, PathBuf)>) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if is_link(&metadata) {
        return Err(io::Error::other(format!(
            "资源目录含有链接或重解析点，已停止迁移：{}",
            source.display()
        )));
    }
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()), files)?;
        }
    } else if metadata.is_file() {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        io::copy(&mut fs::File::open(source)?, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        if !same_bytes(source, target)? {
            return Err(io::Error::other("资源复制校验失败，原文件已保留"));
        }
        files.push((source.canonicalize()?, target.canonicalize()?));
    } else {
        return Err(io::Error::other("资源目录含有不支持的文件类型"));
    }
    Ok(())
}

/// The target must be a new directory: no user file is replaced or deleted.
pub(crate) fn copy_resources(source: &Path, target: &Path) -> io::Result<Vec<(PathBuf, PathBuf)>> {
    let source = source.canonicalize()?;
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("目标目录无效"))?
        .canonicalize()?;
    let target = parent.join(
        target
            .file_name()
            .ok_or_else(|| io::Error::other("目标目录无效"))?,
    );
    if target.starts_with(&source) || source.starts_with(&target) {
        return Err(io::Error::other("请选择当前资源目录之外的位置"));
    }
    fs::create_dir(&target)?;
    let mut files = Vec::new();
    for name in DIRECTORIES {
        let directory = source.join(name);
        match fs::symlink_metadata(&directory) {
            Ok(_) => copy_tree(&directory, &target.join(name), &mut files)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "koipage-resource-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn copies_managed_files_and_keeps_database_and_source_untouched() {
        let root = fixture("copy");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("covers/nested")).unwrap();
        fs::write(source.join("covers/nested/a.png"), b"image").unwrap();
        fs::write(source.join("galgame.db"), b"database").unwrap();
        let files = copy_resources(&source, &target).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            fs::read(target.join("covers/nested/a.png")).unwrap(),
            b"image"
        );
        assert_eq!(
            fs::read(source.join("covers/nested/a.png")).unwrap(),
            b"image"
        );
        assert!(!target.join("galgame.db").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn destination_conflict_does_not_overwrite_existing_files() {
        let root = fixture("conflict");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("covers")).unwrap();
        fs::create_dir_all(target.join("covers")).unwrap();
        fs::write(source.join("covers/a.png"), b"new").unwrap();
        fs::write(target.join("covers/a.png"), b"existing").unwrap();
        assert!(copy_resources(&source, &target).is_err());
        assert_eq!(fs::read(target.join("covers/a.png")).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unavailable_source_is_an_error_and_never_becomes_an_empty_migration() {
        let root = fixture("missing");
        assert!(copy_resources(&root.join("missing"), &root.join("target")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn nested_destination_is_rejected_before_copying() {
        let root = fixture("nested");
        fs::create_dir_all(root.join("covers")).unwrap();
        assert!(copy_resources(&root, &root.join("covers/new")).is_err());
        assert!(!root.join("covers/new").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn directory_junctions_are_rejected_instead_of_followed() {
        use std::os::windows::fs::symlink_dir;
        let root = fixture("link");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("covers")).unwrap();
        fs::create_dir_all(root.join("outside")).unwrap();
        // Developer mode/admin is not guaranteed on CI; the non-link tests always run.
        if symlink_dir(root.join("outside"), source.join("covers/link")).is_ok() {
            assert!(copy_resources(&source, &target).is_err());
            fs::remove_dir(source.join("covers/link")).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}
