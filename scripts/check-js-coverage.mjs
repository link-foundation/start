#!/usr/bin/env node

/**
 * Parse Bun's text coverage report and enforce a minimum line coverage.
 *
 * Bun prints a table whose totals row has no `%` suffix on the numbers:
 *
 *   -------------|---------|---------|-------------------
 *   File         | % Funcs | % Lines | Uncovered Line #s
 *   -------------|---------|---------|-------------------
 *   All files    |   92.60 |   88.09 |
 *
 * The previous inline CI expression (`grep -oP '\d+\.\d+(?=%)'`) therefore
 * never matched, `parseFloat('')` produced NaN and the job printed
 * "Could not determine coverage, skipping check" and passed. That made the
 * coverage gate a permanent false negative (issue #158), so parsing lives here
 * where it is unit tested and a missing/unparsable report is a hard failure.
 *
 * Usage: node scripts/check-js-coverage.mjs <coverage.txt> [--threshold 45]
 */

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const TOTALS_LABEL = 'All files';

/**
 * Extract line coverage (the `% Lines` column of the `All files` row).
 * @param {string} report Raw text coverage report.
 * @returns {number|null} Percentage, or null when the row is absent/unparsable.
 */
export function parseLineCoverage(report) {
  const row = String(report ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(TOTALS_LABEL))
    .pop();
  if (!row) {
    return null;
  }
  const columns = row
    .split('|')
    .map((column) => column.trim())
    .slice(1);
  const numbers = columns
    .map((column) => Number.parseFloat(column))
    .filter((value) => Number.isFinite(value));
  // Columns are `% Funcs`, `% Lines`, `Uncovered Line #s`; line coverage is the
  // second numeric column, and the uncovered-lines column is never a float.
  if (numbers.length < 2) {
    return null;
  }
  return numbers[1];
}

/**
 * Evaluate a coverage report against a threshold.
 * @param {string} report Raw text coverage report.
 * @param {number} threshold Minimum acceptable line coverage.
 * @returns {{ok: boolean, coverage: number|null, message: string}}
 */
export function checkCoverage(report, threshold) {
  const coverage = parseLineCoverage(report);
  if (coverage === null) {
    return {
      ok: false,
      coverage: null,
      message: `❌ Could not determine coverage: no parsable "${TOTALS_LABEL}" row in the report`,
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
  let threshold = 45;
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
    console.error('Usage: node scripts/check-js-coverage.mjs <coverage.txt> [--threshold 45]');
    process.exit(2);
  }
  if (!Number.isFinite(threshold)) {
    console.error('❌ --threshold must be a number');
    process.exit(2);
  }

  let report;
  try {
    report = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`❌ Could not read coverage report ${file}: ${error.message}`);
    process.exit(1);
  }

  const result = checkCoverage(report, threshold);
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
