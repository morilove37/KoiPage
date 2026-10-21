//! Per-game launch overrides; global settings remain the inherited defaults.

use super::{
    error::{CmdError, CmdResult},
    games::pool,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Switch {
    #[default]
    Inherit,
    On,
    Off,
}
impl Switch {
    pub fn resolve(self, global: bool) -> bool {
        match self {
            Self::Inherit => global,
            Self::On => true,
            Self::Off => false,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchProfile {
    pub locale: Switch,
    pub magpie: Switch,
    pub luna: Switch,
    pub locale_source: String,
    pub locale_path: String,
    pub scaling_mode: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveLaunchProfile {
    pub profile: LaunchProfile,
    pub locale: bool,
    pub magpie: bool,
    pub luna: bool,
    pub locale_source: String,
    pub locale_path: Option<String>,
    pub scaling_mode: Option<String>,
}
fn key(game_id: i64) -> String {
    format!("game_launch_profile_{game_id}")
}
pub async fn load(db: &SqlitePool, game_id: i64) -> CmdResult<LaunchProfile> {
    let value: Option<Option<String>> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(key(game_id))
            .fetch_optional(db)
            .await?;
    match value.flatten() {
        Some(value) => serde_json::from_str(&value)
            .map_err(|e| CmdError(format!("启动配置损坏，请在详情页重置：{e}"))),
        None => Ok(LaunchProfile {
            locale_source: "inherit".into(),
            ..Default::default()
        }),
    }
}
async fn global(db: &SqlitePool, key: &str) -> CmdResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, Option<String>>("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(db)
            .await?
            .flatten(),
    )
}
fn on(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}
pub async fn resolve(db: &SqlitePool, game_id: i64) -> CmdResult<EffectiveLaunchProfile> {
    let profile = load(db, game_id).await?;
    let locale = profile
        .locale
        .resolve(on(global(db, "locale_tool_use").await?.as_deref()));
    let magpie = profile
        .magpie
        .resolve(on(global(db, "magpie_autostart").await?.as_deref()));
    let luna = profile
        .luna
        .resolve(on(global(db, "luna_autostart").await?.as_deref()));
    let inherited = profile.locale_source.is_empty() || profile.locale_source == "inherit";
    let locale_source = if inherited {
        global(db, "locale_tool_source")
            .await?
            .unwrap_or_else(|| "bundled".into())
    } else {
        profile.locale_source.clone()
    };
    let locale_path = if inherited {
        global(db, "locale_tool_path").await?
    } else if profile.locale_path.trim().is_empty() {
        None
    } else {
        Some(profile.locale_path.trim().into())
    };
    let scaling_mode = if profile.scaling_mode.trim().is_empty() {
        global(db, "magpie_scaling_mode").await?
    } else {
        Some(profile.scaling_mode.trim().into())
    };
    Ok(EffectiveLaunchProfile {
        profile,
        locale,
        magpie,
        luna,
        locale_source,
        locale_path,
        scaling_mode,
    })
}
async fn ensure_game(db: &SqlitePool, game_id: i64) -> CmdResult<()> {
    if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM games WHERE id = ?)")
        .bind(game_id)
        .fetch_one(db)
        .await?
    {
        return Err(CmdError("游戏不存在".into()));
    }
    Ok(())
}
#[tauri::command]
pub async fn launch_profile_get(app: AppHandle, game_id: i64) -> CmdResult<EffectiveLaunchProfile> {
    let db = pool(&app).await?;
    ensure_game(&db, game_id).await?;
    resolve(&db, game_id).await
}
#[tauri::command]
pub async fn launch_profile_save(
    app: AppHandle,
    game_id: i64,
    profile: LaunchProfile,
) -> CmdResult<EffectiveLaunchProfile> {
    if !["", "inherit", "bundled", "custom"].contains(&profile.locale_source.as_str()) {
        return Err(CmdError("转区工具来源无效".into()));
    }
    if profile.locale_source == "custom"
        && !std::path::Path::new(profile.locale_path.trim()).is_file()
    {
        return Err(CmdError("请选择存在的自定义转区工具".into()));
    }
    if !profile.scaling_mode.is_empty() {
        let config = crate::launcher::magpie::magpie_scaling_config(app.clone()).await?;
        if !config
            .modes
            .iter()
            .any(|mode| mode.name == profile.scaling_mode)
        {
            return Err(CmdError(
                "所选缩放模式已不存在，请重新选择或跟随全局".into(),
            ));
        }
    }
    let db = pool(&app).await?;
    ensure_game(&db, game_id).await?;
    let json = serde_json::to_string(&profile).map_err(|e| CmdError(e.to_string()))?;
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(key(game_id)).bind(json).execute(&db).await?;
    resolve(&db, game_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flags_resolve_without_changing_global_defaults() {
        assert!(Switch::Inherit.resolve(true));
        assert!(!Switch::Off.resolve(true));
        assert!(Switch::On.resolve(false));
        assert!(serde_json::from_str::<LaunchProfile>(r#"{"locale":"yes"}"#).is_err());
    }
    #[tokio::test]
    async fn per_game_overrides_do_not_write_global_settings() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('locale_tool_use','1'),('luna_autostart','0'),('magpie_autostart','1');").execute(&db).await.unwrap();
        assert!(resolve(&db, 1).await.unwrap().locale);
        sqlx::query("INSERT INTO settings VALUES(?,?)")
            .bind(key(1))
            .bind(r#"{"locale":"off","luna":"on","magpie":"off","localeSource":"inherit"}"#)
            .execute(&db)
            .await
            .unwrap();
        let first = resolve(&db, 1).await.unwrap();
        assert!(!first.locale);
        assert!(!first.magpie);
        assert!(first.luna);
        let other = resolve(&db, 2).await.unwrap();
        assert!(other.locale);
        assert!(other.magpie);
        assert!(!other.luna);
        let original: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='locale_tool_use'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(original, "1");
        db.close().await;
    }
}
