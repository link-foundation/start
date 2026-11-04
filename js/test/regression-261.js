/**
 * Issue #261: bounded typed source edits in `--use-formal-ai`, offline.
 *
 * A change is bound to a complete fresh read of the exact target and its
 * preimage, applies only the owned replacement, keeps the matched mutation
 * receipt and is verified byte for byte on readback. Failed, stale, ambiguous
 * or missing evidence stays unresolved with its original failure. The
 * held-out requests replay the receipts of a real Formal AI runtime
 * (test/fixtures/formal-ai/receipts-261.json, written by
 * experiments/issue-261/capture-receipts.cjs).
 */
const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EXIT, resolveBounds } = require('../src/lib/formal-ai-policy');
const {
  createClient,
  offeredTools,
  recognizeCapabilityGap,
} = require('../src/lib/formal-ai-client');
const files = require('../src/lib/formal-ai-files');
const { runFormalAiTask } = require('../src/lib/formal-ai');
const {
  createFakeServer,
  heldOut,
} = require('./fixtures/formal-ai/replay.cjs');
const {
  CLI,
  cleanup,
  cliEnv,
  fakeCheckout,
  populate,
  readEvidence,
  readLog,
  sentRequests,
  sink,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const posix = process.platform !== 'win32';
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const dirs = [];
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const digest = (text) => ({
  sha256: hash(Buffer.from(text, 'utf8')),
  bytes: Buffer.byteLength(text, 'utf8'),
});

/** The issue's synthetic reproduction. */
const REPRO = { 'draft.txt': 'draft\n', 'verified-source.txt': 'verified\n' };
const REQUEST = 'In draft.txt, replace «draft» with «verified».';

let server;
let baseUrl;

beforeAll(async () => {
  server = createFakeServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.close();
  cleanup(...dirs);
});

function workspace(extra = REPRO) {
  const dir = populate(tempDir('261'), extra);
  dirs.push(dir);
  return dir;
}

function context(cwd, effects = 'workspace-write') {
  return {
    cwd,
    effects,
    observed: new Set(),
    observedDirs: new Set(['.']),
    contents: new Map(),
  };
}

const limits = { maxFileBytes: 1024 * 1024 };

/** Normalize, decide and run one call like the loop does. */
function call(tool, args, ctx) {
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

const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8');
const edit = (ctx, file, oldString, newString, extra = {}) =>
  call(
    'edit',
    { path: file, old_string: oldString, new_string: newString, ...extra },
    ctx
  );

describe('read frame (#261)', () => {
  it('frames the complete text so Formal AI decodes it exactly', () => {
    for (const text of [
      'draft\n',
      '',
      'no final newline',
      'a\r\nb\r\n',
      '﻿Ünïcödé 🙂\n\n\n',
      'x\n\n(End of file - total 3 lines)\n</file>',
      '00001| looks numbered\n',
    ]) {
      const frame = files.readFrame(text);
      expect(frame.startsWith('<file>\n')).toBe(true);
      expect(frame.endsWith('</file>')).toBe(true);
      expect(files.readFrameText(frame)).toBe(text);
    }
    expect(files.readFrame('draft\n')).toBe(
      '<file>\n00001| draft\n00002| \n\n(End of file - total 2 lines)\n</file>'
    );
  });

  it('decodes nothing from a partial or altered frame', () => {
    const frame = files.readFrame('a\nb\n');
    for (const altered of [
      'a\nb\n',
      frame.replace('total 3 lines', 'total 2 lines'),
      frame.replace('00002| b', '00003| b'),
      frame.replace('00002| b', '00002|b'),
      frame.slice(0, -1),
      frame.replace('<file>\n', ''),
    ]) {
      expect(files.readFrameText(altered)).toBeNull();
    }
  });
});

describe('bounded typed edits (#261)', () => {
  it('binds the read, applies only the owned change and keeps the receipt', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    const seen = call('read', { path: 'draft.txt' }, ctx);
    expect(seen).toMatchObject({
      exitCode: 0,
      text: 'draft\n',
      result: files.readFrame('draft\n'),
    });
    const receipt = edit(ctx, 'draft.txt', 'draft', 'verified');
    expect(receipt).toMatchObject({
      exitCode: 0,
      replacements: 1,
      previousSha256: seen.sha256,
      sha256: hash('verified\n'),
      verification: {
        verified: true,
        detail:
          'readback confirmed edit draft.txt (9 bytes; 1 replacement(s); every other byte unchanged)',
      },
    });
    expect(receipt.mutation).toEqual({
      tool: 'edit',
      target: 'draft.txt',
      preimage: digest('draft\n'),
      postimage: digest('verified\n'),
      matches: [{ offset: 0, oldBytes: 5, newBytes: 8 }],
      readback: digest('verified\n'),
    });
    expect(JSON.parse(receipt.result)).toEqual({
      ok: true,
      path: 'draft.txt',
      tool: 'edit',
      preimage: digest('draft\n'),
      postimage: digest('verified\n'),
      replacements: 1,
      verified: true,
    });
    expect(read(cwd, 'draft.txt')).toBe('verified\n');
    expect(read(cwd, 'verified-source.txt')).toBe('verified\n');
    // The verified postimage is the new binding: a second edit may follow.
    expect(ctx.contents.get('draft.txt')).toBe(hash('verified\n'));
  });

  it('fails a mismatched OLD and changes nothing', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    expect(edit(ctx, 'draft.txt', 'drafted', 'verified')).toMatchObject({
      exitCode: 1,
      error: 'draft.txt: old_string was not found; nothing changed',
    });
    expect(edit(ctx, 'draft.txt', 'Draft', 'verified').exitCode).toBe(1);
    expect(read(cwd, 'draft.txt')).toBe('draft\n');
  });

  it('fails repeated occurrences unless replace_all is set', () => {
    const text = 'draft one\ndraft two\n';
    const cwd = workspace({ 'twice.txt': text });
    const ctx = context(cwd);
    call('read', { path: 'twice.txt' }, ctx);
    expect(edit(ctx, 'twice.txt', 'draft', 'verified').error).toBe(
      'twice.txt: old_string occurs 2 times; give more surrounding text or set replace_all; nothing changed'
    );
    expect(read(cwd, 'twice.txt')).toBe(text);
    const receipt = edit(ctx, 'twice.txt', 'draft', 'verified', {
      replace_all: true,
    });
    expect(receipt).toMatchObject({ exitCode: 0, replacements: 2 });
    expect(receipt.mutation.matches).toEqual([
      { offset: 0, oldBytes: 5, newBytes: 8 },
      { offset: 10, oldBytes: 5, newBytes: 8 },
    ]);
    expect(read(cwd, 'twice.txt')).toBe('verified one\nverified two\n');
  });

  it('preserves Unicode, CRLF, a BOM and a missing final newline', () => {
    const text = '﻿Ünïcödé café ☕\r\nsecond line 🙂\r\nno final newline';
    const cwd = workspace({ 'unicode.txt': text });
    const ctx = context(cwd);
    call('read', { path: 'unicode.txt' }, ctx);
    const receipt = edit(ctx, 'unicode.txt', 'café', 'naïve');
    expect(receipt.verification.verified).toBe(true);
    const before = Buffer.from(text, 'utf8');
    expect(receipt.mutation.matches).toEqual([
      {
        offset: before.indexOf(Buffer.from('café', 'utf8')),
        oldBytes: 5,
        newBytes: 6,
      },
    ]);
    expect(fs.readFileSync(path.join(cwd, 'unicode.txt'))).toEqual(
      Buffer.from(text.replace('café', 'naïve'), 'utf8')
    );
  });

  it('refuses text that is not valid Unicode', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    expect(edit(ctx, 'draft.txt', 'draft', 'bad \ud800').error).toBe(
      'draft.txt: old_string or new_string is not valid Unicode text; nothing changed'
    );
    expect(
      call('write', { path: 'draft.txt', content: '\udfff' }, ctx).error
    ).toBe('draft.txt: content is not valid Unicode text; nothing changed');
    expect(read(cwd, 'draft.txt')).toBe('draft\n');
  });

  it('needs a complete read with the read tool, not cat or a listing', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    // What `cat draft.txt` or `ls` records: observed, but no exact preimage.
    ctx.observed.add('draft.txt');
    const message =
      'draft.txt: was not read completely with the read tool in this task; read it before changing it; nothing changed';
    expect(edit(ctx, 'draft.txt', 'draft', 'verified').error).toBe(message);
    expect(
      call('write', { path: 'draft.txt', content: 'verified\n' }, ctx).error
    ).toBe(message);
    expect(read(cwd, 'draft.txt')).toBe('draft\n');
  });

  it('fails a stale read and works again after a fresh one', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    fs.writeFileSync(path.join(cwd, 'draft.txt'), 'draft draft\n');
    expect(edit(ctx, 'draft.txt', 'draft draft', 'verified').error).toBe(
      'draft.txt: changed since start read it; read it again before changing it; nothing changed'
    );
    expect(read(cwd, 'draft.txt')).toBe('draft draft\n');
    call('read', { path: 'draft.txt' }, ctx);
    expect(edit(ctx, 'draft.txt', 'draft draft', 'verified').exitCode).toBe(0);
    expect(read(cwd, 'draft.txt')).toBe('verified\n');
  });

  it('never overwrites a change made while it was writing', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    ctx.beforeReplace = (file) => fs.writeFileSync(file, 'theirs\n');
    const receipt = edit(ctx, 'draft.txt', 'draft', 'verified');
    expect(receipt).toMatchObject({
      exitCode: 1,
      error:
        'draft.txt: changed while start was changing it; read it again; nothing changed',
    });
    // The failed mutation keeps its receipt; the stale binding is dropped.
    expect(receipt.mutation).toMatchObject({
      tool: 'edit',
      preimage: digest('draft\n'),
      postimage: digest('verified\n'),
    });
    expect(read(cwd, 'draft.txt')).toBe('theirs\n');
    expect(ctx.contents.has('draft.txt')).toBe(false);
    expect(fs.readdirSync(cwd).sort()).toEqual([
      'draft.txt',
      'verified-source.txt',
    ]);
  });

  it('never replaces a file created while it was writing a new one', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    ctx.beforeReplace = (file) => fs.writeFileSync(file, 'theirs\n');
    expect(
      call('write', { path: 'new.txt', content: 'mine\n' }, ctx).error
    ).toBe('new.txt: was created while start was writing it; nothing changed');
    expect(read(cwd, 'new.txt')).toBe('theirs\n');
  });

  it('reports a readback that differs from the intended postimage', () => {
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    ctx.afterReplace = (file) => fs.writeFileSync(file, 'verified!\n');
    const receipt = edit(ctx, 'draft.txt', 'draft', 'verified');
    expect(receipt.verification.verified).toBe(false);
    expect(receipt.verification.detail).toContain(
      'readback of draft.txt differs from the intended text'
    );
    expect(JSON.parse(receipt.result)).toMatchObject({
      ok: false,
      verified: false,
    });
    expect(receipt.mutation.readback).toEqual(digest('verified!\n'));
    expect(ctx.contents.has('draft.txt')).toBe(false);
  });

  it.skipIf(!posix || root)(
    'keeps the receipt of a mutation that could not be written',
    () => {
      const cwd = workspace();
      const ctx = context(cwd);
      call('read', { path: 'draft.txt' }, ctx);
      fs.chmodSync(cwd, 0o555);
      try {
        const receipt = edit(ctx, 'draft.txt', 'draft', 'verified');
        expect(receipt.exitCode).toBe(1);
        expect(receipt.error).toMatch(
          /^draft\.txt: failed \(EACCES\); nothing changed$/
        );
        expect(receipt.mutation).toMatchObject({
          preimage: digest('draft\n'),
          postimage: digest('verified\n'),
        });
      } finally {
        fs.chmodSync(cwd, 0o755);
      }
      expect(read(cwd, 'draft.txt')).toBe('draft\n');
    }
  );
});

