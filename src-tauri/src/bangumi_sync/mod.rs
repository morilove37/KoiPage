pub mod client;
pub mod credentials;
pub mod engine;
pub mod merge;
pub mod model;
pub mod store;

use crate::commands::{
    error::{CmdError, CmdResult},
    games::pool,
};
use model::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct SyncState {
    pub(crate) gate: tokio::sync::Mutex<()>,
    dirty: AtomicBool,
    last_attempt: Mutex<Option<Instant>>,
}
pub fn mark_dirty(app: &AppHandle) {
    if let Some(state) = app.try_state::<SyncState>() {
        state.dirty.store(true, Ordering::Release);
    }
}
fn notify(app: &AppHandle, event: &str) {
    let _ = app.emit(event, ());
}
async fn status(app: &AppHandle) -> CmdResult<SyncStatus> {
    let c = store::config(&pool(app).await?).await?;
    let connected = c.account.is_some() && credentials::load()?.is_some();
    Ok(SyncStatus {
        connected,
        account: c.account,
        enabled: c.enabled && connected,
        interval_seconds: 120,
        private_new: c.private_new,
        last_run_at: c.last_run_at,
        last_error: c.last_error,
        last_report: c.last_report,
    })
}

#[tauri::command]
pub async fn bangumi_sync_status(app: AppHandle) -> CmdResult<SyncStatus> {
    status(&app).await
}

