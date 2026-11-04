#!/usr/bin/env node
/**
 * Capture Formal AI receipts for the offline tests of issue #261.
 *
 * Starts the Formal AI runtime from START_FORMAL_AI_ROOT exactly as
 * `--use-formal-ai` does and runs each held-out request through start's real
 * task loop in a fresh fixture directory (files, symbolic links and files
 * beside the workspace, named `../name`), offering
 * start's current tool contract for the effect mode. Every chat completion
 * (thinking steps dropped), the tool receipts, the outcome and the bytes of
 * every fixture file afterwards are written to
 * js/test/fixtures/formal-ai/receipts-261.json, which the offline stand-in
 * (replay.cjs) answers from by request, offered tool names and turn.
 *
 * Usage:
 *   START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-261/capture-receipts.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = path.join(__dirname, '..', '..', 'js', 'src', 'lib');
const { resolveBounds } = require(path.join(lib, 'formal-ai-policy'));
const runtimeLib = require(path.join(lib, 'formal-ai-runtime'));
const { createClient, offeredTools } = require(
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
  'receipts-261.json'
);

/** The issue's synthetic reproduction. */
const BASE = { 'draft.txt': 'draft\n', 'verified-source.txt': 'verified\n' };

/** [name, request, effects, files, symlinks {link: target}]. */
const SCENARIOS = [
  [
    'issue reproduction',
    'In draft.txt, replace «draft» with «verified».',
    'workspace-write',
    BASE,
    {},
  ],
  [
    'issue reproduction, read-only',
    'In draft.txt, replace «draft» with «verified».',
    'read-only',
    BASE,
    {},
  ],
  [
    'mismatched OLD',
    'In mismatch.txt, replace «drafted» with «verified».',
    'workspace-write',
    { 'mismatch.txt': 'draft\n', 'verified-source.txt': 'verified\n' },
    {},
  ],
  [
    'repeated occurrences',
    'In twice.txt, replace «draft» with «verified».',
    'workspace-write',
    { 'twice.txt': 'draft one\ndraft two\n' },
    {},
  ],
  [
    'Unicode and CRLF',
    'In unicode.txt, replace «café» with «naïve».',
    'workspace-write',
    { 'unicode.txt': 'Ünïcödé café ☕\r\nsecond line 🙂\r\nno final newline' },
    {},
  ],
  [
    'symlinked path',
    'In link.txt, replace «draft» with «verified».',
    'workspace-write',
    { 'real.txt': 'draft\n' },
    { 'link.txt': 'real.txt' },
  ],
  [
    'symlink leaving the workspace',
    'In escape.txt, replace «draft» with «verified».',
    'workspace-write',
    { '../outside.txt': 'draft\n' },
    { 'escape.txt': '../outside.txt' },
  ],
  [
    'foreign path',
    'In ../outside.txt, replace «draft» with «verified».',
    'workspace-write',
    { ...BASE, '../outside.txt': 'draft\n' },
    {},
  ],
];

/** A workspace `ws` in a fresh directory; `../name` files sit beside it. */
function fixture(files, links) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ai-261-'));
  const dir = path.join(root, 'ws');
  fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  for (const [link, target] of Object.entries(links)) {
    fs.symlinkSync(target, path.join(dir, link));
  }
  return { root, dir };
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
    for (const [name, request, effects, files, links] of SCENARIOS) {
      const { root, dir: cwd } = fixture(files, links);
      const bounds = { ...base, effects };
      const tools = offeredTools(effects);
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
        Object.keys(files).map((file) => [
          file,
          fs.readFileSync(path.join(cwd, file), 'utf8'),
        ])
      );
      receipts.push({
        name,
        request,
        effects,
        files,
        links,
        offered: tools.map((tool) => tool.function.name),
        responses,
        tools: evidence.steps
          .filter((s) => s.kind === 'tool')
          .map((s) => ({
            tool: s.tool || 'bash',
            command: s.command,
            decision: s.decision,
            exitCode: s.exitCode ?? null,
          })),
        outcome: evidence.outcome,
        after,
      });
      fs.rmSync(root, { recursive: true, force: true });
      process.stderr.write(
        `${name} [${effects}] -> ${evidence.outcome.status} ${evidence.outcome.exitCode}: ${evidence.outcome.message}\n`
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
        source: `captured from Formal AI ${identity.version} (${identity.commit}) js agent mode by experiments/issue-261/capture-receipts.cjs`,
        capturedAt: new Date().toISOString().slice(0, 10),
        receipts,
      },
      null,
      2
    )}\n`
  );
  process.stderr.write(`wrote ${OUT}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
