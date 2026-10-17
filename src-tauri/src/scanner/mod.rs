//! Recursive game-folder scanner.
//!
//! Pure filesystem heuristics — no image decoding, no extra crates. The module
//! is deliberately independent of the command layer so the recognition rules
//! can be unit-tested without a Tauri app handle:
//!
//! * [`scan_directory`] walks a root and returns one [`ScanCandidate`] per
//!   plausible game folder.
//! * [`recognize`] applies the exe / cover / title heuristics to a single
//!   folder that is already known to contain an executable.
//!
//! The only `tauri`-aware piece is [`scan_directory_cmd`], which wraps the walk
//! and asks the database which folders are already imported.
//!
//! ### Heuristics
//!
//! A directory is a *game folder* when, at its own level, it contains at least
//! one `.exe` that is not on the installer/redistributable blocklist. Nested
//! folders are still walked (so a collection root yields many candidates) but a
//! parent is never reported just because a child has an exe.
//!
//! Walking is iterative with an explicit stack: depth is bounded by the
//! supplied `maxDepth` and by [`MAX_ABSOLUTE_DEPTH`], so no recursion depth can
//! blow the stack. Symlinks are never followed, and reparse points (Windows
//! junctions) are detected via `std` metadata rather than a new dependency.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::error::{CmdError, CmdResult};
use crate::commands::games::pool;
use crate::commands::util::required_string;

/// Depth cap applied on top of the caller's `maxDepth`.
///
/// `maxDepth` is user-supplied (a scan root can store any positive integer), so
/// this is the backstop that keeps a pathological tree from running away.
pub const MAX_ABSOLUTE_DEPTH: u32 = 64;

/// Directory names that are skipped wholesale, matched case-insensitively.
const SKIPPED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".venv",
    "venv",
    "$recycle.bin",
    "system volume information",
    "windows",
    "winsxs",
    "recycler",
    "temp",
    "tmp",
    "cache",
    "logs",
];

/// Executable name fragments that mark a file as *not* the game.
///
/// Matched against the lowercased file stem, so `unins000.exe` is caught by
/// `unins`. Entries are intentionally broad (`config`) because a mis-detected
/// launcher is worse than a missing suggestion.
const EXE_BLOCKLIST: &[&str] = &[
    "unins",
    "uninst",
    "setup",
    "install",
    "vcredist",
    "vc_redist",
    "dxsetup",
    "dxwebsetup",
    "directx",
    "config",
    "setting",
    "launcher",
    "unity",
    "unitycrashhandler",
    "crashhandler",
    "crashreport",
    "report",
    "update",
    "updater",
    "patch",
    "register",
    "readme",
    "help",
    "manual",
    "tool",
    "test",
    "sample",
    "server",
    "editor",
    "player_crash",
    "ffmpeg",
    "7z",
    "winrar",
];

/// Exact (lowercased) stems that are strong positives, ranked first.
const EXE_PREFERRED: &[&str] = &["game", "start", "play", "galgame", "game_start"];

/// Batch launcher extensions we accept as an alternative to `.exe`.
const SCRIPT_EXTENSIONS: &[&str] = &["bat", "cmd"];

/// Script stems that are installers/uninstallers rather than launchers.
const SCRIPT_BLOCKLIST: &[&str] = &[
    "unins", "uninst", "setup", "install", "vcredist", "dxsetup", "directx", "readme", "help",
];

/// Script names that commonly launch the game or apply a patch.
const SCRIPT_PREFERRED: &[&str] = &[
    "start", "launch", "run", "play", "game", "galgame", "patch", "游戏", "启动", "开始",
];

/// Cover image extensions we accept, lowercased and without the dot.
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp"];

/// Cover file stems that are strong positives, ranked first.
const COVER_PREFERRED: &[&str] = &["cover", "folder", "package", "jacket", "box", "thumb"];

