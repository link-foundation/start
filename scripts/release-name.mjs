/**
 * Pure helpers for constructing GitHub release tags and titles from a
 * version + optional language prefix. Extracted so the logic can be
 * unit-tested without shelling out to the GitHub API.
 *
 * Known language prefixes map to human-readable titles; anything else
 * is passed through verbatim and an empty prefix preserves the original
 * un-prefixed behaviour ("v<version>" tag, "<version>" title).
 */

export const LANGUAGE_TITLES = Object.freeze({
  'js-': 'JavaScript',
  'rust-': 'Rust',
});

/**
 * Build the git tag for a release.
 * @param {string} version  Version number without a leading "v".
 * @param {string} [prefix] Optional language/package prefix (e.g., "rust-").
 * @returns {string} Tag of the form "${prefix}v${version}".
 */
export function releaseTag(version, prefix = '') {
  return `${prefix}v${version}`;
}

/**
 * Build the GitHub release title for a release.
 * @param {string} version  Version number without a leading "v".
 * @param {string} [prefix] Optional language/package prefix (e.g., "rust-").
 * @returns {string}
 *   - "[JavaScript] <version>" for prefix "js-"
 *   - "[Rust] <version>"        for prefix "rust-"
 *   - "<prefix><version>"       for any other non-empty prefix
 *   - "<version>"               for empty prefix (pre-prefix behaviour)
 */
export function releaseName(version, prefix = '') {
  const languageTitle = LANGUAGE_TITLES[prefix];
  if (languageTitle) return `[${languageTitle}] ${version}`;
  if (prefix) return `${prefix}${version}`;
  return version;
}
