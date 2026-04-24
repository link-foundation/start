#!/usr/bin/env bun

/**
 * Create GitHub Release from CHANGELOG.md
 * Usage: node scripts/create-github-release.mjs --release-version <version> --repository <repository> [--prefix <prefix>]
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
 *
 * Uses link-foundation libraries:
 * - use-m: Dynamic package loading without package.json dependencies
 * - command-stream: Modern shell command execution with streaming support
 * - lino-arguments: Unified configuration from CLI args, env vars, and .lenv files
 */

import { readFileSync } from 'fs';
import { releaseTag, releaseName } from './release-name.mjs';

// Load use-m dynamically
const { use } = eval(
  await (await fetch('https://unpkg.com/use-m/use.js')).text()
);

// Import link-foundation libraries
const { $ } = await use('command-stream');
const { makeConfig } = await use('lino-arguments');

// Parse CLI arguments using lino-arguments
// Note: Using --release-version instead of --version to avoid conflict with yargs' built-in --version flag
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .option('release-version', {
        type: 'string',
        default: getenv('VERSION', ''),
        describe: 'Version number (e.g., 1.0.0)',
      })
      .option('repository', {
        type: 'string',
        default: getenv('REPOSITORY', ''),
        describe: 'GitHub repository (e.g., owner/repo)',
      })
      .option('prefix', {
        type: 'string',
        default: getenv('PREFIX', ''),
        describe:
          'Optional language/package prefix for the tag and title (e.g., "js-" or "rust-")',
      }),
});

const { releaseVersion: version, repository, prefix } = config;

if (!version || !repository) {
  console.error('Error: Missing required arguments');
  console.error(
    'Usage: node scripts/create-github-release.mjs --release-version <version> --repository <repository> [--prefix <prefix>]'
  );
  process.exit(1);
}

const tag = releaseTag(version, prefix);
const name = releaseName(version, prefix);

console.log(
  `Creating GitHub release: tag=${tag}, name=${name}, prefix=${prefix || '(none)'}`
);

try {
  // Read CHANGELOG.md
  const changelog = readFileSync('./CHANGELOG.md', 'utf8');

  // Extract changelog entry for this version
  // Read from CHANGELOG.md between this version header and the next version header
  const versionHeaderRegex = new RegExp(`## ${version}[\\s\\S]*?(?=## \\d|$)`);
  const match = changelog.match(versionHeaderRegex);

  let releaseNotes = '';
  if (match) {
    // Remove the version header itself and trim
    releaseNotes = match[0].replace(`## ${version}`, '').trim();
  }

  if (!releaseNotes) {
    releaseNotes = `Release ${version}`;
  }

  // Create release using GitHub API with JSON input
  // This avoids shell escaping issues that occur when passing text via command-line arguments
  // (Previously caused apostrophes like "didn't" to appear as "didn'''" in releases)
  const payload = JSON.stringify({
    tag_name: tag,
    name,
    body: releaseNotes,
  });

  await $`gh api repos/${repository}/releases -X POST --input -`.run({
    stdin: payload,
  });

  console.log(`\u2705 Created GitHub release: ${tag} (${name})`);
} catch (error) {
  console.error('Error creating release:', error.message);
  process.exit(1);
}
