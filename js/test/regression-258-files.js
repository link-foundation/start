/**
 * Issue #258: the structured read/edit/write tools of `--use-formal-ai`
 * (src/lib/formal-ai-files.js) and their loop integration, offline.
 */
const { describe, it, expect, afterAll } = require('bun:test');
const fs = require('fs');
const path = require('path');
const {
  BOUND_DEFAULTS,
  resolveBounds,
  EXIT,
} = require('../src/lib/formal-ai-policy');
const files = require('../src/lib/formal-ai-files');
const { readFrame, readFrameText } = files;
const { runFormalAiTask } = require('../src/lib/formal-ai');
const {
  cleanup,
  populate,
  sink,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const posix = process.platform !== 'win32';
const dirs = [];
afterAll(() => cleanup(...dirs));

const TEXT =
  '// keep this comment\r\nconst a = 1;\t \n\n  const b = 2; // b\nconst a2 = 1;\n';

function workspace(extra = {}) {
  const dir = populate(tempDir('files'), {
    'a.js': TEXT,
    'sub/b.txt': 'one two one\n',
    ...extra,
  });
  dirs.push(dir);
  return dir;
}

function context(cwd, effects = 'workspace-write') {
  return {
    cwd,
    effects,
    observed: new Set(),
    observedDirs: new Set(),
    contents: new Map(),
  };
}

const bounds = { maxFileBytes: BOUND_DEFAULTS.maxFileBytes.value };

/** Normalize, decide and run one call like the loop does. */
function call(tool, args, ctx, limits = bounds) {
  const normalized = files.normalizeFileArgs(tool, args);
  if (normalized.problem) {
    return { problem: normalized.problem };
  }
  const decision = files.evaluateFileCall(tool, normalized.args, ctx);
  if (!decision.allowed) {
    return { refused: decision.reason };
  }
  return files.runFileCall(tool, normalized.args, decision, ctx, limits);
}

describe('file tool arguments (#258)', () => {
  it('normalizes aliases and rejects malformed arguments', () => {
    expect(
      files.normalizeFileArgs('edit', {
        filePath: 'a.js',
        oldString: 'x',
        newString: 'y',
      })
    ).toEqual({
      args: { path: 'a.js', oldString: 'x', newString: 'y', replaceAll: false },
    });
    for (const [tool, args] of [
      ['read', null],
      ['read', []],
      ['read', {}],
      ['read', { path: 1 }],
      ['read', { path: ' ' }],
      ['read', { path: 'a\0b' }],
      ['read', { path: 'a', file_path: 'b' }],
      ['edit', { path: 'a', old_string: 'x' }],
      ['edit', { path: 'a', old_string: 'x', new_string: 'y', replace_all: 1 }],
      ['write', { path: 'a' }],
    ]) {
      expect(files.normalizeFileArgs(tool, args).problem).toBeString();
    }
  });
});

describe('file tool policy (#258)', () => {
  it('refuses changes in read-only mode, outside paths and unobserved targets', () => {
    const cwd = workspace();
    const outside = tempDir('outside');
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link'));
    const ro = context(cwd, 'read-only');
    expect(
      call('edit', { path: 'a.js', old_string: 'a', new_string: 'b' }, ro)
    ).toMatchObject({ refused: expect.stringContaining('read-only') });
    expect(call('write', { path: 'a.js', content: '' }, ro).refused).toContain(
      'START_FORMAL_AI_EFFECTS=workspace-write'
    );
    const rw = context(cwd);
    for (const target of [
      '../x',
      '/etc/passwd',
      '~/.ssh/id_rsa',
      'link',
      path.join(outside, 'secret.txt'),
    ]) {
      expect(call('read', { path: target }, rw).refused).toContain(
        'outside the working directory'
      );
    }
    expect(call('read', { path: '.' }, rw).refused).toContain('not a file');
    expect(
      call('edit', { path: 'a.js', old_string: 'a', new_string: 'b' }, rw)
        .refused
    ).toBe('target "a.js" was not read before the change');
    expect(call('write', { path: 'new.txt', content: 'x' }, rw).refused).toBe(
      'target "new.txt" was not observed before the change'
    );
    rw.observedDirs.add('.');
    // A new file in a listed directory may be created, an existing one not.
    expect(call('write', { path: 'a.js', content: 'x' }, rw).refused).toBe(
      'target "a.js" was not observed before the change'
    );
    expect(
      call('write', { path: 'new.txt', content: 'x\n' }, rw)
    ).toMatchObject({ exitCode: 0, verification: { verified: true } });
    expect(fs.readFileSync(path.join(cwd, 'new.txt'), 'utf8')).toBe('x\n');
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'secret'
    );
  });
});

