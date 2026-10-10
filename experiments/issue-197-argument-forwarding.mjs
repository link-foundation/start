import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A finite fake Cargo process verifies argument forwarding without compiling.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(resolve(tmpdir(), 'start-issue-197-cargo-'));
try {
  const output = resolve(directory, 'arguments.txt');
  writeFileSync(
    resolve(directory, 'cargo'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$ISSUE_197_CARGO_ARGUMENTS"\n',
    { mode: 0o700 }
  );
  for (const [input, expected] of [
    [
      ['clippy', '--all-targets', '--all-features', '--', '-D', 'warnings'],
      ['clippy', '--all-targets', '--all-features', '-j', '2', '--', '-D', 'warnings'],
    ],
    [['test', '--lib'], ['test', '--lib', '-j', '2']],
  ]) {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/bounded-cargo.mjs'), ...input],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          ISSUE_197_CARGO_ARGUMENTS: output,
        },
        encoding: 'utf8',
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = readFileSync(output, 'utf8').trimEnd().split('\n');
    assert.deepEqual(actual, expected);
    console.log(JSON.stringify({ input, actual }));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
