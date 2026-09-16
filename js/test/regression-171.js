/**
 * Regression tests for issue #171: the "Container kept for investigation" log
 * omits the post-mortem facts docker already has.
 *
 *   171.1 the watcher's single `docker inspect` must also collect
 *         `StartedAt`, `FinishedAt` and `Error`;
 *   171.2 a post-mortem block must be appended whenever the container is kept;
 *   171.3 the removal path must state the same facts in one line;
 *   171.4 signal decoding (`128+n` -> name) lives in one shared helper used by
 *         both the watcher (completion time) and the status formatter.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildDetachedDockerCompletionScript,
  readDockerContainerState,
  recordAttachedDockerPostMortem,
} = require('../src/lib/docker-cleanup');
const {
  DOCKER_STATE_INSPECT_FORMAT,
  buildDockerPostMortemSnippet,
  buildDockerRemovalNoteSnippet,
  buildDockerStateSnippet,
  describeExitCode,
  formatContainerPostMortem,
  formatContainerRemovalNote,
  formatLifetime,
  normalizeDockerTimestamp,
} = require('../src/lib/docker-post-mortem');
const {
  describeExitCode: reExported,
} = require('../src/lib/isolation-log-utils');

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('issue #171.4: one shared exit-code describer', () => {
  it('decodes 128+n into the signal name', () => {
    expect(describeExitCode(137)).toEqual({
      code: 137,
      signal: 'SIGKILL',
      text: '137 (SIGKILL - 128+9)',
    });
    expect(describeExitCode(143).signal).toBe('SIGTERM');
    expect(describeExitCode(139).signal).toBe('SIGSEGV');
  });

  it('leaves ordinary exit codes alone', () => {
    expect(describeExitCode(0)).toEqual({ code: 0, signal: null, text: '0' });
    expect(describeExitCode(1).text).toBe('1');
    expect(describeExitCode(-1).text).toBe('-1');
  });

  it('reports unknown for a non numeric code', () => {
    expect(describeExitCode(null).text).toBe('unknown');
    expect(describeExitCode(undefined).signal).toBeNull();
  });

  it('is re-exported from isolation-log-utils so both callers share it', () => {
    expect(reExported).toBe(describeExitCode);
  });
});

describe('issue #171: docker timestamp and lifetime helpers', () => {
  it('rejects the docker zero-time sentinel', () => {
    expect(normalizeDockerTimestamp('0001-01-01T00:00:00Z')).toBeNull();
    expect(normalizeDockerTimestamp('')).toBeNull();
    expect(normalizeDockerTimestamp('unknown')).toBeNull();
    expect(normalizeDockerTimestamp('<no value>')).toBeNull();
    expect(normalizeDockerTimestamp('2026-09-15T22:21:46.740817278Z')).toBe(
      '2026-09-15T22:21:46.740817278Z'
    );
  });

  it('computes the container lifetime', () => {
    expect(
      formatLifetime(
        '2026-09-15T22:21:40.942007645Z',
        '2026-09-15T22:21:46.740817278Z'
      )
    ).toBe('5.798s');
    expect(formatLifetime('unknown', 'unknown')).toBeNull();
    expect(
      formatLifetime('2026-09-15T22:21:46.000Z', '0001-01-01T00:00:00Z')
    ).toBeNull();
  });
});

describe('issue #171.2: the kept-container log carries the post-mortem', () => {
  it('formats the block in the documented shape', () => {
    const block = formatContainerPostMortem({
      containerName: 'demo',
      exitCode: 137,
      oomKilled: false,
      startedAt: '2026-09-15T22:21:40.942007645Z',
      finishedAt: '2026-09-15T22:21:46.740817278Z',
      error: '',
    });

    expect(block).toContain('=== Container post-mortem ===');
    expect(block).toContain('Exit Code:  137 (SIGKILL - 128+9)');
    expect(block).toContain('OOMKilled:  false');
    expect(block).toContain('StartedAt:  2026-09-15T22:21:40.942007645Z');
    expect(block).toContain('FinishedAt: 2026-09-15T22:21:46.740817278Z');
    expect(block).toContain('Lifetime:   5.798s');
    expect(block).toContain('Error:      (none)');
  });

  it('renders unknown facts instead of empty fields', () => {
    const block = formatContainerPostMortem({
      containerName: 'demo',
      exitCode: null,
      oomKilled: null,
      startedAt: '0001-01-01T00:00:00Z',
      finishedAt: '',
      error: 'OCI runtime create failed',
    });
    expect(block).toContain('Exit Code:  unknown');
    expect(block).toContain('StartedAt:  unknown');
    expect(block).toContain('Lifetime:   unknown');
    expect(block).toContain('Error:      OCI runtime create failed');
  });
});

describe('issue #171.3: the removal path states the same facts', () => {
  it('formats a single line', () => {
    expect(
      formatContainerRemovalNote({
        containerName: 'demo',
        exitCode: 137,
        oomKilled: false,
        startedAt: '2026-09-15T22:21:40.942007645Z',
        finishedAt: '2026-09-15T22:21:46.740817278Z',
      })
    ).toBe(
      'Container removed: demo (exit 137, SIGKILL, lifetime 5.798s, oomKilled=false)\n'
    );
  });
});

describe('issue #171.1: the watcher collects the full state in one inspect', () => {
  it('asks docker for exit code, oom flag and both timestamps', () => {
    expect(DOCKER_STATE_INSPECT_FORMAT).toContain('{{.State.ExitCode}}');
    expect(DOCKER_STATE_INSPECT_FORMAT).toContain('{{.State.OOMKilled}}');
    expect(DOCKER_STATE_INSPECT_FORMAT).toContain('{{.State.StartedAt}}');
    expect(DOCKER_STATE_INSPECT_FORMAT).toContain('{{.State.FinishedAt}}');
  });
});

describe('issue #171: the generated watcher shell writes the facts', () => {
  function runWatcherBody(snippetFactory, dockerState, dockerError) {
    const dir = makeTempDir('watcher-171-');
    const logPath = path.join(dir, 'run.log');
    const snippet = snippetFactory(logPath);
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(
      dockerPath,
      [
        '#!/bin/sh',
        '[ "$1" = "inspect" ] || exit 1',
        'case "$3" in',
        `  *State.Error*) printf '%s\\n' ${JSON.stringify(dockerError || '')} ;;`,
        `  *) printf '%s\\n' ${JSON.stringify(dockerState)} ;;`,
        'esac',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.chmodSync(dockerPath, 0o755);

    spawnSync('/bin/sh', ['-c', snippet], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
      timeout: 20000,
    });
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  }

  it('appends the post-mortem block for a kept container', () => {
    const log = runWatcherBody(
      (logPath) =>
        `${buildDockerStateSnippet('demo')}; ${buildDockerPostMortemSnippet(
          'demo',
          `'${logPath}'`
        )}`,
      '137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z'
    );

    expect(log).toContain('=== Container post-mortem ===');
    expect(log).toContain('Exit Code:  137 (SIGKILL - 128+9)');
    expect(log).toContain('OOMKilled:  false');
    expect(log).toContain('StartedAt:  2026-09-15T22:21:40.942007645Z');
    expect(log).toContain('FinishedAt: 2026-09-15T22:21:46.740817278Z');
    expect(log).toContain('Lifetime:   5.798s');
    expect(log).toContain('Error:      (none)');
  });

  it('appends a one line note for a removed container', () => {
    const log = runWatcherBody(
      (logPath) =>
        `${buildDockerStateSnippet('demo')}; ${buildDockerRemovalNoteSnippet(
          'demo',
          `'${logPath}'`
        )}`,
      '0 false 2026-09-15T22:21:40.000000000Z 2026-09-15T22:21:41.500000000Z'
    );

    expect(log).toContain(
      'Container removed: demo (exit 0, lifetime 1.500s, oomKilled=false)'
    );
  });

  it('survives an inspect failure without writing garbage', () => {
    const dir = makeTempDir('watcher-171-fail-');
    const logPath = path.join(dir, 'run.log');
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, 'docker'),
      ['#!/bin/sh', 'exit 1', ''].join('\n'),
      'utf8'
    );
    fs.chmodSync(path.join(binDir, 'docker'), 0o755);

    const snippet = `${buildDockerStateSnippet(
      'demo'
    )}; ${buildDockerPostMortemSnippet('demo', `'${logPath}'`)}`;
    const result = spawnSync('/bin/sh', ['-c', snippet], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
      timeout: 20000,
    });

    expect(result.status).toBe(0);
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('Exit Code:  -1');
    expect(log).toContain('StartedAt:  unknown');
    expect(log).toContain('Lifetime:   unknown');
    expect(log).not.toContain('0001-01-01');
  });
});

describe('issue #171: the completion script wires the facts into every path', () => {
  it('collects the full state and writes a post-mortem on the kept path', () => {
    const script = buildDetachedDockerCompletionScript(
      'demo',
      'keep-on-fail',
      '/tmp/demo.log'
    );

    expect(script).toContain('{{.State.StartedAt}}');
    expect(script).toContain('{{.State.FinishedAt}}');
    expect(script).toContain('{{.State.Error}}');
    expect(script).toContain('=== Container post-mortem ===');
    expect(script).toContain('Container removed:');
    expect(script).toContain('Container kept for investigation');
  });

  it('writes a post-mortem even when the container is always kept', () => {
    const script = buildDetachedDockerCompletionScript(
      'demo',
      'keep',
      '/tmp/demo.log'
    );
    expect(script).toContain('=== Container post-mortem ===');
    // The only `docker rm -f` left is the copy-paste hint in the kept message.
    expect(script).not.toContain("docker rm -f 'demo' >>");
  });

  it('writes the removal note when the container is always removed', () => {
    const script = buildDetachedDockerCompletionScript(
      'demo',
      'always',
      '/tmp/demo.log'
    );
    expect(script).toContain('Container removed:');
    expect(script).toContain("docker rm -f 'demo' >>");
  });
});

/**
 * A fake `docker` that answers the two `inspect` templates
 * `readDockerContainerState()` issues: the whitespace-separated state line and
 * the free-form `State.Error`.
 */
