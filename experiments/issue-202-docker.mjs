#!/usr/bin/env bun
// Finite real-Docker regression; run after `bun scripts/bounded-cargo.mjs build`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const image = process.env.START_TEST_DOCKER_IMAGE || 'alpine:3.23';
const native = process.env.START_TEST_NATIVE_BIN || resolve(root, '.cargo-target/debug/start');
const store = mkdtempSync(join(tmpdir(), 'start-issue-202-'));
const env = { ...process.env, START_APP_FOLDER: store, START_DISABLE_AUTO_ISSUE: '1', START_DISABLE_LOG_UPLOAD: '1' };
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
assert.equal(docker('info').status, 0, 'Docker daemon must be available');
const names = [];
try {
  for (const [language, launcher] of [['javascript', ['bun', resolve(root, 'js/src/bin/cli.js')]], ['rust', [native]]]) {
    for (const detached of [false, true]) {
      for (const [index, [command, output, status]] of [
        ["sh -c 'exit 7'; echo after $?", 'after 7', 0],
        ["sh -c 'echo $0 $1' a b", 'a b', 0],
        ["sh -c 'kill -9 $$'; exit $?", '', 137],
      ].entries()) {
        const name = `issue202-${process.pid}-${language}-${detached ? 'd' : 'a'}-${index}`;
        names.push(name);
        const result = spawnSync(launcher[0], [...launcher.slice(1), '-i', 'docker', detached ? '-d' : '-a', '--keep-container', '--image', image, '--shell', 'sh', '--session', name, '--label', 'task=issue202', '--', command], { encoding: 'utf8', env });
        if (!detached) assert.equal(result.status, status, result.stderr + result.stdout);
        else assert.equal(result.status, 0, result.stderr + result.stdout);
        let state;
        // Each command has finite input; observation is bounded to 100 probes.
        for (let attempt = 0; attempt < 100; attempt++) {
          const inspected = docker('inspect', '--format', '{{json .State}}', name);
          assert.equal(inspected.status, 0, inspected.stderr);
          state = JSON.parse(inspected.stdout);
          if (!state.Running) break;
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.equal(state.Running, false, 'command must complete within bounded observation');
        assert.equal(state.ExitCode, status);
        const logs = docker('logs', name);
        assert.equal(logs.status, 0);
        if (output) assert.ok(logs.stdout.includes(output), logs.stdout);
        const labels = JSON.parse(docker('inspect', '--format', '{{json .Config.Labels}}', name).stdout);
        assert.equal(labels.task, 'issue202');
        assert.equal(labels['start-command.session'], name);
        assert.ok(labels['start-command.uuid']);
        let stored;
        for (let attempt = 0; attempt < 100; attempt++) {
          const query = spawnSync(launcher[0], [...launcher.slice(1), '--status', name, '--output-format', 'json'], { encoding: 'utf8', env });
          assert.equal(query.status, 0, query.stderr);
          stored = JSON.parse(query.stdout);
          if (stored.status === 'executed') break;
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.equal(stored.exitCode, status);
        console.log(JSON.stringify({ language, detached, command, expectedExit: status, actualExit: state.ExitCode, storedExit: stored.exitCode, output: logs.stdout.trim(), labels }));
      }
    }
  }
} finally {
  for (const name of names) docker('rm', '-f', name);
  rmSync(store, { recursive: true, force: true });
}
