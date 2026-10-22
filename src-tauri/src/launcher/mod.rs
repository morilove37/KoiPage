//! Game launching, play-time accounting, and library import/export/backup.
//!
//! This module is intentionally separate from [`crate::commands`]: the commands
//! module is the pure SQLite data layer, while everything here has side effects
//! on the *outside* world (spawning processes, touching the filesystem).
//!
//! ## Launch lifecycle
//!
//! `launch_game` inserts a `play_sessions` row and spawns the child process, then
//! hands the waiting to a background task so the command returns immediately
//! with the new session id. When the tracked launch and its descendants exit,
//! that task closes the session,
//! folds the elapsed time into `games.play_time_seconds`, and emits a
//! `game-exited` event so the UI can refetch without polling.
//!
//! Running processes are tracked in [`RunningGames`], which lets `stop_game`
//! find and kill a child that was started earlier in the same app session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::error::{CmdError, CmdResult};
use crate::commands::games::pool;
use crate::commands::util::{not_found, now_iso8601};
pub mod locale;
pub mod magpie;
pub mod luna;
mod process_tree;
pub mod sessions;
use process_tree::TrackedChild;

/// Settings key holding the path of the locale-emulation tool ("转区工具").
pub const LOCALE_TOOL_PATH_KEY: &str = "locale_tool_path";
/// Settings key holding `"1"` / `"0"` for whether the locale tool is used.
pub const LOCALE_TOOL_USE_KEY: &str = "locale_tool_use";
pub const LOCALE_TOOL_SOURCE_KEY: &str = "locale_tool_source";

// ---------------------------------------------------------------------------
// Running-process registry
// ---------------------------------------------------------------------------

/// Games with a tracked launch still alive, keyed by game id.
///
/// Only used so `stop_game` can terminate a launch that this app started; a game
/// launched outside the manager, or before a restart, is simply not tracked.
#[derive(Default)]
pub struct RunningGames(
    pub Mutex<HashMap<i64, RunningGame>>,
    pub tokio::sync::Mutex<()>,
);

/// One tracked launch: its process group and the session it belongs to.
pub struct RunningGame {
    child: TrackedChild,
    pub session_id: i64,
    pub started_at: String,
    clock: std::time::Instant,
}

enum ProcessState {
    Gone,
    Alive,
    Exited(Option<i32>),
}

impl RunningGames {
    fn poll_exit(&self, game_id: i64, session_id: i64) -> CmdResult<ProcessState> {
        let mut map = self.0.lock().map_err(|_| CmdError("进程表已损坏".to_string()))?;
        let Some(entry) = map.get_mut(&game_id) else { return Ok(ProcessState::Gone) };
        if entry.session_id != session_id { return Ok(ProcessState::Gone) }
        let code = match entry.child.try_wait() {
            Ok(None) => return Ok(ProcessState::Alive),
            Ok(Some(status)) => status.code(),
            Err(error) => return Err(CmdError(format!("查询游戏进程失败：{error}"))),
        };
        map.remove(&game_id);
        Ok(ProcessState::Exited(code))
    }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Returned by `launch_game` once the process has been spawned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub session_id: i64,
    /// OS process id, so the frontend can show/link it.
    pub pid: u32,
}

/// Returned by `import_games`. `skipped` counts rows whose `install_path`
/// already existed (or that were invalid), `imported` counts new rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
}

/// Emitted as the `game-exited` event once a launched process terminates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameExitedPayload {
    pub game_id: i64,
    pub session_id: i64,
    pub duration_seconds: i64,
    /// `null` when the process was killed rather than exiting on its own.
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A minimal view of the columns `launch_game` needs, so a launch does not have
/// to deserialize a whole [`crate::commands::model::Game`].
///
/// `id` is not selected: the caller already has it as `game_id`.
#[derive(Debug, Clone, sqlx::FromRow)]
struct LaunchTarget {
    exe_path: Option<String>,
    launch_args: Option<String>,
    workdir: Option<String>,
}

/// Read one `settings` value, treating blank as absent.
async fn setting(pool: &Pool<Sqlite>, key: &str) -> CmdResult<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .and_then(|(v,)| v)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty()))
}

/// Is a truthy settings flag set? Accepts the usual spellings so a hand-edited
/// database does not silently disable the feature.
fn flag_is_on(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Split a command-line string into arguments, honouring double quotes.
///
/// `launch_args` is a single free-text field, so it is parsed with the same
/// conventions `CommandLineToArgvW` uses for simple cases: whitespace separates
/// arguments, `"..."` groups them, and `\"` is a literal quote.
pub fn split_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_content = false;

    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if chars.peek() == Some(&'"') => {
                current.push('"');
                has_content = true;
                chars.next();
            }
            '"' => {
                // Toggle quoting; remember that an empty `""` is still an arg.
                in_quotes = !in_quotes;
                has_content = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_content {
                    args.push(std::mem::take(&mut current));
                    has_content = false;
                }
            }
            c => {
                current.push(c);
                has_content = true;
            }
        }
    }
    if has_content {
        args.push(current);
    }
    args
}

/// The directory a process should start in: the explicit `workdir`, else the
/// executable's parent directory, else the current directory.
fn resolve_workdir(exe: &Path, workdir: Option<&str>) -> PathBuf {
    if let Some(dir) = workdir.map(str::trim).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    exe.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Is this a Windows batch launcher (`.bat` / `.cmd`)?
///
/// Patches occasionally ship as a batch file that sets up the environment and
/// starts the real executable. `CreateProcess` cannot run those directly, so
/// [`launch_game`] wraps them in `cmd.exe`.
pub fn is_script(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
        })
}

