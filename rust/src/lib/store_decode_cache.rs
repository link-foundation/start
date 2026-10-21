//! Decoded execution store, shared within one process and between processes
//! (issue #243).
//!
//! Decoding `executions.lino` costs about 1-4 ms per record, and one
//! `--status` used to decode it up to three times (`get`, then `get_all`
//! twice for the execution chain). The file is still read on every call, so a
//! write by any process is seen at once, but it is decoded again only when its
//! content differs from the last decoded copy. The content itself is the key:
//! unlike an mtime, it cannot miss two same-size writes within one clock tick.
//!
//! A new process (every `$ --status` poll) still had to decode once. The
//! decoded records are therefore also kept as JSON next to the store, tagged
//! with the SHA-256 of the content they were decoded from; parsing that copy
//! is far faster than the lino decode. A copy whose digest does not match the
//! current content is ignored and replaced.

use crate::atomic_write::atomic_write;
use crate::execution_store::ExecutionRecord;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Format tag of the JSON copy; a different tag is ignored.
pub const DECODED_COPY_FORMAT: &str = "start-command-decoded-store-rust-1";

/// Where the records of a read came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeSource {
    /// This process already decoded the same content.
    Memory,
    /// The JSON copy next to the store matched the content.
    Copy,
    /// The content was decoded.
    Decode,
}

struct DecodedStore {
    content: String,
    records: Vec<ExecutionRecord>,
    decodes: usize,
}

fn decoded_stores() -> &'static Mutex<HashMap<PathBuf, DecodedStore>> {
    static STORES: OnceLock<Mutex<HashMap<PathBuf, DecodedStore>>> = OnceLock::new();
    STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn digest_of(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// Values of the JSON copy at `copy_path`, when it was decoded from content
/// with this digest.
fn read_decoded_copy(copy_path: &Path, digest: &str) -> Option<Vec<Value>> {
    let copy: Value = serde_json::from_str(&fs::read_to_string(copy_path).ok()?).ok()?;
    if copy.get("format")?.as_str()? != DECODED_COPY_FORMAT
        || copy.get("sha256")?.as_str()? != digest
    {
        return None;
    }
    copy.get("records")?.as_array().cloned()
}

/// Keep `values` for the next process. Best effort: a read-only folder only
/// costs the next decode.
fn write_decoded_copy(copy_path: &Path, digest: &str, values: &[Value]) {
    let copy = json!({
        "format": DECODED_COPY_FORMAT,
        "sha256": digest,
        "records": values,
    });
    if let Ok(text) = serde_json::to_string(&copy) {
        let _ = atomic_write(copy_path, text.as_bytes());
    }
}

fn to_records(values: &[Value]) -> Vec<ExecutionRecord> {
    values
        .iter()
        .filter_map(ExecutionRecord::from_json)
        .collect()
}

/// Decode `content` of the store at `path` into JSON records, or reuse an
/// earlier decode of the same content: this process's own, or the JSON copy
/// at `copy_path`. Every call returns its own copy, so callers may change the
/// records they get.
pub fn decode_store_content<E>(
    path: &Path,
    content: &str,
    decode: impl FnOnce(&str) -> Result<Vec<Value>, E>,
    copy_path: Option<&Path>,
) -> Result<(Vec<ExecutionRecord>, DecodeSource), E> {
    let mut stores = decoded_stores()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = stores.get(path).filter(|cached| cached.content == content) {
        return Ok((cached.records.clone(), DecodeSource::Memory));
    }
    let decodes = stores.get(path).map_or(0, |cached| cached.decodes);
    let digest = copy_path.map(|_| digest_of(content));
    let copied = copy_path
        .zip(digest.as_deref())
        .and_then(|(copy_path, digest)| read_decoded_copy(copy_path, digest));
    let (records, source, decodes) = match copied {
        Some(values) => (to_records(&values), DecodeSource::Copy, decodes),
        None => {
            let values = decode(content)?;
            if let Some((copy_path, digest)) = copy_path.zip(digest.as_deref()) {
                write_decoded_copy(copy_path, digest, &values);
            }
            (to_records(&values), DecodeSource::Decode, decodes + 1)
        }
    };
    stores.insert(
        path.to_path_buf(),
        DecodedStore {
            content: content.to_string(),
            records: records.clone(),
            decodes,
        },
    );
    Ok((records, source))
}

/// How many times this process decoded the store at `path` since it was last
/// forgotten.
pub fn decode_count(path: &Path) -> usize {
    decoded_stores()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .map_or(0, |cached| cached.decodes)
}

/// Drop the decoded copy of a store held by this process; all stores when
/// `path` is `None`.
pub fn forget_decoded_store(path: Option<&Path>) {
    let mut stores = decoded_stores()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match path {
        Some(path) => {
            stores.remove(path);
        }
        None => stores.clear(),
    }
}
