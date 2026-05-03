#!/usr/bin/env bun

/**
 * Create GitHub Release from a changelog entry.
 * Usage: node scripts/create-github-release.mjs --release-version <version> --repository <repository> [--prefix <prefix>] [--changelog-file <path>] [--badge-type <npm|crates> --package-name <name>]
 *   release-version: Version number (e.g., 1.0.0)
 *   repository:      GitHub repository (e.g., owner/repo)
 *   prefix:          Optional language/package prefix added to the tag and
 *                    release title. Supported values: "" (default), "js-",
 *                    "rust-". The tag becomes "${prefix}v${version}" and the
 *                    release title becomes "[JavaScript] ${version}" or
 *                    "[Rust] ${version}" when the prefix matches a known
 *                    language; other prefixes pass through as
 *                    "${prefix}${version}". An empty prefix preserves the
 *                    original behaviour ("v${version}" tag, "${version}" title).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  extractChangelogEntry,
  packageVersionBadge,
  releaseName,
  releaseTag,
} from "./release-name.mjs";

function toCamelCase(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const name = toCamelCase(rawName);

    if (inlineValue !== undefined) {
      args[name] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[name] = argv[index + 1];
      index += 1;
    } else {
      args[name] = true;
    }
  }

  return args;
}

function usageAndExit() {
  console.error("Error: Missing required arguments");
  console.error(
    "Usage: node scripts/create-github-release.mjs --release-version <version> --repository <repository> [--prefix <prefix>] [--changelog-file <path>] [--badge-type <npm|crates> --package-name <name>]",
  );
  process.exit(1);
}

function isAlreadyExistsError(output) {
  const normalizedOutput = output.toLowerCase();
  return (
    normalizedOutput.includes("already_exists") ||
    normalizedOutput.includes("already exists") ||
    (normalizedOutput.includes("validation failed") &&
      normalizedOutput.includes("tag_name"))
  );
}

function parseCommandArgsEnv(name) {
  const value = process.env[name];
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((arg) => typeof arg === "string")
    ) {
      return parsed;
    }
  } catch {
    // Fall through to the validation error below.
  }

  console.error(`Error: ${name} must be a JSON array of strings`);
  process.exit(1);
}

function createRelease(repository, payload) {
  const ghCommand = process.env.START_GH_COMMAND || "gh";
  const ghArgsPrefix = parseCommandArgsEnv("START_GH_COMMAND_ARGS");
  const result = spawnSync(
    ghCommand,
    [
      ...ghArgsPrefix,
      "api",
      `repos/${repository}/releases`,
      "-X",
      "POST",
      "--input",
      "-",
    ],
    {
      encoding: "utf8",
      input: payload,
    },
  );

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (result.status === 0) {
    return { created: true, stdout, stderr };
  }

  const combinedOutput = `${stdout}\n${stderr}`.trim();
  if (isAlreadyExistsError(combinedOutput)) {
    return { alreadyExists: true, created: false, stdout, stderr };
  }

  const status = result.status ?? 1;
  if (combinedOutput) {
    console.error(combinedOutput);
  }
  console.error(`GitHub release creation failed with exit code ${status}`);
  process.exit(status);
}

const cliArgs = parseArgs(process.argv.slice(2));
const version = cliArgs.releaseVersion || process.env.VERSION || "";
const repository = cliArgs.repository || process.env.REPOSITORY || "";
const prefix = cliArgs.prefix || process.env.PREFIX || "";
const changelogFile =
  cliArgs.changelogFile || process.env.CHANGELOG_FILE || "CHANGELOG.md";
const badgeType = cliArgs.badgeType || process.env.BADGE_TYPE || "";
const packageName = cliArgs.packageName || process.env.PACKAGE_NAME || "";

if (!version || !repository) {
  usageAndExit();
}

if (badgeType && !["npm", "crates"].includes(badgeType)) {
  console.error("Error: --badge-type must be npm or crates");
  process.exit(1);
}

if (badgeType && !packageName) {
  console.error("Error: --package-name is required when --badge-type is set");
  process.exit(1);
}

const tag = releaseTag(version, prefix);
const name = releaseName(version, prefix);

console.log(
  `Creating GitHub release: tag=${tag}, name=${name}, prefix=${prefix || "(none)"}`,
);

try {
  let releaseNotes = "";

  if (existsSync(changelogFile)) {
    const changelog = readFileSync(changelogFile, "utf8");
    releaseNotes = extractChangelogEntry(changelog, version);
  } else {
    console.log(`Changelog file not found: ${changelogFile}`);
  }

  if (!releaseNotes) {
    releaseNotes = `Release ${version}`;
  }

  if (badgeType) {
    const badge = packageVersionBadge({
      packageType: badgeType,
      packageName,
      releaseVersion: version,
    });
    releaseNotes = `${releaseNotes}\n\n---\n\n${badge}`;
  }

  // Create release using GitHub API with JSON input. Passing the body through
  // stdin avoids shell escaping issues in changelog text.
  const payload = JSON.stringify({
    tag_name: tag,
    name,
    body: releaseNotes,
  });

  const releaseResult = createRelease(repository, payload);
  if (releaseResult.alreadyExists) {
    console.log(`GitHub release already exists: ${tag} (${name})`);
  } else {
    console.log(`Created GitHub release: ${tag} (${name})`);
  }
} catch (error) {
  console.error("Error creating release:", error.message);
  process.exit(1);
}
