/** Verify the real regeneration check rejects deliberate generated-file drift. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = 'rust/src/lib/generated/parity_threshold.rs';
const original = readFileSync(file);
try {
  writeFileSync(file, Buffer.concat([original, Buffer.from('\n// deliberate bounded drift probe\n')]));
  const result = spawnSync('bun', ['scripts/generate-rust.mjs', '--check'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /drifted; regenerate from JavaScript/);
  console.log(result.stderr);
  console.log('Actual upstream regeneration rejected modified output.');
} finally {
  writeFileSync(file, original);
}
