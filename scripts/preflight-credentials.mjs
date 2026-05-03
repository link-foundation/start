#!/usr/bin/env node

/**
 * Preflight credential check for release jobs.
 *
 * Surfaces missing or invalid credentials at the *top* of the run summary
 * so a failed publish doesn't surface as a confusing message buried inside
 * `gh` or `npm` output. Each check emits a `::error::` line on failure
 * and exits non-zero.
 *
 * Usage:
 *   node scripts/preflight-credentials.mjs --require gh-token
 *   node scripts/preflight-credentials.mjs --require npm-oidc
 *   node scripts/preflight-credentials.mjs --require crates-io
 *   node scripts/preflight-credentials.mjs --require gh-token --require npm-oidc
 *
 * Env (optional):
 *   PREFLIGHT_PACKAGE_NAME   Package name used for crates.io reachability test.
 *
 * Why this script exists: see docs/case-studies/issue-118/root-cause.md (RC-4).
 */

import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const requiredChecks = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--require" && args[index + 1]) {
    requiredChecks.push(args[index + 1]);
    index += 1;
  }
}

if (requiredChecks.length === 0) {
  console.error("Error: at least one --require <check> argument is required");
  console.error("Available checks: gh-token, npm-oidc, crates-io");
  process.exit(1);
}

const failures = [];

function logCheck(label, status, detail = "") {
  const prefix = status === "ok" ? "✅" : "❌";
  console.log(`${prefix} ${label}${detail ? `: ${detail}` : ""}`);
}

function fail(label, message) {
  failures.push({ label, message });
  console.log(`::error::Preflight check failed (${label}): ${message}`);
  logCheck(label, "fail", message);
}

function checkGhToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    fail(
      "gh-token",
      "Neither GH_TOKEN nor GITHUB_TOKEN is set. Add `env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }` to the step.",
    );
    return;
  }

  try {
    execSync("gh api user --jq .login", {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
    });
    logCheck("gh-token", "ok", "authenticated");
  } catch (error) {
    fail(
      "gh-token",
      `\`gh api user\` rejected the token (HTTP error or expired). Underlying: ${error.message.split("\n")[0]}`,
    );
  }
}

async function checkNpmOidc() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    fail(
      "npm-oidc",
      "ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN is missing. The workflow / job needs `permissions: id-token: write`.",
    );
    return;
  }

  try {
    const response = await fetch(`${requestUrl}&audience=npm:registry.npmjs.org`, {
      headers: { Authorization: `bearer ${requestToken}` },
    });
    if (!response.ok) {
      fail(
        "npm-oidc",
        `OIDC token mint returned HTTP ${response.status}. Trusted publishing may be misconfigured for this workflow.`,
      );
      return;
    }
    const body = await response.json();
    if (!body.value) {
      fail("npm-oidc", "OIDC token mint succeeded but the response had no `value`.");
      return;
    }
    logCheck("npm-oidc", "ok", "test token minted");
  } catch (error) {
    fail("npm-oidc", `OIDC token mint threw: ${error.message}`);
  }
}

async function checkCratesIo() {
  const packageName = process.env.PREFLIGHT_PACKAGE_NAME || "";
  const probeUrl = packageName
    ? `https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}`
    : "https://crates.io/api/v1/summary";

  try {
    const response = await fetch(probeUrl, {
      headers: { "User-Agent": "link-foundation/start preflight" },
    });
    if (response.status >= 500) {
      fail("crates-io", `crates.io returned HTTP ${response.status}.`);
      return;
    }
    logCheck("crates-io", "ok", `${probeUrl} → HTTP ${response.status}`);
  } catch (error) {
    fail("crates-io", `crates.io is unreachable: ${error.message}`);
  }
}

const checkers = {
  "gh-token": checkGhToken,
  "npm-oidc": checkNpmOidc,
  "crates-io": checkCratesIo,
};

for (const name of requiredChecks) {
  const check = checkers[name];
  if (!check) {
    console.error(`::error::Unknown preflight check: ${name}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-await-in-loop
  await check();
}

if (failures.length > 0) {
  console.error("");
  console.error(`Preflight failed: ${failures.length} check(s) did not pass.`);
  process.exit(1);
}

console.log("");
console.log(`Preflight passed: ${requiredChecks.length} check(s).`);