/// One discovered game folder, as serialised to the frontend.
///
/// `serde(rename_all = "camelCase")` matches the rest of the command surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    /// Absolute path of the game folder.
    pub folder_path: String,
    /// Last path component of `folder_path`, kept for display.
    pub folder_name: String,
    /// All plausible executables, best candidate first.
    pub exe_paths: Vec<String>,
    /// `exe_paths[0]` when one exists.
    pub suggested_exe: Option<String>,
    /// Best cover image guess, by name priority then file size.
    pub cover_path: Option<String>,
    /// Folder name with release-group noise stripped.
    pub suggested_title: String,
    /// Size of the folder's own files (not recursive), in bytes.
    pub size_bytes: u64,
    /// True when `folder_path` is already a `games.install_path`.
    pub already_imported: bool,
}

/// `scan_directory` — walk `path` and return one candidate per game folder.
///
/// `max_depth` is clamped to `1..=MAX_ABSOLUTE_DEPTH`; a depth of 1 means "only
/// look at `path` itself".
#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    path: String,
    max_depth: u32,
) -> CmdResult<Vec<ScanCandidate>> {
    let path = required_string(&path, "path")?;
    let already: HashSet<String> = match pool(&app).await {
        Ok(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as("SELECT install_path FROM games")
                .fetch_all(&pool)
                .await?;
            rows.into_iter().map(|(p,)| normalize_key(&p)).collect()
        }
        // A scan must still work before the database has been connected; the
        // import step re-checks uniqueness at the SQL level anyway.
        Err(_) => HashSet::new(),
    };

    if !Path::new(&path).is_dir() {
        return Err(CmdError("扫描目录不存在或无法读取".to_string()));
    }
    tauri::async_runtime::spawn_blocking(move || scan_directory_impl(&path, max_depth, &already))
        .await
        .map_err(|error| CmdError(format!("扫描失败: {error}")))
}

/// `inspect_exe_file` — build a candidate around one executable the user picked.
///
/// This is the manual-import path for folders the scanner cannot place: the
/// user points at the exact `.exe`, so the answer to "which exe starts this
/// game?" is already known and must win over the heuristics. The parent folder
/// is still run through [`recognize`] so that covers, folder size and the other
/// executables stay available, but [`ScanCandidate::suggested_exe`] is forced to
/// the selected file.
///
/// A parent folder where `recognize` returns `None` (single blocklisted exe,
/// unreadable entries, …) is **not** an error: a minimal candidate is built
/// instead, because the user's explicit choice is itself the evidence.
#[tauri::command]
pub async fn inspect_exe_file(app: AppHandle, path: String) -> CmdResult<ScanCandidate> {
    let path = required_string(&path, "path")?;
    let launch_path = Path::new(&path);
    let launchable = launch_path.is_file()
        && launch_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("exe")
                    || SCRIPT_EXTENSIONS
                        .iter()
                        .any(|script| extension.eq_ignore_ascii_case(script))
            });
    if !launchable {
        return Err(CmdError(
            "请选择真实存在的 exe、.bat 或 .cmd 文件".to_string(),
        ));
    }
    let already: HashSet<String> = match pool(&app).await {
        Ok(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as("SELECT install_path FROM games")
                .fetch_all(&pool)
                .await?;
            rows.into_iter().map(|(p,)| normalize_key(&p)).collect()
        }
        // Same reasoning as `scan_directory`: importing must stay possible
        // before the database is connected, and `game_create` re-checks
        // uniqueness at the SQL level anyway.
        Err(_) => HashSet::new(),
    };

    inspect_exe_file_impl(&PathBuf::from(path), &already)
}

