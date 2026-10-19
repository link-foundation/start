#!/usr/bin/env node

/**
 * Fail-closed npm publishing for scripts/publish-to-npm.mjs (issue #234).
 *
 * command-stream's `$` resolves on a non-zero exit code (see
 * experiments/issue-234/command-stream-exit-code.mjs). The publish loop used
 * `try { await $`npm run changeset:publish` } catch {}`, so a rejected
 * publish never reached the `catch`: the script printed "✅ Published",
 * set `published=true`, and the release job created a GitHub release for a
 * version that was not on npm. Every outcome here is decided by exit codes
 * and by asking the registry, never by the absence of an exception.
 *
 * Set START_DEBUG=1 to trace registry lookups. The default state is off.
 */

import { debug } from './debug-print.mjs';

/**
 * Ask the registry whether `name@version` exists. Fails closed: anything
 * other than a hit or an E404 throws, so an outage never reads as "missing".
 *
 * @param {Function} $ command-stream `$`
 * @param {string} name
 * @param {string} version
 * @returns {Promise<boolean>}
 */
export async function isNpmVersionPublished($, name, version) {
  const spec = `${name}@${version}`;
  const result = await $`npm view ${spec} version`.run({
    capture: true,
    mirror: false,
  });
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '');
  debug('isNpmVersionPublished', { spec, code: result.code, stdout });
  if (result.code === 0) {
    // Older npm versions print nothing and exit 0 for a missing version.
    return stdout === version;
  }
  if (/\bE404\b/.test(stderr)) {
    return false;
  }
  throw new Error(
    `npm view ${spec} failed with exit code ${result.code}: ${stderr.trim()}`
  );
}

/**
 * Poll the registry until `name@version` is visible.
 *
 * @param {Function} $ command-stream `$`
 * @param {{ name: string, version: string, attempts?: number, delayMs?: number, sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<boolean>}
 */
export async function waitForNpmVersion(
  $,
  { name, version, attempts = 6, delayMs = 10000, sleep }
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await isNpmVersionPublished($, name, version)) {
      return true;
    }
    if (attempt < attempts) {
      console.log(
        `${name}@${version} is not visible on npm yet (check ${attempt}/${attempts}); waiting ${delayMs / 1000}s...`
      );
      await sleep(delayMs);
    }
  }
  return false;
}

/**
 * Publish `name@version` with `npm run changeset:publish`, retrying failed
 * attempts, and confirm on the registry before reporting success.
 *
 * @param {Function} $ command-stream `$`
 * @param {{ name: string, version: string, maxRetries?: number, retryDelayMs?: number, verifyAttempts?: number, verifyDelayMs?: number, sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ alreadyPublished: boolean }>}
 * @throws when every attempt fails or the version never shows up on npm
 */
export async function publishToNpm(
  $,
  {
    name,
    version,
    maxRetries = 3,
    retryDelayMs = 10000,
    verifyAttempts = 6,
    verifyDelayMs = 10000,
    sleep,
  }
) {
  console.log(`Checking if version ${version} is already published...`);
  if (await isNpmVersionPublished($, name, version)) {
    console.log(`Version ${version} is already published to npm`);
    return { alreadyPublished: true };
  }
  console.log(
    `Version ${version} not found on npm, proceeding with publish...`
  );

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    console.log(`Publish attempt ${attempt} of ${maxRetries}...`);
    const result = await $`npm run changeset:publish`;
    if (result.code === 0) {
      if (
        await waitForNpmVersion($, {
          name,
          version,
          attempts: verifyAttempts,
          delayMs: verifyDelayMs,
          sleep,
        })
      ) {
        return { alreadyPublished: false };
      }
      throw new Error(
        `npm run changeset:publish exited 0 but ${name}@${version} is not on npm`
      );
    }
    console.log(`Publish failed with exit code ${result.code}`);
    // A publish that timed out client-side may still have landed.
    if (await isNpmVersionPublished($, name, version)) {
      console.log(`${name}@${version} is on npm despite the failed exit`);
      return { alreadyPublished: false };
    }
    if (attempt < maxRetries) {
      console.log(`Waiting ${retryDelayMs / 1000}s before retry...`);
      await sleep(retryDelayMs);
    }
  }
  throw new Error(
    `Failed to publish ${name}@${version} after ${maxRetries} attempts`
  );
}
