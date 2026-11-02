/**
 * Issue #255: `$ --use-formal-ai -- <request>` end to end through the CLI,
 * with an offline Formal AI checkout (test/fixtures/formal-ai) started exactly
 * like a real one. Covers parsing of `--`, option-like text and shell
 * metacharacters, the no-fallback guarantee, logs, evidence and cancellation.
 */
const { describe, it, expect, afterAll } = require('bun:test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');
const { requestText, EVIDENCE_SCHEMA } = require('../src/lib/formal-ai-cli');
const {
  CLI,
  cleanup,
  cliEnv,
  fakeBin,
  fakeCheckout,
  readEvidence,
  readLog,
  receiptFixture,
  sentRequests,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const posix = process.platform !== 'win32';
const dirs = [];
const checkout = fakeCheckout();
const oldCheckout = fakeCheckout({ version: '0.355.26' });
dirs.push(checkout, oldCheckout);

afterAll(() => cleanup(...dirs));

/** Run the CLI in a fresh fixture with an isolated app folder. */
function cli(args, { env = {}, root = tempDir('cli'), cwd } = {}) {
  dirs.push(root);
  const dir = cwd || receiptFixture();
  dirs.push(dir);
  const before = snapshot(dir);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: cliEnv(root, env),
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    ...result,
    root,
    cwd: dir,
    before,
    after: snapshot(dir),
    requests: sentRequests(root),
  };
}

const withRuntime = { START_FORMAL_AI_ROOT: checkout };

describe('--use-formal-ai parsing (#255)', () => {
  it('keeps everything after -- as request text', () => {
    const cases = [
      [
        ['print', 'list', 'of', 'files', 'in', 'current', 'directory'],
        'print list of files in current directory',
      ],
      [['--help'], '--help'],
      [['--isolated', 'docker', 'ls'], '--isolated docker ls'],
      [['ls;', 'rm', '-rf', '~'], 'ls; rm -rf ~'],
      [
        ['ls; rm -rf ~ && echo $(id) | sh > x'],
        'ls; rm -rf ~ && echo $(id) | sh > x',
      ],
      [['--', 'what is', '--version?'], '-- what is --version?'],
    ];
    for (const [words, text] of cases) {
      const result = parseArgs(['--use-formal-ai', '--', ...words]);
      expect(result.wrapperOptions.useFormalAi).toBe(true);
      expect(result.rawCommand).toEqual(words);
      expect(requestText(result.rawCommand)).toBe(text);
      // Option-like request text never becomes a start option.
      expect(result.wrapperOptions.isolated).toBeFalsy();
      expect(result.wrapperOptions.help).toBeFalsy();
    }
  });

  it('is off unless requested', () => {
    expect(parseArgs(['--', 'ls']).wrapperOptions.useFormalAi).toBe(false);
    expect(
      parseArgs(['ls', '--use-formal-ai']).wrapperOptions.useFormalAi
    ).toBe(false);
  });

  it('rejects combinations the experimental mode does not support', () => {
    for (const args of [
      ['--use-formal-ai', '--isolated', 'docker', '--', 'ls'],
      ['--use-formal-ai', '--detached', '--isolated', 'screen', '--', 'ls'],
      ['--use-formal-ai', '--use-command-stream', '--', 'ls'],
    ]) {
      expect(() => parseArgs(args)).toThrow(
        /--use-formal-ai cannot be combined with/
      );
    }
  });
});

