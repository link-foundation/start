#!/usr/bin/env bun
/**
 * Structural invariants for every GitHub Actions workflow (issue #158).
 *
 * These guard the CI/CD properties that silently regressed before: a job with
 * no timeout, a workflow-level `concurrency` block that cancels a started
 * release, a bare `always()` that keeps work running after cancellation, a
 * missing aggregate status job that lets a red run look green, and coverage
 * gates that swallow their own failures.
 *
 * The Rust suite mirrors these checks in `rust/tests/ci_workflow_invariants.rs`.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { readdirSync, readFileSync } = require('fs');
const { join, resolve } = require('path');

const workflowDir = resolve(__dirname, '..', '..', '.github', 'workflows');
const repoRoot = resolve(__dirname, '..', '..');

// Jobs that push commits, tags, releases or packages. They must share one
// repository-wide concurrency group so two writers never run at once.
const WRITER_JOBS = new Set([
  'release',
  'instant-release',
  'changeset-pr',
  'auto-release',
  'manual-release',
]);
const MAIN_WRITER_GROUP = 'main-writer-${{ github.repository }}-main';

function listWorkflows() {
  return readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

function readWorkflow(name) {
  return readFileSync(join(workflowDir, name), 'utf8').replaceAll('\r\n', '\n');
}

/** Split a workflow into `{ name, body }` job blocks using indentation. */
function parseJobs(workflow) {
  const lines = workflow.split('\n');
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  assert.notStrictEqual(jobsIndex, -1, 'workflow has no jobs: block');

  const jobs = [];
  for (let index = jobsIndex + 1; index < lines.length; index++) {
    const header = lines[index].match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (!header) {
      continue;
    }
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(line) || /^[a-zA-Z]/.test(line)) {
        break;
      }
      body.push(line);
    }
    jobs.push({ name: header[1], body: body.join('\n') });
  }
  return jobs;
}

