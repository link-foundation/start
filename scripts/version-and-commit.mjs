#!/usr/bin/env bun

/**
 * Version packages and commit to main.
 *
 * JavaScript modes:
 *   changeset: Run changeset versioning in js/
 *   instant:   Direct package.json bump for manual JS releases
 *
 * Rust modes:
 *   changelog: Bump Cargo.toml and collect rust/changelog.d fragments
 *   manual:    Bump Cargo.toml with a manual description and any fragments
 *
 * Usage:
 *   node scripts/version-and-commit.mjs --mode <changeset|instant|changelog|manual> [--bump-type <type>] [--description <desc>] [--working-dir <dir>]
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import path from "path";

const repoRoot = process.cwd();

// Load use-m dynamically
const { use } = eval(
  await (await fetch("https://unpkg.com/use-m/use.js")).text(),
);

// Import link-foundation libraries
const { $ } = await use("command-stream");
const { makeConfig } = await use("lino-arguments");

// Parse CLI arguments using lino-arguments
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .option("mode", {
        type: "string",
        default: getenv("MODE", "changeset"),
        describe: "Version mode: changeset, instant, changelog, or manual",
        choices: ["changeset", "instant", "changelog", "manual"],
      })
      .option("bump-type", {
        type: "string",
        default: getenv("BUMP_TYPE", ""),
        describe:
          "Version bump type for instant/changelog/manual: major, minor, or patch",
      })
      .option("description", {
        type: "string",
        default: getenv("DESCRIPTION", ""),
        describe: "Description for manual version bumps",
      })
      .option("working-dir", {
        type: "string",
        default: getenv("WORKING_DIR", "."),
        describe: "Working directory containing package.json or Cargo.toml",
      }),
});

const { mode, bumpType, description, workingDir } = config;
const packageKind = mode === "changelog" || mode === "manual" ? "rust" : "js";
const workingDirectory = path.resolve(repoRoot, workingDir || ".");

// Debug: Log parsed configuration
console.log("Parsed configuration:", {
  mode,
  bumpType: bumpType || "(none)",
  description: description || "(none)",
  workingDir,
  packageKind,
});

// Detect if positional arguments were used (common mistake)
const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith("--")) {
  console.error("Error: Positional arguments detected!");
  console.error("Command line arguments:", args);
  console.error("");
  console.error(
    "This script requires named arguments (--mode, --bump-type, --description).",
  );
  console.error("Usage:");
  console.error("  JS changeset mode:");
  console.error(
    "    node scripts/version-and-commit.mjs --mode changeset --working-dir js",
  );
  console.error("  JS instant mode:");
  console.error(
    "    node scripts/version-and-commit.mjs --mode instant --working-dir js --bump-type <major|minor|patch> [--description <desc>]",
  );
  console.error("  Rust changelog mode:");
  console.error(
    "    node scripts/version-and-commit.mjs --mode changelog --working-dir rust --bump-type <major|minor|patch>",
  );
  console.error("  Rust manual mode:");
  console.error(
    "    node scripts/version-and-commit.mjs --mode manual --working-dir rust --bump-type <major|minor|patch> [--description <desc>]",
  );
  process.exit(1);
}

const modesRequiringBumpType = ["instant", "changelog", "manual"];
if (modesRequiringBumpType.includes(mode) && !bumpType) {
  console.error(`Error: --bump-type is required for ${mode} mode`);
  process.exit(1);
}

if (bumpType && !["major", "minor", "patch"].includes(bumpType)) {
  console.error(
    `Invalid bump type: "${bumpType}". Expected major, minor, or patch.`,
  );
  process.exit(1);
}

if (!existsSync(workingDirectory)) {
  console.error(`Error: working directory does not exist: ${workingDirectory}`);
  process.exit(1);
}

if (workingDirectory !== repoRoot) {
  console.log(`Changing to working directory: ${workingDirectory}`);
  process.chdir(workingDirectory);
}

/**
 * Append to GitHub Actions output file.
 * @param {string} key
 * @param {string} value
 */
function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

/**
 * Convert a package-relative path into a repo-relative Git path.
 * @param {string[]} segments
 * @returns {string}
 */
