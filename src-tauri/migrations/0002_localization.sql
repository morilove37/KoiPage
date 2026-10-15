-- Display translations are kept separately from the user's original metadata.
CREATE TABLE IF NOT EXISTS localization_cache (
    source_text TEXT PRIMARY KEY,
    translated_text TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
