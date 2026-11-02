/**
 * Issue #258: Formal AI edit requests through `--use-formal-ai`.
 *
 * - The released Bash-only tool contract makes Formal AI answer with an
 *   explicit `workspace-edit-capability-gap/v1`; start must report that as an
 *   incomplete, nonzero outcome with its obligations, never as success.
 * - With the structured read/edit/write tools, the same literal edit runs
 *   read -> edit -> sha256sum readback and changes only the declaration.
 * - Plain question answering without tools stays exit 0.
 *
 * Replies come from receipts captured from the real Formal AI 0.355.29
 * runtime (test/fixtures/formal-ai/receipts-258.json, written by
 * experiments/issue-258/capture-receipts.cjs) for both tool contracts.
 */
const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  EXIT,
  evaluateCommand,
  resolveBounds,
} = require('../src/lib/formal-ai-policy');
const {
  BASH_TOOL,
  createClient,
  offeredTools,
  parseCompletion,
  recognizeCapabilityGap,
} = require('../src/lib/formal-ai-client');
const { runFormalAiTask } = require('../src/lib/formal-ai');
const { createFakeServer, edits } = require('./fixtures/formal-ai/replay.cjs');
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
/** The exact gap response of the issue. */
const GAP =
  '{"complete":false,"missingCapabilities":["read","edit"],"reason":"EditToolUnavailable","schema":"workspace-edit-capability-gap/v1","target":"snippet.mjs","verified":false}';
const ISSUE_EDIT =
  'In snippet.mjs, replace the before label declaration with the after label declaration, preserving all other content.';
const LITERAL_EDIT =
  'In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.';
const ORIGINAL = edits.fixture['snippet.mjs'];
const EDITED = ORIGINAL.replace(
  'const label = "before";',
  'const label = "after";'
);

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
  const dir = populate(tempDir('258'), edits.fixture);
  dirs.push(dir);
  return dir;
}

/** Run one request through the real loop with a chosen tool contract. */
async function run(request, { effects = 'read-only', tools, cwd } = {}) {
  const dir = cwd || fixture();
  const bounds = { ...resolveBounds({}), effects };
  const deadline = Date.now() + bounds.timeoutMs;
  const client = createClient({ baseUrl, bounds, deadline, tools });
  const sent = [];
  const stdout = sink();
  const notes = [];
  const evidence = await runFormalAiTask({
    request,
    cwd: dir,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    bounds,
    deadline,
    client: {
      complete(messages, options) {
        sent.push(JSON.parse(JSON.stringify(messages)));
        return client.complete(messages, options);
      },
    },
    io: { stdout, stderr: sink(), note: (text) => notes.push(text) },
  });
  return {
    evidence,
    outcome: evidence.outcome,
    tools: evidence.steps.filter((s) => s.kind === 'tool'),
    text: fs.readFileSync(path.join(dir, 'snippet.mjs'), 'utf8'),
    stdout: stdout.text(),
    notes,
    sent,
  };
}

describe('capability-gap recognition (#258)', () => {
  it('recognizes the exact gap response', () => {
    expect(recognizeCapabilityGap(GAP, [])).toEqual({
      schema: 'workspace-edit-capability-gap/v1',
      target: 'snippet.mjs',
      reason: 'EditToolUnavailable',
      missingCapabilities: ['read', 'edit'],
      complete: false,
      verified: false,
    });
    expect(recognizeCapabilityGap(`\n ${GAP}\n`, [])).not.toBeNull();
    expect(
      recognizeCapabilityGap(
        '{"complete":false,"reason":"VerificationRunToolUnavailable","schema":"workspace-change-verification-gap/v1","target":"a.js","verified":false}',
        []
      )
    ).toMatchObject({ missingCapabilities: [], target: 'a.js' });
  });

  it('accepts only known, explicitly incomplete gap objects', () => {
    const variant = (patch) => JSON.stringify({ ...JSON.parse(GAP), ...patch });
    for (const content of [
      '',
      'I cannot edit files.',
      `Here you go: ${GAP}`,
      `${GAP}\n${GAP}`,
      '[1]',
      variant({ schema: 'workspace-edit-capability-gap/v2' }),
      variant({ schema: 'something-else/v1' }),
      variant({ reason: 'Whatever' }),
      variant({ complete: true }),
      variant({ verified: true }),
      variant({ complete: 'false' }),
      variant({ target: '' }),
      variant({ target: 3 }),
      variant({ missingCapabilities: 'read' }),
      variant({ missingCapabilities: ['read', 'teleport'] }),
    ]) {
      expect(recognizeCapabilityGap(content, [])).toBeNull();
    }
  });

  it('ignores gap text echoed from a tool result', () => {
    const messages = [
      { role: 'user', content: 'show contents of gap.json' },
      { role: 'tool', tool_call_id: 'c1', content: GAP },
    ];
    expect(recognizeCapabilityGap(GAP, messages)).toBeNull();
  });

  it('offers the change tools only in workspace-write mode', () => {
    const names = (effects) =>
      offeredTools(effects).map((tool) => tool.function.name);
    expect(names('read-only')).toEqual(['bash', 'read']);
    expect(names('workspace-write')).toEqual(['bash', 'read', 'edit', 'write']);
  });

  it('parses file tool calls with Formal AI argument aliases', () => {
    const completion = (name, args) => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [
              { id: 'c', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    });
    const [read] = parseCompletion(
      completion('read', {
        filePath: 'a.js',
        file_path: 'a.js',
        path: 'a.js',
      })
    ).toolCalls;
    expect(read).toMatchObject({
      tool: 'read',
      command: 'read a.js',
      args: { path: 'a.js' },
    });
    expect(() =>
      parseCompletion(completion('read', { path: 'a.js', file_path: 'b.js' }))
    ).toThrow('conflicting');
    expect(() =>
      parseCompletion(completion('edit', { path: 'a.js', old_string: 'x' }))
    ).toThrow('edit needs new_string');
  });
});