/// Build the `cmd.exe` invocation for a batch launcher.
///
/// `/D` skips AutoRun commands, `/C` runs the script and exits. The arguments
/// stay separate so the standard Windows quoting handles spaces and quotes.
fn script_command(script: &Path, args: &[String]) -> CmdResult<(PathBuf, Vec<String>)> {
    let command_interpreter = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    if !command_interpreter.is_file() {
        return Err(CmdError("找不到 cmd.exe，无法启动 .bat/.cmd 脚本".into()));
    }
    let mut command = vec![
        "/D".to_string(),
        "/C".to_string(),
        "call".to_string(),
        script.to_string_lossy().into_owned(),
    ];
    command.extend(args.iter().cloned());
    Ok((command_interpreter, command))
}

/// `YYYYMMDD-HHMMSS` in UTC, for timestamped backup file names.
fn timestamp_slug() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

// ---------------------------------------------------------------------------
// launch_game / stop_game
// ---------------------------------------------------------------------------

/// `launch_game` — start a game's executable and open a play session.
///
/// Returns as soon as the process is spawned; the session is closed later by a
/// background task that awaits the child.
#[tauri::command]
pub async fn launch_game(app: AppHandle, game_id: i64) -> CmdResult<LaunchResult> {
    // Reserve launch setup across its database awaits, so concurrent requests
    // cannot both pass the registry check before either inserts its child.
    let running_state = app.state::<RunningGames>();
    let _launch_guard = running_state.1.lock().await;
    if app.path().app_config_dir()?.join(".koipage-restore/ready").is_file() {
        return Err(CmdError("恢复已准备完成，请完全退出恋页后重新打开，再启动游戏。".into()));
    }
    let db = pool(&app).await?;

    if crate::commands::installation::is_archived(&db, game_id).await? {
        return Err(CmdError("该游戏已卸载并归档，请先重新安装并恢复安装状态后再启动。".into()));
    }

    let target = sqlx::query_as::<_, LaunchTarget>(
        "SELECT exe_path, launch_args, workdir FROM games WHERE id = ?",
    )
    .bind(game_id)
    .fetch_optional(&db)
    .await?
    .ok_or_else(|| not_found("game", game_id))?;

    let exe = target
        .exe_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| CmdError(format!("游戏 {game_id} 尚未设置可执行文件路径")))?;
    let exe_path = PathBuf::from(exe);
    if !exe_path.is_file() {
        return Err(CmdError(format!("可执行文件不存在: {}", exe_path.display())));
    }

    // Refuse a second concurrent launch rather than leaking a second child.
    {
        let running = app.state::<RunningGames>();
        let map = running
            .0
            .lock()
            .map_err(|_| CmdError("进程表已损坏".to_string()))?;
        if map.contains_key(&game_id) {
            return Err(CmdError(format!("游戏 {game_id} 已在运行中或正在结算，请稍后重试")));
        }
    }

    let args = split_args(target.launch_args.as_deref().unwrap_or(""));
    let workdir = resolve_workdir(&exe_path, target.workdir.as_deref());
    // A patch may ship as `start.bat` rather than an executable; those can only
    // be started through `cmd.exe`, never with `CreateProcess` directly.
    let script = is_script(&exe_path);

    // Start Magpie first when the user opted in, so the scaling hotkey is ready
    // by the time the game window appears. Best effort only — a missing or
    // broken Magpie install must never stop the game from launching.
    let launch_profile = crate::commands::launch_profiles::resolve(&db, game_id).await?;
    if launch_profile.magpie && !launch_profile.profile.scaling_mode.trim().is_empty() && magpie::is_running() {
        return Err(CmdError("Magpie 正在运行。请在启动面板中确认退出并重新启动 Magpie，以应用本款缩放模式。".into()));
    }
    if launch_profile.magpie {
        let source = setting(&db, magpie::SOURCE_KEY).await?;
        let custom = setting(&db, magpie::PATH_KEY).await?;
        let scaling = launch_profile.scaling_mode.clone();
        magpie::autostart(&app, source.as_deref(), custom.as_deref(), scaling.as_deref());
    }

    if launch_profile.luna {
        if let Err(error) = luna::luna_launch(app.clone()).await {
            crate::app_warn!("[luna] optional per-game autostart: {error}");
        }
    }

    let locale_use = launch_profile.locale;
    if locale_use && script {
        return Err(CmdError(
            "转区启动暂不支持 .bat/.cmd 启动脚本；请改用游戏 exe，或先关闭转区启动。".into(),
        ));
    }
    let (program, program_args): (PathBuf, Vec<String>) = if locale_use {
        if launch_profile.locale_source == "custom" {
            let tool = launch_profile.locale_path.clone()
                .filter(|path| Path::new(path).is_file())
                .ok_or_else(|| CmdError("转区工具不存在，请在设置中选择工具，或改用内置 LE。".into()))?;
            let tool = PathBuf::from(tool);
            let le = tool.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("LEProc.exe"));
            let all = if le { locale::arguments(&exe_path, &args, false) } else {
                std::iter::once(exe_path.to_string_lossy().into_owned()).chain(args).collect()
            };
            (tool, all)
        } else {
            locale::validate_game(&exe_path)?;
            (locale::bundled_path(&app)?, locale::arguments(&exe_path, &args, true))
        }
    } else if script {
        // `/C` executes the script and then cmd exits; args stay separate so
        // Rust's Windows quoting protects paths with spaces.
        script_command(&exe_path, &args)?
    } else {
        (exe_path.clone(), args)
    };
    let mut command = std::process::Command::new(&program);
    command.args(&program_args);
    if workdir.is_dir() {
        command.current_dir(&workdir);
    }

    automatic_save_backup(&app, game_id, crate::commands::save_backups::BackupReason::BeforeLaunch).await?;

    let mut child = TrackedChild::spawn(&mut command).map_err(|e| {
        CmdError(format!(
            "启动失败 {}: {e}",
            program.to_string_lossy()
        ))
    })?;
    let pid = child.id();

    // Session is opened *after* a successful spawn so a failed launch does not
    // leave a dangling open session behind.
    let started_at = now_iso8601();
    let session_result: CmdResult<i64> = async {
    let mut tx = db.begin().await?;
    let session_id: i64 = sqlx::query_scalar(
        "INSERT INTO play_sessions (game_id, started_at, ended_at, duration_seconds) \
         VALUES (?, ?, NULL, 0) RETURNING id",
    )
    .bind(game_id)
    .bind(&started_at)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE games SET last_played_at = ?, \
         status = CASE WHEN status IN ('unplayed', 'wishlist') THEN 'playing' ELSE status END, \
         updated_at = ? WHERE id = ?",
    )
    .bind(&started_at)
    .bind(&started_at)
    .bind(game_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(session_id)
    }.await;
    let session_id = match session_result {
        Ok(id) => id,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    {
        let running = app.state::<RunningGames>();
        let mut map = running
            .0
            .lock()
            .map_err(|_| CmdError("进程表已损坏".to_string()))?;
        map.insert(
            game_id,
            RunningGame {
                child,
                session_id,
                started_at: started_at.clone(),
                clock: std::time::Instant::now(),
            },
        );
    }

    // Poll with `try_wait` while the child stays in the registry. Moving the
    // child out and calling `wait()` here would make `stop_game` and duplicate
    // launch checks lose sight of a process for its entire lifetime.
    let app_for_wait = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut checkpoint_clock = std::time::Instant::now();
        let session_clock = std::time::Instant::now();
        loop {
            {
                // Serialize removal and database settlement with launches, stops
                // and updater readiness checks. An empty process map alone does
                // not mean the last play-session transaction has committed.
                let running = app_for_wait.state::<RunningGames>();
                let _session_guard = running.1.lock().await;
                let state = app_for_wait.state::<RunningGames>().poll_exit(game_id, session_id);
                if matches!(state, Ok(ProcessState::Gone)) { return; }
                if let Err(error) = &state {
                    crate::app_warn!("[launcher] process query game_id={game_id}: {error}");
                }
                if checkpoint_clock.elapsed().as_secs() >= 30 {
                    if let Err(error) = sessions::checkpoint(&db, session_id, session_clock.elapsed().as_secs() as i64).await {
                        crate::app_warn!("[launcher] checkpoint session_id={session_id}: {error}");
                    }
                    checkpoint_clock = std::time::Instant::now();
                }
                if let Ok(ProcessState::Exited(exit_code)) = state {
                    if let Err(error) = finish_session(
                        &app_for_wait,
                        game_id,
                        session_id,
                        session_clock.elapsed().as_secs() as i64,
                        exit_code,
                    )
                    .await {
                        crate::app_warn!("[launcher] settlement session_id={session_id}: {error}");
                    }
                    // Settle time first. Snapshot I/O must never add to play time.
                    // Forced stops use the separate stop_game path, never this hook.
                    if exit_code == Some(0) {
                        if let Err(error) = automatic_save_backup(&app_for_wait, game_id,
                            crate::commands::save_backups::BackupReason::AfterExit).await {
                            crate::app_warn!("[save-backup] game_id={game_id}: {error}");
                        }
                    }
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    });

    crate::logging::record("INFO", "launcher", &format!("游戏启动 game_id={game_id} session_id={session_id} pid={pid}"));
    Ok(LaunchResult { session_id, pid })
}

/// Called with the launch mutex held. Keep background results available even
/// when the saves tab is closed and its event listeners are not mounted.
async fn automatic_save_backup(app: &AppHandle, game_id: i64,
    reason: crate::commands::save_backups::BackupReason) -> CmdResult<()> {
    let outcome = crate::commands::save_backups::auto_backup(app, game_id, reason).await;
    let (success, message) = match &outcome {
        Ok(Some(_)) => (true, "自动存档备份已完成。".to_string()),
        Ok(None) => return Ok(()),
        Err(error) => (false, error.to_string()),
    };
    let created_at = now_iso8601();
    let status = serde_json::json!({ "createdAt": created_at, "success": success, "message": message });
    if let Ok(db) = pool(app).await {
        if let Err(error) = sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(format!("game_save_backup_last:{game_id}"))
            .bind(status.to_string()).execute(&db).await {
            crate::app_warn!("[save-backup] status persistence game_id={game_id}: {error}");
        }
    }
    let _ = app.emit(if success { "save-backup-completed" } else { "save-backup-failed" },
        serde_json::json!({ "gameId": game_id, "createdAt": created_at, "success": success, "message": message }));
    outcome.map(|_| ())
}

/// `game_running` — whether this app currently tracks a live process for a game.
///
/// The launch dialog uses this when it is reopened, so its stop button reflects
/// the real process registry instead of resetting to "not running" locally.
#[tauri::command]
pub fn game_running(app: AppHandle, game_id: i64) -> CmdResult<bool> {
    let running = app.state::<RunningGames>();
    let mut map = running
        .0
        .lock()
        .map_err(|_| CmdError("进程表已损坏".to_string()))?;
    let Some(entry) = map.get_mut(&game_id) else {
        return Ok(false);
    };
    match entry.child.try_wait() {
        Ok(None) => Ok(true),
        // Keep an exited entry until the watcher closes its play session and
        // emits `game-exited`; removing it here would lose that bookkeeping.
        Ok(Some(_)) => Ok(false),
        Err(error) => Err(CmdError(format!("查询游戏进程失败：{error}"))),
    }
}

/// Close a play session and fold its duration into the game's total.
///
/// Idempotent: a session that is already closed keeps its stored duration, so a
/// kill path that races the natural-exit path cannot double-count.
async fn finish_session(
    app: &AppHandle,
    game_id: i64,
    session_id: i64,
    elapsed: i64,
    exit_code: Option<i32>,
) -> CmdResult<GameExitedPayload> {
    let db = pool(app).await?;
    let duration = sessions::settle(&db, session_id,
        Some(elapsed)).await?;

    let payload = GameExitedPayload {
        game_id,
        session_id,
        duration_seconds: duration,
        exit_code,
    };
    // A missing webview (app shutting down) must not fail the bookkeeping.
    crate::logging::record("INFO", "launcher", &format!("游戏退出 game_id={game_id} session_id={session_id} duration_seconds={duration} exit_code={exit_code:?}"));
    let _ = app.emit("game-exited", payload.clone());
    Ok(payload)
}

/// `stop_game` — kill a process this app started, closing its session.
///
/// Returns `false` when nothing was running for that game.
#[tauri::command]
pub async fn stop_game(app: AppHandle, game_id: i64) -> CmdResult<bool> {
    let running_state = app.state::<RunningGames>();
    let _session_guard = running_state.1.lock().await;
    let entry = {
        let running = app.state::<RunningGames>();
        let mut map = running
            .0
            .lock()
            .map_err(|_| CmdError("进程表已损坏".to_string()))?;
        map.remove(&game_id)
    };

    let Some(mut entry) = entry else {
        return Ok(false);
    };

    // The original patch/locale launcher may already be gone. Terminate the
    // tracked launch, including its remaining game descendants.
    if let Err(error) = entry.child.kill() {
        if !matches!(entry.child.try_wait(), Ok(Some(_))) {
            // A failed termination must keep the process controllable and
            // tracked by its existing watcher.
            app.state::<RunningGames>().0.lock()
                .map_err(|_| CmdError("进程表已损坏".to_string()))?
                .insert(game_id, entry);
            return Err(CmdError(format!("结束进程失败: {error}")));
        }
    }
    let exit_code = entry.child.wait().ok().and_then(|s| s.code());

    // Reap the session here; the wait task in `launch_game` finds the map entry
    // already gone and returns without touching it.
    finish_session(&app, game_id, entry.session_id, entry.clock.elapsed().as_secs() as i64, exit_code).await?;

    Ok(true)
}


// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/// Flat, portable representation of a game for JSON/CSV interchange.
///
/// Deliberately not the DB row: `id` and the audit timestamps are dropped so an
/// export can be imported on another machine without id collisions.
///
/// # Field naming
///
/// The Rust fields are **snake_case**, so `sqlx::FromRow` matches them against
/// the snake_case SQL columns directly — no `#[sqlx(rename)]` or SQL aliases are
/// needed. `#[serde(rename_all = "camelCase")]` affects **only** serde (the JSON
/// export and the CSV header row), which is why the JSON keys are camelCase
/// while the column mapping stays trivial. The two concerns are independent;
/// `export_game_row_mapping_is_not_shifted_by_serde_rename` guards this.
#[derive(Debug, Clone, Default, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExportGame {
    pub title: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub favorite: Option<i64>,
    #[serde(default)]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub install_path: String,
    #[serde(default)]
    pub exe_path: Option<String>,
    #[serde(default)]
    pub launch_args: Option<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub play_time_seconds: Option<i64>,
    #[serde(default)]
    pub last_played_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub vndb_id: Option<String>,
    #[serde(default)]
    pub bangumi_id: Option<String>,
}