describe('read (#258)', () => {
  it('returns the exact text and records the observation', () => {
    const cwd = workspace();
    const ctx = context(cwd, 'read-only');
    const receipt = call('read', { path: './a.js' }, ctx);
    // Formal AI binds a read as complete only in its numbered frame (#261).
    expect(receipt).toMatchObject({
      exitCode: 0,
      text: TEXT,
      result: readFrame(TEXT),
      bytes: Buffer.byteLength(TEXT),
    });
    expect(readFrameText(receipt.result)).toBe(TEXT);
    expect(ctx.observed.has('a.js')).toBe(true);
    expect(ctx.contents.get('a.js')).toBe(receipt.sha256);
  });

  it('fails for missing, directory, oversized and non-text files', () => {
    const cwd = workspace({ 'bin.dat': '', 'big.txt': 'x'.repeat(64) });
    fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0xff, 0xfe, 0]));
    fs.writeFileSync(path.join(cwd, 'nul.txt'), 'a\0b');
    const ctx = context(cwd, 'read-only');
    const error = (name, limits) => call('read', { path: name }, ctx, limits);
    expect(error('missing.txt')).toMatchObject({
      exitCode: 1,
      error: 'missing.txt: no such file',
    });
    expect(JSON.parse(error('missing.txt').result)).toEqual({
      ok: false,
      is_error: true,
      error: 'missing.txt: no such file',
    });
    expect(error('sub').error).toBe('sub: is a directory, not a file');
    expect(error('bin.dat').error).toBe('bin.dat: is not UTF-8 text');
    expect(error('nul.txt').error).toBe('nul.txt: is not UTF-8 text');
    expect(error('big.txt', { maxFileBytes: 10 }).error).toBe(
      'big.txt: has 64 bytes; START_FORMAL_AI_MAX_FILE_BYTES is 10'
    );
    expect(ctx.observed.size).toBe(0);
  });
});

describe('edit (#258)', () => {
  it('replaces one literal occurrence, preserving every other byte and the mode', () => {
    const cwd = workspace();
    const file = path.join(cwd, 'a.js');
    if (posix) {
      fs.chmodSync(file, 0o640);
    }
    const ctx = context(cwd);
    call('read', { path: 'a.js' }, ctx);
    const receipt = call(
      'edit',
      {
        path: 'a.js',
        old_string: 'const b = 2;',
        new_string: 'const b = $&3;',
      },
      ctx
    );
    expect(receipt).toMatchObject({
      exitCode: 0,
      replacements: 1,
      verification: { verified: true },
    });
    expect(JSON.parse(receipt.result)).toMatchObject({
      ok: true,
      path: 'a.js',
      tool: 'edit',
      replacements: 1,
      verified: true,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      TEXT.replace('const b = 2;', () => 'const b = $&3;')
    );
    if (posix) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    }
    // No temporary file is left behind.
    expect(fs.readdirSync(cwd).sort()).toEqual(['a.js', 'sub']);
  });

  it('keeps a byte order mark', () => {
    const cwd = workspace({ 'bom.txt': '\ufefffirst\nsecond\n' });
    const ctx = context(cwd);
    expect(call('read', { path: 'bom.txt' }, ctx).text).toBe(
      '\ufefffirst\nsecond\n'
    );
    const receipt = call(
      'edit',
      { path: 'bom.txt', old_string: 'second', new_string: '2nd' },
      ctx
    );
    expect(receipt.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(cwd, 'bom.txt'))).toEqual(
      Buffer.from('\ufefffirst\n2nd\n', 'utf8')
    );
  });

  it('refuses ambiguous, missing, empty and no-op replacements', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'sub/b.txt' }, ctx);
    const edit = (args) => call('edit', { path: 'sub/b.txt', ...args }, ctx);
    expect(edit({ old_string: 'one', new_string: '1' }).error).toBe(
      'sub/b.txt: old_string occurs 2 times; give more surrounding text or set replace_all; nothing changed'
    );
    expect(edit({ old_string: 'three', new_string: '3' }).error).toContain(
      'not found'
    );
    expect(edit({ old_string: '', new_string: '3' }).error).toContain('empty');
    expect(edit({ old_string: 'two', new_string: 'two' }).error).toContain(
      'the same'
    );
    expect(fs.readFileSync(path.join(cwd, 'sub/b.txt'), 'utf8')).toBe(
      'one two one\n'
    );
    expect(
      edit({ old_string: 'one', new_string: '1', replace_all: true })
    ).toMatchObject({ exitCode: 0, replacements: 2 });
    expect(fs.readFileSync(path.join(cwd, 'sub/b.txt'), 'utf8')).toBe(
      '1 two 1\n'
    );
  });

  it('does not overwrite a file changed since it was read', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'a.js' }, ctx);
    fs.writeFileSync(path.join(cwd, 'a.js'), 'someone else\n');
    expect(
      call('edit', { path: 'a.js', old_string: 'else', new_string: 'x' }, ctx)
        .error
    ).toContain('changed since start read it');
    expect(call('write', { path: 'a.js', content: 'x' }, ctx).error).toContain(
      'changed since start read it'
    );
    expect(fs.readFileSync(path.join(cwd, 'a.js'), 'utf8')).toBe(
      'someone else\n'
    );
  });

  it('keeps the file size bound for the new text', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    const limits = { maxFileBytes: Buffer.byteLength(TEXT) };
    call('read', { path: 'a.js' }, ctx, limits);
    expect(
      call(
        'edit',
        {
          path: 'a.js',
          old_string: 'const a = 1;',
          new_string: 'const a = 10;',
        },
        ctx,
        limits
      ).error
    ).toContain('START_FORMAL_AI_MAX_FILE_BYTES');
    expect(fs.readFileSync(path.join(cwd, 'a.js'), 'utf8')).toBe(TEXT);
  });
});

