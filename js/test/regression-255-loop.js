/**
 * Issue #255: the `--use-formal-ai` task loop against the offline Formal AI
 * stand-in, which replays receipts captured from the real runtime
 * (test/fixtures/formal-ai/receipts.json) plus synthetic failure scenarios.
 * Real tools run in temporary directories; nothing touches the network.
 */
const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('fs');
const path = require('path');
const { resolveBounds, EXIT } = require('../src/lib/formal-ai-policy');
const { createClient } = require('../src/lib/formal-ai-client');
const { runFormalAiTask } = require('../src/lib/formal-ai');
const {
  createFakeServer,
  receipts,
} = require('./fixtures/formal-ai/replay.cjs');
const {
  cleanup,
  fakeBin,
  populate,
  receiptFixture,
  sink,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const { AbortController } = globalThis;
const posix = process.platform !== 'win32';

let server;
let baseUrl;
const dirs = [];

beforeAll(async () => {
  server = createFakeServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.close();
  cleanup(...dirs);
});

function fixture() {
  const dir = receiptFixture();
  dirs.push(dir);
  return dir;
}

/** Run one request through the real loop and client. */
async function run(request, options = {}) {
  const cwd = options.cwd || fixture();
  const bounds = { ...resolveBounds({}), ...options.bounds };
  const deadline = options.deadline || Date.now() + bounds.timeoutMs;
  const stdout = sink();
  const stderr = sink();
  const notes = [];
  const client = createClient({ baseUrl, bounds, deadline });
  const sent = [];
  const recording = {
    async complete(messages, opts) {
      sent.push(JSON.parse(JSON.stringify(messages)));
      return client.complete(messages, opts);
    },
  };
  const before = snapshot(cwd);
  const evidence = await runFormalAiTask({
    request,
    cwd,
    env: options.env || { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    bounds,
    client: recording,
    deadline,
    signal: options.signal,
    io: {
      stdout,
      stderr,
      note: (text) => {
        notes.push(text);
        if (options.onNote) {
          options.onNote(text);
        }
      },
    },
  });
  return {
    cwd,
    before,
    after: snapshot(cwd),
    evidence,
    outcome: evidence.outcome,
    tools: evidence.steps.filter((s) => s.kind === 'tool'),
    stdout: stdout.text(),
    stderr: stderr.text(),
    notes,
    sent,
    requests: client.requests,
  };
}

const lines = (text) => text.split('\n').filter(Boolean).sort();

describe('--use-formal-ai receipts (#255)', () => {
  it('every captured request replays to its captured outcome', async () => {
    for (const receipt of receipts) {
      const result = await run(receipt.request, {
        bounds: { effects: receipt.effects },
      });
      expect({
        request: receipt.request,
        effects: receipt.effects,
        status: result.outcome.status,
        exitCode: result.outcome.exitCode,
        tools: result.tools.map((t) => [
          t.command,
          t.decision,
          t.exitCode ?? null,
        ]),
      }).toEqual({
        request: receipt.request,
        effects: receipt.effects,
        status: receipt.outcome.status,
        exitCode: receipt.outcome.exitCode,
        tools: receipt.tools.map((t) => [t.command, t.decision, t.exitCode]),
      });
    }
  });
});

describe('--use-formal-ai reads (#255)', () => {
  it.skipIf(!posix)(
    'lists a directory for paraphrased requests without changing it',
    async () => {
      for (const request of [
        'print list of files in current directory',
        'what files are in this folder?',
        'ls -la',
      ]) {
        const result = await run(request);
        expect(result.outcome.status).toBe('completed');
        expect(result.outcome.exitCode).toBe(0);
        expect(result.outcome.message).toContain('no file changed');
        expect(result.outcome.remainingObligations).toEqual([]);
        for (const name of fs.readdirSync(result.cwd)) {
          expect(result.stdout).toContain(name);
        }
        expect(result.after).toEqual(result.before);
      }
    }
  );

  it.skipIf(!posix)(
    'lists a novel directory with spaces and Unicode, matching an independent listing',
    async () => {
      const cwd = populate(tempDir('novel'), {
        'Ωmega file.txt': 'x',
        '日本語 ノート.md': 'y',
        'two  spaces': null,
        '-dash-first': 'z',
        'émoji 🎉.txt': '',
      });
      dirs.push(cwd);
      const result = await run('print list of files in current directory', {
        cwd,
      });
      expect(result.outcome.exitCode).toBe(0);
      expect(result.tools.map((t) => t.argv)).toEqual([['ls']]);
      // Independent comparison: the tool's real output against readdir.
      expect(lines(result.stdout)).toEqual(fs.readdirSync(cwd).sort());
      // Formal AI received exactly that output as untrusted data.
      const toolMessage = result.sent[1].find((m) => m.role === 'tool');
      expect(toolMessage.content).toContain('<untrusted_context>');
      expect(toolMessage.content).toContain('日本語 ノート.md');
      expect(result.after).toEqual(result.before);
    }
  );

  it.skipIf(!posix)('lists a named subdirectory', async () => {
    const result = await run('list files in docs');
    expect(result.outcome.exitCode).toBe(0);
    expect(result.stdout).toBe('guide.md\n');
  });

  it.skipIf(!posix)(
    'reports a missing path with the tool’s real status',
    async () => {
      for (const request of [
        'list files in missing-dir',
        // Formal AI 0.355.27 reads "corrent" as a path (reported upstream);
        // start reports that truthfully instead of guessing.
        'print list of files in corrent directory',
      ]) {
        const result = await run(request);
        expect(result.outcome.status).toBe('completed');
        expect(result.outcome.exitCode).toBe(2);
        expect(result.outcome.message).toContain('exited with 2');
        expect(result.outcome.remainingObligations).toEqual([
          'the last tool call failed',
        ]);
        expect(result.stderr).toContain('No such file or directory');
        expect(result.after).toEqual(result.before);
      }
    }
  );

  it.skipIf(!posix)(
    'keeps malicious file contents as data and neither obeys nor forwards a fake status',
    async () => {
      const result = await run('show contents of notes.txt');
      expect(result.outcome.exitCode).toBe(0);
      expect(result.tools.map((t) => t.command)).toEqual(['cat notes.txt']);
      expect(result.after).toEqual(result.before);
      const toolMessage = result.sent[1].find((m) => m.role === 'tool');
      expect(toolMessage.content.match(/<\/?untrusted_context>/g)).toEqual([
        '<untrusted_context>',
        '</untrusted_context>',
      ]);
      expect(toolMessage.content).toContain('[tag removed]');
    }
  );

  it.skipIf(!posix)(
    'never presents a read as a completed deletion',
    async () => {
      // Formal AI 0.355.27 answers "delete all files" with `ls` and claims
      // success (reported upstream); start reports what really happened.
      const result = await run('delete all files');
      expect(result.tools.map((t) => t.command)).toEqual(['ls']);
      expect(result.outcome.message).toBe(
        'finished after 1 tool call(s); no file changed'
      );
      expect(result.after).toEqual(result.before);
    }
  );

  it.skipIf(!posix)('caps tool output', async () => {
    const result = await run('print list of files in current directory', {
      bounds: { maxOutputBytes: 8 },
    });
    expect(result.stdout.length).toBeLessThanOrEqual(8);
    expect(result.tools[0].truncated).toBe(true);
    expect(result.notes.join('\n')).toContain(
      'output truncated at START_FORMAL_AI_MAX_OUTPUT_BYTES=8'
    );
    expect(result.sent[1].at(-1).content).toContain(
      '[output truncated by start]'
    );
  });
});

describe('--use-formal-ai refusals and unsupported requests (#255)', () => {
  it('fails explicitly when Formal AI does not understand', async () => {
    for (const request of [
      'book me a flight to Paris',
      'an request nobody recorded',
    ]) {
      const result = await run(request);
      expect(result.outcome.status).toBe('unsupported');
      expect(result.outcome.exitCode).toBe(EXIT.UNSUPPORTED);
      expect(result.tools).toEqual([]);
      expect(result.after).toEqual(result.before);
    }
  });

  it('refuses shell syntax Formal AI passes through', async () => {
    const result = await run('ls; rm -rf ~');
    expect(result.outcome.status).toBe('refused');
    expect(result.outcome.exitCode).toBe(EXIT.REFUSED);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      command: 'ls; rm -rf ~',
      decision: 'refused',
    });
    expect(result.tools[0].exitCode).toBeUndefined();
    expect(result.after).toEqual(result.before);
  });

  it.skipIf(!posix)('refuses changes in read-only mode', async () => {
    const result = await run('create a directory named build');
    expect(result.outcome.exitCode).toBe(EXIT.REFUSED);
    expect(result.outcome.message).toContain('effect mode is read-only');
    expect(result.tools.map((t) => [t.command, t.decision])).toEqual([
      ['test ! -e build', 'allowed'],
      ['mkdir build', 'refused'],
    ]);
    expect(fs.existsSync(path.join(result.cwd, 'build'))).toBe(false);
    expect(result.after).toEqual(result.before);
  });

  it('refuses a change to a target it never observed', async () => {
    const result = await run('synthetic: overwrite without looking', {
      bounds: { effects: 'workspace-write' },
    });
    expect(result.outcome.exitCode).toBe(EXIT.REFUSED);
    expect(result.outcome.message).toContain('was not observed');
    expect(result.after).toEqual(result.before);
  });

  it('refuses a change outside the working directory', async () => {
    const result = await run('synthetic: write outside', {
      bounds: { effects: 'workspace-write' },
    });
    expect(result.outcome.exitCode).toBe(EXIT.REFUSED);
    expect(result.outcome.message).toContain('outside the working directory');
    expect(fs.existsSync(path.join(result.cwd, '..', 'escape.txt'))).toBe(
      false
    );
  });

  it('rejects a tool start does not offer', async () => {
    const result = await run('synthetic: call an unknown tool');
    expect(result.outcome.status).toBe('protocol-error');
    expect(result.outcome.exitCode).toBe(EXIT.PROTOCOL);
    expect(result.tools).toEqual([]);
  });

  it('reports a failing runtime after bounded retries', async () => {
    const result = await run('synthetic: server error', {
      bounds: { maxRetries: 2 },
    });
    expect(result.outcome.status).toBe('protocol-error');
    expect(result.outcome.exitCode).toBe(EXIT.PROTOCOL);
    expect(result.outcome.message).toBe(
      'Formal AI returned HTTP 500 (after 2 retries)'
    );
    expect(result.requests).toBe(3);
  });
});

