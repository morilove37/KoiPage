-- ============================================================================
-- galgame-manager initial schema (UP)
--
-- IMPORTANT — do not re-add a `-- migrate:down` section to this file.
--
-- tauri-plugin-sql passes this file's *entire contents* to sqlx as a single
-- `MigrationType::ReversibleUp` script (see `MigrationKind::Up` ->
-- `MigrationType::ReversibleUp` in tauri-plugin-sql). sqlx does not parse
-- `-- migrate:down` markers the way the `sqlx` CLI does, so anything after that
-- marker is executed as part of the up migration.
--
-- The original version of this file carried the down statements inline, which
-- meant the migration created every table and then immediately dropped them
-- again — leaving an empty database recorded as successfully migrated (and
-- therefore never retried). The down statements now live in
-- `0001_init.down.sql`, which is never referenced by Rust code.
--
-- All timestamps are stored as ISO8601 UTC strings (e.g. 2024-05-01T12:34:56Z).
-- ============================================================================

CREATE TABLE IF NOT EXISTS games (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT    NOT NULL,
    original_title    TEXT,
    developer         TEXT,
    release_date      TEXT,
    -- Allowed values: unplayed | wishlist | playing | completed | on_hold | dropped
    -- (validated in Rust; SQLite has no enum type). See commands::model::ALL_STATUSES.
    status            TEXT    NOT NULL DEFAULT 'unplayed',
    rating            INTEGER,
    favorite          INTEGER NOT NULL DEFAULT 0,
    cover_path        TEXT,
    description       TEXT,
    install_path      TEXT    NOT NULL,
    exe_path          TEXT,
    launch_args       TEXT,
    workdir           TEXT,
    save_path         TEXT,
    play_time_seconds INTEGER NOT NULL DEFAULT 0,
    last_played_at    TEXT,
    notes             TEXT,
    vndb_id           TEXT,
    bangumi_id        TEXT,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
);

-- install_path is UNIQUE so the scanner can de-duplicate discovered games.
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_install_path ON games (install_path);

CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    color TEXT
);

CREATE TABLE IF NOT EXISTS game_tags (
    game_id INTEGER NOT NULL,
    tag_id  INTEGER NOT NULL,
    PRIMARY KEY (game_id, tag_id),
    FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id)  REFERENCES tags  (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_tags_tag_id ON game_tags (tag_id);

CREATE TABLE IF NOT EXISTS play_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id          INTEGER NOT NULL,
    started_at       TEXT    NOT NULL,
    ended_at         TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_play_sessions_game_id ON play_sessions (game_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS scan_roots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    path      TEXT    NOT NULL UNIQUE,
    enabled   INTEGER NOT NULL DEFAULT 1,
    max_depth INTEGER NOT NULL DEFAULT 3
);
