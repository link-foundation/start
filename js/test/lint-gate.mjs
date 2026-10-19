// ESLint exits 0 when it finds only warnings, so `eslint .` let every
// warn-level rule (require-await) through CI unnoticed (issue #234). Each lint
// command CI and the pre-commit hook run must reject a warning-only file.
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const jsRoot = join(import.meta.dir, '..');
const eslint = join(jsRoot, 'node_modules', '.bin', 'eslint');
const pkg = JSON.parse(readFileSync(join(jsRoot, 'package.json'), 'utf8'));

// Prettier-clean, so the only finding is the require-await warning.
const warningOnly = 'export async function f() {\n  return 1;\n}\n';

/** Run an `eslint ...` command on stdin in place of the paths it lints. */
function lintWarningOnly(command, cwd, filename) {
  const [bin, ...args] = command.trim().split(/\s+/);
  expect(bin).toBe('eslint');
  const flags = args.filter((arg) => arg !== '.');
  return spawnSync(
    eslint,
    [...flags, '--stdin', '--stdin-filename', filename],
    { cwd, input: warningOnly, encoding: 'utf8' }
  );
}

describe('lint gate', () => {
  it('fails `bun run lint` on a warning', () => {
    const result = lintWarningOnly(pkg.scripts.lint, jsRoot, 'src/probe.mjs');
    expect(result.stdout).toContain('require-await');
    expect(result.status).toBe(1);
  });

  it('fails `bun run lint:scripts` on a warning', () => {
    const command = pkg.scripts['lint:scripts'].replace(/^cd \.\. && /, '');
    const result = lintWarningOnly(
      command,
      join(jsRoot, '..'),
      'scripts/probe.mjs'
    );
    expect(result.stdout).toContain('require-await');
    expect(result.status).toBe(1);
  });

  it('fails the pre-commit hook on a warning', () => {
    const [command] = pkg['lint-staged']['*.{js,mjs,cjs}'];
    const result = lintWarningOnly(
      command.replace(' --fix', ''),
      jsRoot,
      'src/probe.mjs'
    );
    expect(result.stdout).toContain('require-await');
    expect(result.status).toBe(1);
  });
});
