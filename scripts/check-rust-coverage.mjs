#!/usr/bin/env node

/**
 * Parse a cargo-tarpaulin log and enforce a minimum line coverage.
 *
 * tarpaulin ends a successful run with a summary line such as:
 *
 *   50.73% coverage, 908/1790 lines covered
 *
 * When a test fails it prints `Error: "Test failed during run"` instead and
 * never reaches the summary. The previous inline CI step piped tarpaulin into
 * `tee` without `pipefail`, read an empty coverage value, and reported
 * "❌ Coverage % is below the 50% threshold" - a misleading failure that sent
 * readers hunting for a coverage drop when a test had failed (issue #234).
 * Parsing lives here, mirroring `check-js-coverage.mjs`, so each outcome has
 * its own unit-tested message.
 *
 * Usage: node scripts/check-rust-coverage.mjs <tarpaulin.log> [--threshold 50]
 */

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const SUMMARY = /^(\d+(?:\.\d+)?)% coverage, \d+\/\d+ lines covered/;
const TEST_FAILURE = /^Error: "Test failed during run"/;

/**
 * Extract the final coverage percentage from a tarpaulin log.
 * @param {string} log Raw tarpaulin output.
 * @returns {number|null} Percentage, or null when no summary line exists.
 */
export function parseTarpaulinCoverage(log) {
  const summaries = String(log ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(SUMMARY))
    .filter(Boolean);
  if (summaries.length === 0) {
    return null;
  }
  return Number.parseFloat(summaries.at(-1)[1]);
}

/**
 * Evaluate a tarpaulin log against a threshold.
 * @param {string} log Raw tarpaulin output.
 * @param {number} threshold Minimum acceptable line coverage.
 * @returns {{ok: boolean, coverage: number|null, message: string}}
 */
export function checkCoverage(log, threshold) {
  const coverage = parseTarpaulinCoverage(log);
  if (coverage === null) {
    const testsFailed = String(log ?? '')
      .split(/\r?\n/)
      .some((line) => TEST_FAILURE.test(line.trim()));
    return {
      ok: false,
      coverage: null,
      message: testsFailed
        ? '❌ Coverage not measured: a test failed during the tarpaulin run (see the failing test above)'
        : '❌ Could not determine coverage: no tarpaulin "% coverage" summary in the log',
    };
  }
  if (coverage >= threshold) {
    return {
      ok: true,
      coverage,
      message: `✅ Coverage ${coverage}% meets the ${threshold}% threshold`,
    };
  }
  return {
    ok: false,
    coverage,
    message: `❌ Coverage ${coverage}% is below the ${threshold}% threshold`,
  };
}

function parseArgs(argv) {
  let file = null;
  let threshold = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold' && argv[i + 1]) {
      threshold = Number.parseFloat(argv[i + 1]);
      i++;
    } else if (!file) {
      file = argv[i];
    }
  }
  return { file, threshold };
}

function main() {
  const { file, threshold } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error(
      'Usage: node scripts/check-rust-coverage.mjs <tarpaulin.log> [--threshold 50]'
    );
    process.exit(2);
  }
  if (!Number.isFinite(threshold)) {
    console.error('❌ --threshold must be a number');
    process.exit(2);
  }

  let log;
  try {
    log = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`❌ Could not read tarpaulin log ${file}: ${error.message}`);
    process.exit(1);
  }

  const result = checkCoverage(log, threshold);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
