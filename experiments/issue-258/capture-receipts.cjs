#!/usr/bin/env node
/**
 * Capture Formal AI receipts for the offline tests of issue #258.
 *
 * Starts the Formal AI runtime from START_FORMAL_AI_ROOT exactly as
 * `--use-formal-ai` does and runs each request through start's real task loop
 * in a fresh copy of a small fixture directory, once per advertised tool
 * contract: the released Bash-only contract of start 0.41.0 (`["bash"]`) and
 * start's current contract for the effect mode. Every chat completion (thinking
 * steps dropped), the tool receipts, the outcome and the fixture text are
 * written to js/test/fixtures/formal-ai/receipts-258.json, which the offline
 * stand-in (replay.cjs) answers from by request, offered tool names and turn.
 *
 * Usage:
 *   START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-258/capture-receipts.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = path.join(__dirname, '..', '..', 'js', 'src', 'lib');
const { resolveBounds } = require(path.join(lib, 'formal-ai-policy'));
const runtimeLib = require(path.join(lib, 'formal-ai-runtime'));
const { BASH_TOOL, createClient, offeredTools } = require(
  path.join(lib, 'formal-ai-client')
);
const { runFormalAiTask } = require(path.join(lib, 'formal-ai'));

const OUT = path.join(
  __dirname,
  '..',
  '..',
  'js',
  'test',
  'fixtures',
  'formal-ai',
  'receipts-258.json'
);

/** snippet.mjs with comments, odd whitespace and unrelated content. */
const FIXTURE = {
  'snippet.mjs': [
    '// Synthetic snippet for issue #258: keep this comment.',
    'const label = "before";',
    '',
    '\texport function show(name) {  ',
    '  return `${label}: ${name}`; // trailing comment',
    '}',
    '/* label = "before" in a comment stays */',
    '',
  ].join('\n'),
};

/** The issue's wording, and the same edit with the literal declarations. */
const EDIT =
  'In snippet.mjs, replace the before label declaration with the after label declaration, preserving all other content.';
const LITERAL =
  'In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.';

/** [request, effects, contract]; contract "bash-only" is start 0.41.0's. */
const REQUESTS = [
  [EDIT, 'workspace-write', 'bash-only'],
  [EDIT, 'read-only', 'current'],
  [EDIT, 'workspace-write', 'current'],
  [LITERAL, 'workspace-write', 'bash-only'],
  [LITERAL, 'read-only', 'current'],
  [LITERAL, 'workspace-write', 'current'],
  ['show contents of snippet.mjs', 'read-only', 'current'],
  ['What is 2 + 2?', 'read-only', 'current'],
  ['What is 2 + 2?', 'read-only', 'bash-only'],
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ai-258-'));
  for (const [name, text] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function reduce(raw) {
  const choice = raw.choices[0];
  return {
    finish_reason: choice.finish_reason,
    message: {
      role: 'assistant',
      content: choice.message.content,
      ...(choice.message.tool_calls
        ? { tool_calls: choice.message.tool_calls }
        : {}),
    },
  };
}

async function main() {
  const base = resolveBounds({});
  const runtime = await runtimeLib.startRuntime({
    env: process.env,
    bounds: base,
  });
  const receipts = [];
  try {
    for (const [request, effects, contract] of REQUESTS) {
      const cwd = fixture();
      const bounds = { ...base, effects };
      const tools =
        contract === 'bash-only' ? [BASH_TOOL] : offeredTools(effects);
      const client = createClient({
        baseUrl: runtime.baseUrl,
        bounds,
        deadline: Date.now() + bounds.timeoutMs,
        tools,
      });
      const responses = [];
      const recording = {
        async complete(messages, options) {
          const response = await client.complete(messages, options);
          responses.push(reduce(response.raw));
          return response;
        },
      };
      const evidence = await runFormalAiTask({
        request,
        cwd,
        env: process.env,
        bounds,
        client: recording,
      });
      const after = Object.fromEntries(
        Object.keys(FIXTURE).map((name) => [
          name,
          fs.readFileSync(path.join(cwd, name), 'utf8'),
        ])
      );
      receipts.push({
        request,
        effects,
        offered: tools.map((tool) => tool.function.name),
        responses,
        tools: evidence.steps
          .filter((s) => s.kind === 'tool')
          .map((s) => ({
            tool: s.tool,
            command: s.command,
            decision: s.decision,
            exitCode: s.exitCode ?? null,
          })),
        outcome: evidence.outcome,
        after,
      });
      fs.rmSync(cwd, { recursive: true, force: true });
      process.stderr.write(
        `${request} [${effects}, ${contract}] -> ${evidence.outcome.status} ${evidence.outcome.exitCode}\n`
      );
    }
  } finally {
    runtime.stop();
  }
  const identity = runtime.identity;
  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        source: `captured from Formal AI ${identity.version} (${identity.commit}) js agent mode by experiments/issue-258/capture-receipts.cjs`,
        capturedAt: new Date().toISOString().slice(0, 10),
        fixture: FIXTURE,
        receipts,
      },
      null,
      2
    )}\n`
  );
  process.stderr.write(
    `wrote ${OUT}; format it with: cd js && npx prettier --write ${path.relative(path.join(__dirname, '..', '..', 'js'), OUT)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
