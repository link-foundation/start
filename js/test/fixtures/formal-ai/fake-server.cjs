/**
 * Offline stand-in for the Formal AI JavaScript agent-mode server used by the
 * `--use-formal-ai` tests (issue #255). Tests assemble a fake checkout whose
 * js/server/main.mjs loads this file, so start spawns it exactly like a real
 * runtime: `<node> main.mjs --agent-mode --host 127.0.0.1 --port N --silent`.
 *
 * Replies come from replay.cjs. Every request body is appended as one JSON
 * line to FORMAL_AI_MEMORY_PATH (set through START_FORMAL_AI_MEMORY_PATH), so
 * tests can inspect exactly what start sent.
 */

const { createFakeServer } = require('./replay.cjs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1] || '127.0.0.1';
createFakeServer(process.env.FORMAL_AI_MEMORY_PATH).listen(port, host);
