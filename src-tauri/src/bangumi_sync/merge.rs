use super::model::SyncValue;

pub fn to_remote_status(status: &str) -> Option<i64> {
    match status {
        "unplayed" | "wishlist" => Some(1),
        "completed" => Some(2),
        "playing" => Some(3),
        "on_hold" => Some(4),
        "dropped" => Some(5),
        _ => None,
    }
}
pub fn to_local_status(status: i64) -> Option<&'static str> {
    match status {
        1 => Some("wishlist"),
        2 => Some("completed"),
        3 => Some("playing"),
        4 => Some("on_hold"),
        5 => Some("dropped"),
        _ => None,
    }
}

pub struct MergeResult {
    pub value: SyncValue,
    pub conflicts: Vec<String>,
}

fn field<T: Clone + Eq>(
    base: Option<&T>,
    local: &T,
    remote: &T,
    local_defined: bool,
    remote_defined: bool,
) -> Result<T, ()> {
    if local == remote {
        return Ok(local.clone());
    }
    if let Some(base) = base {
        if local == base {
            return Ok(remote.clone());
        }
        if remote == base {
            return Ok(local.clone());
        }
    } else {
        if !local_defined {
            return Ok(remote.clone());
        }
        if !remote_defined {
            return Ok(local.clone());
        }
    }
    Err(())
}

pub fn merge_values(
    base: Option<&SyncValue>,
    local: &SyncValue,
    remote: &SyncValue,
    rate_defined: bool,
    comment_defined: bool,
) -> MergeResult {
    if base.is_some_and(|b| b.collection_type.is_some())
        && remote.collection_type.is_none()
        && local != remote
    {
        return MergeResult {
            value: local.clone(),
            conflicts: vec!["collection".into()],
        };
    }
    let mut value = local.clone();
    let mut conflicts = Vec::new();
    match field(
        base.map(|b| &b.collection_type),
        &local.collection_type,
        &remote.collection_type,
        local.collection_type.is_some(),
        remote.collection_type.is_some(),
    ) {
        Ok(v) => value.collection_type = v,
        Err(_) => conflicts.push("status".into()),
    }
    match field(
        base.map(|b| &b.rate),
        &local.rate,
        &remote.rate,
        rate_defined,
        remote.rate != 0,
    ) {
        Ok(v) => value.rate = v,
        Err(_) => conflicts.push("rate".into()),
    }
    match field(
        base.map(|b| &b.comment),
        &local.comment,
        &remote.comment,
        comment_defined,
        !remote.comment.is_empty(),
    ) {
        Ok(v) => value.comment = v,
        Err(_) => conflicts.push("comment".into()),
    }
    if value.collection_type.is_none()
        && remote.collection_type.is_some()
        && !conflicts.iter().any(|f| f == "status")
    {
        conflicts.push("status".into());
    }
    MergeResult { value, conflicts }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bangumi_sync::model::SyncValue;
    fn value(status: Option<i64>, rate: i64, comment: &str) -> SyncValue {
        SyncValue {
            collection_type: status,
            rate,
            comment: comment.into(),
        }
    }

    #[test]
    fn status_mapping_uploads_unplayed_as_wishlist_and_maps_all_other_states() {
        assert_eq!(to_remote_status("unplayed"), Some(1));
        for (local, remote) in [
            ("wishlist", Some(1)),
            ("completed", Some(2)),
            ("playing", Some(3)),
            ("on_hold", Some(4)),
            ("dropped", Some(5)),
        ] {
            assert_eq!(to_remote_status(local), remote);
            if let Some(remote) = remote {
                assert_eq!(to_local_status(remote), Some(local));
            }
        }
        assert_eq!(to_local_status(99), None);
    }

    #[test]
    fn first_sync_imports_remote_into_empty_personal_fields_without_public_rating() {
        let remote = value(Some(2), 9, "远端短评");
        let result = merge_values(None, &value(None, 0, ""), &remote, false, false);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.value, remote);
    }

    #[test]
    fn initial_different_existing_states_conflict_instead_of_overwriting() {
        let result = merge_values(
            None,
            &value(Some(3), 0, ""),
            &value(Some(2), 8, ""),
            false,
            false,
        );
        assert_eq!(result.conflicts, vec!["status"]);
    }

    #[test]
    fn one_sided_changes_merge_field_by_field_and_equal_changes_do_not_loop() {
        let base = value(Some(3), 8, "old");
        let local = value(Some(3), 9, "old");
        let remote = value(Some(2), 8, "new");
        let merged = merge_values(Some(&base), &local, &remote, true, true);
        assert!(merged.conflicts.is_empty());
        assert_eq!(merged.value, value(Some(2), 9, "new"));
        assert!(
            merge_values(Some(&base), &remote, &remote, true, true)
                .conflicts
                .is_empty()
        );
    }

    #[test]
    fn conflicting_edits_and_remote_removal_require_resolution() {
        let base = value(Some(3), 8, "old");
        let merged = merge_values(
            Some(&base),
            &value(Some(2), 9, "mine"),
            &value(Some(4), 7, "theirs"),
            true,
            true,
        );
        assert_eq!(merged.conflicts, vec!["status", "rate", "comment"]);
        assert_eq!(
            merge_values(Some(&base), &base, &SyncValue::default(), true, true).conflicts,
            vec!["collection"]
        );
        assert!(
            merge_values(Some(&base), &value(None, 8, "old"), &base, true, true)
                .conflicts
                .contains(&"status".into())
        );
    }
}
