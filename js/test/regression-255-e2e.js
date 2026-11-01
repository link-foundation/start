/**
 * Issue #255: opt-in end-to-end test of `--use-formal-ai` against a REAL
 * Formal AI checkout. Skipped unless both are set:
 *
 *   START_FORMAL_AI_E2E=1 START_FORMAL_AI_ROOT=/path/to/formal-ai \
 *     bun test ./test/regression-255-e2e.js
 *
 * It runs the issue's demo in an isolated directory whose names contain
 * spaces and Unicode, compares the listing with an independent readdir and
 * proves the directory is unchanged. Use START_FORMAL_AI_NODE to pick the
 * Node.js that runs the Formal AI server.
 */
const { describe, it, expect, afterAll } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  CLI,
  cleanup,
  cliEnv,
  populate,
  readEvidence,
  readLog,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const enabled =
  process.env.START_FORMAL_AI_E2E === '1' &&
  Boolean(process.env.START_FORMAL_AI_ROOT) &&
  process.platform !== 'win32';
const dirs = [];
afterAll(() => cleanup(...dirs));

function run(request, files) {
  const root = tempDir('e2e');
  const cwd = populate(tempDir('e2e-fixture'), files);
  dirs.push(root, cwd);
  const before = snapshot(cwd);
  const env = cliEnv(root, {
    START_FORMAL_AI_ROOT: process.env.START_FORMAL_AI_ROOT,
    START_FORMAL_AI_NODE: process.env.START_FORMAL_AI_NODE || 'node',
  });
  delete env.START_FORMAL_AI_MEMORY_PATH;
  const result = spawnSync(
    process.execPath,
    [CLI, '--use-formal-ai', '--', ...request.split(' ')],
    { cwd, env, encoding: 'utf8', timeout: 120000 }
  );
  return { ...result, root, cwd, before, after: snapshot(cwd) };
}

describe.skipIf(!enabled)('--use-formal-ai with a real runtime (#255)', () => {
  it(
    'prints the list of files in the current directory',
    () => {
      const result = run('print list of files in current directory', {
        'a b.txt': 'one\n',
        'ünï cødé.md': '# two\n',
        'sub dir': null,
        plain: '',
      });
      expect(result.status).toBe(0);
      const listed = result.stdout
        .split('\n')
        .filter((line) => line && fs.existsSync(path.join(result.cwd, line)));
      expect(listed.sort()).toEqual(fs.readdirSync(result.cwd).sort());
      expect(result.after).toEqual(result.before);
      const evidence = readEvidence(readLog(result.root));
      expect(evidence.runtime.source).toBe('checkout');
      expect(evidence.outcome.status).toBe('completed');
      expect(evidence.effects).toMatchObject({
        added: [],
        removed: [],
        changed: [],
      });
    },
    { timeout: 150000 }
  );

  it(
    'fails explicitly on an unsupported request',
    () => {
      const result = run('book me a flight to Paris', { 'a.txt': 'a' });
      expect(result.status).toBe(65);
      expect(result.after).toEqual(result.before);
    },
    { timeout: 150000 }
  );
});
