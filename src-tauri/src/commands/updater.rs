use tauri::{AppHandle, Manager};

use super::error::{CmdError, CmdResult};
use crate::launcher::RunningGames;

/// Wait for launch registration or session settlement before allowing an update.
#[tauri::command]
pub async fn ensure_update_ready(app: AppHandle) -> CmdResult<()> {
    let running = app.state::<RunningGames>();
    let _launch = running.1.lock().await;
    let games = running.0.lock().map_err(|_| CmdError("无法读取游戏运行状态，请稍后重试。".into()))?;
    if !games.is_empty() {
        return Err(CmdError("请先退出正在运行的游戏，等待游玩时长保存后再安装更新。".into()));
    }
    Ok(())
}
