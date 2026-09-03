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

/** Split a job body into individual `- ...` step blocks. */
function parseSteps(body) {
  const lines = body.split('\n');
  const steps = [];
  let current = null;
  let indent = 0;
  for (const line of lines) {
    const start = line.match(/^(\s*)-\s/);
    if (start && (current === null || start[1].length === indent)) {
      if (current) {
        steps.push(current.join('\n'));
      }
      current = [line];
      indent = start[1].length;
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  if (current) {
    steps.push(current.join('\n'));
  }
  return steps;
}

/** True when line `index` of `workflow` sits inside a `run:` block. */
function inRunBlock(workflow, index) {
  const lines = workflow.split('\n');
  const line = lines[index];
  if (/^\s*(- )?run:/.test(line)) {
    return true;
  }
  const indent = line.length - line.trimStart().length;
  if (!line.trim()) {
    return false;
  }
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const previous = lines[cursor];
    if (!previous.trim()) {
      continue;
    }
    const previousIndent = previous.length - previous.trimStart().length;
    if (previousIndent >= indent) {
      continue;
    }
    return /^\s*(- )?run:\s*[|>]/.test(previous);
  }
  return false;
}

const workflows = listWorkflows();

describe('CI workflow invariants', () => {
  it('finds every workflow file', () => {
    assert.ok(workflows.length >= 4, `only found ${workflows.join(', ')}`);
    for (const expected of [
      'js.yml',
      'rust.yml',
      'security.yml',
      'links.yml',
    ]) {
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
      assert.match(
        workflow,
        /GIT_CONFIG_KEY_0: init\.defaultBranch/,
        `${name}`
      );
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
        const hidesAGate = /\btee\b|\bbun run\b|\bcargo\b|\bnpm run\b/.test(
          line
        );
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

  // --- issue #168: false negatives the pipeline could not see -------------

  it('lints and audits the workflows themselves', () => {
    assert.ok(
      workflows.includes('workflows.yml'),
      'no workflows.yml: nothing ran actionlint or zizmor over .github/workflows'
    );
    const meta = readWorkflow('workflows.yml');
    assert.match(
      meta,
      /rhysd\/actionlint/,
      'workflows.yml must run actionlint'
    );
    assert.match(meta, /zizmor/, 'workflows.yml must run zizmor');
    for (const config of ['zizmor.yml', 'actionlint.yaml']) {
      assert.doesNotThrow(
        () => readFileSync(join(repoRoot, '.github', config)),
        `missing .github/${config}`
      );
    }
  });

  it('never interpolates untrusted context into a run: block', () => {
    // actionlint/zizmor call this template-injection: the value is attacker
    // controlled on a fork PR and is pasted into the shell verbatim.
    const untrusted =
      /\$\{\{\s*github\.(head_ref|base_ref|event\.[A-Za-z0-9_.]*(title|body|name|label|ref))/;
    for (const name of workflows) {
      for (const [index, line] of readWorkflow(name).split('\n').entries()) {
        if (line.trimStart().startsWith('#')) {
          continue;
        }
        if (inRunBlock(readWorkflow(name), index) && untrusted.test(line)) {
          assert.fail(
            `${name}:${index + 1} interpolates untrusted context into run:; pass it through env: instead - ${line.trim()}`
          );
        }
      }
    }
  });

  it('does not persist credentials on read-only checkouts', () => {
    for (const name of workflows) {
      for (const job of parseJobs(readWorkflow(name))) {
        if (WRITER_JOBS.has(job.name)) {
          continue;
        }
        for (const step of parseSteps(job.body)) {
          if (!/uses:\s*actions\/checkout/.test(step)) {
            continue;
          }
          assert.match(
            step,
            /persist-credentials:\s*false/,
            `${name}: read-only job "${job.name}" checks out with the token left in .git/config`
          );
        }
      }
    }
  });

  it('pins third-party actions to a commit hash', () => {
    // Trusted first-party namespaces may use a moving tag; anything else is a
    // mutable ref in a job that can hold write credentials.
    const trusted =
      /^(actions|github|docker|astral-sh|lycheeverse|zizmorcore|changesets)\//;
    for (const name of workflows) {
      const workflow = readWorkflow(name);
      for (const match of workflow.matchAll(/uses:\s*(\S+)/g)) {
        const reference = match[1];
        if (reference.startsWith('docker://') || reference.startsWith('./')) {
          continue;
        }
        if (trusted.test(reference)) {
          continue;
        }
        assert.match(
          reference,
          /@[0-9a-f]{40}$/,
          `${name}: third-party action ${reference} must be pinned to a commit hash`
        );
      }
    }
  });

  it('audits both dependency graphs for advisories', () => {
    const security = readWorkflow('security.yml');
    const jobs = parseJobs(security).map((job) => job.name);
    for (const job of ['cargo-audit', 'npm-audit']) {
      assert.ok(jobs.includes(job), `security.yml has no ${job} job`);
    }
    assert.match(
      security,
      /cargo audit/,
      'cargo-audit job must run cargo audit'
    );
    assert.match(security, /npm audit/, 'npm-audit job must run npm audit');
  });

  it('lints the repository-level scripts/ directory', () => {
    // js/eslint.config.mjs has js/ as its base path, so `eslint .` run from js/
    // silently skipped scripts/ - the release automation (issue #168).
    assert.doesNotThrow(
      () => readFileSync(join(repoRoot, 'eslint.config.mjs')),
      'no repository-level eslint.config.mjs: scripts/ would go unlinted'
    );
    const js = readWorkflow('js.yml');
    assert.match(js, /lint:scripts/, 'js.yml must lint scripts/');
    assert.match(
      js,
      /format:check:scripts/,
      'js.yml must format-check scripts/'
    );
  });

  it('scopes CodeQL to this project\u2019s own code', () => {
    // Without this, CodeQL extracts the third-party bundles archived under
    // dev/log/ as evidence and fails pull requests on other projects'
    // findings (issue #168: js/redos in the vendored use-m snapshot).
    const security = readWorkflow('security.yml');
    const codeqlJob = parseJobs(security).find((job) => job.name === 'codeql');
    assert.ok(codeqlJob, 'security.yml has no codeql job');
    const configPath = jobKey(codeqlJob.body, 'config-file', 10);
    assert.ok(
      configPath,
      'the CodeQL init step must pass config-file, or archived evidence is analysed'
    );
    const config = readFileSync(join(repoRoot, configPath), 'utf8');
    assert.match(
      config,
      /^paths-ignore:/m,
      `${configPath} has no paths-ignore`
    );
    assert.match(
      config,
      /^\s*-\s*dev\/log\s*$/m,
      `${configPath} must exclude dev/log`
    );
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