function repoPath(...segments) {
  return path
    .relative(repoRoot, path.join(workingDirectory, ...segments))
    .split(path.sep)
    .join("/");
}

/**
 * Count release request fragments for the active package.
 * @returns {number}
 */
function countReleaseFragments() {
  const fragmentDir = packageKind === "rust" ? "changelog.d" : ".changeset";
  try {
    const files = readdirSync(fragmentDir);
    return files.filter((file) => file.endsWith(".md") && file !== "README.md")
      .length;
  } catch {
    return 0;
  }
}

/**
 * Parse version from Cargo.toml content.
 * @param {string} cargoToml
 * @returns {string}
 */
function parseCargoVersion(cargoToml) {
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("Could not find version in Cargo.toml");
  }
  return match[1];
}

/**
 * Get package version.
 * @param {'local'|'remote'} source
 * @returns {Promise<string>}
 */
async function getVersion(source = "local") {
  if (source === "remote") {
    const versionPath =
      packageKind === "rust"
        ? repoPath("Cargo.toml")
        : repoPath("package.json");
    const remoteRef = `origin/main:${versionPath}`;
    const result = await $`git show ${remoteRef}`.run({ capture: true });
    return packageKind === "rust"
      ? parseCargoVersion(result.stdout)
      : JSON.parse(result.stdout).version;
  }

  if (packageKind === "rust") {
    return parseCargoVersion(readFileSync("Cargo.toml", "utf8"));
  }

  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

/**
 * Bump a semantic version.
 * @param {string} version
 * @param {'major'|'minor'|'patch'} type
 * @returns {string}
 */
function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Unsupported semantic version: ${version}`);
  }

  let [, major, minor, patch] = match.map(Number);

  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Strip simple YAML frontmatter from changelog fragments.
 * @param {string} content
 * @returns {string}
 */
function stripFrontmatter(content) {
  const frontmatterMatch = content.match(
    /^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/,
  );
  return (frontmatterMatch ? frontmatterMatch[1] : content).trim();
}

/**
 * Read Rust changelog fragments.
 * @returns {{ file: string, content: string }[]}
 */
function readRustFragments() {
  const fragmentDir = "changelog.d";
  if (!existsSync(fragmentDir)) {
    return [];
  }

  return readdirSync(fragmentDir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => ({
      file,
      content: stripFrontmatter(
        readFileSync(path.join(fragmentDir, file), "utf8"),
      ),
    }))
    .filter(({ content }) => content);
}

/**
 * Remove processed Rust changelog fragments.
 */
function removeRustFragments() {
  const fragmentDir = "changelog.d";
  if (!existsSync(fragmentDir)) {
    return;
  }

  for (const file of readdirSync(fragmentDir)) {
    if (file.endsWith(".md") && file !== "README.md") {
      unlinkSync(path.join(fragmentDir, file));
      console.log(`Removed changelog fragment ${file}`);
    }
  }
}

/**
 * Prepend a Rust changelog entry.
 * @param {string} version
 * @param {string} body
 */
function updateRustChangelog(version, body) {
  const changelogPath = "CHANGELOG.md";
  const insertMarker = "<!-- changelog-insert-here -->";
  const date = new Date().toISOString().split("T")[0];
  const newEntry = `\n## [${version}] - ${date}\n\n${body.trim()}\n`;

  if (!existsSync(changelogPath)) {
    writeFileSync(
      changelogPath,
      `# Changelog

All notable changes to the Rust package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

${insertMarker}
${newEntry}
`,
      "utf8",
    );
    return;
  }

  let changelog = readFileSync(changelogPath, "utf8");
  if (changelog.includes(insertMarker)) {
    changelog = changelog.replace(insertMarker, `${insertMarker}${newEntry}`);
  } else {
    const firstVersionHeading = changelog.match(/^##\s+/m);
    if (firstVersionHeading) {
      changelog =
        changelog.slice(0, firstVersionHeading.index) +
        newEntry +
        changelog.slice(firstVersionHeading.index);
    } else {
      changelog = `${changelog.trimEnd()}${newEntry}\n`;
    }
  }

  writeFileSync(changelogPath, changelog, "utf8");
}

/**
 * Bump Cargo.toml and collect Rust changelog content.
 * @param {string} oldVersion
 * @returns {string}
 */
function runRustVersionBump(oldVersion) {
  const newVersion = bumpVersion(oldVersion, bumpType);
  const cargoToml = readFileSync("Cargo.toml", "utf8");
  writeFileSync(
    "Cargo.toml",
    cargoToml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVersion}"`),
    "utf8",
  );

  const fragments = readRustFragments();
  const changelogParts = [];

  if (description) {
    changelogParts.push(description.trim());
  }

  for (const fragment of fragments) {
    changelogParts.push(fragment.content);
    console.log(`Collected changelog fragment ${fragment.file}`);
  }

  if (changelogParts.length === 0) {
    changelogParts.push(`Manual ${bumpType} release.`);
  }

  updateRustChangelog(newVersion, changelogParts.join("\n\n"));
  removeRustFragments();

  return newVersion;
}

