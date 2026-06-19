#!/usr/bin/env bun
/**
 * Regression tests for issue #138:
 * "Detached docker session log omits the image-preparation phase
 *  (docker pull / dind boot) — $ does not preserve the full log in one file"
 *
 * When a command is launched with `--isolated docker`, the image-preparation
 * phase (the `docker pull`) used to be printed to the console only and never
 * written to the session log file. An operator tailing the session log (e.g.
 * via `$ --upload-log <uuid>`) during a multi-GB pull would see only the
 * header — the minutes spent pulling left no trace in the log.
 *
 * The fix tees the pull output into the session log and brackets it with
 * `Preparing image …` / `Image ready (<duration>)` markers so the single
 * session-log file is a gap-free record of everything that ran.
 *
 * Reference: https://github.com/link-foundation/start/issues/138
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  dockerPullImage,
  dockerImageExists,
  isDockerAvailable,
} = require('../src/lib/docker-utils');

function makeTempLog() {
  const logPath = path.join(
    os.tmpdir(),
    `start-138-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
  );
  fs.writeFileSync(logPath, '=== Start Command Log ===\n');
  return logPath;
}

describe('docker pull is recorded in the session log (issue #138)', () => {
  // Silence the virtual-command console output during these tests.
  let originalLog;
  let originalError;
  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    console.log = () => {};
    console.error = () => {};
  });
  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it('writes prep markers and the docker error into the log on a failed pull', () => {
    if (!isDockerAvailable()) {
      console.log = originalLog;
      console.log('  Skipping: docker daemon not available');
      return;
    }

    const logPath = makeTempLog();
    try {
      // An invalid reference format fails fast without any network access.
      const result = dockerPullImage('invalid..badname', logPath);
      const contents = fs.readFileSync(logPath, 'utf8');

      assert.strictEqual(
        result.success,
        false,
        'pull of invalid ref must fail'
      );
      assert.ok(
        contents.includes('Preparing image invalid..badname'),
        'log must contain the "Preparing image …" start marker'
      );
      assert.ok(
        contents.includes('Image preparation failed'),
        'log must contain the failure marker with elapsed duration'
      );
      // The docker error itself (teed pull output) must be in the log, not just
      // on the console — this is the core of issue #138.
      assert.ok(
        contents.includes('invalid reference format'),
        'log must capture the teed docker pull error output'
      );
    } finally {
      fs.rmSync(logPath, { force: true });
    }
  });

  it('tees real pull output and an "Image ready" marker into the log', () => {
    if (!isDockerAvailable()) {
      console.log = originalLog;
      console.log('  Skipping: docker daemon not available');
      return;
    }

    // Use a tiny image and force a real pull by removing it first.
    const image = 'hello-world:latest';
    try {
      require('child_process').execSync(`docker rmi ${image}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // image not present locally — that's fine, the pull below still runs
    }

    const logPath = makeTempLog();
    try {
      const result = dockerPullImage(image, logPath);
      if (!result.success) {
        // No network in this environment — cannot exercise the success path.
        console.log = originalLog;
        console.log('  Skipping: docker pull failed (no registry access?)');
        return;
      }

      const contents = fs.readFileSync(logPath, 'utf8');
      assert.ok(
        contents.includes(`Preparing image ${image}`),
        'log must contain the "Preparing image …" start marker'
      );
      assert.ok(
        /Image ready \(\d+\.\d+s\)/.test(contents),
        'log must contain "Image ready (<duration>)" marker'
      );
      assert.ok(
        contents.includes('Pulling from') ||
          contents.includes('Status:') ||
          contents.includes('Pull complete'),
        'log must capture the teed docker pull progress output'
      );
      assert.ok(
        dockerImageExists(image),
        'image should exist locally after a successful pull'
      );
    } finally {
      fs.rmSync(logPath, { force: true });
    }
  });

  it('does not write prep markers when no logPath is given (backward compat)', () => {
    if (!isDockerAvailable()) {
      console.log = originalLog;
      console.log('  Skipping: docker daemon not available');
      return;
    }

    // Without a logPath, dockerPullImage must still return the {success, output}
    // shape and must not throw. We only assert the contract here.
    const result = dockerPullImage('invalid..badname');
    assert.strictEqual(result.success, false);
    assert.strictEqual(typeof result.output, 'string');
  });
});

describe('runInDocker threads logPath into dockerPullImage (issue #138)', () => {
  it('source passes options.logPath to dockerPullImage', () => {
    const isolationSrc = fs.readFileSync(
      path.join(__dirname, '../src/lib/isolation.js'),
      'utf8'
    );
    assert.ok(
      /dockerPullImage\(options\.image,\s*options\.logPath\)/.test(
        isolationSrc
      ),
      'runInDocker must pass options.logPath to dockerPullImage'
    );
  });

  it('dockerPullImage tees output and writes prep markers in source', () => {
    const dockerUtilsSrc = fs.readFileSync(
      path.join(__dirname, '../src/lib/docker-utils.js'),
      'utf8'
    );
    assert.ok(
      dockerUtilsSrc.includes('Preparing image'),
      'docker-utils must write a "Preparing image …" marker'
    );
    assert.ok(
      dockerUtilsSrc.includes('Image ready'),
      'docker-utils must write an "Image ready (<duration>)" marker'
    );
    assert.ok(
      dockerUtilsSrc.includes('tee -a'),
      'docker-utils must tee docker pull output into the log file'
    );
  });
});
