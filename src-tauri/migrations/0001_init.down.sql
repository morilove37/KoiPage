-- ============================================================================
-- galgame-manager initial schema (DOWN) — for manual/offline rollback only.
--
-- This file is deliberately NOT referenced by any Rust code and is NOT passed
-- to tauri-plugin-sql. `include_str!` for migrations points only at
-- `0001_init.sql`.
--
-- Background: tauri-plugin-sql hands the whole migration file to sqlx as an
-- "up" script and does not understand `-- migrate:down` markers. Keeping the
-- drop statements in the up file caused the migration to create every table
-- and then drop it again, producing an empty database that sqlx still recorded
-- as successfully applied.
--
-- To roll back manually, run this against the database, then delete the
-- matching row from `_sqlx_migrations` (version = 1).
-- ============================================================================

DROP INDEX IF EXISTS idx_play_sessions_game_id;
DROP TABLE IF EXISTS play_sessions;
DROP INDEX IF EXISTS idx_game_tags_tag_id;
DROP TABLE IF EXISTS game_tags;
DROP TABLE IF EXISTS tags;
DROP INDEX IF EXISTS idx_games_install_path;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS scan_roots;