function withFakeDockerState({ state, error = '' }, fn) {
  const fakeBin = makeTempDir('fake-docker-171-');
  const dockerPath = path.join(fakeBin, 'docker');
  fs.writeFileSync(
    dockerPath,
    [
      '#!/bin/sh',
      '[ "$1" = "inspect" ] || exit 1',
      'case "$3" in',
      `  *State.Error*) printf '%s\\n' ${JSON.stringify(error)} ;;`,
      `  *) printf '%s\\n' ${JSON.stringify(state)} ;;`,
      'esac',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(dockerPath, 0o755);
  const original = process.env.START_DOCKER_BIN;
  process.env.START_DOCKER_BIN = dockerPath;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.START_DOCKER_BIN;
    } else {
      process.env.START_DOCKER_BIN = original;
    }
  }
}

describe('issue #171: the attached path records the same facts', () => {
  it('reads every documented fact in one inspect', () => {
    const state = withFakeDockerState(
      {
        state:
          '137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z',
      },
      () => readDockerContainerState('demo')
    );

    expect(state).toEqual({
      containerName: 'demo',
      exitCode: 137,
      oomKilled: false,
      startedAt: '2026-09-15T22:21:40.942007645Z',
      finishedAt: '2026-09-15T22:21:46.740817278Z',
      error: null,
    });
  });

  it('rejects the zero-time sentinel for a container that never started', () => {
    const state = withFakeDockerState(
      {
        state: '125 false 0001-01-01T00:00:00Z 0001-01-01T00:00:00Z',
        error: 'no such file or directory',
      },
      () => readDockerContainerState('demo')
    );

    expect(state.startedAt).toBeNull();
    expect(state.finishedAt).toBeNull();
    expect(state.error).toBe('no such file or directory');
  });

  it('returns null when the container cannot be inspected at all', () => {
    const fakeBin = makeTempDir('fake-docker-gone-171-');
    const dockerPath = path.join(fakeBin, 'docker');
    fs.writeFileSync(dockerPath, '#!/bin/sh\nexit 1\n', 'utf8');
    fs.chmodSync(dockerPath, 0o755);
    const original = process.env.START_DOCKER_BIN;
    process.env.START_DOCKER_BIN = dockerPath;
    try {
      expect(readDockerContainerState('demo')).toBeNull();
    } finally {
      if (original === undefined) {
        delete process.env.START_DOCKER_BIN;
      } else {
        process.env.START_DOCKER_BIN = original;
      }
    }
  });

  it('appends the post-mortem block to a kept attached run log', () => {
    const dir = makeTempDir('attached-kept-171-');
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, 'output\n', 'utf8');

    const message = recordAttachedDockerPostMortem({
      containerName: 'demo',
      state: {
        exitCode: 137,
        oomKilled: false,
        startedAt: '2026-09-15T22:21:40.942007645Z',
        finishedAt: '2026-09-15T22:21:46.740817278Z',
        error: null,
      },
      logPath,
      removed: false,
    });

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('=== Container post-mortem ===');
    expect(log).toContain('Exit Code:  137 (SIGKILL - 128+9)');
    expect(log).toContain('Lifetime:   5.798s');
    expect(message).toContain('=== Container post-mortem ===');
  });

  it('appends the one line note when the attached container is removed', () => {
    const dir = makeTempDir('attached-removed-171-');
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, 'output\n', 'utf8');

    const message = recordAttachedDockerPostMortem({
      containerName: 'demo',
      state: {
        exitCode: 0,
        oomKilled: false,
        startedAt: '2026-09-15T22:21:40.942007645Z',
        finishedAt: '2026-09-15T22:21:46.740817278Z',
        error: null,
      },
      logPath,
      removed: true,
    });

    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      'Container removed: demo (exit 0, lifetime 5.798s, oomKilled=false)'
    );
    expect(message).toBe(
      '\nContainer removed: demo (exit 0, lifetime 5.798s, oomKilled=false)'
    );
  });

  it('stays silent when docker could not be inspected', () => {
    const dir = makeTempDir('attached-silent-171-');
    const logPath = path.join(dir, 'run.log');
    fs.writeFileSync(logPath, 'output\n', 'utf8');

    expect(
      recordAttachedDockerPostMortem({
        containerName: 'demo',
        state: null,
        logPath,
        removed: false,
      })
    ).toBe('');
    expect(fs.readFileSync(logPath, 'utf8')).toBe('output\n');
  });
});