/// Column order for CSV output. Also the header row.
const CSV_COLUMNS: [&str; 19] = [
    "title",
    "originalTitle",
    "developer",
    "releaseDate",
    "status",
    "rating",
    "favorite",
    "coverPath",
    "description",
    "installPath",
    "exePath",
    "launchArgs",
    "workdir",
    "savePath",
    "playTimeSeconds",
    "lastPlayedAt",
    "notes",
    "vndbId",
    "bangumiId",
];

fn game_to_csv_row(game: &ExportGame) -> Vec<String> {
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    let opt_num = |v: &Option<i64>| v.map(|n| n.to_string()).unwrap_or_default();
    vec![
        game.title.clone(),
        opt(&game.original_title),
        opt(&game.developer),
        opt(&game.release_date),
        opt(&game.status),
        game.rating.map(|rating| rating.to_string()).unwrap_or_default(),
        opt_num(&game.favorite),
        opt(&game.cover_path),
        opt(&game.description),
        game.install_path.clone(),
        opt(&game.exe_path),
        opt(&game.launch_args),
        opt(&game.workdir),
        opt(&game.save_path),
        opt_num(&game.play_time_seconds),
        opt(&game.last_played_at),
        opt(&game.notes),
        opt(&game.vndb_id),
        opt(&game.bangumi_id),
    ]
}