describe('foreign and symlinked paths (#261)', () => {
  it.skipIf(!posix)('edits the real file behind an in-workspace link', () => {
    const cwd = workspace({ 'real.txt': 'draft\n' });
    fs.symlinkSync('real.txt', path.join(cwd, 'link.txt'));
    const ctx = context(cwd);
    expect(call('read', { path: 'link.txt' }, ctx).text).toBe('draft\n');
    const receipt = edit(ctx, 'link.txt', 'draft', 'verified');
    expect(receipt).toMatchObject({
      exitCode: 0,
      mutation: { target: 'real.txt' },
    });
    expect(fs.lstatSync(path.join(cwd, 'link.txt')).isSymbolicLink()).toBe(
      true
    );
    expect(read(cwd, 'real.txt')).toBe('verified\n');
  });

  it.skipIf(!posix)('refuses links and paths leaving the workspace', () => {
    const outside = tempDir('261-outside');
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'draft\n');
    const cwd = workspace();
    fs.symlinkSync(
      path.join(outside, 'outside.txt'),
      path.join(cwd, 'escape.txt')
    );
    const ctx = context(cwd);
    for (const target of [
      'escape.txt',
      path.join(outside, 'outside.txt'),
      '../outside.txt',
    ]) {
      expect(call('read', { path: target }, ctx).refused).toContain(
        'outside the working directory'
      );
      expect(edit(ctx, target, 'draft', 'verified').refused).toBeString();
    }
    expect(read(outside, 'outside.txt')).toBe('draft\n');
  });

  it.skipIf(!posix)('never writes through a dangling link', () => {
    const cwd = workspace();
    fs.symlinkSync('missing.txt', path.join(cwd, 'dangling.txt'));
    const ctx = context(cwd);
    expect(
      call('write', { path: 'dangling.txt', content: 'x\n' }, ctx).error
    ).toBe(
      'dangling.txt: is a symbolic link start cannot resolve inside the working directory; nothing changed'
    );
    expect(fs.existsSync(path.join(cwd, 'missing.txt'))).toBe(false);
  });

  it.skipIf(!posix)('fails when the target becomes a link mid-change', () => {
    const outside = tempDir('261-swap');
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'draft\n');
    const cwd = workspace();
    const ctx = context(cwd);
    call('read', { path: 'draft.txt' }, ctx);
    ctx.beforeReplace = (file) => {
      fs.rmSync(file);
      fs.symlinkSync(path.join(outside, 'outside.txt'), file);
    };
    expect(edit(ctx, 'draft.txt', 'draft', 'verified').error).toContain(
      'changed while start was changing it'
    );
    expect(read(outside, 'outside.txt')).toBe('draft\n');
    expect(fs.lstatSync(path.join(cwd, 'draft.txt')).isSymbolicLink()).toBe(
      true
    );
  });
});