describe('the released Bash-only tool contract (#258)', () => {
  it('reports the gap as incomplete with exit 65 and obligations', async () => {
    const result = await run(ISSUE_EDIT, {
      effects: 'workspace-write',
      tools: [BASH_TOOL],
    });
    expect(result.sent[0]).toEqual([{ role: 'user', content: ISSUE_EDIT }]);
    expect(result.outcome).toEqual({
      status: 'capability-gap',
      exitCode: EXIT.UNSUPPORTED,
      message:
        'Formal AI reported a capability gap for snippet.mjs (EditToolUnavailable; missing read, edit); nothing was verified as done',
      remainingObligations: [
        'the requested change to snippet.mjs was not made or not verified',
      ],
      gap: JSON.parse(GAP),
    });
    expect(result.tools).toEqual([]);
    expect(result.text).toBe(ORIGINAL);
  });

  it('keeps answering plain questions with exit 0', async () => {
    const result = await run('What is 2 + 2?', { tools: [BASH_TOOL] });
    expect(result.outcome).toMatchObject({
      status: 'answered',
      exitCode: 0,
      remainingObligations: [],
    });
  });
});

describe('structured file tools against captured receipts (#258)', () => {
  it.skipIf(!posix)(
    'every captured request replays to its captured outcome and file text',
    async () => {
      for (const receipt of edits.receipts) {
        const offered = receipt.offered.join(',');
        const tools =
          offered === 'bash'
            ? [BASH_TOOL]
            : offeredTools(receipt.effects).map((t) => t);
        expect(tools.map((t) => t.function.name)).toEqual(receipt.offered);
        const result = await run(receipt.request, {
          effects: receipt.effects,
          tools,
        });
        expect({
          request: receipt.request,
          offered,
          outcome: result.outcome,
          tools: result.tools.map((t) => [t.command, t.decision, t.exitCode]),
          text: result.text,
        }).toEqual({
          request: receipt.request,
          offered,
          outcome: receipt.outcome,
          tools: receipt.tools.map((t) => [t.command, t.decision, t.exitCode]),
          text: receipt.after['snippet.mjs'],
        });
      }
    }
  );

  it.skipIf(!posix)(
    'reads, edits and reads back, preserving all other bytes',
    async () => {
      const result = await run(LITERAL_EDIT, { effects: 'workspace-write' });
      expect(result.outcome).toMatchObject({
        status: 'completed',
        exitCode: 0,
        message: 'finished after 3 tool call(s); changed snippet.mjs',
        remainingObligations: [],
      });
      expect(result.text).toBe(EDITED);
      const [read, edit, check] = result.tools;
      expect(read).toMatchObject({
        tool: 'read',
        effect: 'read',
        exitCode: 0,
        bytes: Buffer.byteLength(ORIGINAL),
      });
      expect(edit).toMatchObject({
        tool: 'edit',
        effect: 'write',
        target: 'snippet.mjs',
        exitCode: 0,
        replacements: 1,
        previousSha256: read.sha256,
        verification: { verified: true },
        effects: { changed: ['snippet.mjs'], added: [], removed: [] },
      });
      expect(edit.sha256).toBe(
        crypto.createHash('sha256').update(EDITED).digest('hex')
      );
      expect(check).toMatchObject({
        command: 'sha256sum -- snippet.mjs',
        exitCode: 0,
      });
      // Formal AI received the exact file text and the readback hash.
      const toolMessages = result.sent[3].filter((m) => m.role === 'tool');
      expect(toolMessages[0].content).toBe(ORIGINAL);
      expect(toolMessages[2].content).toContain(edit.sha256);
      expect(result.evidence.effects).toMatchObject({
        changed: ['snippet.mjs'],
        added: [],
        removed: [],
      });
    }
  );

  it('reports the missing edit tool in read-only mode with the remedy', async () => {
    const result = await run(LITERAL_EDIT);
    expect(result.outcome).toMatchObject({
      status: 'capability-gap',
      exitCode: EXIT.UNSUPPORTED,
      gap: { missingCapabilities: ['edit'], target: 'snippet.mjs' },
      remainingObligations: [
        'the requested change to snippet.mjs was not made or not verified',
        'set START_FORMAL_AI_EFFECTS=workspace-write to offer the edit and write tools',
      ],
    });
    expect(result.text).toBe(ORIGINAL);
  });

  it('shows a file through the read tool without changing it', async () => {
    const result = await run('show contents of snippet.mjs');
    expect(result.outcome).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.tools.map((t) => t.command)).toEqual(['read snippet.mjs']);
    expect(result.stdout).toBe(ORIGINAL);
    expect(result.text).toBe(ORIGINAL);
  });
});

