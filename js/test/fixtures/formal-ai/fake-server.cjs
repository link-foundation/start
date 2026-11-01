/**
 * Offline stand-in for the Formal AI JavaScript agent-mode server used by the
 * `--use-formal-ai` tests (issue #255). Tests assemble a fake checkout whose
 * js/server/main.mjs loads this file, so start spawns it exactly like a real
 * runtime: `<node> main.mjs --agent-mode --host 127.0.0.1 --port N --silent`.
 *
 * It replays receipts.json, captured from the real runtime: the reply to a
 * request is its recorded response number k, where k is the number of
 * assistant turns already in the conversation. Unknown requests get the
 * runtime's "did not understand" reply. A few SYNTHETIC scenarios cover
 * states a real runtime cannot be made to produce on demand; their
 * requests start with `synthetic:`.
 *
 * Every request body is appended as one JSON line to FORMAL_AI_MEMORY_PATH
 * (set through START_FORMAL_AI_MEMORY_PATH), so tests can inspect exactly
 * what start sent.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { receipts } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'receipts.json'), 'utf8')
);

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

/** SYNTHETIC scenarios: request -> (assistantTurns, messages) -> message|status */
const SYNTHETIC = {
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
  // A write that claims success but leaves no trace (fake `mkdir` on PATH).
  'synthetic: unverified mkdir': (turns) =>
    turns === 0 ? toolCall('test ! -e out') : toolCall('mkdir out'),
};

function reply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const request = (messages.find((m) => m.role === 'user') || {}).content || '';
  const turns = messages.filter((m) => m.role === 'assistant').length;
  if (SYNTHETIC[request]) {
    return SYNTHETIC[request](turns, messages);
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

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1] || '127.0.0.1';
const log = process.env.FORMAL_AI_MEMORY_PATH;

http
  .createServer((req, res) => {
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
  })
  .listen(port, host);
