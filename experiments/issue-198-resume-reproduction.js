#!/usr/bin/env node
/** Minimal red/green reproduction, optionally using an earlier committed module. */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const filename = path.resolve(__dirname, '../js/src/lib/execution-resume.js');
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
let resume;
if (baseline) {
  const source = execFileSync('git', ['show', `${baseline}:js/src/lib/execution-resume.js`], { encoding: 'utf8' });
  const earlier = new Module(filename, module);
  earlier.filename = filename;
  earlier.paths = Module._nodeModulePaths(path.dirname(filename));
  earlier._compile(source, filename);
  resume = earlier.exports;
} else {
  resume = require(filename);
}
const record = { uuid: 'repro-198', command: 'printf original', options: {
  isolated: 'docker', isolationMode: 'detached', sessionName: 'box', commandHandoff: true,
} };
const { SessionState } = require('../js/src/lib/session-probe');
const plan = resume.buildResumePlan(record, 'printf replacement', { state: SessionState.STOPPED, alive: false });
console.log(JSON.stringify({ baseline: baseline || 'working tree', mode: plan.mode, commands: plan.steps.map((s) => s.args[0]) }, null, 2));
assert.equal(plan.mode, resume.ResumeMode.DOCKER_START, 'A handoff-capable container must not snapshot its writable layer');
assert.ok(!plan.steps.some((step) => step.args[0] === 'commit'));