/// Pure helper for [`inspect_exe_file`]; separated so it needs no app handle.
///
/// Returns a candidate for *any* path, including one whose parent folder the
/// heuristics reject entirely.
pub fn inspect_exe_file_impl(
    exe: &Path,
    already_imported: &HashSet<String>,
) -> CmdResult<ScanCandidate> {
    let dir = exe
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // Deliberately *not* `canonicalize()`: on Windows that returns a verbatim
    // `\\?\C:\...` path, which is an artifact of the call rather than anything
    // the user picked. It would be stored verbatim in `games.exe_path`, would
    // never string-match the scanner's plain `C:\...` paths, and `Command::new`
    // treats the prefix inconsistently. Keeping the caller's path means the
    // stored value is exactly what the file dialog returned.
    let selected = exe.to_string_lossy().into_owned();

    // Read the parent's own entries (not recursive): `recognize` only ever
    // looks at the level it is given, and the manual flow has no depth setting.
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // Matches the scanner: symlinks are never treated as real files.
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            files.push((entry.path(), size));
        }
    }

    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let folder_path = dir.to_string_lossy().into_owned();
    let already = already_imported.contains(&normalize_key(&folder_path));

    match recognize(&dir, &files, already_imported) {
        Some(mut candidate) => {
            // The user's pick leads, but the rest of the recognised list stays
            // selectable. Removing the old entry before the insert keeps the
            // list duplicate-free when the heuristic had already ranked it
            // first (or when its spelling differs only by case/separator).
            candidate.exe_paths.retain(|p| !paths_equal(p, &selected));
            candidate.exe_paths.insert(0, selected.clone());
            candidate.suggested_exe = Some(selected);
            Ok(candidate)
        }
        // Minimal fallback: no error, because "the user chose this exe" is
        // stronger evidence than the exe blocklist. Cover/size are best effort.
        None => {
            let mut size_bytes: u64 = 0;
            let mut images: Vec<(PathBuf, u64)> = Vec::new();
            for (file, size) in &files {
                size_bytes = size_bytes.saturating_add(*size);
                if is_cover_name(file) {
                    images.push((file.clone(), *size));
                }
            }
            // Same name-priority rule as the scanner, so `cover.jpg` still wins
            // over a larger `screenshot.png`.
            let cover_path = pick_cover(&dir, &images);

            Ok(ScanCandidate {
                folder_path: folder_path.clone(),
                suggested_title: suggested_title(&folder_name),
                folder_name,
                exe_paths: vec![selected.clone()],
                suggested_exe: Some(selected),
                cover_path,
                size_bytes,
                already_imported: already,
            })
        }
    }
}

/// Compare two paths for "same file" without touching the filesystem.
///
/// Windows paths are case-insensitive and mix separators, so a plain `==` would
/// let the selected exe appear twice in `exe_paths`.
fn paths_equal(a: &str, b: &str) -> bool {
    normalize_key(a) == normalize_key(b)
}

/// Pure walk, extracted so it can be exercised without a Tauri app handle.
pub fn scan_directory_impl(
    path: &str,
    max_depth: u32,
    already_imported: &HashSet<String>,
) -> Vec<ScanCandidate> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Vec::new();
    }

    let max_depth = max_depth.clamp(1, MAX_ABSOLUTE_DEPTH);
    let mut out: Vec<ScanCandidate> = Vec::new();
    // Explicit stack of (directory, depth-from-root); the root itself is depth 1.
    let mut stack: Vec<(PathBuf, u32)> = vec![(root, 1)];

    while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // Unreadable folder (permissions, races): skip it, keep scanning.
            Err(_) => continue,
        };

        let mut files: Vec<(PathBuf, u64)> = Vec::new();
        let mut subdirs: Vec<PathBuf> = Vec::new();

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // `symlink_metadata` is what `file_type()` already reflects: a
            // symlink reports `is_symlink()`, so it is never descended into.
            if file_type.is_symlink() {
                continue;
            }
            let entry_path = entry.path();
            if file_type.is_dir() {
                if is_skipped_dir(&entry_path) || !is_real_dir(&entry_path) {
                    continue;
                }
                subdirs.push(entry_path);
            } else if file_type.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push((entry_path, size));
            }
        }

        if depth < max_depth {
            for subdir in subdirs {
                stack.push((subdir, depth + 1));
            }
        }

        if let Some(candidate) = recognize(&dir, &files, already_imported) {
            out.push(candidate);
        }
    }

    // Stable, user-friendly ordering: shallowest first, then by name.
    out.sort_by(|a, b| {
        let depth_a = Path::new(&a.folder_path).components().count();
        let depth_b = Path::new(&b.folder_path).components().count();
        depth_a
            .cmp(&depth_b)
            .then_with(|| a.folder_path.to_lowercase().cmp(&b.folder_path.to_lowercase()))
    });
    out
}

