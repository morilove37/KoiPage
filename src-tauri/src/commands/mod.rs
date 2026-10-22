//! SQLite data layer: schema migrations plus the Tauri command surface.
//!
//! Migrations live in `src-tauri/migrations/` and are registered with
//! `tauri_plugin_sql` from [`migrations`]. The plugin only runs them
//! *lazily*, when a database is actually connected — either because it is
//! listed in the plugin's `preload` config or because the frontend calls
//! `Database.load("sqlite:galgame.db")`. See [`crate::DB_URL`].

pub mod error;
pub mod backup;
pub mod installation;
pub mod save_backups;
pub mod launch_profiles;
pub mod relocation;
pub mod library_batch;
pub mod covers;
pub mod games;
pub mod metadata;
pub mod model;
pub mod play_sessions;
pub mod scan_roots;
pub mod settings;
pub mod tags;
pub mod util;
pub mod updater;
pub mod share;
pub mod window;

// `CmdError` / `CmdResult` are used by the sibling modules via `super::error`;
// nothing outside this module needs them, so they are not re-exported here.

/// Connection string shared by the Rust plugin registration and the frontend.
///
/// tauri-plugin-sql stores sqlite files relative to `BaseDirectory::App`, so
/// this is `<app_config_dir>/galgame.db` on disk.
pub const DB_URL: &str = "sqlite:galgame.db";

/// Migrations applied to [`DB_URL`].
///
/// `tauri_plugin_sql::Migration` is a plain struct — the plugin does **not**
/// accept a `sqlx::migrate!()` macro here. Each entry's `sql` is the literal
/// migration body, so it is inlined via `include_str!` at compile time.
///
/// # The `sql` body must contain ONLY up statements
///
/// The whole `sql` string is handed to sqlx as one
/// `MigrationType::ReversibleUp` script. **sqlx does not parse `-- migrate:up`
/// / `-- migrate:down` markers** — that is `sqlx-cli` behaviour, not
/// `SqlxMigration::new`. A down block left in this string would therefore run
/// as part of the up migration.
///
/// This is not hypothetical: the first version of `0001_init.sql` had its down
/// block inline, so sqlx created all six tables and then immediately dropped
/// them, recording version 1 as `success = 1`. The database was left empty and
/// **permanently un-migratable**, because sqlx never retries a succeeded
/// migration. Down statements live in `0001_init.down.sql`, which is not
/// referenced by any Rust code and exists only for manual rollback.
pub fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    use tauri_plugin_sql::MigrationKind;

    vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "init",
        sql: include_str!("../../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }, tauri_plugin_sql::Migration {
        version: 2,
        description: "localization cache",
        sql: include_str!("../../migrations/0002_localization.sql"),
        kind: MigrationKind::Up,
    }, tauri_plugin_sql::Migration {
        version: 3,
        description: "character birthdays",
        sql: include_str!("../../migrations/0003_birthdays.sql"),
        kind: MigrationKind::Up,
    }]
}

/// Escape a user-supplied string for a SQL `LIKE` pattern.
pub(crate) fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
