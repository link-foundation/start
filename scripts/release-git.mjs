#!/usr/bin/env node

/**
 * Fail-closed helpers for the release scripts that write to main (#211).
 *
 * command-stream's `$` resolves on a non-zero exit code. Until #211 a push
 * rejected by the main ruleset (GH013) therefore fell through to
 * "✅ Version bump committed and pushed to main", and the self-healing
 * crates.io check turned the run green. These helpers turn every such
 * failure into an exception, and verify that the version commit actually
 * reached main before anything is published.
 *
 * Set START_DEBUG=1 to trace every checked command. The default state is off.
 */

import { debug } from './debug-print.mjs';

/**
 * Await a command-stream command and throw when it exits non-zero.
 *
 * @param {PromiseLike<{ code: number, stdout?: string, stderr?: string }>} command
 *   a `$` template call, e.g. $`git push origin main`
 * @param {string} label human-readable command, used in the error message
 * @returns {Promise<{ code: number, stdout?: string, stderr?: string }>}
 */
export async function checked(command, label) {
  const result = await command;
  debug(`checked: ${label}`, { code: result.code });
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code}`);
  }
  return result;
}

/**
 * Verify that `commit` is contained in the remote branch. A plain
 * `git rev-parse` comparison would fail when another commit lands on main
 * right after the push, so this checks ancestry against a fresh fetch.
 *
 * @param {Function} $ command-stream `$`
 * @param {{ commit?: string, remote?: string, branch?: string }} [options]
 * @returns {Promise<string>} the verified commit SHA
 */
export async function verifyCommitOnRemote(
  $,
  { commit = 'HEAD', remote = 'origin', branch = 'main' } = {}
) {
  const sha = (
    await checked(
      $`git rev-parse ${commit}`.run({ capture: true, mirror: false }),
      `git rev-parse ${commit}`
    )
  ).stdout.trim();
  await checked(
    $`git fetch ${remote} ${branch}`,
    `git fetch ${remote} ${branch}`
  );
  const remoteRef = `${remote}/${branch}`;
  const ancestry =
    await $`git merge-base --is-ancestor ${sha} ${remoteRef}`.run({
      capture: true,
      mirror: false,
    });
  debug('verifyCommitOnRemote', { sha, remoteRef, code: ancestry.code });
  if (ancestry.code !== 0) {
    throw new Error(
      `Commit ${sha} is not on ${remoteRef} after the push; the version commit did not reach ${branch}`
    );
  }
  return sha;
}

const RULE_REJECTION =
  /\bGH0(?:06|13)\b|Repository rule violations|protected branch hook declined/i;
const NON_FAST_FORWARD =
  /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|Updates were rejected because the (?:remote contains work|tip of your current branch is behind)/i;

/**
 * Classify a rejected `git push` from its output.
 *
 * A ruleset rejection also prints `[rejected]`, but no rebase can satisfy a
 * rule, so it is checked first. Anything else (auth, network) is "other":
 * rebasing would only hide the real error.
 *
 * @param {string} output combined stdout and stderr of `git push`
 * @returns {'rule'|'non-fast-forward'|'other'}
 */
export function classifyPushRejection(output) {
  const text = String(output ?? '');
  if (RULE_REJECTION.test(text)) {
    return 'rule';
  }
  if (NON_FAST_FORWARD.test(text)) {
    return 'non-fast-forward';
  }
  return 'other';
}

/**
 * Push `branch`, rebasing onto the remote and retrying when another writer
 * landed first. The main-writer concurrency group orders writers but each
 * one checks out the commit that triggered its run, so a writer queued
 * behind another one is rejected as non-fast-forward (#234, CI/CD best
 * practice 10). A rebase that conflicts - another writer bumped the same
 * version files - fails loudly instead of replaying a stale version. Never
 * forces.
 *
 * @param {Function} $ command-stream `$`
 * @param {{ remote?: string, branch?: string, maxAttempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ attempt: number }>}
 */
export async function pushWithRetry(
  $,
  {
    remote = 'origin',
    branch = 'main',
    maxAttempts = 3,
    delayMs = 5000,
    sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await $`git push ${remote} ${branch}`.run({
      capture: true,
    });
    if (result.code === 0) {
      return { attempt };
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const kind = classifyPushRejection(output);
    debug('pushWithRetry', { attempt, code: result.code, kind });
    if (kind === 'rule') {
      throw new Error(
        `git push ${remote} ${branch} was blocked by a repository rule; fix the rule (or its bypass list), not the workflow:\n${output.trim()}`
      );
    }
    if (kind !== 'non-fast-forward') {
      throw new Error(
        `git push ${remote} ${branch} failed with exit code ${result.code}:\n${output.trim()}`
      );
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `git push ${remote} ${branch} was still non-fast-forward after ${maxAttempts} attempts`
      );
    }
    console.log(
      `Push rejected: ${remote}/${branch} moved (attempt ${attempt}/${maxAttempts}); rebasing and retrying in ${delayMs / 1000}s...`
    );
    await sleep(delayMs);
    await checked(
      $`git pull --rebase ${remote} ${branch}`,
      `git pull --rebase ${remote} ${branch} (another writer changed the same files; re-run the release)`
    );
  }
  throw new Error('unreachable');
}

/**
 * Bump a semantic version.
 *
 * @param {string} version
 * @param {'major'|'minor'|'patch'} type
 * @returns {string}
 */
export function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Unsupported semantic version: ${version}`);
  }

  let [, major, minor, patch] = match.map(Number);

  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Bump `version` by `type`, skipping every version the registry already has.
 * main can lag behind the registry (0.23.0 on main while crates.io had
 * 0.24.0 from an older tree, #211); reusing that number would make the
 * publish step a silent "already published" no-op.
 *
 * @param {string} version current version
 * @param {'major'|'minor'|'patch'} type bump type
 * @param {(version: string) => Promise<boolean>} isPublished registry lookup
 * @param {number} [maxAttempts]
 * @returns {Promise<string>}
 */
export async function nextUnpublishedVersion(
  version,
  type,
  isPublished,
  maxAttempts = 100
) {
  let candidate = bumpVersion(version, type);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!(await isPublished(candidate))) {
      return candidate;
    }
    console.log(`${candidate} is already published; bumping again`);
    candidate = bumpVersion(candidate, type);
  }
  throw new Error(
    `No unpublished ${type} version found after ${version} within ${maxAttempts} attempts`
  );
}

/**
 * Ask crates.io whether `name@version` exists. Fails closed: any answer
 * other than 200/404 throws, so an outage never picks a taken version.
 * CRATES_IO_BASE_URL overrides the API root (used by the tests).
 *
 * @param {string} name
 * @param {string} version
 * @returns {Promise<boolean>}
 */
export async function isCrateVersionPublished(name, version) {
  const baseUrl = (
    process.env.CRATES_IO_BASE_URL || 'https://crates.io/api/v1'
  ).replace(/\/$/, '');
  const url = `${baseUrl}/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'link-foundation/start version-and-commit',
    },
  });
  debug('isCrateVersionPublished', { url, status: response.status });
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw new Error(
    `Unexpected crates.io response ${response.status} for ${url}`
  );
}