describe('--use-formal-ai changes (#255)', () => {
  it.skipIf(!posix)(
    'observes, changes and reads back in workspace-write mode',
    async () => {
      const result = await run('create a directory named build', {
        bounds: { effects: 'workspace-write' },
      });
      expect(result.outcome).toMatchObject({
        status: 'completed',
        exitCode: 0,
        message: 'finished after 3 tool call(s); added build',
      });
      const mkdir = result.tools.find((t) => t.command === 'mkdir build');
      expect(mkdir.effect).toBe('write');
      expect(mkdir.verification).toEqual({
        verified: true,
        detail: 'readback confirmed mkdir build',
      });
      expect(fs.statSync(path.join(result.cwd, 'build')).isDirectory()).toBe(
        true
      );
      // Unrelated content is untouched.
      const { build, ...rest } = result.after;
      expect(build).toBeDefined();
      expect(Object.keys(rest).sort()).toEqual(
        Object.keys(result.before).sort()
      );
      for (const [name, value] of Object.entries(result.before)) {
        if (name !== '.' && !value.startsWith('dir')) {
          expect(rest[name]).toBe(value);
        }
      }
    }
  );

  it.skipIf(!posix)(
    'does not trust an exit status the readback contradicts',
    async () => {
      const bin = fakeBin({ mkdir: 'exit 0' });
      dirs.push(bin);
      const result = await run('synthetic: unverified mkdir', {
        bounds: { effects: 'workspace-write' },
        env: { PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.outcome.status).toBe('unverified');
      expect(result.outcome.exitCode).toBe(EXIT.PROTOCOL);
      expect(result.outcome.message).toContain('readback failed: out');
    }
  );
});

describe('--use-formal-ai failures and bounds (#255)', () => {
  it.skipIf(!posix)('reports a missing tool as 127', async () => {
    const bin = fakeBin({});
    dirs.push(bin);
    const result = await run('synthetic: run a missing tool', {
      env: { PATH: bin },
    });
    expect(result.outcome.exitCode).toBe(127);
    expect(result.tools[0]).toMatchObject({
      exitCode: 127,
      spawnError: 'ENOENT',
    });
  });

  it('stops at the step budget', async () => {
    const result = await run('synthetic: loop forever', {
      bounds: { maxSteps: 3 },
    });
    expect(result.outcome.status).toBe('budget-exhausted');
    expect(result.outcome.exitCode).toBe(EXIT.BUDGET);
    expect(result.tools).toHaveLength(3);
  });

  it('stops at the time budget', async () => {
    const result = await run('print list of files in current directory', {
      deadline: Date.now() - 1,
    });
    expect(result.outcome.exitCode).toBe(EXIT.BUDGET);
    expect(result.tools).toEqual([]);
  });

  it.skipIf(!posix)('stops a tool at its time limit', async () => {
    const bin = fakeBin({ cat: 'exec sleep 30' });
    dirs.push(bin);
    const started = Date.now();
    const result = await run('synthetic: read slowly', {
      bounds: { toolTimeoutMs: 300 },
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.outcome.status).toBe('budget-exhausted');
    expect(result.outcome.exitCode).toBe(EXIT.BUDGET);
    expect(result.tools[0].timedOut).toBe(true);
  });

  it.skipIf(!posix)(
    'cancels the running tool and reports the signal',
    async () => {
      const bin = fakeBin({ cat: 'exec sleep 30' });
      dirs.push(bin);
      for (const [reason, code] of [
        ['SIGTERM', 143],
        ['SIGINT', 130],
      ]) {
        const controller = new AbortController();
        const started = Date.now();
        const result = await run('synthetic: read slowly', {
          env: { PATH: `${bin}:${process.env.PATH}` },
          signal: controller.signal,
          onNote: (text) => {
            if (text === '$ cat slow.txt') {
              setTimeout(() => controller.abort(reason), 100);
            }
          },
        });
        expect(Date.now() - started).toBeLessThan(10000);
        expect(result.outcome).toMatchObject({
          status: 'cancelled',
          exitCode: code,
        });
        expect(result.outcome.remainingObligations).toEqual([
          'the task was interrupted; later steps did not run',
        ]);
      }
    }
  );
});