describe('write (#258)', () => {
  it('replaces a read file and refuses a missing directory', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'a.js' }, ctx);
    expect(
      call('write', { path: 'a.js', content: 'new\n' }, ctx)
    ).toMatchObject({
      exitCode: 0,
      bytes: 4,
      verification: { verified: true },
    });
    expect(fs.readFileSync(path.join(cwd, 'a.js'), 'utf8')).toBe('new\n');
    ctx.observedDirs.add('gone');
    expect(call('write', { path: 'gone/x.txt', content: 'x' }, ctx).error).toBe(
      'gone/x.txt: its directory does not exist'
    );
  });
});

describe('START_FORMAL_AI_MAX_FILE_BYTES (#258)', () => {
  it('defaults to 1 MiB and is bounded', () => {
    expect(resolveBounds({}).maxFileBytes).toBe(1024 * 1024);
    expect(
      resolveBounds({ START_FORMAL_AI_MAX_FILE_BYTES: '4096' }).maxFileBytes
    ).toBe(4096);
    for (const value of ['0', '-1', 'abc', String(64 * 1024 * 1024)]) {
      expect(() =>
        resolveBounds({ START_FORMAL_AI_MAX_FILE_BYTES: value })
      ).toThrow();
    }
  });
});

describe('file tools in the task loop (#258)', () => {
  /** A scripted client: each turn returns the next message. */
  function scripted(turns) {
    let index = 0;
    return {
      complete: () => {
        const message = turns[index++];
        return Promise.resolve({
          content: message.content || '',
          finishReason: message.toolCalls ? 'tool_calls' : 'stop',
          handler: null,
          toolCalls: message.toolCalls || [],
          raw: {},
        });
      },
    };
  }
  const fileCall = (tool, args) => ({
    id: `c_${tool}`,
    name: tool,
    tool,
    args: files.normalizeFileArgs(tool, args).args,
    arguments: JSON.stringify(args),
    command: `${tool} ${args.path}`,
  });

  async function loop(turns, effects = 'workspace-write') {
    const cwd = workspace();
    const before = snapshot(cwd);
    const evidence = await runFormalAiTask({
      request: 'scripted',
      cwd,
      env: { PATH: process.env.PATH },
      bounds: { ...resolveBounds({}), effects },
      client: scripted(turns),
      io: { stdout: sink(), stderr: sink(), note: () => {} },
    });
    return { cwd, before, after: snapshot(cwd), evidence };
  }

  it('stops with 77 before an unobserved edit runs', async () => {
    const result = await loop([
      {
        toolCalls: [
          fileCall('edit', { path: 'a.js', old_string: 'a', new_string: 'b' }),
        ],
      },
    ]);
    expect(result.evidence.outcome).toMatchObject({
      status: 'refused',
      exitCode: EXIT.REFUSED,
      remainingObligations: [
        'the refused call did not run; nothing after it ran either',
      ],
    });
    expect(result.after).toEqual(result.before);
  });

  it('refuses edits in read-only mode even after a read', async () => {
    const result = await loop(
      [
        { toolCalls: [fileCall('read', { path: 'a.js' })] },
        {
          toolCalls: [
            fileCall('edit', {
              path: 'a.js',
              old_string: 'a',
              new_string: 'b',
            }),
          ],
        },
      ],
      'read-only'
    );
    expect(result.evidence.outcome.exitCode).toBe(EXIT.REFUSED);
    expect(result.evidence.outcome.message).toContain('read-only');
    expect(result.after).toEqual(result.before);
  });

  it('reports a failed edit with its real status and no change', async () => {
    const result = await loop([
      { toolCalls: [fileCall('read', { path: 'a.js' })] },
      {
        toolCalls: [
          fileCall('edit', {
            path: 'a.js',
            old_string: 'zzz',
            new_string: 'b',
          }),
        ],
      },
      { content: 'The edit failed.' },
    ]);
    // The failure stays unresolved with its original error (#261).
    expect(result.evidence.outcome).toMatchObject({
      status: 'incomplete',
      exitCode: 1,
      remainingObligations: [
        '`edit a.js` failed: a.js: old_string was not found; nothing changed',
      ],
      failures: [
        {
          command: 'edit a.js',
          tool: 'edit',
          target: 'a.js',
          exitCode: 1,
          error: 'a.js: old_string was not found; nothing changed',
        },
      ],
    });
    expect(result.after).toEqual(result.before);
  });
});
