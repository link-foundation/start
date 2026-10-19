#!/usr/bin/env bun

/**
 * Publish to npm using OIDC trusted publishing
 * Usage: node scripts/publish-to-npm.mjs [--should-pull]
 *   should_pull: Optional flag to pull latest changes before publishing (for release job)
 *
 * IMPORTANT: Update the PACKAGE_NAME constant below to match your package.json
 *
 * Uses link-foundation libraries:
 * - use-m: Dynamic package loading without package.json dependencies
 * - command-stream: Modern shell command execution with streaming support
 * - lino-arguments: Unified configuration from CLI args, env vars, and .lenv files
 */

import { readFileSync, appendFileSync } from 'fs';
import { loadCommandStream } from './load-command-stream.mjs';
import { publishToNpm } from './npm-publish.mjs';
import { checked } from './release-git.mjs';

// TODO: Update this to match your package name in package.json
const PACKAGE_NAME = 'start-command';

// Load use-m dynamically
const { use } = eval(
  await (await fetch('https://unpkg.com/use-m/use.js')).text()
);

// Import link-foundation libraries
const { $ } = await loadCommandStream(use);
const { makeConfig } = await use('lino-arguments');

// Parse CLI arguments using lino-arguments
const config = makeConfig({
  yargs: ({ yargs, getenv }) =>
    yargs
      .option('should-pull', {
        type: 'boolean',
        default: getenv('SHOULD_PULL', false),
        describe: 'Pull latest changes before publishing',
      })
      .option('working-dir', {
        type: 'string',
        default: getenv('WORKING_DIR', '.'),
        describe: 'Working directory containing package.json',
      }),
});

const { shouldPull, workingDir } = config;

// Change to working directory if specified
if (workingDir && workingDir !== '.') {
  console.log(`Changing to working directory: ${workingDir}`);
  process.chdir(workingDir);
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Append to GitHub Actions output file
 * @param {string} key
 * @param {string} value
 */
function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

async function main() {
  try {
    if (shouldPull) {
      // Pull the latest changes we just pushed
      await checked($`git pull origin main`, 'git pull origin main');
    }

    // Get current version
    const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
    const currentVersion = packageJson.version;
    console.log(`Current version to publish: ${currentVersion}`);

    // `published` is set only after the registry confirms the version, so a
    // failed publish can no longer create a GitHub release (issue #234).
    const { alreadyPublished } = await publishToNpm($, {
      name: PACKAGE_NAME,
      version: currentVersion,
      sleep,
    });
    setOutput('published', 'true');
    setOutput('published_version', currentVersion);
    if (alreadyPublished) {
      setOutput('already_published', 'true');
    } else {
      console.log(`\u2705 Published ${PACKAGE_NAME}@${currentVersion} to npm`);
    }
  } catch (error) {
    console.error('\u274C Error:', error.message);
    process.exit(1);
  }
}

main();
