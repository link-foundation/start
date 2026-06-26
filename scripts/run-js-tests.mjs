#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const jsDir = join(root, 'js');
const testDir = join(jsDir, 'test');
const DEFAULT_TEST_TIMEOUT_MS = '30000';

const flagsWithValues = new Set([
  '--bail',
  '--coverage-dir',
  '--coverage-reporter',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--reporter',
  '--reporter-outfile',
  '--rerun-each',
  '--retry',
  '--seed',
  '--test-name-pattern',
  '--timeout',
  '-t',
]);

function collectTests(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTests(absolute);
      }
      if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name)) {
        return [];
      }
      return `./${relative(jsDir, absolute)}`;
    })
    .sort();
}

function hasPattern(args) {
  let expectingValue = false;
  for (const arg of args) {
    if (expectingValue) {
      expectingValue = false;
      continue;
    }
    if (arg === '--') {
      return true;
    }
    if (flagsWithValues.has(arg)) {
      expectingValue = true;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    return true;
  }
  return false;
}

function normalizePathArg(arg) {
  const absolute = join(jsDir, arg);
  if (!existsSync(absolute)) {
    return [arg];
  }
  const stat = statSync(absolute);
  if (stat.isDirectory()) {
    return collectTests(absolute);
  }
  return [`./${relative(jsDir, absolute)}`];
}

function normalizeUserArgs(args) {
  const normalized = [];
  let expectingValue = false;
  for (const arg of args) {
    if (expectingValue) {
      normalized.push(arg);
      expectingValue = false;
      continue;
    }
    if (flagsWithValues.has(arg)) {
      normalized.push(arg);
      expectingValue = true;
      continue;
    }
    if (arg.startsWith('-') || arg.startsWith('/')) {
      normalized.push(arg);
      continue;
    }
    normalized.push(...normalizePathArg(arg));
  }
  return normalized;
}

export function hasExplicitTimeout(args) {
  for (const arg of args) {
    if (arg === '--') {
      return false;
    }
    if (arg === '--timeout' || arg === '-t' || arg.startsWith('--timeout=')) {
      return true;
    }
  }
  return false;
}

export function applyDefaultTimeout(args) {
  if (hasExplicitTimeout(args)) {
    return args;
  }
  return ['--timeout', DEFAULT_TEST_TIMEOUT_MS, ...args];
}

function run() {
  const userArgs = process.argv.slice(2);
  const normalizedUserArgs = normalizeUserArgs(userArgs);
  const effectiveUserArgs = applyDefaultTimeout(normalizedUserArgs);
  const testFiles = hasPattern(userArgs) ? [] : collectTests(testDir);
  const bun = process.versions.bun ? process.execPath : 'bun';
  const result = spawnSync(bun, ['test', ...effectiveUserArgs, ...testFiles], {
    cwd: jsDir,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
