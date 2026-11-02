/**
 * Issue #255: opt-in end-to-end test of `--use-formal-ai` against a REAL
 * Formal AI checkout. Skipped unless both are set:
 *
 *   START_FORMAL_AI_E2E=1 START_FORMAL_AI_ROOT=/path/to/formal-ai \
 *     bun test ./test/regression-255-e2e.js
 *
 * It runs the issue's demo in an isolated directory whose names contain
 * spaces and Unicode, compares the listing with an independent readdir and
 * proves the directory is unchanged. Issue #258 adds an isolated
 * read/edit/read task in workspace-write mode, the explicit capability gap of
 * the same request in read-only mode, and a plain question answered without
 * tools. Use START_FORMAL_AI_NODE to pick the Node.js that runs the Formal AI
 * server.
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

function run(request, files, extra = {}) {
  const root = tempDir('e2e');
  const cwd = populate(tempDir('e2e-fixture'), files);
  dirs.push(root, cwd);
  const before = snapshot(cwd);
  const env = cliEnv(root, {
    START_FORMAL_AI_ROOT: process.env.START_FORMAL_AI_ROOT,
    START_FORMAL_AI_NODE: process.env.START_FORMAL_AI_NODE || 'node',
    ...extra,
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

const SNIPPET =
  '// keep this comment\nconst label = "before";\n\n\texport const shown = label;  \n/* "before" stays here */\n';
const EDIT =
  'In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.';

describe.skipIf(!enabled)(
  '--use-formal-ai edits with a real runtime (#258)',
  () => {
    it(
      'reads, edits and reads back one file in workspace-write mode',
      () => {
        const result = run(
          EDIT,
          { 'snippet.mjs': SNIPPET, 'other.txt': 'unrelated\n' },
          { START_FORMAL_AI_EFFECTS: 'workspace-write' }
        );
        expect(result.status).toBe(0);
        expect(
          fs.readFileSync(path.join(result.cwd, 'snippet.mjs'), 'utf8')
        ).toBe(
          SNIPPET.replace('const label = "before";', 'const label = "after";')
        );
        expect(
          fs.readFileSync(path.join(result.cwd, 'other.txt'), 'utf8')
        ).toBe('unrelated\n');
        const evidence = readEvidence(readLog(result.root));
        expect(
          evidence.steps.filter((s) => s.kind === 'tool').map((s) => s.command)
        ).toEqual([
          'read snippet.mjs',
          'edit snippet.mjs',
          'sha256sum -- snippet.mjs',
        ]);
        expect(evidence.effects).toMatchObject({
          added: [],
          removed: [],
          changed: ['snippet.mjs'],
        });
      },
      { timeout: 150000 }
    );

    it(
      'exits nonzero with the capability gap in read-only mode',
      () => {
        const result = run(EDIT, { 'snippet.mjs': SNIPPET });
        expect(result.status).toBe(65);
        expect(result.after).toEqual(result.before);
        const evidence = readEvidence(readLog(result.root));
        expect(evidence.outcome).toMatchObject({
          status: 'capability-gap',
          gap: {
            schema: 'workspace-edit-capability-gap/v1',
            target: 'snippet.mjs',
          },
        });
      },
      { timeout: 150000 }
    );

    it(
      'answers a plain question with exit 0',
      () => {
        const result = run('What is 2 + 2?', { 'a.txt': 'a' });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('2 + 2 = 4');
        expect(result.after).toEqual(result.before);
      },
      { timeout: 150000 }
    );
  }
);
