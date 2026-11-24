-- 2DFan guide (攻略/帖子) support: a per-game subject binding plus a local
-- cache of scraped topic lists and topic bodies.
--
-- The binding lives on `games` (one subject per game) because a game row is
-- already the identity the detail page renders; the cache tables are keyed by
-- 2DFan ids so two games bound to the same subject share one cached copy.
--
-- `blocks_json` holds the already-structured body (paragraph/line/table/image/
-- heading blocks) rather than HTML: the frontend never renders raw markup, so
-- the scraper is the only place that understands 2DFan's markup.

ALTER TABLE games ADD COLUMN twodfan_id TEXT;

-- One row per subject: the scraped topic list, as JSON.
CREATE TABLE IF NOT EXISTS twodfan_topic_list (
    subject_id TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    topics_json TEXT NOT NULL
);

-- One row per topic: the parsed body of every page, concatenated.
CREATE TABLE IF NOT EXISTS twodfan_topic (
    topic_id INTEGER PRIMARY KEY,
    subject_id TEXT,
    title TEXT NOT NULL,
    author TEXT,
    published_at TEXT,
    page_count INTEGER NOT NULL DEFAULT 0,
    blocks_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twodfan_topic_subject ON twodfan_topic (subject_id);