describe('independent postimage verification (#261)', () => {
  const pre = Buffer.from('aXbXc', 'utf8');
  const oldBytes = Buffer.from('X', 'utf8');
  const newBytes = Buffer.from('YY', 'utf8');
  const matches = [
    { offset: 1, oldBytes: 1, newBytes: 2 },
    { offset: 3, oldBytes: 1, newBytes: 2 },
  ];
  const verify = (post, m = matches, o = oldBytes) =>
    files.verifyMutation(pre, Buffer.from(post, 'utf8'), m, o, newBytes);

  it('accepts exactly the owned replacements', () => {
    expect(verify('aYYbYYc')).toEqual({
      verified: true,
      detail: '2 replacement(s); every other byte unchanged',
    });
  });

  it('rejects any other byte change, length or receipt mismatch', () => {
    for (const post of ['aYYbYYd', 'aYYbXc', 'aYYbYYcc', 'YYbYYc', 'aYYBYYc']) {
      expect(verify(post).verified).toBe(false);
    }
    // A receipt whose matched region does not hold OLD in the preimage.
    expect(
      verify('aYYbYYc', [
        { offset: 0, oldBytes: 1, newBytes: 2 },
        { offset: 3, oldBytes: 1, newBytes: 2 },
      ]).verified
    ).toBe(false);
    expect(verify('aYYbYYc', matches, Buffer.from('Z')).verified).toBe(false);
  });
});

