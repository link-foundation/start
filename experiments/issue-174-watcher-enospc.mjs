// Reproduces issue #174: `docker logs -f C >> /dev/full` fails with ENOSPC
// while C is still running. The 0.34.0 watcher then inspected a *running*
// container (ExitCode=0, FinishedAt=0001-01-01...), `docker rm -f`ed it and
// finalized the record as executed / exit 0.
//
// Usage: node experiments/issue-174-watcher-enospc.mjs   (needs docker + alpine)
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-174-'));
process.env.START_APP_FOLDER = appFolder;
const {
  buildDetachedDockerCompletionScript,
  DOCKER_CONTAINER_CLEANUP_POLICY,
} = require('../js/src/lib/docker-cleanup.js');
const { ExecutionStore, ExecutionRecord } = require('../js/src/lib/execution-store.js');

const name = `issue-174-${process.pid}`;
const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8' });
const running = () => docker('inspect', '-f', '{{.State.Running}}', name).stdout.trim() || 'REMOVED';

const store = new ExecutionStore({ appFolder });
const record = new ExecutionRecord({ command: 'work', logPath: '/dev/full', options: { isolated: 'docker' } });
store.save(record);

docker('run', '-d', '--name', name, 'alpine:3.20', 'sh', '-c', 'i=0; while [ $i -lt 30 ]; do echo work; sleep 0.1; i=$((i+1)); done; exit 7');
console.log(`started ${name}; running=${running()}`);

const script = buildDetachedDockerCompletionScript(name, DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT, '/dev/full', record.uuid);
const t0 = Date.now();
const watcher = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: process.env });
console.log(`watcher finished after ${Date.now() - t0} ms`);
console.log(`container after watcher: ${running()}`);
const exit = docker('inspect', '-f', '{{.State.ExitCode}} {{.State.FinishedAt}}', name).stdout.trim();
console.log(`container state after watcher: ${exit || 'REMOVED'}`);
const final = store.get(record.uuid);
console.log(`record: status=${final.status} exitCode=${final.exitCode} endTimeSource=${final.endTimeSource} exitReason=${final.exitReason}`);
docker('rm', '-f', name);
fs.rmSync(appFolder, { recursive: true, force: true });