/// Apply the recognition rules to one directory.
///
/// Returns `None` when the folder holds no plausible executable, which is what
/// keeps `scan_directory_impl` from reporting every folder in a tree.
pub fn recognize(
    dir: &Path,
    files: &[(PathBuf, u64)],
    already_imported: &HashSet<String>,
) -> Option<ScanCandidate> {
    let mut exes: Vec<(String, u8)> = Vec::new();
    let mut images: Vec<(PathBuf, u64)> = Vec::new();
    let mut size_bytes: u64 = 0;

    for (file, size) in files {
        size_bytes = size_bytes.saturating_add(*size);

        if let Some(name) = file.file_name().and_then(|n| n.to_str()) {
            let rank = if has_extension(name, "exe") {
                exe_rank(name)
            } else if SCRIPT_EXTENSIONS
                .iter()
                .any(|extension| has_extension(name, extension))
            {
                script_rank(name)
            } else {
                None
            };
            if let Some(rank) = rank {
                exes.push((name.to_string(), rank));
            }
        }
        if is_cover_name(file) {
            images.push((file.clone(), *size));
        }
    }

    if exes.is_empty() {
        return None;
    }

    // Best rank first, then byte-wise name order for determinism.
    exes.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    exes.dedup_by(|a, b| a.0.eq_ignore_ascii_case(&b.0));
    let exe_paths: Vec<String> = exes
        .iter()
        .map(|(name, _)| dir.join(name).to_string_lossy().into_owned())
        .collect();

    let cover_path = pick_cover(dir, &images);
    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let folder_path = dir.to_string_lossy().into_owned();

    // `suggested_exe` borrows `exe_paths` before the move below, so it is
    // computed first; no clone is needed.
    let suggested_exe = exe_paths.first().cloned();

    Some(ScanCandidate {
        suggested_title: suggested_title(&folder_name),
        folder_path: folder_path.clone(),
        folder_name,
        suggested_exe,
        exe_paths,
        cover_path,
        size_bytes,
        already_imported: already_imported.contains(&normalize_key(&folder_path)),
    })
}

/// Rank an `.exe` filename. Lower is better; `None` means "reject".
///
/// Priority: preferred stems, then Chinese-named executables, then `*.cn.exe`
/// (a very common localization convention), then anything else not blocklisted.
fn exe_rank(name: &str) -> Option<u8> {
    let stem = file_stem(name).to_lowercase();
    if stem.is_empty() {
        return None;
    }
    if EXE_BLOCKLIST
        .iter()
        .any(|bad| stem.starts_with(bad) || stem.contains(bad))
    {
        return None;
    }
    if EXE_PREFERRED.contains(&stem.as_str()) {
        return Some(0);
    }
    if stem.ends_with(".cn") || stem.contains("_cn") || stem.contains("chs") {
        return Some(1);
    }
    // A CJK character in the executable name is a strong signal for a localized
    // build of a Japanese game.
    if stem.chars().any(is_cjk) {
        return Some(2);
    }
    Some(3)
}

/// Rank a `.bat` / `.cmd` launcher. Lower is better; `None` means "reject".
///
/// Scripts always rank below executables (base 10), so a folder that also ships
/// `game.exe` still defaults to the exe; a folder with only a patch script still
/// becomes an importable candidate and the user can pick the script.
fn script_rank(name: &str) -> Option<u8> {
    let stem = file_stem(name).to_lowercase();
    if stem.is_empty() {
        return None;
    }
    if SCRIPT_BLOCKLIST
        .iter()
        .any(|bad| stem.contains(bad))
    {
        return None;
    }
    if SCRIPT_PREFERRED.iter().any(|preferred| stem.contains(preferred)) {
        return Some(10);
    }
    Some(14)
}

/// Pick the cover: name priority first, then the largest file.
fn pick_cover(dir: &Path, images: &[(PathBuf, u64)]) -> Option<String> {
    let best = images.iter().min_by(|a, b| {
        let rank_a = cover_rank(&a.0);
        let rank_b = cover_rank(&b.0);
        // Lower rank wins; ties go to the bigger file, then to name order.
        rank_a
            .cmp(&rank_b)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.0.to_string_lossy().cmp(&b.0.to_string_lossy()))
    })?;
    let _ = dir;
    Some(best.0.to_string_lossy().into_owned())
}