describe('unresolved failures in the task loop (#261)', () => {
  /** A scripted client: each turn returns the next message. */
  function scripted(turns) {
    let index = 0;
    const sent = [];
    return {
      sent,
      complete(messages) {
        sent.push(JSON.parse(JSON.stringify(messages)));
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
  let ids = 0;
  const typed = (tool, args) => ({
    id: `c_${++ids}`,
    name: tool,
    tool,
    args: files.normalizeFileArgs(tool, args).args,
    arguments: JSON.stringify(args),
    command: files.describeFileCall(
      tool,
      files.normalizeFileArgs(tool, args).args
    ),
  });
  const bash = (command) => ({
    id: `c_${++ids}`,
    name: 'bash',
    tool: 'bash',
    command,
  });
  const readDraft = { toolCalls: [typed('read', { path: 'draft.txt' })] };
  const editDraft = (oldString = 'draft') => ({
    toolCalls: [
      typed('edit', {
        path: 'draft.txt',
        old_string: oldString,
        new_string: 'verified',
      }),
    ],
  });

  async function loop(turns, fixture = REPRO) {
    const cwd = workspace(fixture);
    const client = scripted(turns);
    const evidence = await runFormalAiTask({
      request: REQUEST,
      cwd,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      bounds: { ...resolveBounds({}), effects: 'workspace-write' },
      client,
      io: { stdout: sink(), stderr: sink(), note: () => {} },
    });
    return {
      cwd,
      evidence,
      outcome: evidence.outcome,
      sent: client.sent,
      draft: read(cwd, 'draft.txt'),
      source: read(cwd, 'verified-source.txt'),
    };
  }

  it('completes the exact reproduction with a verified edit', async () => {
    const result = await loop([
      readDraft,
      editDraft(),
      { toolCalls: [bash('sha256sum -- draft.txt')] },
      { content: 'Replaced `draft` with `verified` in `draft.txt`.' },
    ]);
    expect(result.outcome).toEqual({
      status: 'completed',
      exitCode: 0,
      message: 'finished after 3 tool call(s); changed draft.txt',
      remainingObligations: [],
    });
    expect(result.draft).toBe('verified\n');
    expect(result.source).toBe('verified\n');
    const [readMessage, editMessage, digestMessage] = result.sent[3].filter(
      (m) => m.role === 'tool'
    );
    expect(readMessage.content).toBe(files.readFrame('draft\n'));
    expect(JSON.parse(editMessage.content)).toMatchObject({
      ok: true,
      verified: true,
      postimage: digest('verified\n'),
    });
    expect(digestMessage.content).toContain(hash('verified\n'));
    const step = result.evidence.steps.find((s) => s.tool === 'edit');
    expect(step.mutation).toMatchObject({
      preimage: digest('draft\n'),
      postimage: digest('verified\n'),
      readback: digest('verified\n'),
    });
  });

  it('keeps an edit after cat unresolved', async () => {
    const result = await loop([
      { toolCalls: [bash('cat draft.txt')] },
      editDraft(),
      { content: 'Done.' },
    ]);
    expect(result.outcome).toMatchObject({
      status: 'incomplete',
      exitCode: 1,
      failures: [
        {
          command: 'edit draft.txt',
          error:
            'draft.txt: was not read completely with the read tool in this task; read it before changing it; nothing changed',
        },
      ],
    });
    expect(result.draft).toBe('draft\n');
  });

  it('keeps a mismatched OLD unresolved after a later read', async () => {
    const result = await loop([
      readDraft,
      editDraft('drafted'),
      readDraft,
      { content: 'Done.' },
    ]);
    expect(result.outcome).toEqual({
      status: 'incomplete',
      exitCode: 1,
      message:
        '`edit draft.txt` failed (draft.txt: old_string was not found; nothing changed) and no later call resolved it; no file changed',
      remainingObligations: [
        '`edit draft.txt` failed: draft.txt: old_string was not found; nothing changed',
      ],
      failures: [
        {
          command: 'edit draft.txt',
          tool: 'edit',
          target: 'draft.txt',
          exitCode: 1,
          error: 'draft.txt: old_string was not found; nothing changed',
        },
      ],
    });
  });

  it('resolves a failed edit only by a verified change of the target', async () => {
    const result = await loop([
      readDraft,
      editDraft('drafted'),
      editDraft('draft'),
      { content: 'Done.' },
    ]);
    expect(result.outcome).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.draft).toBe('verified\n');
  });

  it('never takes a copy as the substring edit', async () => {
    const result = await loop([
      readDraft,
      editDraft('drafted'),
      { toolCalls: [typed('read', { path: 'verified-source.txt' })] },
      { toolCalls: [bash('cp verified-source.txt draft.txt')] },
      { content: 'Done.' },
    ]);
    // The copy ran and its effect is reported, but the edit stays failed.
    expect(result.draft).toBe('verified\n');
    expect(result.outcome).toMatchObject({
      status: 'incomplete',
      exitCode: 1,
      failures: [{ command: 'edit draft.txt' }],
    });
    expect(result.outcome.message).toContain('changed draft.txt');
  });

  it('keeps a failed bash write unresolved until the same call succeeds', async () => {
    const result = await loop([
      readDraft,
      { toolCalls: [bash('mkdir draft.txt')] },
      { toolCalls: [bash('touch draft.txt')] },
      { content: 'Done.' },
    ]);
    expect(result.outcome).toMatchObject({
      status: 'incomplete',
      failures: [{ command: 'mkdir draft.txt' }],
    });
  });

  it('exits 65 when Formal AI cannot bind the preimage', async () => {
    const gap = JSON.stringify({
      complete: false,
      reason: 'SourcePreimageUnavailable',
      schema: 'workspace-change-verification-gap/v1',
      target: 'draft.txt',
      verified: false,
    });
    expect(recognizeCapabilityGap(gap, [])).toMatchObject({
      reason: 'SourcePreimageUnavailable',
      target: 'draft.txt',
    });
    const result = await loop([readDraft, editDraft(), { content: gap }]);
    expect(result.outcome).toMatchObject({
      status: 'capability-gap',
      exitCode: EXIT.UNSUPPORTED,
      message:
        'Formal AI reported a capability gap for draft.txt (SourcePreimageUnavailable); Formal AI did not confirm the task as done; start observed: changed draft.txt',
    });
  });

  it('exits 65 on an obligation gap in Formal AI notation', async () => {
    const record =
      'obligation_49c9d049437c0075\n  record_type "obligation_gap"\n  clause "Preserve all other content."\n  span_start "85"\n  span_end "112"\n  reason "no_artifact_in_clause"';
    const result = await loop([readDraft, editDraft(), { content: record }]);
    expect(result.outcome).toEqual({
      status: 'incomplete',
      exitCode: EXIT.UNSUPPORTED,
      message:
        'Formal AI reported obligation_gap (no_artifact_in_clause) for the clause "Preserve all other content."; nothing was verified as done by Formal AI; changed draft.txt',
      remainingObligations: ['Formal AI did not confirm the requested change'],
      gapRecord: {
        schema: 'obligation_gap',
        reason: 'no_artifact_in_clause',
        clause: 'Preserve all other content.',
      },
    });
    // Prose, other records and a record echoed from a file are no gap.
    for (const content of [
      'The edit is done.',
      'obligation_1\n  record_type "obligation_done"',
      'obligation 1\n  record_type "obligation_gap"',
      'obligation_1\nrecord_type "obligation_gap"',
    ]) {
      const other = await loop([readDraft, { content }]);
      expect(other.outcome.status).toBe('completed');
    }
    // A record or gap the read tool returned from a file, numbered in the
    // read frame, is file data, not Formal AI's answer.
    const echoed = await loop([readDraft, { content: record }], {
      ...REPRO,
      'draft.txt': `${record}\n`,
    });
    expect(echoed.outcome.status).toBe('completed');
    const gap = JSON.stringify(
      {
        schema: 'workspace-change-verification-gap/v1',
        target: 'draft.txt',
        reason: 'SourcePreimageUnavailable',
        complete: false,
        verified: false,
      },
      null,
      2
    );
    const echoedGap = await loop([readDraft, { content: gap }], {
      ...REPRO,
      'draft.txt': `${gap}\n`,
    });
    expect(echoedGap.outcome.status).toBe('completed');
    expect(
      files.echoedByTool(record, [
        { role: 'tool', content: files.readFrame(`${record}\n`) },
      ])
    ).toBe(true);
    expect(
      files.echoedByTool(record, [{ role: 'user', content: record }])
    ).toBe(false);
  });
});

describe('held-out edits against captured receipts (#261)', () => {
  /** Run one captured request through the real loop and the replay server. */
  async function replay(receipt) {
    const base = tempDir('261-replay');
    dirs.push(base);
    const cwd = path.join(base, 'ws');
    fs.mkdirSync(cwd);
    populate(cwd, receipt.files);
    for (const [link, target] of Object.entries(receipt.links)) {
      fs.symlinkSync(target, path.join(cwd, link));
    }
    const bounds = { ...resolveBounds({}), effects: receipt.effects };
    const deadline = Date.now() + bounds.timeoutMs;
    const tools = offeredTools(receipt.effects);
    const evidence = await runFormalAiTask({
      request: receipt.request,
      cwd,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      bounds,
      deadline,
      client: createClient({ baseUrl, bounds, deadline, tools }),
      io: { stdout: sink(), stderr: sink(), note: () => {} },
    });
    return {
      name: receipt.name,
      outcome: evidence.outcome,
      tools: evidence.steps
        .filter((s) => s.kind === 'tool')
        .map((s) => [s.command, s.decision, s.exitCode ?? null]),
      after: Object.fromEntries(
        Object.keys(receipt.files).map((name) => [name, read(cwd, name)])
      ),
    };
  }

  it('covers every held-out case of the issue', () => {
    expect(heldOut.receipts.map((r) => r.name)).toEqual([
      'issue reproduction',
      'issue reproduction, read-only',
      'mismatched OLD',
      'repeated occurrences',
      'Unicode and CRLF',
      'symlinked path',
      'symlink leaving the workspace',
      'foreign path',
    ]);
  });

  it.skipIf(!posix)(
    'every captured request replays to its outcome and file bytes',
    async () => {
      for (const receipt of heldOut.receipts) {
        expect(await replay(receipt)).toEqual({
          name: receipt.name,
          outcome: receipt.outcome,
          tools: receipt.tools.map((t) => [t.command, t.decision, t.exitCode]),
          after: receipt.after,
        });
      }
    }
  );

  it.skipIf(!posix)('the reproduction leaves the source unchanged', () => {
    const [repro] = heldOut.receipts;
    expect(repro.outcome).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(repro.after).toEqual({
      'draft.txt': 'verified\n',
      'verified-source.txt': 'verified\n',
    });
    expect(repro.tools.map((t) => t.command)).toEqual([
      'read draft.txt',
      'edit draft.txt',
      'sha256sum -- draft.txt',
    ]);
  });
});

describe('the reproduction through the CLI (#261)', () => {
  const checkout = fakeCheckout({ version: '0.355.32' });
  dirs.push(checkout);

  it.skipIf(!posix)('exits 0 with the exact bytes', () => {
    const base = tempDir('cli-261');
    dirs.push(base);
    const cwd = workspace();
    const before = snapshot(cwd);
    const result = spawnSync(
      process.execPath,
      [CLI, '--use-formal-ai', '--', REQUEST],
      {
        cwd,
        env: cliEnv(base, {
          START_FORMAL_AI_ROOT: checkout,
          START_FORMAL_AI_EFFECTS: 'workspace-write',
        }),
        encoding: 'utf8',
        timeout: 60000,
      }
    );
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(cwd, 'draft.txt'))).toEqual(
      Buffer.from('verified\n')
    );
    const after = snapshot(cwd);
    expect(after['verified-source.txt']).toBe(before['verified-source.txt']);
    expect(result.stderr).toContain(
      '[formal-ai] readback confirmed edit draft.txt (9 bytes; 1 replacement(s); every other byte unchanged)'
    );
    const requests = sentRequests(base);
    const readResult = requests[1].messages.find((m) => m.role === 'tool');
    expect(readResult.content).toBe(files.readFrame('draft\n'));
    expect(readEvidence(readLog(base)).outcome).toMatchObject({
      status: 'completed',
      exitCode: 0,
    });
  });
});
