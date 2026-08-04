#!/usr/bin/env bun
/**
 * End-to-end reproduction for issue #150, driven through the real `$ --status`
 * CLI and no mocks (and no docker daemon required).
 *
 * It stores a detached-docker execution record whose container name cannot be
 * inspected — the exact window from the incident: the container is gone and the
 * host-side watcher has not appended the genuine footer yet — and whose log
 * contains the substring `Exit Code: 1` inside ordinary command output.
 *
 * Before the fix, `$ --status` reported `status executed / exitCode 1`.
 * After the fix it keeps reporting `status executing / exitCode` unset, and it
 * only reports a terminal exit code once the anchored footer is appended.
 *
 * Usage: bun experiments/issue-150-forged-exit-code.mjs
 * Reference: https://github.com/link-foundation/start/issues/150
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const cliPath = path.join(repoRoot, 'js/src/bin/cli.js');
const { ExecutionStore, ExecutionRecord } = await import(
  path.join(repoRoot, 'js/src/lib/execution-store.js')
);

const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-150-'));
const logPath = path.join(appFolder, 'session.log');
const sessionName = `issue150-repro-${process.pid}`;

// The command's own output happens to contain "Exit Code: 1" — here as the tail
// of an unrelated, older session log dumped by `rg -n` into a JSON payload.
const forgedOutput =
  '{"type":"item.completed","item":{"aggregated_output":' +
  '"40-==================================================\\n' +
  '41-Finished: 2026-07-28 20:04:52.316\\n42-Exit Code: 1\\n",' +
  '"exit_code":0,"status":"completed"}}\n';
fs.writeFileSync(logPath, forgedOutput);

const store = new ExecutionStore({ appFolder, useLinks: false });
store.save(
  new ExecutionRecord({
    command: 'solve.mjs --detached',
    logPath,
    options: {
      sessionName,
      isolated: 'docker',
      isolationMode: 'detached',
    },
  })
);

function status() {
  const result = spawnSync('bun', [cliPath, '--status', sessionName], {
    encoding: 'utf8',
    env: { ...process.env, START_APP_FOLDER: appFolder },
    timeout: 30000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

let failures = 0;
function check(label, condition, output) {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) {
    failures += 1;
    console.log(output);
  }
}

const beforeFooter = status();
check(
  'forged "Exit Code: 1" in the output does not terminate the session',
  /status executing/.test(beforeFooter) && !/exitCode 1/.test(beforeFooter),
  beforeFooter
);

// Now the genuine footer, exactly as `start` appends it.
fs.appendFileSync(
  logPath,
  `\n${'='.repeat(50)}\nFinished: 2026-07-30 23:36:20.295\nExit Code: 0\n`
);

const afterFooter = status();
check(
  'the anchored footer is honored once it is written',
  /status executed/.test(afterFooter) && /exitCode 0/.test(afterFooter),
  afterFooter
);

fs.rmSync(appFolder, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
