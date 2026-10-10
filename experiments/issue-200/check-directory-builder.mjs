#!/usr/bin/env node
// Compile the actual directory-constructor block under both cfg branches.
// This tiny probe needs no Cargo target or cross-platform standard library.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = new URL('../../rust/src/lib/log_sanitizer.rs', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.search(/    let (?:mut )?builder = DirBuilder::new\(\);/);
const end = source.indexOf('\n    builder\n', start);
assert.ok(start >= 0 && end > start, 'Expected the production constructor block');
const constructor = source
  .slice(start, end)
  .replaceAll('#[cfg(unix)]', '#[cfg(probe_unix)]');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-dirbuilder-probe-'));
try {
  const fixturePath = path.join(directory, 'constructor.rs');
  fs.writeFileSync(
    fixturePath,
    `use std::fs::DirBuilder;
pub fn create_directory(directory: &std::path::Path) -> std::io::Result<()> {
${constructor}
    builder.create(directory)
}
`
  );
  for (const platform of ['non-Unix', 'Unix']) {
    const result = spawnSync(
      'rustc',
      [
        '--edition=2021',
        '--crate-type=lib',
        '--crate-name=start_dirbuilder_probe',
        '--emit=metadata',
        '-Dwarnings',
        '--check-cfg=cfg(probe_unix)',
        ...(platform === 'Unix' ? ['--cfg=probe_unix'] : []),
        '-o',
        path.join(directory, `${platform}.rmeta`),
        fixturePath,
      ],
      { encoding: 'utf8' }
    );
    console.log(`${platform} constructor: exit ${result.status}`);
    if (result.status !== 0 || result.error) {
      process.stderr.write(result.stderr || String(result.error));
      process.exitCode = 1;
    }
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