/// Rank a cover-candidate filename; `cover.*` beats `folder.*`, which beats
/// any other image.
fn cover_rank(path: &Path) -> u8 {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();
    match COVER_PREFERRED.iter().position(|p| *p == stem) {
        Some(index) => index as u8,
        None => COVER_PREFERRED
            .iter()
            .position(|p| stem.starts_with(p))
            .map(|index| index as u8)
            .unwrap_or(COVER_PREFERRED.len() as u8),
    }
}

/// Derive a display title from a folder name by stripping release-group noise.
///
/// Handles bracketed tags (`[汉化]`, `(18禁)`), trailing version markers
/// (`v1.02`, `ver 1.0`), and separator runs left behind by the removal.
pub fn suggested_title(folder_name: &str) -> String {
    let mut title = folder_name.to_string();

    // Bracketed / parenthesised groups: [..], （..）, (..), 【..】
    for (open, close) in [('[', ']'), ('（', '）'), ('(', ')'), ('【', '】')] {
        title = strip_bracketed(&title, open, close);
    }

    // Trailing version markers.
    title = strip_trailing_version(&title);

    // Trailing separators and whitespace left behind by the removals.
    let trimmed = title.trim_end_matches(['_', '-', ' ', '　', '.', '·']).trim();
    let trimmed = trimmed.trim_start_matches(['_', '-', ' ', '　', '.']).trim();
    let collapsed = collapse_spaces(trimmed);

    if collapsed.is_empty() {
        folder_name.trim().to_string()
    } else {
        collapsed
    }
}

/// Remove every `open ... close` span (non-nested, first close wins).
fn strip_bracketed(input: &str, open: char, close: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        if ch == open {
            depth += 1;
            continue;
        }
        if ch == close {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth == 0 {
            out.push(ch);
        }
    }
    out
}

/// Strip a trailing `v1.02` / `ver1.0` / `Ver. 2` marker, plus a trailing
/// `1.0` style number when it directly follows a space or separator.
fn strip_trailing_version(input: &str) -> String {
    const MARKERS: &[&str] = &["ver.", "ver", "version", "v"];
    let trimmed = input.trim_end();
    let lower = trimmed.to_lowercase();

    for marker in MARKERS {
        // Find the last separator-delimited token and test whether it is
        // exactly `<marker><digits>[.<digits>][a-z]`.
        let split_at = trimmed
            .char_indices()
            .rev()
            .find(|(_, c)| matches!(c, ' ' | '_' | '-' | '　'))
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let token = &lower[split_at..];
        if token.len() == marker.len() {
            continue;
        }
        if let Some(rest) = token.strip_prefix(marker) {
            if !rest.is_empty() && is_version_number(rest) {
                return trimmed[..split_at]
                    .trim_end_matches([' ', '_', '-', '　'])
                    .to_string();
            }
        }
    }
    trimmed.to_string()
}

/// `1`, `1.0`, `1.02b` — and nothing else.
fn is_version_number(value: &str) -> bool {
    let mut saw_digit = false;
    let mut saw_dot = false;
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            saw_digit = true;
        } else if ch == '.' && !saw_dot {
            saw_dot = true;
        } else if ch.is_ascii_alphabetic() {
            // Only a single trailing letter is tolerated (`1.0b`).
            return saw_digit && value.ends_with(ch);
        } else {
            return false;
        }
    }
    saw_digit
}

/// Collapse runs of whitespace into single spaces.
fn collapse_spaces(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    out
}

/// Case-insensitive, extension-only test.
fn has_extension(name: &str, extension: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// Filename stem, or the whole name when it has no extension.
fn file_stem(name: &str) -> &str {
    Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
}

/// True when the file looks like a cover image (by extension).
fn is_cover_name(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.iter().any(|ext| e.eq_ignore_ascii_case(ext)))
}

