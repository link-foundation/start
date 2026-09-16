/**
 * Runs the generated post-mortem shell against a fake `docker` binary, so the
 * POSIX shell the detached watcher executes can be verified without Docker.
 *
 * Usage: node experiments/issue-171-post-mortem-shell.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postMortem = require('../js/src/lib/docker-post-mortem.js');
const { shellQuote } = require('../js/src/lib/isolation-log-utils.js');

const FAKE_DOCKER = `#!/bin/sh
case "$3" in
  *State.Error*) printf '%s' "$FAKE_ERROR" ;;
  *) printf '%s\\n' "$FAKE_STATE" ;;
esac
`;

const cases = [
  {
    name: 'SIGKILL, no error',
    state: '137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z',
    error: '',
  },
  {
    name: 'clean exit',
    state: '0 false 2026-09-15T22:21:40.000000000Z 2026-09-15T22:21:41.500000000Z',
    error: '',
  },
  {
    name: 'never finished (docker zero time)',
    state: '0 false 2026-09-15T22:21:40.000000000Z 0001-01-01T00:00:00Z',
    error: 'OCI runtime create failed: no such file or directory',
  },
  { name: 'inspect fails', state: null, error: '' },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-mortem-'));
const dockerPath = path.join(dir, 'docker');
fs.writeFileSync(dockerPath, FAKE_DOCKER, 'utf8');
fs.chmodSync(dockerPath, 0o755);

for (const testCase of cases) {
  const logPath = path.join(dir, 'out.log');
  fs.writeFileSync(logPath, '');
  const script = [
    postMortem.buildDockerStateSnippet('demo-container'),
    postMortem.buildDockerPostMortemSnippet('demo-container', shellQuote(logPath)),
    postMortem.buildDockerRemovalNoteSnippet('demo-container', shellQuote(logPath)),
  ].join('; ');
  const result = spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testCase.state === null ? dir.replace('post-mortem-', 'empty-') : `${dir}${path.delimiter}${process.env.PATH}`,
      FAKE_STATE: testCase.state || '',
      FAKE_ERROR: testCase.error,
    },
  });
  console.log(`\n### ${testCase.name} (sh exit ${result.status})`);
  if (result.stderr) console.log(`stderr: ${result.stderr.trim()}`);
  console.log(fs.readFileSync(logPath, 'utf8'));
}

fs.rmSync(dir, { recursive: true, force: true });