/// Quote one CSV field per RFC 4180.
///
/// A field is quoted when it contains a comma, a double quote, CR or LF. Inner
/// double quotes are doubled. Fields without those characters are emitted
/// verbatim, so plain data stays readable.
fn csv_escape(field: &str) -> String {
    let needs_quotes = field.contains(',')
        || field.contains('"')
        || field.contains('\n')
        || field.contains('\r');
    if !needs_quotes {
        return field.to_string();
    }
    let mut out = String::with_capacity(field.len() + 2);
    out.push('"');
    for ch in field.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

/// Serialise games as an RFC 4180 CSV document (CRLF line endings, trailing
/// newline). Quoting/escaping is handled by [`csv_escape`].
pub fn games_to_csv(games: &[ExportGame]) -> String {
    let mut out = String::new();
    out.push_str(&CSV_COLUMNS.join(","));
    out.push_str("\r\n");
    for game in games {
        let row: Vec<String> = game_to_csv_row(game).iter().map(|f| csv_escape(f)).collect();
        out.push_str(&row.join(","));
        out.push_str("\r\n");
    }
    out
}

/// Parse an RFC 4180 CSV document into records.
///
/// Handles quoted fields containing commas, doubled quotes (`""` → `"`), and
/// embedded CR/LF inside quotes. A bare CR or LF outside quotes ends a record;
/// both `\r\n` and `\n` are accepted, and a trailing newline does not create a
/// spurious empty record.
pub fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    // Distinguishes `a,` (two fields, second empty) from `a` (one field).
    let mut field_started = false;

    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            match ch {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        field.push('"');
                        chars.next();
                    } else {
                        in_quotes = false;
                    }
                }
                c => field.push(c),
            }
            continue;
        }

        match ch {
            '"' if field.is_empty() => {
                // Only the first character of a field may open a quoted section.
                in_quotes = true;
                field_started = true;
            }
            ',' => {
                record.push(std::mem::take(&mut field));
                field_started = false;
            }
            '\r' => {
                // Swallow the LF of a CRLF pair.
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                field_started = false;
                records.push(std::mem::take(&mut record));
            }
            '\n' => {
                record.push(std::mem::take(&mut field));
                field_started = false;
                records.push(std::mem::take(&mut record));
            }
            c => {
                field.push(c);
                field_started = true;
            }
        }
    }

    // Flush the final field/record unless the document ended on a newline.
    if field_started || !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }

    // Drop rows that are completely empty (e.g. blank lines between records).
    records
        .into_iter()
        .filter(|r| !(r.len() == 1 && r[0].is_empty()))
        .collect()
}

