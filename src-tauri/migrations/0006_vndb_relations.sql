-- Cache of VNDB "related works" per VN.
--
-- Relations are stable data, so one fetch is reused across every game that
-- points at the same VN: without this table, opening the detail page of each
-- entry in a series re-queried the API for the same list.
CREATE TABLE IF NOT EXISTS vndb_relation (
    vndb_id TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    relations_json TEXT NOT NULL
);
