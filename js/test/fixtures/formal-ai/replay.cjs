/**
 * Replies of the offline Formal AI stand-in (issue #255), shared by the fake
 * runtime process (fake-server.cjs) and in-process tests.
 *
 * A request gets its recorded response number k from receipts.json, where k
 * is the number of assistant turns already in the conversation. Unknown
 * requests get the runtime's "did not understand" reply. SYNTHETIC scenarios
 * (requests starting with `synthetic:`) cover states a real runtime cannot be
 * made to produce on demand. A number reply is an HTTP error status, and a
 * `{status, text}` reply an HTTP error with that exact body.
 *
 * Receipts of issue #258 (receipts-258.json) also record the tool names start
 * offered; they answer only a request offering exactly those tools, so the
 * released Bash-only contract and the structured file tools replay apart.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const { receipts } = load('receipts.json');
const edits = load('receipts-258.json');

/**
 * The HTTP 500 body a released start discarded (issue #257), captured from a
 * Formal AI 0.355.28 runtime whose local policy forbids its Rust grammar WASM.
 */
const CAPTURED_500 =
  '{"error":{"message":"Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info.","type":"formal_ai_error"}}';

function toolCall(command, id = `call_${Math.random().toString(16).slice(2)}`) {
  return {
    role: 'assistant',
    content: 'Let me run the requested command to get that for you.',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command }) },
      },
    ],
  };
}

const answer = (content) => ({ role: 'assistant', content });

/**
 * SYNTHETIC scenarios: request -> (assistantTurns, messages, body) ->
 * message | status | {status, text}.
 * A constant list matched by string equality: request text only selects among
 * these entries and is never used as a property key, so `constructor`,
 * `toString` and similar names reach the "did not understand" reply.
 */
const SYNTHETIC = Object.freeze(
  Object.entries({
    // Never stops asking for more reads: exhausts the step budget.
    'synthetic: loop forever': () => toolCall('pwd'),
    // A tool start must not run.
    'synthetic: call an unknown tool': () => ({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'python', arguments: '{"code":"1"}' },
        },
      ],
    }),
    // A long-running read (a fake `cat` from the test PATH sleeps).
    'synthetic: read slowly': (turns) =>
      turns === 0 ? toolCall('cat slow.txt') : answer('done'),
    // A tool that does not exist on PATH.
    'synthetic: run a missing tool': (turns) =>
      turns === 0 ? toolCall('tree') : answer('The `tree` command failed.'),
    // Writes outside the observed workspace.
    'synthetic: overwrite without looking': () => toolCall('touch README.md'),
    'synthetic: write outside': () => toolCall('touch ../escape.txt'),
    // A server error on every request.
    'synthetic: server error': () => 500,
    // The captured runtime failure of issue #257 on every request.
    'synthetic: server error (captured #257)': () => ({
      status: 500,
      text: CAPTURED_500,
    }),
    // A 503 whose body echoes credentials and control characters.
    'synthetic: server error with secrets': () => ({
      status: 503,
      text: JSON.stringify({
        error: {
          type: 'upstream_error',
          message: `proxy refused Authorization: Bearer sk-test-0123456789\u0007 api_key=sk-live-abcdef`,
        },
      }),
    }),
    // A write that claims success but leaves no trace (fake `mkdir` on PATH).
    'synthetic: unverified mkdir': (turns) =>
      turns === 0 ? toolCall('test ! -e out') : toolCall('mkdir out'),
  })
);

function reply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const request = (messages.find((m) => m.role === 'user') || {}).content || '';
  const turns = messages.filter((m) => m.role === 'assistant').length;
  const scenario = SYNTHETIC.find(([name]) => name === request);
  if (scenario) {
    const [, respond] = scenario;
    return respond(turns, messages, body);
  }
  const offered = (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => tool && tool.function && tool.function.name)
    .join(',');
  const edit = edits.receipts.find(
    (r) => r.request === request && r.offered.join(',') === offered
  );
  if (edit && edit.responses[turns]) {
    return edit.responses[turns].message;
  }
  const receipt = receipts.find((r) => r.request === request);
  if (receipt && receipt.responses[turns]) {
    return receipt.responses[turns].message;
  }
  return {
    role: 'assistant',
    content: "I didn't understand you. Could you rephrase?",
    thinking_steps: [{ step: 'dispatch_handler', detail: 'unknown' }],
  };
}

/**
 * HTTP server speaking the agent-mode subset start uses.
 * @param {string} [log] - File that receives every request body as a JSON line
 * @returns {import('http').Server}
 */
function createFakeServer(log) {
  return http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: 'formal-ai' }] });
        return;
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        send(404, { error: 'not found' });
        return;
      }
      const body = JSON.parse(text);
      if (log) {
        fs.appendFileSync(log, `${JSON.stringify(body)}\n`);
      }
      const message = reply(body);
      if (typeof message === 'number') {
        send(message, { error: 'synthetic failure' });
        return;
      }
      if (typeof message.status === 'number') {
        res.writeHead(message.status, { 'content-type': 'application/json' });
        res.end(message.text);
        return;
      }
      send(200, {
        id: 'chatcmpl_fake',
        object: 'chat.completion',
        model: 'formal-ai',
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
      });
    });
  });
}

module.exports = {
  CAPTURED_500,
  SYNTHETIC,
  createFakeServer,
  edits,
  receipts,
  reply,
};
