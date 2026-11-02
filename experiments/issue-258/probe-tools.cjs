#!/usr/bin/env node
/**
 * Issue #258 probe: send one edit request to a real Formal AI runtime with
 * different advertised tool sets and print the raw replies (content,
 * tool_calls, thinking-step names). Uses start's own runtime resolution.
 *
 *   START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-258/probe-tools.cjs
 */
const path = require('path');
const lib = path.join(__dirname, '..', '..', 'js', 'src', 'lib');
const { resolveBounds } = require(path.join(lib, 'formal-ai-policy'));
const runtimeLib = require(path.join(lib, 'formal-ai-runtime'));

const tool = (name, properties, required) => ({
  type: 'function',
  function: {
    name,
    description: name,
    parameters: { type: 'object', properties, required },
  },
});
const TOOLS = {
  bash: tool('bash', { command: { type: 'string' } }, ['command']),
  read: tool('read', { path: { type: 'string' } }, ['path']),
  edit: tool(
    'edit',
    {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    ['path', 'old_string', 'new_string']
  ),
  write: tool(
    'write',
    { path: { type: 'string' }, content: { type: 'string' } },
    ['path', 'content']
  ),
};
const PROMPT =
  process.argv[2] ||
  'In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.';

async function main() {
  const runtime = await runtimeLib.startRuntime({
    env: process.env,
    bounds: resolveBounds({}),
  });
  try {
    for (const names of [['bash'], ['bash', 'read', 'edit', 'write']]) {
      const messages = [{ role: 'user', content: PROMPT }];
      for (let turn = 0; turn < 4; turn++) {
        const res = await fetch(
          `${runtime.baseUrl}${runtimeLib.API_PREFIX}/chat/completions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'formal-ai',
              messages,
              tools: names.map((n) => TOOLS[n]),
            }),
          }
        );
        const body = await res.json();
        const msg = body.choices[0].message;
        console.log(
          JSON.stringify(
            {
              tools: names,
              turn,
              status: res.status,
              finish: body.choices[0].finish_reason,
              content: msg.content,
              tool_calls: msg.tool_calls,
              steps: (msg.thinking_steps || []).map(
                (s) => `${s.step}:${String(s.detail).slice(0, 80)}`
              ),
            },
            null,
            1
          )
        );
        if (!msg.tool_calls || !msg.tool_calls.length) break;
        messages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls,
        });
        const call = msg.tool_calls[0];
        const result =
          call.function.name === 'read'
            ? 'export const label = "before";\n// keep me\n'
            : '';
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  } finally {
    runtime.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
