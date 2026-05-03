#!/usr/bin/env node

/**
 * Back-fill the body of an existing GitHub Release from a changelog.
 *
 * Use this once for releases that were created before the
 * `create-github-release.mjs` script learnt to inject per-version notes
 * and a package badge. See docs/case-studies/issue-118/root-cause.md
 * (RC-2).
 *
 * Usage:
 *   GH_TOKEN=… node scripts/backfill-release-notes.mjs \
 *     --repository link-foundation/start \
 *     --tag rust-v0.13.0 \
 *     --changelog-file rust/CHANGELOG.md \
 *     --badge-type crates \
 *     --package-name start-command
 *
 * Optional flags:
 *   --release-version <version>  Override the version used for badge / changelog
 *                                lookup (defaults to the version parsed out of
 *                                the tag, e.g. "rust-v0.13.0" → "0.13.0").
 *   --dry-run                    Print the body that would be PATCHed and exit.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { debug, dumpEnv } from "./debug-print.mjs";
import {
  extractChangelogEntry,
  normalizeReleaseVersionForBadge,
  packageVersionBadge,
} from "./release-name.mjs";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      out[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repository = args.repository;
const tag = args.tag;
const changelogFile = args["changelog-file"];
const badgeType = args["badge-type"];
const packageName = args["package-name"];
const releaseVersion =
  args["release-version"] || normalizeReleaseVersionForBadge(tag || "");

debug("backfill-release-notes args:", { repository, tag, changelogFile, badgeType, packageName, releaseVersion, dryRun: args.dryRun });
dumpEnv(["GH_TOKEN", "GITHUB_TOKEN"]);

if (!repository || !tag || !changelogFile || !badgeType || !packageName) {
  console.error(
    "Usage: GH_TOKEN=… node scripts/backfill-release-notes.mjs --repository <owner/repo> --tag <tag> --changelog-file <path> --badge-type <npm|crates> --package-name <name> [--release-version <version>] [--dry-run]",
  );
  process.exit(1);
}

if (!existsSync(changelogFile)) {
  console.error(`::error::Changelog file not found: ${changelogFile}`);
  process.exit(1);
}

const changelog = readFileSync(changelogFile, "utf8");
let notes = extractChangelogEntry(changelog, releaseVersion);
if (!notes) {
  notes = `Release ${releaseVersion}`;
}

const badge = packageVersionBadge({
  packageType: badgeType,
  packageName,
  releaseVersion,
});

const body = `${notes}\n\n---\n\n${badge}\n`;

if (args.dryRun) {
  console.log("--- dry run: body that would be PATCHed ---");
  console.log(body);
  process.exit(0);
}

let releaseId;
try {
  releaseId = execSync(
    `gh api "repos/${repository}/releases/tags/${tag}" --jq .id`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
} catch (error) {
  console.error(`::error::Could not find release ${tag} in ${repository}: ${error.message.split("\n")[0]}`);
  process.exit(1);
}

if (!releaseId) {
  console.error(`::error::Release ${tag} not found in ${repository}`);
  process.exit(1);
}

const payload = JSON.stringify({ body });

try {
  execSync(`gh api "repos/${repository}/releases/${releaseId}" -X PATCH --input -`, {
    stdio: ["pipe", "inherit", "inherit"],
    input: payload,
  });
} catch (error) {
  console.error(`::error::Could not PATCH release ${tag}: ${error.message.split("\n")[0]}`);
  process.exit(1);
}

console.log(`✅ Back-filled release ${tag} (${releaseId}) with ${body.length} chars of body.`);