fn csv_record_to_game(header: &[String], record: &[String]) -> ExportGame {
    let mut game = ExportGame::default();
    let get = |name: &str| -> Option<String> {
        let idx = header.iter().position(|h| h == name)?;
        record
            .get(idx)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let get_num = |name: &str| -> Option<i64> { get(name).and_then(|v| v.parse::<i64>().ok()) };

    game.title = get("title").unwrap_or_default();
    game.original_title = get("originalTitle");
    game.developer = get("developer");
    game.release_date = get("releaseDate");
    game.status = get("status");
    game.rating = get("rating").and_then(|value| value.parse::<f64>().ok());
    game.favorite = get_num("favorite");
    game.cover_path = get("coverPath");
    game.description = get("description");
    game.install_path = get("installPath").unwrap_or_default();
    game.exe_path = get("exePath");
    game.launch_args = get("launchArgs");
    game.workdir = get("workdir");
    game.save_path = get("savePath");
    game.play_time_seconds = get_num("playTimeSeconds");
    game.last_played_at = get("lastPlayedAt");
    game.notes = get("notes");
    game.vndb_id = get("vndbId");
    game.bangumi_id = get("bangumiId");
    game
}

/// Load every game in export form, ordered by title.
async fn load_export_games(db: &Pool<Sqlite>) -> CmdResult<Vec<ExportGame>> {
    let rows = sqlx::query_as::<_, ExportGame>(
        "SELECT title, original_title, developer, release_date, status, ROUND(CAST(rating AS REAL) + 1e-12, 2) AS rating, favorite, \
         cover_path, description, install_path, exe_path, launch_args, workdir, save_path, \
         play_time_seconds, last_played_at, notes, vndb_id, bangumi_id FROM games \
         ORDER BY title COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// `export_games` — write the library to `path` as JSON or CSV.
///
/// `format` is `"json"` or `"csv"` (case-insensitive). Returns the number of
/// games written.
#[tauri::command]
pub async fn export_games(app: AppHandle, format: String, path: String) -> CmdResult<usize> {
    let db = pool(&app).await?;
    let path = path.trim();
    if path.is_empty() {
        return Err(CmdError("导出路径不能为空".to_string()));
    }

    let games = load_export_games(&db).await?;

    let body = match format.trim().to_ascii_lowercase().as_str() {
        "json" => serde_json::to_string_pretty(&games)
            .map_err(|e| CmdError(format!("序列化 JSON 失败: {e}")))?,
        "csv" => games_to_csv(&games),
        other => {
            return Err(CmdError(format!(
                "不支持的导出格式 {other:?}，请使用 \"json\" 或 \"csv\""
            )));
        }
    };

    let dest = Path::new(path);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CmdError(format!("无法创建目录 {}: {e}", parent.display())))?;
        }
    }
    std::fs::write(dest, body)
        .map_err(|e| CmdError(format!("写入 {} 失败: {e}", dest.display())))?;

    Ok(games.len())
}

/// Decode an export file based on its extension: `.json` or `.csv`.
fn parse_import_file(path: &Path, contents: &str) -> CmdResult<Vec<ExportGame>> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "json" => serde_json::from_str::<Vec<ExportGame>>(contents)
            .map_err(|e| CmdError(format!("解析 JSON 失败: {e}"))),
        "csv" => {
            let mut records = parse_csv(contents);
            if records.is_empty() {
                return Err(CmdError("CSV 文件为空或没有数据行".to_string()));
            }
            let header = records.remove(0);
            Ok(records
                .iter()
                .map(|r| csv_record_to_game(&header, r))
                .collect())
        }
        other => Err(CmdError(format!(
            "不支持的文件类型 {other:?}，请选择 .json 或 .csv 文件"
        ))),
    }
}

