//! Small helpers shared across command modules.

use super::error::{CmdError, CmdResult};

/// Current time as an ISO8601 UTC string with a `Z` suffix, second precision.
///
/// The schema stores every timestamp in this format, so all writes go through
/// this helper rather than `SQLite`'s `datetime()` (which emits `YYYY-MM-DD
/// HH:MM:SS` without a timezone).
pub fn now_iso8601() -> String {
    let now = time::OffsetDateTime::now_utc();
    now.replace_nanosecond(0)
        .expect("0ns is a valid nanosecond value")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC3339 formatting of a valid UTC datetime cannot fail")
}

/// Reject a malformed timestamp before it reaches the database.
pub fn validate_iso8601(value: &str, field: &str) -> CmdResult<()> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|_| ())
        .map_err(|e| CmdError(format!("{field} must be an ISO8601 timestamp: {e}")))
}

/// Trim a required string and reject blanks.
pub fn required_string(value: &str, field: &str) -> CmdResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CmdError(format!("{field} must not be empty")));
    }
    Ok(trimmed.to_string())
}

/// Normalise an optional string: trim, then treat blank as absent.
pub fn optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Validate `games.status` against the allowed set.
pub fn validate_status(status: &str) -> CmdResult<String> {
    let status = status.trim();
    if super::model::ALL_STATUSES.contains(&status) {
        Ok(status.to_string())
    } else {
        Err(CmdError(format!(
            "status must be one of {:?}, got {status:?}",
            super::model::ALL_STATUSES
        )))
    }
}

/// Validate a finite 0-10 rating and round to two decimal places.
pub fn validate_rating(rating: Option<f64>) -> CmdResult<Option<f64>> {
    match rating {
        Some(r) if !r.is_finite() || !(0.0..=10.0).contains(&r) => {
            Err(CmdError(format!("rating must be between 0 and 10, got {r}")))
        }
        Some(r) => Ok(Some(crate::rating::round_rating(r))),
        None => Ok(None),
    }
}

/// Validate `scan_roots.max_depth` (>= 1) when present.
pub fn validate_max_depth(max_depth: Option<i64>) -> CmdResult<Option<i64>> {
    match max_depth {
        Some(d) if d < 1 => Err(CmdError(format!("maxDepth must be >= 1, got {d}"))),
        other => Ok(other),
    }
}

/// Map a "no rows" condition to a friendly error.
pub fn not_found(entity: &str, id: i64) -> CmdError {
    CmdError(format!("{entity} {id} not found"))
}
