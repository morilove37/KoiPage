pub mod avatars;
pub mod model;
pub mod portable;
pub mod providers;
pub mod store;

use crate::commands::{
    error::{CmdError, CmdResult},
    games::pool,
    settings::settings_get_impl,
};
use model::*;
use std::{
    path::Path,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct Runtime {
    progress: Progress,
    cancel: Arc<AtomicBool>,
}
fn runtime() -> &'static Mutex<Runtime> {
    static STATE: OnceLock<Mutex<Runtime>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Runtime::default()))
}
fn progress() -> Progress {
    runtime()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .progress
        .clone()
}
fn change(f: impl FnOnce(&mut Progress)) {
    f(&mut runtime().lock().unwrap_or_else(|e| e.into_inner()).progress);
}
fn updated(app: &AppHandle) {
    let _ = app.emit("birthdays-updated", ());
}

#[tauri::command]
pub async fn birthdays_list(app: AppHandle) -> CmdResult<Snapshot> {
    let db = pool(&app).await?;
    let characters = store::list_characters(&db).await?;
    for c in &characters {
        if let Some(path) = &c.avatar_path {
            crate::allow_asset_file(&app, path);
        }
    }
    Ok(Snapshot {
        characters,
        sync: store::list_sync(&db).await?,
        enabled: settings_get_impl(&db, "birthday_sync_enabled")
            .await?
            .as_deref()
            == Some("1"),
        progress: progress(),
    })
}

#[tauri::command]
pub async fn birthdays_update(app: AppHandle, id: String, input: CharacterEdit) -> CmdResult<()> {
    let db = pool(&app).await?;
    if !valid_date(input.month, input.day) {
        return Err(CmdError("请输入有效的生日月日，或同时留空".into()));
    }
    let avatar = if !input.reset {
        input
            .avatar_file
            .as_deref()
            .map(|p| {
                avatars::read_image(Path::new(p))
                    .and_then(|bytes| avatars::save_image(&avatars::cache_dir(&app)?, &bytes))
            })
            .transpose()?
    } else {
        None
    };
    store::update_character(&db, &id, &input, avatar.as_deref()).await?;
    updated(&app);
    Ok(())
}

#[tauri::command]
pub async fn birthdays_sync_start(app: AppHandle, force: bool) -> CmdResult<Progress> {
    if progress().running {
        return Ok(progress());
    }
    let db = pool(&app).await?;
    // Only an explicit request (force=true) opts the user into future updates.
    let enabled = settings_get_impl(&db, "birthday_sync_enabled")
        .await?
        .as_deref()
        == Some("1");
    if !force && !enabled {
        return Ok(progress());
    }
    if force {
        sqlx::query("INSERT INTO settings(key,value) VALUES('birthday_sync_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").execute(&db).await?;
    }
    let work = store::sync_work(&db, force).await?;
    let cancel = {
        let mut state = runtime().lock().unwrap_or_else(|e| e.into_inner());
        if state.progress.running {
            return Ok(state.progress.clone());
        }
        state.cancel = Arc::new(AtomicBool::new(false));
        state.progress = Progress {
            running: !work.is_empty(),
            total: work.len(),
            ..Progress::default()
        };
        state.cancel.clone()
    };
    if work.is_empty() {
        updated(&app);
        return Ok(progress());
    }
    tauri::async_runtime::spawn(async move {
        let result = run_sync(&app, &db, work, cancel).await;
        change(|p| {
            p.running = false;
            p.cancelling = false;
            p.current = None;
            if let Err(e) = result {
                p.error = Some(e.to_string());
            }
        });
        updated(&app);
    });
    Ok(progress())
}

async fn run_sync(
    app: &AppHandle,
    db: &sqlx::SqlitePool,
    work: Vec<SyncWork>,
    cancel: Arc<AtomicBool>,
) -> CmdResult<()> {
    let mut client = providers::ProviderClient::new(cancel.clone())?;
    let dir = avatars::cache_dir(app)?;
    for w in work {
        if client.is_cancelled() {
            break;
        }
        change(|p| p.current = Some(w.title.clone()));
        updated(app);
        let result = async {
            let mut characters = client.characters(&w).await?;
            for c in &mut characters {
                if client.is_cancelled() {
                    return Err(CmdError("已取消同步".into()));
                }
                let existing: Option<String> =
                    sqlx::query_scalar("SELECT avatar_path FROM birthday_characters WHERE id=?")
                        .bind(format!("{}:{}", w.source, c.external_id))
                        .fetch_optional(db)
                        .await?
                        .flatten();
                if let Some(path) = existing.filter(|p| Path::new(p).is_file()) {
                    c.avatar = Some(path);
                    continue;
                }
                c.avatar = match c.avatar.take() {
                    Some(url) => match client.avatar(&url).await {
                        Ok(bytes) => avatars::save_image(&dir, &bytes).ok(),
                        Err(e) if e.0.contains("429") => return Err(e),
                        Err(_) => None,
                    },
                    None => None,
                };
            }
            if client.is_cancelled() {
                return Err(CmdError("已取消同步".into()));
            }
            store::save_work_cancellable(db, &w, &characters, &cancel).await?;
            Ok::<_, CmdError>(())
        }
        .await;
        if client.is_cancelled() {
            break;
        }
        let mut limited = false;
        if let Err(error) = result {
            store::record_failure(db, &w, &error.0).await?;
            limited = error.0.contains("429");
            change(|p| {
                p.failed += 1;
                p.error = Some(error.0);
            });
        }
        change(|p| p.completed += 1);
        updated(app);
        if limited {
            break;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn birthdays_sync_cancel() -> CmdResult<Progress> {
    let mut state = runtime().lock().unwrap_or_else(|e| e.into_inner());
    if state.progress.running {
        state.cancel.store(true, Ordering::Relaxed);
        state.progress.cancelling = true;
    }
    Ok(state.progress.clone())
}

#[tauri::command]
pub async fn birthdays_export(app: AppHandle, path: String) -> CmdResult<usize> {
    let db = pool(&app).await?;
    let data = portable::export_data(&db).await?;
    let count = data.characters.len();
    let bytes = serde_json::to_vec(&data).map_err(|_| CmdError("生日资料导出失败".into()))?;
    if bytes.len() as u64 > portable::MAX_PORTABLE {
        return Err(CmdError("生日资料超过 64 MB，无法导出".into()));
    }
    std::fs::write(&path, bytes).map_err(|_| CmdError("无法写入生日资料文件".into()))?;
    Ok(count)
}

#[tauri::command]
pub async fn birthdays_import(app: AppHandle, path: String) -> CmdResult<usize> {
    if progress().running {
        return Err(CmdError("请先取消生日同步，再导入资料".into()));
    }
    use std::io::Read;
    let file = std::fs::File::open(&path).map_err(|_| CmdError("无法打开生日资料文件".into()))?;
    let mut bytes = vec![];
    file.take(portable::MAX_PORTABLE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CmdError("生日资料读取失败".into()))?;
    if bytes.len() as u64 > portable::MAX_PORTABLE {
        return Err(CmdError("生日资料不能超过 64 MB".into()));
    }
    let data = serde_json::from_slice(&bytes)
        .map_err(|_| CmdError("生日资料格式无效，请选择本应用导出的 JSON 文件".into()))?;
    let db = pool(&app).await?;
    let count = portable::import_data(&db, data, &avatars::cache_dir(&app)?).await?;
    updated(&app);
    Ok(count)
}
#[cfg(test)]
mod tests;
