#!/usr/bin/env node

/**
 * Verify that a freshly created GitHub Release contains the expected
 * exact-version package badge.
 *
 * This guards against the "false positive" failure mode described in
 * docs/case-studies/issue-118/requirements.md (R4): a release that exists
 * but visually looks unbumped because the badge wasn't injected.
 *
 * Usage:
 *   node scripts/verify-release-badge.mjs \
 *     --repository link-foundation/start \
 *     --tag rust-v0.14.1 \
 *     --badge-type crates \
 *     --package-name start-command \
 *     --release-version 0.14.1
 *
 * Exits non-zero with a `::error::` line if the badge is missing.
 */

import { execSync } from "node:child_process";

import { packageVersionBadge } from "./release-name.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      result[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

const {
  repository,
  tag,
  "badge-type": badgeType,
  "package-name": packageName,
  "release-version": releaseVersion,
} = parseArgs(process.argv.slice(2));

if (!repository || !tag || !badgeType || !packageName || !releaseVersion) {
  console.error(
    "Usage: node scripts/verify-release-badge.mjs --repository <owner/repo> --tag <tag> --badge-type <npm|crates> --package-name <name> --release-version <version>",
  );
  process.exit(1);
}

const expectedBadge = packageVersionBadge({
  packageType: badgeType,
  packageName,
  releaseVersion,
});

const expectedBadgeUrl = expectedBadge.match(/\((https:[^)]+)\)$/);
const expectedBadgeImage = expectedBadge.match(/\!\[[^\]]*\]\((https:[^)]+)\)/);

if (!expectedBadgeUrl || !expectedBadgeImage) {
  console.error(`::error::Could not parse expected badge for ${badgeType}/${packageName}/${releaseVersion}`);
  process.exit(1);
}

let body;
try {
  body = execSync(
    `gh api "repos/${repository}/releases/tags/${tag}" --jq .body`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (error) {
  console.error(`::error::Could not fetch release ${tag} from ${repository}: ${error.message.split("\n")[0]}`);
  process.exit(1);
}

const hasBadgeUrl = body.includes(expectedBadgeUrl[1]);
const hasBadgeImage = body.includes(expectedBadgeImage[1]);

if (hasBadgeUrl && hasBadgeImage) {
  console.log(`✅ Release ${tag} contains the expected ${badgeType} badge.`);
  process.exit(0);
}

console.error(`::error::Release ${tag} is missing the expected ${badgeType} badge.`);
console.error(`  Expected image URL: ${expectedBadgeImage[1]}`);
console.error(`  Expected link URL:  ${expectedBadgeUrl[1]}`);
console.error("  Actual release body:");
console.error(body);
process.exit(1);
