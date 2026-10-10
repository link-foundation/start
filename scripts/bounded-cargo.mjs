#!/usr/bin/env node
/** Optional local Rust verification: one shared target, two jobs, finite disk. */
import {
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  openSync,
  closeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(root, '.cargo-target');
const lock = resolve(root, '.cargo-target.lock');
const limit = Number(process.env.START_CARGO_MAX_GIB || 4) * 1024 ** 3;
const memory = Number(process.env.START_CARGO_MEMORY_GIB || 2) * 1024 ** 3;
if (!Number.isFinite(limit) || limit <= 0) {
  throw new Error('START_CARGO_MAX_GIB must be positive and finite');
}
if (!Number.isFinite(memory) || memory <= 0) {
  throw new Error('START_CARGO_MEMORY_GIB must be positive and finite');
}
function diskUsage(path) {
  try {
    const stat = statSync(path);
    return stat.isDirectory()
      ? readdirSync(path).reduce(
          (sum, name) => sum + diskUsage(resolve(path, name)),
          0
        )
      : stat.size;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}
const descriptor = openSync(lock, 'wx');
try {
  if (diskUsage(target) > limit) {
    rmSync(target, { recursive: true, force: true });
    console.log('Pruned shared Cargo target above its configured disk budget.');
  }
  mkdirSync(target, { recursive: true });
  const cargoArguments = process.argv.slice(2);
  const separator = cargoArguments.indexOf('--');
  // Cargo's separator forwards remaining flags to rustc/rustdoc. Keep the
  // build concurrency bound on Cargo's side of that boundary.
  cargoArguments.splice(
    separator < 0 ? cargoArguments.length : separator,
    0,
    '-j',
    '2'
  );
  const command = process.platform === 'linux' ? 'prlimit' : 'cargo';
  const args =
    process.platform === 'linux'
      ? [`--as=${Math.floor(memory)}`, '--', 'cargo', ...cargoArguments]
      : cargoArguments;
  const result = spawnSync(command, args, {
    cwd: resolve(root, 'rust'),
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' },
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
  if (diskUsage(target) > limit) {
    rmSync(target, { recursive: true, force: true });
    console.log('Pruned shared Cargo target after build exceeded disk budget.');
  }
} finally {
  closeSync(descriptor);
  rmSync(lock, { force: true });
}