/**
 * Stage package-owned release files only.
 */
async function stageReleaseFiles() {
  const pathspecs =
    packageKind === "rust"
      ? ["Cargo.toml", "CHANGELOG.md", "changelog.d"]
      : ["package.json", "package-lock.json", "CHANGELOG.md", ".changeset"];

  for (const pathspec of pathspecs) {
    await $`git add -A -- ${pathspec}`;
  }
}

async function main() {
  try {
    // Configure git
    await $`git config user.name "github-actions[bot]"`;
    await $`git config user.email "github-actions[bot]@users.noreply.github.com"`;

    // Check if remote main has advanced (handles re-runs after partial success)
    console.log("Checking for remote changes...");
    await $`git fetch origin main`;

    const localHeadResult = await $`git rev-parse HEAD`.run({ capture: true });
    const localHead = localHeadResult.stdout.trim();

    const remoteHeadResult = await $`git rev-parse origin/main`.run({
      capture: true,
    });
    const remoteHead = remoteHeadResult.stdout.trim();

    if (localHead !== remoteHead) {
      console.log(
        `Remote main has advanced (local: ${localHead}, remote: ${remoteHead})`,
      );
      console.log("This may indicate a previous attempt partially succeeded.");

      const remoteVersion = await getVersion("remote");
      console.log(`Remote version: ${remoteVersion}`);

      const fragmentCount = countReleaseFragments();

      if (fragmentCount === 0) {
        console.log("No release fragments to process and remote has advanced.");
        console.log(
          "Assuming version bump was already completed in a previous attempt.",
        );
        setOutput("version_committed", "false");
        setOutput("already_released", "true");
        setOutput("new_version", remoteVersion);
        return;
      }

      console.log("Rebasing on remote main to incorporate changes...");
      await $`git rebase origin/main`;
    }

    // Get current version before bump
    const oldVersion = await getVersion();
    console.log(`Current version: ${oldVersion}`);

    if (mode === "instant") {
      console.log("Running instant version bump...");
      const instantScript = path.join(
        repoRoot,
        "scripts/instant-version-bump.mjs",
      );
      if (description) {
        await $`node ${instantScript} --bump-type ${bumpType} --description ${description}`;
      } else {
        await $`node ${instantScript} --bump-type ${bumpType}`;
      }
    } else if (mode === "changeset") {
      console.log("Running changeset version...");
      await $`npm run changeset:version`;
    } else {
      console.log(`Running Rust ${mode} version bump...`);
      runRustVersionBump(oldVersion);
    }

    // Get new version after bump
    const newVersion = await getVersion();
    console.log(`New version: ${newVersion}`);
    setOutput("new_version", newVersion);

    await stageReleaseFiles();

    // Check if there are changes to commit
    const statusResult = await $`git status --porcelain`.run({ capture: true });
    const status = statusResult.stdout.trim();

    if (status) {
      console.log("Changes detected, committing...");

      const commitMessage =
        packageKind === "rust" ? `rust-v${newVersion}` : newVersion;
      const escapedMessage = commitMessage.replace(/"/g, '\\"');
      await $`git commit -m "${escapedMessage}"`;

      // Push directly to main
      await $`git push origin main`;

      console.log("✅ Version bump committed and pushed to main");
      setOutput("version_committed", "true");
    } else {
      console.log("No changes to commit");
      setOutput("version_committed", "false");
    }
  } catch (error) {
    console.error("Error:", error.message);
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

main();