#[tauri::command]
pub async fn bangumi_sync_connect(app: AppHandle, token: String) -> CmdResult<SyncStatus> {
    let state = app.state::<SyncState>();
    let _guard = state.gate.lock().await;
    let token = token.trim();
    let api = client::Client::new(token)?;
    let account = api.me().await?;
    if account.id <= 0 || account.username.is_empty() {
        return Err(CmdError("Bangumi 账号信息无效".into()));
    }
    let db = pool(&app).await?;
    let mut c = store::config(&db).await?;
    // Persist disabled state before replacing credentials: an interrupted account
    // replacement must never run the old plan with a new user's token.
    c.enabled = false;
    store::save_config(&db, &c).await?;
    credentials::save(token)?;
    if c.account.as_ref().map(|a| a.id) != Some(account.id) {
        sqlx::query("UPDATE bangumi_game_sync SET resolution=NULL,conflict_json=NULL")
            .execute(&db)
            .await?;
    }
    c.account = Some(account);
    c.last_error = None;
    c.last_report = None;
    store::save_config(&db, &c).await?;
    mark_dirty(&app);
    notify(&app, "bangumi-sync-config-changed");
    status(&app).await
}
#[tauri::command]
pub async fn bangumi_sync_disconnect(app: AppHandle) -> CmdResult<SyncStatus> {
    let state = app.state::<SyncState>();
    let _guard = state.gate.lock().await;
    let db = pool(&app).await?;
    let mut c = store::config(&db).await?;
    c.enabled = false;
    store::save_config(&db, &c).await?;
    credentials::delete()?;
    c.account = None;
    c.last_error = None;
    c.last_report = None;
    store::save_config(&db, &c).await?;
    notify(&app, "bangumi-sync-config-changed");
    status(&app).await
}
#[tauri::command]
pub async fn bangumi_sync_configure(
    app: AppHandle,
    enabled: bool,
    private_new: bool,
) -> CmdResult<SyncStatus> {
    let state = app.state::<SyncState>();
    let _guard = state.gate.lock().await;
    if enabled && !status(&app).await?.connected {
        return Err(CmdError("请先在设置中连接 Bangumi 个人令牌".into()));
    }
    let db = pool(&app).await?;
    let mut c = store::config(&db).await?;
    c.enabled = enabled;
    c.private_new = private_new;
    store::save_config(&db, &c).await?;
    mark_dirty(&app);
    notify(&app, "bangumi-sync-config-changed");
    status(&app).await
}
#[tauri::command]
pub async fn bangumi_sync_items(app: AppHandle) -> CmdResult<Vec<SyncItem>> {
    store::rows(&pool(&app).await?)
        .await?
        .iter()
        .map(|r| r.item())
        .collect()
}
#[tauri::command]
pub async fn bangumi_sync_profile_get(app: AppHandle, game_id: i64) -> CmdResult<SyncItem> {
    store::row(&pool(&app).await?, game_id).await?.item()
}
#[tauri::command]
pub async fn bangumi_sync_profile_save(
    app: AppHandle,
    game_id: i64,
    subject_id: Option<i64>,
    enabled: bool,
    personal_rate: Option<i64>,
    personal_comment: Option<String>,
    expected_revision: Option<i64>,
) -> CmdResult<SyncItem> {
    if subject_id.is_some_and(|id| id <= 0) {
        return Err(CmdError("Bangumi ID 必须为正整数".into()));
    }
    let state = app.state::<SyncState>();
    let _guard = state.gate.lock().await;
    let db = pool(&app).await?;
    let previous = store::row(&db, game_id).await?;
    if subject_id != previous.subject_id() {
        if let Some(subject) = subject_id {
            if let Some(token) = credentials::load()? {
                client::Client::new(&token)?.validate_game(subject).await?;
            } else {
                let response = crate::metadata::http_client()?
                    .get(format!("https://api.bgm.tv/v0/subjects/{subject}"))
                    .send()
                    .await
                    .map_err(|_| CmdError("无法校验 Bangumi 游戏编号，请检查网络".into()))?;
                if !response.status().is_success() {
                    return Err(CmdError(format!(
                        "Bangumi 条目校验失败：HTTP {}",
                        response.status().as_u16()
                    )));
                }
                let value: serde_json::Value = response
                    .json()
                    .await
                    .map_err(|_| CmdError("Bangumi 条目格式无效".into()))?;
                if value["type"].as_i64() != Some(4) || value["id"].as_i64() != Some(subject) {
                    return Err(CmdError("请填写 Bangumi 游戏条目的编号".into()));
                }
            }
        }
    }
    let item = store::save_profile(
        &db,
        game_id,
        subject_id,
        enabled,
        personal_rate,
        personal_comment,
        expected_revision,
    )
    .await?;
    mark_dirty(&app);
    notify(&app, "bangumi-sync-config-changed");
    Ok(item)
}
#[tauri::command]
pub async fn bangumi_sync_pause(app: AppHandle, game_id: i64) -> CmdResult<SyncItem> {
    // Enabled-only CAS invalidates any in-flight row without queueing a stale
    // full profile behind the network operation.
    let item = store::pause(&pool(&app).await?, game_id).await?;
    notify(&app, "bangumi-sync-config-changed");
    Ok(item)
}
#[tauri::command]
pub async fn bangumi_sync_resolve(
    app: AppHandle,
    game_id: i64,
    choice: String,
) -> CmdResult<SyncItem> {
    if !["local", "remote"].contains(&choice.as_str()) {
        return Err(CmdError("同步冲突处理选项无效".into()));
    }
    let state = app.state::<SyncState>();
    let _guard = state.gate.lock().await;
    let db = pool(&app).await?;
    let row = store::row(&db, game_id).await?;
    if row.conflict_json.is_none() {
        return Err(CmdError("该作品当前没有待处理冲突".into()));
    }
    sqlx::query("UPDATE bangumi_game_sync SET resolution=? WHERE game_id=?")
        .bind(choice)
        .bind(game_id)
        .execute(&db)
        .await?;
    mark_dirty(&app);
    notify(&app, "bangumi-sync-config-changed");
    store::row(&db, game_id).await?.item()
}
#[tauri::command]
pub async fn bangumi_sync_run(app: AppHandle, force: Option<bool>) -> CmdResult<SyncReport> {
    let force = force.unwrap_or(false);
    let state = app.state::<SyncState>();
    let Ok(_guard) = state.gate.try_lock() else {
        if force { return Err(CmdError("已有 Bangumi 同步正在进行，请稍候再试".into())); }
        return Ok(SyncReport::default());
    };
    let db = pool(&app).await?;
    let mut c = store::config(&db).await?;
    if !c.enabled && !force {
        return Ok(SyncReport::default());
    }
    if !force
        && !state.dirty.load(Ordering::Acquire)
        && state
            .last_attempt
            .lock()
            .map_err(|_| CmdError("同步状态不可用".into()))?
            .is_some_and(|last| last.elapsed() < Duration::from_secs(120))
    {
        return Ok(SyncReport::default());
    }
    state.dirty.swap(false, Ordering::AcqRel);
    *state
        .last_attempt
        .lock()
        .map_err(|_| CmdError("同步状态不可用".into()))? = Some(Instant::now());
    let result = async {
        let token =
            credentials::load()?.ok_or_else(|| CmdError("请先连接 Bangumi 个人令牌".into()))?;
        let api = client::Client::new(&token)?;
        let account = api.me().await?;
        if c.account.as_ref().map(|a| a.id) != Some(account.id) {
            return Err(CmdError(
                "令牌账号与已连接账号不同，请重新连接后开启同步".into(),
            ));
        }
        engine::run(&db, &api, &account, c.private_new).await
    }
    .await;
    c.last_run_at = Some(crate::commands::util::now_iso8601());
    match result {
        Ok(report) => {
            c.last_report = Some(report.clone());
            c.last_error = None;
            store::save_config(&db, &c).await?;
            let _ = app.emit("bangumi-sync-updated", &report);
            Ok(report)
        }
        Err(error) => {
            c.last_report = None;
            if error.0.starts_with("BGM_HTTP_401")
                || error.0.starts_with("BGM_HTTP_403")
                || error.0.contains("账号不同")
                || error.0.contains("请先连接")
            {
                c.enabled = false;
            }
            c.last_error = Some(error.0.clone());
            store::save_config(&db, &c).await?;
            let _ = app.emit(
                "bangumi-sync-updated",
                SyncReport {
                    errors: 1,
                    ..Default::default()
                },
            );
            Err(error)
        }
    }
}
