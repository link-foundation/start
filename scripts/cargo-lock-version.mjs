/**
 * Keep the root package entry of Cargo.lock at the Cargo.toml version.
 *
 * A release bump that rewrites only Cargo.toml leaves Cargo.lock behind, and
 * every later `cargo` run silently rewrites it: `cargo build --locked` fails,
 * contributors see an unrelated Cargo.lock diff, and the committed lock file
 * no longer describes what CI built (issue #234). The Rust template syncs the
 * lock file in its version-and-commit script for the same reason.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Set the version of the `[[package]]` named `name` in Cargo.lock text.
 * @param {string} lockText
 * @param {string} name
 * @param {string} version
 * @returns {{ text: string, found: boolean, changed: boolean }}
 */
export function setCargoLockPackageVersion(lockText, name, version) {
  const entry = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(name)}"\\r?\\nversion = ")([^"]*)(")`
  );
  const match = lockText.match(entry);
  if (!match) {
    return { text: lockText, found: false, changed: false };
  }
  if (match[2] === version) {
    return { text: lockText, found: true, changed: false };
  }
  return {
    text: lockText.replace(entry, `$1${version}$3`),
    found: true,
    changed: true,
  };
}

/**
 * Rewrite Cargo.lock in place. A missing lock file is not an error (library
 * crates may not commit one); a lock file without the package is.
 * @param {string} lockPath
 * @param {string} name
 * @param {string} version
 * @returns {boolean} whether the file changed
 */
export function syncCargoLockVersion(lockPath, name, version) {
  if (!existsSync(lockPath)) {
    console.log(`No ${lockPath}; skipping lock file version sync`);
    return false;
  }
  const result = setCargoLockPackageVersion(
    readFileSync(lockPath, 'utf8'),
    name,
    version
  );
  if (!result.found) {
    throw new Error(`${lockPath} has no [[package]] entry for ${name}`);
  }
  if (result.changed) {
    writeFileSync(lockPath, result.text, 'utf8');
    console.log(`Updated ${lockPath}: ${name} ${version}`);
  } else {
    console.log(`${lockPath} already at ${name} ${version}`);
  }
  return result.changed;
}