describe('no interpreter bypass of the tool policy (#258)', () => {
  it('still refuses interpreters, in-place editors and shell redirection', () => {
    const cwd = fixture();
    const context = {
      cwd,
      effects: 'workspace-write',
      observed: new Set(['snippet.mjs']),
      observedDirs: new Set(['.']),
    };
    for (const command of [
      "node -e \"require('fs').writeFileSync('snippet.mjs', 'x')\"",
      'python3 -c pass',
      'perl -pi -e s/before/after/ snippet.mjs',
      'sed -i s/before/after/ snippet.mjs',
      'awk 1 snippet.mjs',
      'sh -c true',
      'bash -c true',
      'tee snippet.mjs',
      'dd of=snippet.mjs',
      'echo x > snippet.mjs',
    ]) {
      expect(evaluateCommand(command, context).allowed).toBe(false);
    }
  });
});

describe('edit requests through the CLI (#258)', () => {
  const checkout = fakeCheckout({ version: '0.355.29' });
  dirs.push(checkout);

  function cli(request, env = {}) {
    const root = tempDir('cli-258');
    const cwd = fixture();
    dirs.push(root);
    const before = snapshot(cwd);
    const result = spawnSync(
      process.execPath,
      [CLI, '--use-formal-ai', '--', request],
      {
        cwd,
        env: cliEnv(root, { START_FORMAL_AI_ROOT: checkout, ...env }),
        encoding: 'utf8',
        timeout: 60000,
      }
    );
    return {
      ...result,
      before,
      after: snapshot(cwd),
      text: fs.readFileSync(path.join(cwd, 'snippet.mjs'), 'utf8'),
      requests: sentRequests(root),
      evidence: readEvidence(readLog(root)),
    };
  }

  it.skipIf(!posix)('edits a file in workspace-write mode', () => {
    const result = cli(LITERAL_EDIT, {
      START_FORMAL_AI_EFFECTS: 'workspace-write',
    });
    expect(result.status).toBe(0);
    expect(result.text).toBe(EDITED);
    expect(result.stderr).toContain('[formal-ai] edit snippet.mjs');
    expect(result.stderr).toContain(
      '[formal-ai] readback confirmed edit snippet.mjs'
    );
    expect(result.requests[0].tools.map((t) => t.function.name)).toEqual([
      'bash',
      'read',
      'edit',
      'write',
    ]);
    expect(result.evidence.outcome).toMatchObject({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('exits 65 on a reported gap without changing anything', () => {
    const result = cli(LITERAL_EDIT);
    expect(result.status).toBe(EXIT.UNSUPPORTED);
    expect(result.after).toEqual(result.before);
    expect(result.stderr).toContain(
      'capability-gap: Formal AI reported a capability gap for snippet.mjs'
    );
    expect(result.stderr).toContain('START_FORMAL_AI_EFFECTS=workspace-write');
    expect(result.evidence.outcome).toMatchObject({
      status: 'capability-gap',
      exitCode: EXIT.UNSUPPORTED,
      gap: { reason: 'EditToolUnavailable' },
    });
  });

  it('answers a plain question with exit 0', () => {
    const result = cli('What is 2 + 2?');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[formal-ai] 2 + 2 = 4');
    expect(result.evidence.outcome).toMatchObject({
      status: 'answered',
      exitCode: 0,
    });
  });
});
