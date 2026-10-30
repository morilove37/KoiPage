CREATE TABLE bangumi_game_sync (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    personal_rate INTEGER CHECK(personal_rate IS NULL OR (typeof(personal_rate)='integer' AND personal_rate BETWEEN 0 AND 10)),
    personal_comment TEXT,
    account_id INTEGER,
    baseline_subject_id INTEGER,
    baseline_json TEXT,
    conflict_json TEXT,
    resolution TEXT CHECK(resolution IS NULL OR resolution IN ('local','remote')),
    last_synced_at TEXT,
    error TEXT,
    revision INTEGER NOT NULL DEFAULT 0
);
