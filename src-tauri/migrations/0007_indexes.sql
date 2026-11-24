-- Indexes for the queries every launch runs.
--
-- The library list sorts with `ORDER BY title COLLATE NOCASE`, and the play
-- history sorts with `ORDER BY started_at DESC, id DESC`. Neither had an index:
-- 0001 only covered `games(install_path)`, `game_tags(tag_id)` and
-- `play_sessions(game_id)`, so both lists were sorted in memory on every visit.
-- A few dozen rows hide that cost, but the sort is O(n log n) per open and it
-- grows with the library, so the index pays for itself as soon as a user has a
-- few hundred entries.
--
-- The collation has to be spelled out: the default BINARY collation would not
-- serve `COLLATE NOCASE`, and an index SQLite cannot use is pure write cost.
CREATE INDEX IF NOT EXISTS idx_games_title_nocase ON games (title COLLATE NOCASE);

-- `id DESC` is included so the whole ORDER BY is satisfied by the index rather
-- than requiring a second pass for ties on the same timestamp.
CREATE INDEX IF NOT EXISTS idx_play_sessions_started_at
    ON play_sessions (started_at DESC, id DESC);
