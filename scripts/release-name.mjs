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
  "js-": "JavaScript",
  "rust-": "Rust",
});

const PACKAGE_BADGES = Object.freeze({
  npm: {
    label: "npm",
    color: "blue",
    url: (packageName, version) =>
      `https://www.npmjs.com/package/${encodeURIComponent(packageName)}/v/${encodeURIComponent(version)}`,
  },
  crates: {
    label: "crates.io",
    color: "orange",
    url: (packageName, version) =>
      `https://crates.io/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
  },
});

/**
 * Build the git tag for a release.
 * @param {string} version  Version number without a leading "v".
 * @param {string} [prefix] Optional language/package prefix (e.g., "rust-").
 * @returns {string} Tag of the form "${prefix}v${version}".
 */
export function releaseTag(version, prefix = "") {
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
export function releaseName(version, prefix = "") {
  const languageTitle = LANGUAGE_TITLES[prefix];
  if (languageTitle) return `[${languageTitle}] ${version}`;
  if (prefix) return `${prefix}${version}`;
  return version;
}

/**
 * Convert a release version or tag into the package-manager version used in
 * exact-version badges.
 * @param {string} releaseVersion Version or tag, e.g. "v1.2.3" or "js-v1.2.3".
 * @returns {string} Bare semver string.
 */
export function normalizeReleaseVersionForBadge(releaseVersion) {
  const trimmedVersion = String(releaseVersion).trim();
  const semverTagMatch = trimmedVersion.match(
    /(?:^|-)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i,
  );

  if (semverTagMatch) {
    return semverTagMatch[1];
  }

  return trimmedVersion
    .replace(/^[A-Za-z][A-Za-z0-9]*-/, "")
    .replace(/^v/i, "");
}

/**
 * Escape a shields.io static badge path segment. Static badge segments use
 * "-" and "_" as delimiters, so literal instances must be doubled.
 * @param {string} value
 * @returns {string}
 */
export function encodeShieldsStaticBadgeSegment(value) {
  return encodeURIComponent(value).replace(/-/g, "--").replace(/_/g, "__");
}

/**
 * Build an exact package-version badge for GitHub Release notes.
 * @param {{ packageType: 'npm'|'crates', packageName: string, releaseVersion: string }} options
 * @returns {string}
 */
export function packageVersionBadge({
  packageType,
  packageName,
  releaseVersion,
}) {
  const badgeConfig = PACKAGE_BADGES[packageType];
  if (!badgeConfig) {
    throw new Error(`Unsupported package badge type: ${packageType}`);
  }

  const version = normalizeReleaseVersionForBadge(releaseVersion);
  const label = encodeShieldsStaticBadgeSegment(badgeConfig.label);
  const badgeVersion = encodeShieldsStaticBadgeSegment(version);

  return `[![${badgeConfig.label} version](https://img.shields.io/badge/${label}-${badgeVersion}-${badgeConfig.color}.svg)](${badgeConfig.url(packageName, version)})`;
}

/**
 * Extract one version entry from a changelog. Supports both Changesets headings
 * ("## 1.2.3") and Keep a Changelog headings ("## [1.2.3] - 2026-05-02").
 * @param {string} changelog
 * @param {string} releaseVersion Version or tag to extract.
 * @returns {string}
 */
export function extractChangelogEntry(changelog, releaseVersion) {
  const version = normalizeReleaseVersionForBadge(releaseVersion);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionHeading = new RegExp(
    `^##\\s+(?:\\[?v?${escapedVersion}\\]?)(?:\\s|$)`,
  );
  const nextHeading = /^##\s+/;
  const lines = String(changelog).split(/\r?\n/);

  let startIndex = -1;
  for (const [index, line] of lines.entries()) {
    if (versionHeading.test(line)) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = startIndex; index < lines.length; index += 1) {
    if (nextHeading.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n").trim();
}
