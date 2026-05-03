#!/usr/bin/env node

/**
 * Lightweight debug logger for CI scripts.
 *
 * Many of our pipeline scripts swallow context when something goes wrong:
 * a single "::error::" line tells you nothing about which inputs the script
 * actually received. This module exposes a `debug(...)` helper that prints
 * messages only when CI debug mode is enabled, so we can leave verbose
 * tracing in the code with the default state switched off (per CLAUDE.md
 * guidelines).
 *
 * Activation:
 *   - Set START_DEBUG=1 (preferred local toggle), or
 *   - Set RUNNER_DEBUG=1 (GitHub "Re-run all jobs with debug logging"), or
 *   - Set ACTIONS_STEP_DEBUG=true (the secret-gated workflow debug switch).
 *
 * Each output line is prefixed with `::debug::` so GitHub renders it in the
 * collapsible debug stream when ACTIONS_STEP_DEBUG=true.
 *
 * Usage:
 *   import { debug, isDebugEnabled, dumpEnv } from "./debug-print.mjs";
 *   debug("publishing", { name, version });
 *
 * See docs/case-studies/issue-118/solutions.md (S9).
 */

export function isDebugEnabled() {
  return (
    process.env.START_DEBUG === "1" ||
    process.env.START_DEBUG === "true" ||
    process.env.RUNNER_DEBUG === "1" ||
    process.env.ACTIONS_STEP_DEBUG === "true"
  );
}

function format(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function debug(...parts) {
  if (!isDebugEnabled()) return;
  const line = parts.map(format).join(" ");
  for (const chunk of line.split("\n")) {
    console.log(`::debug::${chunk}`);
  }
}

export function dumpEnv(keys) {
  if (!isDebugEnabled()) return;
  const present = {};
  for (const key of keys) {
    const value = process.env[key];
    present[key] = value
      ? `${value.length} chars (${value.slice(0, 4)}…)`
      : "<unset>";
  }
  debug("env snapshot:", present);
}