/// `import_games` — insert games from a JSON/CSV export.
///
/// De-duplicates on `install_path`: a row whose path already exists is counted
/// as skipped, as is a row missing `title` or `installPath`.
#[tauri::command]
pub async fn import_games(app: AppHandle, path: String) -> CmdResult<ImportResult> {
    let db = pool(&app).await?;
    let src = PathBuf::from(path.trim());
    if !src.is_file() {
        return Err(CmdError(format!("文件不存在: {}", src.display())));
    }

    let contents = std::fs::read_to_string(&src)
        .map_err(|e| CmdError(format!("读取 {} 失败: {e}", src.display())))?;
    let games = parse_import_file(&src, &contents)?;

    let now = now_iso8601();
    let mut imported = 0usize;
    let mut skipped = 0usize;

    let mut tx = db.begin().await?;
    for game in games {
        let title = game.title.trim();
        let install_path = game.install_path.trim();
        if title.is_empty() || install_path.is_empty() {
            skipped += 1;
            continue;
        }

        // Skip anything already present, including a duplicate inside the file.
        let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM games WHERE install_path = ?")
            .bind(install_path)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_some() {
            skipped += 1;
            continue;
        }

        let result = sqlx::query(
            "INSERT INTO games (title, original_title, developer, release_date, status, rating, \
             favorite, cover_path, description, install_path, exe_path, launch_args, workdir, \
             save_path, play_time_seconds, last_played_at, notes, vndb_id, bangumi_id, created_at, \
             updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
             ?15, ?16, ?17, ?18, ?19, ?20, ?20)",
        )
        .bind(title)
        .bind(game.original_title)
        .bind(game.developer)
        .bind(game.release_date)
        .bind(
            game.status
                .filter(|s| crate::commands::model::ALL_STATUSES.contains(&s.as_str()))
                .unwrap_or_else(|| crate::commands::model::STATUS_UNPLAYED.to_string()),
        )
        .bind(crate::commands::util::validate_rating(game.rating)?)
        .bind(game.favorite.unwrap_or(0))
        .bind(game.cover_path)
        .bind(game.description)
        .bind(install_path)
        .bind(game.exe_path)
        .bind(game.launch_args)
        .bind(game.workdir)
        .bind(game.save_path)
        .bind(game.play_time_seconds.unwrap_or(0))
        .bind(game.last_played_at)
        .bind(game.notes)
        .bind(game.vndb_id)
        .bind(game.bangumi_id)
        .bind(&now)
        .execute(&mut *tx)
        .await;

        match result {
            Ok(_) => imported += 1,
            // The unique index on install_path turns a race into a skip.
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => skipped += 1,
            Err(e) => return Err(CmdError(e.to_string())),
        }
    }
    tx.commit().await?;

    if imported > 0 {
        let saved = match crate::commands::covers::directory(&app) {
            Ok(directory) => crate::commands::covers::migrate(&db, &directory).await,
            Err(error) => Err(error),
        };
        if let Err(error) = saved { crate::app_warn!("[covers] imported library cover preservation: {error}"); }
        if let Err(error) = crate::commands::scan_roots::sync_asset_scope(app).await {
            crate::app_warn!("[covers] imported library asset grants: {error}");
        }
    }
    Ok(ImportResult { imported, skipped })
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/// `backup_database` — copy the sqlite file into `dest_dir` with a timestamp.
///
/// SQLite creates a consistent standalone snapshot with `VACUUM INTO`, so pages
/// committed in WAL mode are included. Returns the new file's path.
#[tauri::command]
pub async fn backup_database(app: AppHandle, dest_dir: String) -> CmdResult<String> {
    let db = pool(&app).await?;

    let dest_dir = dest_dir.trim();
    if dest_dir.is_empty() {
        return Err(CmdError("备份目录不能为空".to_string()));
    }
    let dest_dir = PathBuf::from(dest_dir);

    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| CmdError(format!("无法创建目录 {}: {e}", dest_dir.display())))?;
    let base = format!("galgame-{}", timestamp_slug());
    let mut dest = dest_dir.join(format!("{base}.db"));
    let mut suffix = 1usize;
    while dest.exists() {
        dest = dest_dir.join(format!("{base}-{suffix}.db"));
        suffix += 1;
    }

    // `VACUUM INTO` asks SQLite itself for a transactionally consistent
    // snapshot. A filesystem copy can silently omit committed pages that are
    // still in the WAL file.
    write_snapshot(&db, &dest).await?;
    Ok(dest.to_string_lossy().into_owned())
}