/// True when any path component is on the skip list.
fn is_skipped_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_lowercase())
        .is_some_and(|n| SKIPPED_DIR_NAMES.contains(&n.as_str()))
}

/// Reject Windows junctions / reparse points, which `is_dir()` alone accepts.
///
/// Without `std::os::windows::fs::MetadataExt` (still unstable for
/// `file_attributes`) the portable signal is a zero-length directory with no
/// readable entries, so the check stays cheap: only paths that fail to read are
/// treated as fake directories.
fn is_real_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok()
}

/// Normalise a path for the "already imported" comparison.
///
/// Windows paths are compared case-insensitively and without a trailing
/// separator, so `E:\Games\Foo\` and `e:\games\foo` match.
fn normalize_key(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    trimmed.to_lowercase().replace('/', "\\")
}

/// Any CJK ideograph (covers Chinese and Japanese kanji).
fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(names: &[(&str, u64)]) -> Vec<(PathBuf, u64)> {
        names
            .iter()
            .map(|(n, s)| (PathBuf::from("/games/demo").join(n), *s))
            .collect()
    }

    #[test]
    fn title_strips_group_noise() {
        assert_eq!(suggested_title("CLANNAD (18禁) [汉化]"), "CLANNAD");
        assert_eq!(suggested_title("Fate_stay_night_v1.02"), "Fate_stay_night");
        assert_eq!(suggested_title("Steins;Gate 全年龄"), "Steins;Gate 全年龄");
        assert_eq!(suggested_title("【汉化】月姫"), "月姫");
        // Never returns an empty title.
        assert_eq!(suggested_title("[汉化]"), "[汉化]");
    }

    #[test]
    fn exe_blocklist_rejects_installers() {
        assert_eq!(exe_rank("unins000.exe"), None);
        assert_eq!(exe_rank("vcredist_x64.exe"), None);
        assert_eq!(exe_rank("config.exe"), None);
        assert_eq!(exe_rank("game.exe"), Some(0));
        assert_eq!(exe_rank("GAME.EXE"), Some(0));
        assert_eq!(exe_rank("Sabbat_of_the_Witch_cn.exe"), Some(1));
        assert_eq!(exe_rank("月姫.exe"), Some(2));
    }

    #[test]
    fn script_launchers_rank_after_executables() {
        assert_eq!(script_rank("start.bat"), Some(10));
        assert_eq!(script_rank("patch.bat"), Some(10));
        assert_eq!(script_rank("启动游戏.cmd"), Some(10));
        assert_eq!(script_rank("unins000.bat"), None);
        assert_eq!(script_rank("setup.bat"), None);
        assert_eq!(script_rank("misc.cmd"), Some(14));
    }

    #[test]
    fn recognize_accepts_batch_launchers() {
        // Both present: the executable stays the default suggestion, the script
        // stays selectable in the dropdown.
        let both = recognize(
            Path::new("/games/demo"),
            &files(&[("game.exe", 10), ("start.bat", 5)]),
            &HashSet::new(),
        )
        .expect("candidate");
        assert_eq!(both.exe_paths.len(), 2);
        assert!(both.suggested_exe.unwrap().ends_with("game.exe"));

        // Script-only patch folder: still importable, suggested launch is the bat.
        let script_only = recognize(
            Path::new("/games/patch"),
            &files(&[("start.bat", 5)]),
            &HashSet::new(),
        )
        .expect("script-only folder is a candidate");
        assert!(script_only.suggested_exe.unwrap().ends_with("start.bat"));

        // Installer scripts are rejected like installer executables.
        assert!(recognize(
            Path::new("/games/x"),
            &files(&[("unins000.bat", 5)]),
            &HashSet::new(),
        )
        .is_none());
    }

    #[test]
    fn recognize_requires_an_executable() {
        let none = recognize(Path::new("/games/demo"), &files(&[("readme.txt", 10)]), &HashSet::new());
        assert!(none.is_none());

        let some = recognize(
            Path::new("/games/demo"),
            &files(&[
                ("unins000.exe", 100),
                ("game.exe", 200),
                ("cover.jpg", 50),
                ("big.png", 900),
            ]),
            &HashSet::new(),
        )
        .expect("game.exe makes this a candidate");

        assert_eq!(some.exe_paths.len(), 1);
        assert!(some.suggested_exe.unwrap().ends_with("game.exe"));
        // `cover.jpg` beats the larger `big.png` because of the name priority.
        assert!(some.cover_path.unwrap().ends_with("cover.jpg"));
        assert_eq!(some.size_bytes, 1250);
        assert_eq!(some.suggested_title, "demo");
    }

    #[test]
    fn already_imported_is_case_insensitive() {
        let mut set = HashSet::new();
        set.insert(normalize_key("E:\\Games\\Demo\\"));
        let candidate = recognize(
            Path::new("E:\\games\\demo"),
            &files(&[("game.exe", 1)]),
            &set,
        )
        .expect("candidate");
        assert!(candidate.already_imported);
    }

    /// A throwaway directory under the OS temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("galgame-scanner-{tag}-{nanos}"));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn write(&self, name: &str, bytes: usize) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, vec![0u8; bytes]).expect("write temp file");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn inspect_exe_file_prefers_the_selected_executable() {
        let dir = TempDir::new("prefer");
        // `game.exe` would normally win (rank 0); the user picked the
        // blocklisted `config.exe`, which must lead anyway.
        dir.write("game.exe", 10);
        let picked = dir.write("config.exe", 20);
        dir.write("cover.jpg", 30);

        let candidate =
            inspect_exe_file_impl(&picked, &HashSet::new()).expect("never errors on a real file");

        assert_eq!(candidate.folder_path, dir.0.to_string_lossy());
        assert_eq!(candidate.suggested_exe.as_deref(), Some(picked.to_string_lossy().as_ref()));
        // The heuristic's own pick is still offered as an alternative.
        assert!(candidate
            .exe_paths
            .iter()
            .any(|p| p.ends_with("game.exe")));
        // The selected exe appears exactly once, at the front.
        assert_eq!(candidate.exe_paths.len(), 2);
        assert_eq!(paths_equal(&candidate.exe_paths[0], &picked.to_string_lossy()), true);
        assert!(candidate.cover_path.unwrap().ends_with("cover.jpg"));
    }

    #[test]
    fn inspect_exe_file_never_errors_when_recognition_fails() {
        let dir = TempDir::new("fallback");
        // Sole executable, and it is on the blocklist: `recognize` returns None.
        let picked = dir.write("unins000.exe", 40);
        dir.write("cover.jpg", 10);

        let candidate = inspect_exe_file_impl(&picked, &HashSet::new())
            .expect("a minimal candidate beats an error");

        assert_eq!(candidate.folder_path, dir.0.to_string_lossy());
        assert_eq!(candidate.exe_paths.len(), 1);
        assert_eq!(candidate.suggested_exe.as_deref(), Some(picked.to_string_lossy().as_ref()));
        // The title comes from the folder name via the shared helper.
        assert_eq!(
            candidate.suggested_title,
            suggested_title(&dir.0.file_name().unwrap().to_string_lossy())
        );
        // Best-effort cover and size.
        assert!(candidate.cover_path.unwrap().ends_with("cover.jpg"));
        assert_eq!(candidate.size_bytes, 50);
        assert!(!candidate.already_imported);
    }

    #[test]
    fn inspect_exe_file_flags_already_imported_folders() {
        let dir = TempDir::new("imported");
        let picked = dir.write("game.exe", 10);

        let mut set = HashSet::new();
        set.insert(normalize_key(&dir.0.to_string_lossy()));

        let candidate = inspect_exe_file_impl(&picked, &set).expect("candidate");
        assert!(candidate.already_imported);
    }

    #[test]
    fn inspect_exe_file_reports_the_parent_folder() {
        let dir = TempDir::new("parent");
        let picked = dir.write("game.exe", 10);

        let candidate = inspect_exe_file_impl(&picked, &HashSet::new()).expect("candidate");
        assert_eq!(candidate.folder_name, dir.0.file_name().unwrap().to_string_lossy());
        // The title derives from the folder, not from the exe name.
        assert!(!candidate.suggested_title.contains("game.exe"));
    }
}
