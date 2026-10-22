//! Per-game save snapshots. Library/database archives live in `backup`, separately.

use super::{
    error::{CmdError, CmdResult},
    games::pool,
};
use crate::launcher::RunningGames;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
fn error(e: impl std::fmt::Display) -> CmdError {
    CmdError(format!("存档备份：{e}"))
}
fn unique(prefix: &str) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{prefix}-{}-{}-{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveBackupSettings {
    pub before_launch: bool,
    pub after_exit: bool,
    pub keep_automatic: u32,
}
impl Default for SaveBackupSettings {
    fn default() -> Self {
        Self {
            before_launch: false,
            after_exit: false,
            keep_automatic: 10,
        }
    }
}
impl SaveBackupSettings {
    fn normalized(mut self) -> Self {
        self.keep_automatic = self.keep_automatic.clamp(1, 50);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupReason {
    Manual,
    BeforeLaunch,
    AfterExit,
    #[serde(rename = "beforeRestore")]
    Safety,
}
impl BackupReason {
    fn automatic(self) -> bool {
        matches!(self, Self::BeforeLaunch | Self::AfterExit)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub id: String,
    pub created_at: String,
    pub reason: BackupReason,
    pub files: usize,
    pub bytes: u64,
    pub source_path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub safety_backup_id: Option<String>,
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    snapshot: Snapshot,
    directory: bool,
    directories: Vec<String>,
    entries: Vec<Entry>,
}

fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
/// Inspect every ancestor, including junctions: canonicalizing first would hide them.
fn checked_path(path: &Path, missing: bool) -> CmdResult<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(error("请配置不含相对跳转的绝对存档路径"));
    }
    let mut current = PathBuf::new();
    let mut absent = false;
    for part in path.components() {
        current.push(part);
        // A Windows drive prefix alone (C: or \\?\C:) is not a rooted path.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(m) => {
                if absent || is_link(&m) {
                    return Err(error("不支持符号链接、目录联接或重解析点"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && missing => absent = true,
            Err(e) => return Err(error(e)),
        }
    }
    if absent {
        let parent = path.parent().ok_or_else(|| error("路径缺少父目录"))?;
        let parent = fs::canonicalize(parent).map_err(|_| error("存档的父目录必须已存在"))?;
        Ok(parent.join(path.file_name().ok_or_else(|| error("路径无文件名"))?))
    } else {
        fs::canonicalize(path).map_err(error)
    }
}
fn overlaps(a: &Path, b: &Path) -> bool {
    path_contains(a, b) || path_contains(b, a)
}
/// Normalize a configured comparison path even when multiple trailing folders
/// have been removed (for example an uninstalled game's old install path).
fn future_path(path: &Path) -> CmdResult<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(error("配置路径无效"));
    }
    let ancestor = path
        .ancestors()
        .find(|p| fs::symlink_metadata(p).is_ok())
        .ok_or_else(|| error("配置路径无有效父目录"))?;
    Ok(checked_path(ancestor, false)?.join(path.strip_prefix(ancestor).map_err(error)?))
}
fn path_contains(path: &Path, parent: &Path) -> bool {
    #[cfg(windows)]
    {
        Path::new(&path.to_string_lossy().to_lowercase())
            .starts_with(Path::new(&parent.to_string_lossy().to_lowercase()))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(parent)
    }
}
fn safe_relative(s: &str) -> bool {
    !s.is_empty()
        && s.split('/').count() <= 100
        && !s.contains(['\\', ':'])
        && s.split('/').all(|p| {
            let stem = p.split('.').next().unwrap_or("").to_uppercase();
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with([' ', '.'])
                && !p.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() < 150 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn ensure_root(root: &Path) -> CmdResult<()> {
    // Inspect the existing ancestor before creating directories.
    let ancestor = root
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| error("备份位置无效"))?;
    checked_path(ancestor, false)?;
    fs::create_dir_all(root).map_err(error)?;
    checked_path(root, false)?;
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(error)?;
    f.write_all(bytes).map_err(error)?;
    f.sync_all().map_err(error)
}
fn digest_file(path: &Path, limit: u64) -> CmdResult<(u64, String)> {
    checked_path(path, false)?;
    if !fs::metadata(path).map_err(error)?.is_file() {
        return Err(error("存档含有非常规文件"));
    }
    let mut f = fs::File::open(path).map_err(error)?;
    let mut hasher = Sha256::new();
    let mut total = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let n = f.read(&mut buffer).map_err(error)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limit {
            return Err(error("存档超过 1 GB 限制"));
        }
        hasher.update(&buffer[..n]);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}
fn collect(
    source: &Path,
    relative: &str,
    dirs: &mut Vec<String>,
    entries: &mut Vec<Entry>,
    total: &mut u64,
) -> CmdResult<()> {
    let m = fs::symlink_metadata(source).map_err(error)?;
    if is_link(&m) {
        return Err(error("存档包含符号链接或目录联接"));
    }
    if m.is_dir() {
        if !relative.is_empty() {
            dirs.push(relative.into());
        }
        if dirs.len() + entries.len() > MAX_FILES {
            return Err(error("存档超过 10000 个文件或目录"));
        }
        for child in fs::read_dir(source).map_err(error)? {
            let child = child.map_err(error)?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| error("存档文件名不是有效 Unicode"))?;
            let rel = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if !safe_relative(&rel) {
                return Err(error("存档含不安全文件名"));
            }
            collect(&child.path(), &rel, dirs, entries, total)?;
        }
    } else if m.is_file() {
        let (size, sha256) = digest_file(source, MAX_BYTES - *total)?;
        *total += size;
        entries.push(Entry {
            path: relative.into(),
            size,
            sha256,
        });
        if dirs.len() + entries.len() > MAX_FILES {
            return Err(error("存档超过 10000 个文件或目录"));
        }
    } else {
        return Err(error("存档包含非常规文件"));
    }
    Ok(())
}
/// Cleanup only after inspecting the whole owned tree; never follow reparse points.
fn remove_owned(path: &Path) -> CmdResult<()> {
    checked_path(path, false)?;
    fn check(p: &Path) -> CmdResult<()> {
        let m = fs::symlink_metadata(p).map_err(error)?;
        if is_link(&m) {
            return Err(error("清理路径出现链接，已保留以防误删"));
        }
        if m.is_dir() {
            for c in fs::read_dir(p).map_err(error)? {
                check(&c.map_err(error)?.path())?;
            }
        }
        Ok(())
    }
    check(path)?;
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(error)
    } else {
        fs::remove_file(path).map_err(error)
    }
}

fn create_snapshot(source: &Path, root: &Path, reason: BackupReason) -> CmdResult<Snapshot> {
    let source = checked_path(source, false)?;
    // Validate an absent backup root before creating any directory in it.
    let future_root = future_path(root)?;
    if overlaps(&source, &future_root) {
        return Err(error("存档与备份目录不能相互包含"));
    }
    ensure_root(root)?;
    if overlaps(&source, &checked_path(root, false)?) {
        return Err(error("存档与备份目录不能相互包含"));
    }
    let directory = source.is_dir();
    let mut directories = vec![];
    let mut entries = vec![];
    let mut bytes = 0;
    collect(
        &source,
        if directory { "" } else { "save" },
        &mut directories,
        &mut entries,
        &mut bytes,
    )?;
    let snapshot = Snapshot {
        id: unique("save"),
        created_at: super::util::now_iso8601(),
        reason,
        files: entries.len(),
        bytes,
        source_path: source.to_string_lossy().into_owned(),
    };
    let dest = root.join(&snapshot.id);
    fs::create_dir(&dest).map_err(error)?;
    let result = (|| {
        fs::create_dir(dest.join("files")).map_err(error)?;
        for (i, entry) in entries.iter().enumerate() {
            let from = if directory {
                source.join(&entry.path)
            } else {
                source.clone()
            };
            checked_path(&from, false)?;
            let target = dest.join("files").join(i.to_string());
            let mut input = fs::File::open(from).map_err(error)?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(error)?;
            let copied = std::io::copy(&mut (&mut input).take(entry.size + 1), &mut output)
                .map_err(error)?;
            output.sync_all().map_err(error)?;
            if copied != entry.size
                || digest_file(&target, MAX_BYTES)? != (entry.size, entry.sha256.clone())
            {
                return Err(error("存档在备份过程中发生变化，请重试"));
            }
        }
        // Check the tree once more so files added/removed while copying cannot
        // silently produce an incomplete snapshot.
        let mut after_dirs = vec![];
        let mut after_entries = vec![];
        let mut after_bytes = 0;
        collect(
            &source,
            if directory { "" } else { "save" },
            &mut after_dirs,
            &mut after_entries,
            &mut after_bytes,
        )?;
        directories.sort();
        after_dirs.sort();
        after_entries.sort_by(|a, b| a.path.cmp(&b.path));
        let mut before_entries: Vec<_> = entries.iter().collect();
        before_entries.sort_by(|a, b| a.path.cmp(&b.path));
        if directories != after_dirs
            || before_entries != after_entries.iter().collect::<Vec<_>>()
            || bytes != after_bytes
        {
            return Err(error("存档目录在备份过程中变化，请重试"));
        }
        let manifest = Manifest {
            version: 1,
            snapshot: snapshot.clone(),
            directory,
            directories,
            entries,
        };
        // Commit marker LAST: no rename across encrypted Windows directories required.
        write_new(
            &dest.join("manifest.json"),
            &serde_json::to_vec(&manifest).map_err(error)?,
        )?;
        read_manifest(&dest)?;
        Ok(snapshot)
    })();
    if result.is_err() {
        let _ = remove_owned(&dest);
    }
    result
}
fn read_manifest(dir: &Path) -> CmdResult<Manifest> {
    checked_path(dir, false)?;
    let path = dir.join("manifest.json");
    checked_path(&path, false)?;
    let mut bytes = vec![];
    fs::File::open(path)
        .map_err(error)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(error("备份清单过大"));
    }
    let m: Manifest = serde_json::from_slice(&bytes).map_err(error)?;
    if m.version != 1
        || !valid_id(&m.snapshot.id)
        || dir.file_name().and_then(|s| s.to_str()) != Some(m.snapshot.id.as_str())
        || m.entries.len() != m.snapshot.files
        || m.entries.len() + m.directories.len() > MAX_FILES
        || m.snapshot.bytes > MAX_BYTES
    {
        return Err(error("备份清单无效"));
    }
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    for d in &m.directories {
        if !m.directory || !safe_relative(d) || !seen.insert(d.to_lowercase()) {
            return Err(error("备份目录清单无效"));
        }
    }
    for (i, e) in m.entries.iter().enumerate() {
        if !safe_relative(&e.path)
            || !seen.insert(e.path.to_lowercase())
            || e.size > MAX_BYTES
            || (!m.directory && (e.path != "save" || m.entries.len() != 1))
        {
            return Err(error("备份文件清单无效"));
        }
        total = total
            .checked_add(e.size)
            .ok_or_else(|| error("备份大小溢出"))?;
        if total > MAX_BYTES
            || digest_file(&dir.join("files").join(i.to_string()), MAX_BYTES)?
                != (e.size, e.sha256.clone())
        {
            return Err(error("备份文件缺失或校验失败"));
        }
    }
    if total != m.snapshot.bytes || (!m.directory && m.entries.len() != 1) {
        return Err(error("备份计数无效"));
    }
    Ok(m)
}
fn list_snapshots(root: &Path) -> CmdResult<Vec<Snapshot>> {
    if !root.exists() {
        return Ok(vec![]);
    }
    checked_path(root, false)?;
    let mut result = vec![];
    for entry in fs::read_dir(root).map_err(error)? {
        let p = entry.map_err(error)?.path();
        // Partial/uncommitted snapshots are never offered for restore.
        if !p.join("manifest.json").exists() {
            continue;
        }
        match read_manifest(&p) {
            Ok(manifest) => result.push(manifest.snapshot),
            Err(e) => crate::logging::record(
                "WARN",
                "save-backup",
                &format!("已跳过损坏的存档备份 {}：{e}", p.display()),
            ),
        }
    }
    result.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(result)
}
fn trim_automatic(root: &Path, keep: u32) -> CmdResult<()> {
    for snapshot in list_snapshots(root)?
        .into_iter()
        .filter(|s| s.reason.automatic())
        .skip(keep.clamp(1, 50) as usize)
    {
        remove_owned(&root.join(snapshot.id))?;
    }
    Ok(())
}
fn restore_snapshot(source: &Path, root: &Path, id: &str) -> CmdResult<RestoreResult> {
    if !valid_id(id) {
        return Err(error("备份标识无效"));
    }
    let m = read_manifest(&root.join(id))?;
    let source = checked_path(source, true)?;
    if overlaps(&source, &checked_path(root, false)?) {
        return Err(error("存档与备份位置不能相互包含"));
    }
    if source.exists() && source.is_dir() != m.directory {
        return Err(error("当前存档路径类型与备份不同，请检查配置"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| error("不能恢复到文件系统根目录"))?;
    let stage = parent.join(unique(".koipage-save-stage"));
    let rollback = parent.join(unique(".koipage-save-rollback"));
    let safety_backup_id = if source.exists() {
        Some(create_snapshot(&source, root, BackupReason::Safety)?.id)
    } else {
        None
    };
    let staged = (|| {
        if m.directory {
            fs::create_dir(&stage).map_err(error)?;
            for d in &m.directories {
                fs::create_dir_all(stage.join(d)).map_err(error)?;
            }
        }
        for (i, e) in m.entries.iter().enumerate() {
            let to = if m.directory {
                stage.join(&e.path)
            } else {
                stage.clone()
            };
            if let Some(p) = to.parent() {
                fs::create_dir_all(p).map_err(error)?;
            }
            let from = root.join(id).join("files").join(i.to_string());
            checked_path(&from, false)?;
            let mut input = fs::File::open(from).map_err(error)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&to)
                .map_err(error)?;
            std::io::copy(&mut (&mut input).take(e.size + 1), &mut output).map_err(error)?;
            output.sync_all().map_err(error)?;
            if digest_file(&to, MAX_BYTES)? != (e.size, e.sha256.clone()) {
                return Err(error("恢复暂存文件校验失败"));
            }
        }
        Ok(())
    })();
    if let Err(e) = staged {
        if stage.exists() {
            let _ = remove_owned(&stage);
        }
        return Err(e);
    }
    // Refuse unsupported same-volume rename before changing originals. No copy-over fallback.
    let had_source = source.exists();
    checked_path(&source, true)?;
    if had_source {
        if let Err(e) = crate::file_ops::rename(&source, &rollback) {
            let _ = remove_owned(&stage);
            return Err(error(format!(
                "无法安全替换存档（原存档未改动）：{e}。请关闭游戏、占用存档的编辑器或文件同步工具后重试；若文件系统不支持安全重命名，请将存档移到支持的位置。"
            )));
        }
    }
    let published = crate::file_ops::rename(&stage, &source)
        .map_err(error)
        .and_then(|()| {
            // The encrypted-file fallback copies rather than atomically renaming;
            // verify that destination before accepting the replacement.
            if !m.directory {
                let entry = &m.entries[0];
                if digest_file(&source, MAX_BYTES)? != (entry.size, entry.sha256.clone()) {
                    return Err(error("恢复后的存档校验失败"));
                }
            }
            Ok(())
        });
    if let Err(e) = published {
        let recovered = !had_source || crate::file_ops::rename(&rollback, &source).is_ok();
        let _ = remove_owned(&stage);
        return Err(error(format!(
            "恢复替换失败：{e}；回滚{}；安全备份：{}；原件保留位置：{}。请关闭占用存档的游戏、编辑器或同步工具后重试。",
            if recovered { "成功" } else { "失败" },
            safety_backup_id.as_deref().unwrap_or("无"),
            rollback.display()
        )));
    }
    if had_source {
        if let Err(e) = remove_owned(&rollback) {
            crate::logging::record(
                "WARN",
                "save-backup",
                &format!("恢复成功，但旧存档暂存目录保留 {}：{e}", rollback.display()),
            );
        }
    }
    Ok(RestoreResult { safety_backup_id })
}

async fn game_paths(app: &AppHandle, game_id: i64, missing: bool) -> CmdResult<(PathBuf, PathBuf)> {
    let db = pool(app).await?;
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT save_path,install_path FROM games WHERE id=?")
            .bind(game_id)
            .fetch_optional(&db)
            .await?;
    let (save, install) = row.ok_or_else(|| error("游戏不存在"))?;
    let save = save
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| error("请先在游戏详情中设置实际存档文件夹或文件"))?;
    let source = checked_path(Path::new(&save), missing)?;
    if source.parent().is_none() || source.file_name().is_none() {
        return Err(error("不能选择磁盘根目录"));
    }
    if let Some(install) = install.filter(|s| !s.trim().is_empty()) {
        let install = future_path(Path::new(&install))?;
        if path_contains(&install, &source) {
            return Err(error("不能将整个游戏安装目录或其上级作为存档"));
        }
    }
    for root in [
        app.path().app_data_dir()?,
        app.path().app_local_data_dir()?,
        app.path().app_config_dir()?,
    ] {
        let root = future_path(&root)?;
        if overlaps(&source, &root) {
            return Err(error("存档目录不能包含或位于恋页的数据目录"));
        }
    }
    for name in [
        "USERPROFILE",
        "HOME",
        "WINDIR",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(p) = std::env::var_os(name) {
            if let Ok(p) = checked_path(Path::new(&p), false) {
                if path_contains(&p, &source) {
                    return Err(error("不能选择用户、系统或应用数据根目录"));
                }
            }
        }
    }
    let root = app
        .path()
        .app_local_data_dir()?
        .join("save-backups")
        .join(game_id.to_string());
    Ok((source, root))
}
fn deny_running(state: &RunningGames) -> CmdResult<()> {
    if !state
        .0
        .lock()
        .map_err(|_| error("进程表不可用"))?
        .is_empty()
    {
        return Err(error("请先关闭所有由恋页启动的游戏，再操作存档"));
    }
    Ok(())
}
#[tauri::command]
pub async fn save_backup_settings_get(
    app: AppHandle,
    game_id: i64,
) -> CmdResult<SaveBackupSettings> {
    let db = pool(&app).await?;
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE id=?")
        .bind(game_id)
        .fetch_one(&db)
        .await?;
    if exists == 0 {
        return Err(error("游戏不存在"));
    }
    let value =
        super::settings::settings_get_impl(&db, &format!("game_save_backup:{game_id}")).await?;
    Ok(match value {
        Some(s) => serde_json::from_str::<SaveBackupSettings>(&s)
            .map_err(error)?
            .normalized(),
        None => SaveBackupSettings::default(),
    })
}
#[tauri::command]
pub async fn save_backup_settings_set(
    app: AppHandle,
    game_id: i64,
    config: SaveBackupSettings,
) -> CmdResult<SaveBackupSettings> {
    save_backup_settings_get(app.clone(), game_id).await?;
    let config = config.normalized();
    super::settings::settings_set(
        app,
        format!("game_save_backup:{game_id}"),
        Some(serde_json::to_string(&config).map_err(error)?),
    )
    .await?;
    Ok(config)
}
#[tauri::command]
pub async fn save_backup_create(app: AppHandle, game_id: i64) -> CmdResult<Snapshot> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    deny_running(&state)?;
    let (source, root) = game_paths(&app, game_id, false).await?;
    create_snapshot(&source, &root, BackupReason::Manual)
}
#[tauri::command]
pub async fn save_backup_list(app: AppHandle, game_id: i64) -> CmdResult<Vec<Snapshot>> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    let root = app
        .path()
        .app_local_data_dir()?
        .join("save-backups")
        .join(game_id.to_string());
    list_snapshots(&root)
}
#[tauri::command]
pub async fn save_backup_restore(
    app: AppHandle,
    game_id: i64,
    snapshot_id: String,
) -> CmdResult<RestoreResult> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    deny_running(&state)?;
    let (source, root) = game_paths(&app, game_id, true).await?;
    restore_snapshot(&source, &root, &snapshot_id)
}
#[tauri::command]
pub async fn save_backup_delete(
    app: AppHandle,
    game_id: i64,
    snapshot_id: String,
) -> CmdResult<()> {
    let state = app.state::<RunningGames>();
    let _guard = state.1.lock().await;
    if !valid_id(&snapshot_id) {
        return Err(error("备份标识无效"));
    }
    let root = app
        .path()
        .app_local_data_dir()?
        .join("save-backups")
        .join(game_id.to_string());
    let target = root.join(snapshot_id);
    remove_owned(&target)
}
#[tauri::command]
pub async fn save_backup_directory(app: AppHandle, game_id: i64) -> CmdResult<String> {
    let root = app
        .path()
        .app_local_data_dir()?
        .join("save-backups")
        .join(game_id.to_string());
    ensure_root(&root)?;
    Ok(root.to_string_lossy().into_owned())
}
/// Caller MUST hold RunningGames.1. No registry check: an exiting game's entry may remain.
pub async fn auto_backup(
    app: &AppHandle,
    game_id: i64,
    reason: BackupReason,
) -> CmdResult<Option<Snapshot>> {
    let config = save_backup_settings_get(app.clone(), game_id).await?;
    let enabled = match reason {
        BackupReason::BeforeLaunch => config.before_launch,
        BackupReason::AfterExit => config.after_exit,
        _ => return Err(error("自动备份原因无效")),
    };
    if !enabled {
        return Ok(None);
    }
    let (source, root) = game_paths(app, game_id, false).await?;
    let snapshot = create_snapshot(&source, &root, reason)?;
    trim_automatic(&root, config.keep_automatic)?;
    Ok(Some(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(unique("koipage-save-test"));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_unsafe_manifest_paths() {
        for s in [
            "", "../save", "a/../b", "C:/x", "a\\b", "/x", "a//b", "a/./b", "a:stream",
        ] {
            assert!(!safe_relative(s), "{s}");
        }
        assert!(safe_relative("sub/存档.sav"));
        for s in [
            "NUL", "aux.txt", "COM1.dat", "LPT9", "a/slot.", "a/slot ", "a/*",
        ] {
            assert!(!safe_relative(s), "{s}");
        }
    }

    #[test]
    fn settings_defaults_and_bounds() {
        let config: SaveBackupSettings = serde_json::from_str("{}").unwrap();
        assert!(!config.before_launch && !config.after_exit);
        assert_eq!(config.keep_automatic, 10);
        let low: SaveBackupSettings = serde_json::from_str(r#"{"keepAutomatic":0}"#).unwrap();
        assert_eq!(low.normalized().keep_automatic, 1);
        let high: SaveBackupSettings = serde_json::from_str(r#"{"keepAutomatic":999}"#).unwrap();
        assert_eq!(high.normalized().keep_automatic, 50);
    }

    #[test]
    fn missing_install_parent_does_not_invalidate_external_save() {
        let t = Scratch::new();
        let removed_install = t.0.join("Games/Vendor/Title");
        let save = t.0.join("save");
        fs::create_dir(&save).unwrap();
        let install = future_path(&removed_install).unwrap();
        let source = checked_path(&save, false).unwrap();
        assert!(!path_contains(&install, &source));
        assert!(path_contains(&install, &checked_path(&t.0, false).unwrap()));
        assert!(future_path(&t.0.join("../outside")).is_err());
    }

    #[test]
    fn refuses_nested_storage_and_mismatched_restore_kind() {
        let t = Scratch::new();
        let source = t.0.join("save");
        fs::create_dir(&source).unwrap();
        assert!(create_snapshot(&source, &source.join("backups"), BackupReason::Manual).is_err());
        let root = t.0.join("backups");
        let snapshot = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        let file = t.0.join("other.sav");
        fs::write(&file, b"unchanged").unwrap();
        assert!(restore_snapshot(&file, &root, &snapshot.id).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"unchanged");
        assert!(restore_snapshot(&file, &root, "../elsewhere").is_err());
    }

    #[test]
    fn missing_payload_and_manifest_traversal_are_rejected() {
        let t = Scratch::new();
        let source = t.0.join("slot.sav");
        fs::write(&source, b"save").unwrap();
        let root = t.0.join("backups");
        let snapshot = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        let dir = root.join(&snapshot.id);
        let mut m = read_manifest(&dir).unwrap();
        m.entries[0].path = "../outside".into();
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(restore_snapshot(&source, &root, &snapshot.id).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"save");
        m.entries[0].path = "save".into();
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        fs::remove_file(dir.join("files/0")).unwrap();
        assert!(restore_snapshot(&source, &root, &snapshot.id).is_err());
        let good = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        let listed = list_snapshots(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);
        remove_owned(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn snapshot_round_trip_and_safety_backup() {
        let t = Scratch::new();
        let source = t.0.join("save");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::write(source.join("slot.sav"), b"old").unwrap();
        let root = t.0.join("backups");
        let snap = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        fs::write(source.join("slot.sav"), b"new").unwrap();
        fs::write(source.join("extra"), b"extra").unwrap();
        let result = restore_snapshot(&source, &root, &snap.id).unwrap();
        assert_eq!(fs::read(source.join("slot.sav")).unwrap(), b"old");
        assert!(!source.join("extra").exists());
        assert!(source.join("empty").is_dir());
        let safety = read_manifest(&root.join(result.safety_backup_id.unwrap())).unwrap();
        assert_eq!(safety.snapshot.reason, BackupReason::Safety);
        assert_eq!(safety.snapshot.files, 2);
    }

    #[test]
    fn corrupted_payload_does_not_touch_current_save() {
        let t = Scratch::new();
        let source = t.0.join("slot.sav");
        fs::write(&source, b"old").unwrap();
        let root = t.0.join("backups");
        let snap = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        fs::write(root.join(&snap.id).join("files/0"), b"bad").unwrap();
        fs::write(&source, b"current").unwrap();
        assert!(restore_snapshot(&source, &root, &snap.id).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"current");
    }

    #[test]
    fn restore_missing_single_file_and_retention() {
        let t = Scratch::new();
        let source = t.0.join("slot.sav");
        fs::write(&source, b"save").unwrap();
        let root = t.0.join("backups");
        let manual = create_snapshot(&source, &root, BackupReason::Manual).unwrap();
        for _ in 0..3 {
            create_snapshot(&source, &root, BackupReason::BeforeLaunch).unwrap();
        }
        trim_automatic(&root, 1).unwrap();
        assert_eq!(list_snapshots(&root).unwrap().len(), 2);
        fs::remove_file(&source).unwrap();
        assert!(
            restore_snapshot(&source, &root, &manual.id)
                .unwrap()
                .safety_backup_id
                .is_none()
        );
        assert_eq!(fs::read(source).unwrap(), b"save");
    }

    #[test]
    fn encrypted_directory_single_file_restore() {
        let Some(base) = std::env::var_os("KOIPAGE_TEST_ENCRYPTED_ROOT") else {
            return;
        };
        let root = PathBuf::from(base).join(unique("save-backup-encrypted-test"));
        fs::create_dir(&root).unwrap();
        let t = Scratch(root);
        let source = t.0.join("slot.sav");
        fs::write(&source, b"original").unwrap();
        let backups = t.0.join("backups");
        let snapshot = create_snapshot(&source, &backups, BackupReason::Manual).unwrap();
        fs::write(&source, b"changed").unwrap();
        let result = restore_snapshot(&source, &backups, &snapshot.id).unwrap();
        assert!(result.safety_backup_id.is_some());
        assert_eq!(fs::read(&source).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_in_source_tree() {
        let t = Scratch::new();
        let source = t.0.join("save");
        let outside = t.0.join("outside");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&outside).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(source.join("junction"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(create_snapshot(&source, &t.0.join("backups"), BackupReason::Manual).is_err());
        fs::remove_dir(source.join("junction")).unwrap();
    }
}