describe.skipIf(!posix)('--use-formal-ai never falls back (#255)', () => {
  it('runs nothing without a qualified runtime', () => {
    const cases = [
      [{}, 'needs a Formal AI runtime and has no fallback'],
      [{ START_FORMAL_AI_ROOT: oldCheckout }, 'needs 0.355.27 or newer'],
      [
        { ...withRuntime, START_FORMAL_AI_EXPECTED_REVISION: 'abc123' },
        'not START_FORMAL_AI_EXPECTED_REVISION=abc123',
      ],
      [{ START_FORMAL_AI_URL: 'http://127.0.0.1:9' }, 'cannot be qualified'],
    ];
    for (const [env, message] of cases) {
      // "list files in docs" is also a built-in alias for `ls docs`.
      const result = cli(
        ['--use-formal-ai', '--', 'list', 'files', 'in', 'docs'],
        {
          env,
        }
      );
      expect(result.status).toBe(69);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain(
        'No command was run: --use-formal-ai never falls back to aliases, a shell or an LLM.'
      );
      expect(result.stdout).not.toContain('guide.md');
      expect(result.after).toEqual(result.before);
      expect(fs.existsSync(path.join(result.root, 'logs'))).toBe(false);
    }
  });

  it('rejects an empty, overlong or misconfigured request before starting', () => {
    let result = cli(['--use-formal-ai', '--', 'list', 'files'], {
      env: { ...withRuntime, START_FORMAL_AI_MAX_REQUEST_CHARS: '5' },
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('START_FORMAL_AI_MAX_REQUEST_CHARS is 5');
    result = cli(['--use-formal-ai', '--', 'ls'], {
      env: { ...withRuntime, START_FORMAL_AI_MAX_STEPS: 'many' },
    });
    expect(result.status).toBe(78);
    expect(result.requests).toEqual([]);
  });
});

describe.skipIf(!posix)('--use-formal-ai end to end (#255)', () => {
  it('lists the working directory, leaves it unchanged and keeps evidence', () => {
    const result = cli(
      [
        '--use-formal-ai',
        '--',
        'print',
        'list',
        'of',
        'files',
        'in',
        'current',
        'directory',
      ],
      { env: withRuntime }
    );
    expect(result.status).toBe(0);
    for (const name of fs.readdirSync(result.cwd)) {
      expect(result.stdout).toContain(name);
    }
    expect(result.stdout).toContain(
      '--use-formal-ai -- print list of files in current directory'
    );
    expect(result.stderr).toContain('[formal-ai] runtime: formal-ai 0.355.27');
    expect(result.stderr).toContain('[formal-ai] $ ls');
    expect(result.stderr).toContain(
      '[formal-ai] completed: finished after 1 tool call(s); no file changed'
    );
    expect(result.after).toEqual(result.before);

    // The request went to Formal AI verbatim; read-only mode offers bash and
    // the structured read tool, never the change tools (#258).
    expect(result.requests[0].messages).toEqual([
      { role: 'user', content: 'print list of files in current directory' },
    ]);
    expect(result.requests[0].tools.map((t) => t.function.name)).toEqual([
      'bash',
      'read',
    ]);

    const log = readLog(result.root);
    expect(log).toContain('Mode: --use-formal-ai (experimental)');
    expect(log).toContain('Request: print list of files in current directory');
    expect(log).toContain('Effects: read-only');
    expect(log).toMatch(/Exit Code: 0\n$/);
    const evidence = readEvidence(log);
    expect(evidence).toMatchObject({
      schema: EVIDENCE_SCHEMA,
      request: 'print list of files in current directory',
      effectsMode: 'read-only',
      runtime: {
        source: 'checkout',
        version: '0.355.27',
        entry: 'js/server/main.mjs',
        memory: 'START_FORMAL_AI_MEMORY_PATH',
      },
      effects: { added: [], removed: [], changed: [], complete: true },
      outcome: { status: 'completed', exitCode: 0, remainingObligations: [] },
      formalAiRequests: 2,
    });
    expect(evidence.steps.map((s) => s.kind)).toEqual([
      'response',
      'tool',
      'response',
    ]);
    expect(evidence.steps[1]).toMatchObject({
      command: 'ls',
      argv: ['ls'],
      decision: 'allowed',
      effect: 'read',
      exitCode: 0,
    });

    const db = fs.readFileSync(
      path.join(result.root, 'app', 'executions.lino'),
      'utf8'
    );
    expect(db).toContain('print list of files in current directory');
    expect(db).toContain('formal-ai');
  });

  it('never applies aliases or a shell to the request', () => {
    const home = tempDir('home');
    dirs.push(home);
    fs.writeFileSync(path.join(home, 'canary'), 'keep');
    let result = cli(['--use-formal-ai', '--', 'list', 'files', 'in', 'docs'], {
      env: withRuntime,
    });
    expect(result.requests[0].messages[0].content).toBe('list files in docs');
    expect(result.status).toBe(0);

    result = cli(['--use-formal-ai', '--', 'ls; rm -rf ~'], {
      env: { ...withRuntime, HOME: home },
    });
    expect(result.requests[0].messages[0].content).toBe('ls; rm -rf ~');
    expect(result.status).toBe(77);
    expect(result.stderr).toContain('needs shell syntax start does not run');
    expect(fs.readFileSync(path.join(home, 'canary'), 'utf8')).toBe('keep');
    expect(result.after).toEqual(result.before);
  });

  it('reports unsupported requests explicitly', () => {
    const result = cli(['--use-formal-ai', '--', 'book me a flight to Paris'], {
      env: withRuntime,
    });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain(
      'unsupported: Formal AI did not understand the request; no tool ran'
    );
    expect(result.after).toEqual(result.before);
  });

  it('ends with the signal status and evidence when cancelled', async () => {
    const root = tempDir('cancel');
    const cwd = receiptFixture();
    const bin = fakeBin({ cat: 'exec sleep 30' });
    dirs.push(root, cwd, bin);
    const env = cliEnv(root, {
      ...withRuntime,
      PATH: `${bin}:${process.env.PATH}`,
    });
    const child = spawn(
      process.execPath,
      [CLI, '--use-formal-ai', '--', 'synthetic: read slowly'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.includes('$ cat slow.txt') && !child.signalled) {
          child.signalled = true;
          setTimeout(() => child.kill('SIGTERM'), 200);
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(status).toBe(143);
    const evidence = readEvidence(readLog(root));
    expect(evidence.outcome.status).toBe('cancelled');
    expect(evidence.outcome.exitCode).toBe(143);
  });
});
