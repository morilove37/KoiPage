CREATE TABLE birthday_characters (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('vndb', 'bangumi')),
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT,
    birthday_month INTEGER,
    birthday_day INTEGER,
    birthday_raw TEXT,
    avatar_path TEXT,
    override_name TEXT,
    override_month INTEGER,
    override_day INTEGER,
    override_date INTEGER NOT NULL DEFAULT 0,
    override_avatar TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source, external_id)
);
CREATE TABLE birthday_game_characters (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES birthday_characters(id) ON DELETE CASCADE,
    external_game_id TEXT NOT NULL,
    role TEXT NOT NULL,
    spoiler INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(game_id, character_id)
);
CREATE INDEX idx_birthday_links_character ON birthday_game_characters(character_id);
CREATE TABLE birthday_sync (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    synced_at TEXT,
    attempted_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'error')),
    error TEXT
);
