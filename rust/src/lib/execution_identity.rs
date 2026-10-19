//! Names an execution answers to (issue #231).
//!
//! An execution is found by its UUID, its backend session name, the session
//! names it used before a resume (`options.sessionNameHistory`, #162), its
//! display name (`options.name`, set by `--rename`) and its aliases
//! (`options.aliases`, added by `--alias` and `--rename`). Aliases are kept
//! apart from `sessionNameHistory` because that list names real backend
//! sessions: `--cleanup` removes those containers and `--resume` derives the
//! root session from it.
use crate::execution_store::{ExecutionRecord, ExecutionStore};
use serde_json::{json, Value};

fn option_str<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record.options.get(key).and_then(Value::as_str)
}

fn option_list<'a>(record: &'a ExecutionRecord, key: &str) -> Vec<&'a str> {
    record
        .options
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn has_name(record: &ExecutionRecord, identifier: &str) -> bool {
    option_str(record, "name") == Some(identifier)
        || option_list(record, "aliases").contains(&identifier)
}

/// Resolve an identifier among stored records: UUID, then current session
/// name, then earlier session names, then display name and aliases.
pub fn find_record<'a>(
    records: &'a [ExecutionRecord],
    identifier: &str,
) -> Option<&'a ExecutionRecord> {
    if identifier.is_empty() {
        return None;
    }
    records
        .iter()
        .find(|r| r.uuid == identifier)
        .or_else(|| {
            records
                .iter()
                .find(|r| option_str(r, "sessionName") == Some(identifier))
        })
        .or_else(|| {
            records
                .iter()
                .find(|r| option_list(r, "sessionNameHistory").contains(&identifier))
        })
        .or_else(|| records.iter().find(|r| has_name(r, identifier)))
}

/// Every name the record answers to, UUID first, without duplicates.
pub fn execution_aliases(record: &ExecutionRecord) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let candidates = std::iter::once(Some(record.uuid.as_str()))
        .chain(
            option_list(record, "sessionNameHistory")
                .into_iter()
                .map(Some),
        )
        .chain(std::iter::once(option_str(record, "sessionName")))
        .chain(option_list(record, "aliases").into_iter().map(Some))
        .chain(std::iter::once(option_str(record, "name")));
    for name in candidates.flatten() {
        if !name.is_empty() && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// True once the record has a caller-given name (`--alias`/`--rename`).
pub fn has_user_names(record: &ExecutionRecord) -> bool {
    option_str(record, "name").is_some_and(|n| !n.is_empty())
        || !option_list(record, "aliases").is_empty()
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("The new name must not be empty".into());
    }
    if name.starts_with('-') {
        return Err(format!(
            "Invalid name \"{}\": names cannot start with \"-\"",
            name
        ));
    }
    Ok(())
}

/// Add a name to an execution (`$ --alias <id> <name>`) or rename it
/// (`$ --rename <id> <name>`, which keeps the previous display name as an
/// alias). The backend session/container keeps its name; only lookup and the
/// displayed name change. Returns the output to print, or the error.
pub fn name_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    name: &str,
    rename: bool,
) -> Result<String, String> {
    let store = store.ok_or("Execution tracking is disabled.")?;
    validate_name(name)?;
    let changed = store.with_lock(|records| {
        let target = find_record(records, identifier)
            .ok_or_else(|| {
                format!(
                    "No execution found with UUID or session name: {}",
                    identifier
                )
            })?
            .uuid
            .clone();
        let owner = find_record(records, name).map(|r| r.uuid.clone());
        if let Some(owner) = owner.as_ref().filter(|o| **o != target) {
            return Err(format!(
                "Name \"{}\" already refers to execution {}",
                name, owner
            ));
        }
        let record = records.iter_mut().find(|r| r.uuid == target).unwrap();
        let mut aliases: Vec<String> = option_list(record, "aliases")
            .into_iter()
            .map(str::to_string)
            .collect();
        if rename {
            let current_name = option_str(record, "name").map(str::to_string);
            let previous = current_name
                .clone()
                .or_else(|| option_str(record, "sessionName").map(str::to_string))
                .unwrap_or_else(|| record.uuid.clone());
            if previous == name {
                return Ok(None);
            }
            // A session name or UUID still resolves on its own; an earlier
            // display name has to become an alias to keep resolving.
            if current_name.is_some() {
                aliases.push(previous);
            }
            record.options.insert("name".into(), json!(name));
        } else if owner.is_some() {
            return Ok(None);
        } else {
            aliases.push(name.to_string());
        }
        let display = option_str(record, "name").map(str::to_string);
        let mut unique: Vec<String> = Vec::new();
        for alias in aliases {
            if Some(&alias) != display.as_ref() && !unique.contains(&alias) {
                unique.push(alias);
            }
        }
        if unique.is_empty() {
            record.options.remove("aliases");
        } else {
            record.options.insert("aliases".into(), json!(unique));
        }
        Ok(Some(record.clone()))
    })?;
    let unchanged = changed.is_none();
    let current = match changed {
        Some(record) => record,
        None => store.get(identifier).ok_or_else(|| {
            format!(
                "No execution found with UUID or session name: {}",
                identifier
            )
        })?,
    };
    let action = match (unchanged, rename) {
        (true, _) => "Unchanged",
        (false, true) => "Renamed",
        (false, false) => "Aliased",
    };
    Ok(format!(
        "{} execution {}\naliases: [{}]",
        action,
        current.uuid,
        execution_aliases(&current).join(", ")
    ))
}