async fn write_snapshot(db: &Pool<Sqlite>, dest: &Path) -> CmdResult<()> {
    sqlx::query("VACUUM INTO ?")
        .bind(dest.to_string_lossy().into_owned())
        .execute(db)
        .await
        .map_err(|e| CmdError(format!("创建数据库备份失败: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exporting_reads_legacy_ratings_and_rounds_to_hundredths() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0001_init.sql"))
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO games (title, install_path, created_at, updated_at, rating) VALUES ('Legacy', 'old', 'now', 'now', 8), ('Decimal', 'new', 'now', 'now', 8.725)")
            .execute(&pool).await.unwrap();
        let rows = load_export_games(&pool).await.unwrap();
        assert_eq!(rows.iter().find(|row| row.title == "Legacy").unwrap().rating, Some(8.0));
        assert_eq!(rows.iter().find(|row| row.title == "Decimal").unwrap().rating, Some(8.73));
        let csv = games_to_csv(&rows);
        let imported = parse_import_file(Path::new("games.csv"), &csv).unwrap();
        assert_eq!(imported.iter().find(|row| row.title == "Decimal").unwrap().rating, Some(8.73));
    }

    #[cfg(windows)]
    #[test]
    fn watcher_keeps_live_child_controllable_and_ignores_other_sessions() {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 10"])
            .creation_flags(0x0800_0000);
        let child = TrackedChild::spawn(&mut command).unwrap();
        let running = RunningGames::default();
        running.0.lock().unwrap().insert(1, RunningGame { child, session_id: 42, started_at: now_iso8601(), clock: std::time::Instant::now() });
        let live = matches!(running.poll_exit(1, 42), Ok(ProcessState::Alive));
        let old_watcher_ignored = matches!(running.poll_exit(1, 41), Ok(ProcessState::Gone));
        // Kill and reap the child even when an assertion below would fail.
        let mut entry = running.0.lock().unwrap().remove(&1).expect("watcher must retain a live child");
        entry.child.kill().unwrap();
        entry.child.wait().unwrap();
        running.0.lock().unwrap().insert(1, entry);
        let ended = matches!(running.poll_exit(1, 42), Ok(ProcessState::Exited(_)));
        assert!(live && old_watcher_ignored && ended);
        assert!(running.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn backup_contains_committed_wal_pages_without_checkpoint() {
        use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("galgame-backup-{stamp}"));
        std::fs::create_dir(&dir).unwrap();
        let db = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(dir.join("source.db"))
                .create_if_missing(true).journal_mode(SqliteJournalMode::Wal),
        ).await.unwrap();
        sqlx::query("CREATE TABLE evidence (value TEXT)").execute(&db).await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&db).await.unwrap();
        sqlx::query("INSERT INTO evidence VALUES ('committed in WAL')").execute(&db).await.unwrap();
        assert!(std::fs::metadata(dir.join("source.db-wal")).unwrap().len() > 0);
        let dest = dir.join("snapshot.db");
        write_snapshot(&db, &dest).await.unwrap();
        let snapshot = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(&dest).read_only(true),
        ).await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM evidence").fetch_one(&snapshot).await.unwrap();
        assert_eq!(value, "committed in WAL");
        snapshot.close().await;
        db.close().await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn split_args_handles_quotes_and_spaces() {
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("   "), Vec::<String>::new());
        assert_eq!(split_args("-a -b"), vec!["-a", "-b"]);
        assert_eq!(split_args("-a  -b"), vec!["-a", "-b"]);
        assert_eq!(
            split_args(r#"-name "my game" -x"#),
            vec!["-name", "my game", "-x"]
        );
        // Empty quoted string is still an argument.
        assert_eq!(split_args(r#"a "" b"#), vec!["a", "", "b"]);
        // Escaped quote inside a quoted argument.
        assert_eq!(split_args(r#""say \"hi\"""#), vec![r#"say "hi""#]);
    }

    #[test]
    fn csv_escape_quotes_only_when_needed() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), r#""a,b""#);
        assert_eq!(csv_escape(r#"say "hi""#), r#""say ""hi""""#);
        assert_eq!(csv_escape("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_escape("cr\rlf"), "\"cr\rlf\"");
    }

    #[test]
    fn csv_round_trip_preserves_tricky_fields() {
        let game = ExportGame {
            title: "Title, with comma".to_string(),
            original_title: Some(r#"Quote "inside""#.to_string()),
            developer: Some("Line1\nLine2".to_string()),
            install_path: r"C:\Games\a,b".to_string(),
            status: Some("playing".to_string()),
            // Keep this within the validated 0-10 rating range so the fixture
            // stays representative if value validation is ever added to the
            // import path (see `commands::util::validate_rating`).
            rating: Some(8.725),
            favorite: Some(1),
            play_time_seconds: Some(3661),
            ..Default::default()
        };
        let csv = games_to_csv(&[game.clone()]);
        assert!(csv.starts_with("title,originalTitle,"));

        let mut records = parse_csv(&csv);
        let header = records.remove(0);
        assert_eq!(header, CSV_COLUMNS.to_vec());
        assert_eq!(records.len(), 1);

        let parsed = csv_record_to_game(&header, &records[0]);
        assert_eq!(parsed.title, game.title);
        assert_eq!(parsed.original_title, game.original_title);
        assert_eq!(parsed.developer, game.developer);
        assert_eq!(parsed.install_path, game.install_path);
        // Compare against the fixture rather than a hardcoded literal, so the
        // test cannot drift when the sample value changes.
        assert_eq!(parsed.rating, game.rating);
        assert_eq!(parsed.favorite, Some(1));
        assert_eq!(parsed.play_time_seconds, Some(3661));
        assert_eq!(parsed.status.as_deref(), Some("playing"));
    }

    #[test]
    fn csv_round_trip_with_many_games_and_empty_fields() {
        let games = vec![
            ExportGame {
                title: "A".to_string(),
                install_path: "p1".to_string(),
                ..Default::default()
            },
            ExportGame {
                title: "B".to_string(),
                install_path: "p2".to_string(),
                notes: None,
                ..Default::default()
            },
        ];
        let csv = games_to_csv(&games);
        let mut records = parse_csv(&csv);
        let header = records.remove(0);
        assert_eq!(records.len(), 2);
        assert_eq!(csv_record_to_game(&header, &records[0]).title, "A");
        assert_eq!(csv_record_to_game(&header, &records[1]).install_path, "p2");
    }

    #[test]
    fn parse_csv_handles_crlf_and_trailing_newline() {
        let records = parse_csv("a,b\r\n1,2\r\n");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0], vec!["a", "b"]);
        assert_eq!(records[1], vec!["1", "2"]);

        // No trailing newline behaves the same.
        let records = parse_csv("a,b\n1,2");
        assert_eq!(records.len(), 2);
        assert_eq!(records[1], vec!["1", "2"]);
    }

    #[test]
    fn parse_csv_trailing_comma_keeps_empty_field() {
        let records = parse_csv("a,b,\n");
        assert_eq!(records[0], vec!["a", "b", ""]);
    }

    #[test]
    fn parse_csv_embedded_newline_inside_quotes() {
        let records = parse_csv("h1,h2\n\"multi\nline\",x\n");
        assert_eq!(records.len(), 2);
        assert_eq!(records[1][0], "multi\nline");
        assert_eq!(records[1][1], "x");
    }

    #[test]
    fn flag_is_on_accepts_common_spellings() {
        assert!(!flag_is_on(None));
        assert!(flag_is_on(Some("1")));
        assert!(flag_is_on(Some("true")));
        assert!(flag_is_on(Some(" YES ")));
        assert!(!flag_is_on(Some("0")));
        assert!(!flag_is_on(Some("")));
    }

    #[test]
    fn resolve_workdir_prefers_explicit_then_parent() {
        let exe = Path::new(r"C:\Games\Foo\game.exe");
        assert_eq!(
            resolve_workdir(exe, Some(r"D:\Other")),
            PathBuf::from(r"D:\Other")
        );
        assert_eq!(resolve_workdir(exe, None), PathBuf::from(r"C:\Games\Foo"));
        assert_eq!(
            resolve_workdir(exe, Some("   ")),
            PathBuf::from(r"C:\Games\Foo")
        );
    }

    /// The serde `camelCase` rename and the sqlx snake_case column mapping are
    /// independent. This guards against the subtle failure mode where the code
    /// compiles but export keys and column lookups drift apart.
    ///
    /// 1. serde emits `originalTitle` / `playTimeSeconds` (JSON + CSV headers).
    /// 2. `#[sqlx(rename)]` is *not* involved: the Rust field name IS the column
    ///    name, so the `SELECT ... original_title ...` in `load_export_games`
    ///    lines up. Verified here by asserting the SELECT list matches the
    ///    snake_case field names this struct declares.
    #[test]
    fn export_game_row_mapping_is_not_shifted_by_serde_rename() {
        use serde_json::json;

        let game = ExportGame {
            title: "T".to_string(),
            original_title: Some("Original".to_string()),
            release_date: Some("2024-01-01".to_string()),
            cover_path: Some(r"C:\c.png".to_string()),
            install_path: r"C:\Games\T".to_string(),
            exe_path: Some(r"C:\Games\T\t.exe".to_string()),
            launch_args: Some("-x".to_string()),
            save_path: Some(r"C:\save".to_string()),
            play_time_seconds: Some(42),
            last_played_at: Some("2024-05-01T12:00:00Z".to_string()),
            vndb_id: Some("v1".to_string()),
            bangumi_id: Some("b1".to_string()),
            ..Default::default()
        };

        // 1. serde side: camelCase keys.
        let value = serde_json::to_value(&game).expect("serialises");
        assert_eq!(value["originalTitle"], json!("Original"));
        assert_eq!(value["releaseDate"], json!("2024-01-01"));
        assert_eq!(value["coverPath"], json!(r"C:\c.png"));
        assert_eq!(value["installPath"], json!(r"C:\Games\T"));
        assert_eq!(value["exePath"], json!(r"C:\Games\T\t.exe"));
        assert_eq!(value["launchArgs"], json!("-x"));
        assert_eq!(value["savePath"], json!(r"C:\save"));
        assert_eq!(value["playTimeSeconds"], json!(42));
        assert_eq!(value["lastPlayedAt"], json!("2024-05-01T12:00:00Z"));
        assert_eq!(value["vndbId"], json!("v1"));
        assert_eq!(value["bangumiId"], json!("b1"));
        // The snake_case names must NOT leak into the JSON payload.
        assert!(value.get("original_title").is_none());
        assert!(value.get("play_time_seconds").is_none());

        // 2. sqlx side: the column names in `load_export_games` are snake_case
        //    and must match these field names one-for-one.
        let select_columns = [
            "title",
            "original_title",
            "developer",
            "release_date",
            "status",
            "rating",
            "favorite",
            "cover_path",
            "description",
            "install_path",
            "exe_path",
            "launch_args",
            "workdir",
            "save_path",
            "play_time_seconds",
            "last_played_at",
            "notes",
            "vndb_id",
            "bangumi_id",
        ];
        for column in select_columns {
            assert!(
                EXPORT_GAME_FIELDS.contains(&column),
                "column {column:?} has no matching ExportGame field; \
                 FromRow would fail or silently mismatch"
            );
        }

        // 3. Round-trip through serde proves Deserialize uses the same names
        //    that Serialize wrote (what the JSON import path relies on).
        let json = serde_json::to_string(&game).expect("serialises");
        let back: ExportGame = serde_json::from_str(&json).expect("deserialises");
        assert_eq!(back.original_title, game.original_title);
        assert_eq!(back.play_time_seconds, game.play_time_seconds);
        assert_eq!(back.install_path, game.install_path);
    }

    /// Snake_case field names of [`ExportGame`], kept beside the test that
    /// cross-checks them against the SELECT list.
    const EXPORT_GAME_FIELDS: [&str; 19] = [
        "title",
        "original_title",
        "developer",
        "release_date",
        "status",
        "rating",
        "favorite",
        "cover_path",
        "description",
        "install_path",
        "exe_path",
        "launch_args",
        "workdir",
        "save_path",
        "play_time_seconds",
        "last_played_at",
        "notes",
        "vndb_id",
        "bangumi_id",
    ];

    #[test]
    fn scripts_are_detected_case_insensitively() {
        assert!(is_script(Path::new(r"C:\Games\Patch\start.bat")));
        assert!(is_script(Path::new(r"C:\Games\Patch\START.CMD")));
        assert!(!is_script(Path::new(r"C:\Games\Patch\game.exe")));
    }

    /// A patch may be a batch file in a path with spaces; verify the cmd wrapper
    /// both finds the script and forwards an argument containing a space.
    #[cfg(windows)]
    #[test]
    fn batch_launcher_runs_through_cmd_with_spaced_paths_and_args() {
        let directory = std::env::temp_dir().join(format!(
            "koipage-batch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let script = directory.join("start game.bat");
        std::fs::write(&script, "@echo off\r\necho %~1> result.txt\r\n").unwrap();

        let (program, args) = script_command(&script, &["two words".to_string()]).unwrap();
        let status = std::process::Command::new(program)
            .args(&args)
            .current_dir(&directory)
            .status()
            .expect("cmd should start");
        assert!(status.success(), "batch exited with {status:?}");
        let result = std::fs::read_to_string(directory.join("result.txt")).unwrap();
        assert_eq!(result.trim(), "two words");

        std::fs::remove_dir_all(directory).unwrap();
    }
}
