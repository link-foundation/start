// Bounded reproduction of sanitizer #51. Run before and after updating npm.
// Each child has a 384 MiB JS heap and a 20 s deadline; inputs stop at 256 KiB.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(
  new URL(
    '../../js/node_modules/@link-foundation/sensitive-data-sanitizer/bin/sensitive-data-sanitizer.js',
    import.meta.url
  )
);
const config = mkdtempSync(join(tmpdir(), 'start-253-gh-'));
try {
  for (const kib of [64, 128, 256]) {
    const count = Math.ceil((kib * 1024) / 46);
    const input = Array.from({ length: count }, (_, index) => {
      const token = createHash('sha256').update(String(index)).digest('hex');
      return `gh${'p_'}${token.slice(0, 36)} keep\n`;
    }).join('');
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=384',
        cli,
        'redact',
        '-',
        '--stream',
        '--credentials-only',
        '--allow-binary',
      ],
      {
        input,
        encoding: 'utf8',
        env: { ...process.env, GH_CONFIG_DIR: config },
        timeout: 20000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      }
    );
    console.log(
      `${kib} KiB: ${Math.round(performance.now() - started)} ms; status=${result.status}; error=${result.error?.code ?? 'none'}`
    );
    if (result.error?.code === 'ETIMEDOUT') {
      process.exitCode = 1;
      break;
    }
    assert.equal(result.status, 0, result.stderr);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    assert.equal(hash(result.stdout), hash('[REDACTED] keep\n'.repeat(count)));
    console.log(`Verified all ${count} credentials and every non-secret byte.`);
  }
} finally {
  rmSync(config, { recursive: true, force: true });
}