/** Value of a key inside a job body, at any indentation depth. */
function jobKey(body, key, indent = 4) {
  const match = body.match(new RegExp(`^ {${indent}}${key}:[ \\t]*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

/** Value of a key inside the job's `concurrency:` block. */
function concurrencyKey(body, key) {
  return jobKey(body, key, 6);
}

const workflows = listWorkflows();

describe('CI workflow invariants', () => {
  it('finds every workflow file', () => {
    assert.ok(workflows.length >= 4, `only found ${workflows.join(', ')}`);
    for (const expected of ['js.yml', 'rust.yml', 'security.yml', 'links.yml']) {
      assert.ok(workflows.includes(expected), `missing ${expected}`);
    }
  });

  it('declares a least-privilege default permission set', () => {
    for (const name of workflows) {
      const workflow = readWorkflow(name);
      assert.match(
        workflow,
        /^permissions:\n {2}contents: read$/m,
        `${name} must default to read-only contents permission`
      );
    }
  });

  it('gives every job a timeout', () => {
    for (const name of workflows) {
      for (const job of parseJobs(readWorkflow(name))) {
        assert.ok(
          jobKey(job.body, 'timeout-minutes'),
          `${name}: job "${job.name}" has no timeout-minutes`
        );
      }
    }
  });

  it('never puts concurrency at workflow level', () => {
    for (const name of workflows) {
      assert.doesNotMatch(
        readWorkflow(name),
        /^concurrency:$/m,
        `${name}: workflow-level concurrency would also cancel started writers`
      );
    }
  });

  it('gives every job its own concurrency group', () => {
    for (const name of workflows) {
      for (const job of parseJobs(readWorkflow(name))) {
        if (job.name === 'pipeline-status') {
          continue;
        }
        const group = concurrencyKey(job.body, 'group');
        assert.ok(group, `${name}: job "${job.name}" has no concurrency group`);
      }
    }
  });

  it('makes writers non-cancellable and read-only checks cancellable', () => {
    for (const name of workflows) {
      for (const job of parseJobs(readWorkflow(name))) {
        const group = concurrencyKey(job.body, 'group');
        if (!group) {
          continue;
        }
        const cancel = concurrencyKey(job.body, 'cancel-in-progress');
        if (WRITER_JOBS.has(job.name)) {
          assert.strictEqual(
            group,
            MAIN_WRITER_GROUP,
            `${name}: writer "${job.name}" must use the shared main-writer group`
          );
          assert.strictEqual(
            cancel,
            'false',
            `${name}: writer "${job.name}" must not be cancellable`
          );
        } else {
          assert.ok(
            group.startsWith('check-'),
            `${name}: check "${job.name}" must use a check-* group, got ${group}`
          );
          assert.strictEqual(
            cancel,
            'true',
            `${name}: superseded check "${job.name}" should be cancelled`
          );
        }
      }
    }
  });

  it('uses !cancelled() rather than always() outside the status job', () => {
    for (const name of workflows) {
      for (const job of parseJobs(readWorkflow(name))) {
        if (job.name === 'pipeline-status') {
          continue;
        }
        assert.doesNotMatch(
          job.body,
          /always\(\)/,
          `${name}: job "${job.name}" uses always(); use !cancelled() so cancellation propagates`
        );
      }
    }
  });

  it('aggregates every job into a pipeline-status gate', () => {
    for (const name of workflows) {
      const jobs = parseJobs(readWorkflow(name));
      const status = jobs.find((job) => job.name === 'pipeline-status');
      assert.ok(status, `${name}: no pipeline-status job`);
      assert.match(
        status.body,
        /if: always\(\)/,
        `${name}: pipeline-status must run even when jobs are cancelled`
      );
      for (const job of jobs) {
        if (job.name === 'pipeline-status') {
          continue;
        }
        assert.match(
          status.body,
          new RegExp(`(^|[\\s\\[,])${job.name}([\\s\\],]|$)`, 'm'),
          `${name}: pipeline-status does not depend on "${job.name}"`
        );
      }
    }
  });

  it('configures git before checkout so no init hints are printed', () => {
    for (const name of workflows) {
      const workflow = readWorkflow(name);
      assert.match(workflow, /GIT_CONFIG_COUNT: '1'/, `${name}`);
      assert.match(workflow, /GIT_CONFIG_KEY_0: init\.defaultBranch/, `${name}`);
      assert.match(workflow, /GIT_CONFIG_VALUE_0: main/, `${name}`);
    }
  });

  it('never swallows a failing command in a quality gate', () => {
    for (const name of workflows) {
      const workflow = readWorkflow(name);
      for (const [index, line] of workflow.split('\n').entries()) {
        // `|| true` on a `grep` that is allowed to find nothing is fine; the
        // regression was `... | tee coverage.txt || true`, which hid failing
        // tests from the coverage job.
        const hidesAGate = /\btee\b|\bbun run\b|\bcargo\b|\bnpm run\b/.test(line);
        if (
          line.includes('|| true') &&
          hidesAGate &&
          !line.trimStart().startsWith('#')
        ) {
          assert.fail(
            `${name}:${index + 1} uses "|| true", which hides failures: ${line.trim()}`
          );
        }
      }
    }
  });

  it('references only helper scripts that exist', () => {
    const pattern = /(?:bash|node|bun)\s+(scripts\/[A-Za-z0-9._/-]+)/g;
    for (const name of workflows) {
      const workflow = readWorkflow(name);
      for (const match of workflow.matchAll(pattern)) {
        const scriptPath = join(repoRoot, match[1]);
        assert.doesNotThrow(
          () => readFileSync(scriptPath),
          `${name} references missing ${match[1]}`
        );
      }
    }
  });

  it('parses coverage through the tested helper, not an inline grep', () => {
    const js = readWorkflow('js.yml');
    assert.doesNotMatch(
      js,
      /grep -oP '\\d\+\\\.\\d\+\(\?=%\)'/,
      'the inline coverage grep never matched Bun output (issue #158)'
    );
    assert.match(js, /scripts\/check-js-coverage\.mjs/);
    assert.doesNotMatch(
      js,
      /Could not determine coverage, skipping check/,
      'an unparsable coverage report must fail, not skip'
    );
  });
});
