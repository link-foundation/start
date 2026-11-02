/**
 * Issue #257: an HTTP 5xx reply of the Formal AI runtime keeps its bounded,
 * sanitized cause (error type, message and body preview) and the attempt
 * count in the final error and in the evidence, also after bounded retries,
 * without a fallback and without exposing credentials or the environment.
 *
 * The offline stand-in replays the exact 500 body a released start discarded:
 * {"error":{"message":"Aborted(Error: LocalProductWasmForbidden). ...",
 * "type":"formal_ai_error"}}.
 */
const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('child_process');
const http = require('http');
const { resolveBounds, EXIT } = require('../src/lib/formal-ai-policy');
const {
  ProtocolError,
  createClient,
  httpErrorDetails,
  sanitizeDiagnostic,
} = require('../src/lib/formal-ai-client');
const { runFormalAiTask } = require('../src/lib/formal-ai');
const {
  CAPTURED_500,
  createFakeServer,
} = require('./fixtures/formal-ai/replay.cjs');
const {
  CLI,
  cleanup,
  cliEnv,
  fakeCheckout,
  readEvidence,
  readLog,
  receiptFixture,
  sentRequests,
  snapshot,
  tempDir,
} = require('./fixtures/formal-ai/helpers.cjs');

const CAUSE =
  'Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info.';

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

const ask = (request) => [{ role: 'user', content: request }];

/** One client request against the stand-in; resolves to the thrown error. */
async function failure(request, { maxRetries = 0, token = null } = {}) {
  const bounds = { ...resolveBounds({}), maxRetries };
  const client = createClient({
    baseUrl,
    bounds,
    deadline: Date.now() + bounds.timeoutMs,
    token,
  });
  try {
    await client.complete(ask(request));
  } catch (error) {
    return { error, requests: client.requests };
  }
  throw new Error('expected the request to fail');
}

describe('5xx diagnostics of the Formal AI client (#257)', () => {
  it('keeps the captured cause when no retry is allowed', async () => {
    const { error, requests } = await failure(
      'synthetic: server error (captured #257)'
    );
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.exitCode).toBe(EXIT.PROTOCOL);
    expect(error.message).toBe(
      `Formal AI returned HTTP 500: formal_ai_error: ${CAUSE}`
    );
    expect(error.details).toEqual({
      httpStatus: 500,
      errorType: 'formal_ai_error',
      errorMessage: CAUSE,
      bodyPreview: CAPTURED_500,
      bodyChars: CAPTURED_500.length,
      attempts: 1,
    });
    expect(requests).toBe(1);
  });

  it('keeps the cause and the attempt count after bounded retries', async () => {
    const { error, requests } = await failure(
      'synthetic: server error (captured #257)',
      { maxRetries: 1 }
    );
    expect(error.exitCode).toBe(EXIT.PROTOCOL);
    expect(error.message).toBe(
      `Formal AI returned HTTP 500: formal_ai_error: ${CAUSE} (after 1 retry)`
    );
    expect(error.details).toMatchObject({
      httpStatus: 500,
      errorType: 'formal_ai_error',
      errorMessage: CAUSE,
      attempts: 2,
    });
    expect(requests).toBe(2);
  });

  it('never exposes the token, authorization values or control characters', async () => {
    const token = 'sk-test-0123456789';
    const { error } = await failure('synthetic: server error with secrets', {
      maxRetries: 1,
      token,
    });
    const text = JSON.stringify({ message: error.message, ...error.details });
    expect(text).not.toContain(token);
    expect(text).not.toContain('sk-live-abcdef');
    expect(text).not.toContain('\u0007');
    expect(error.details).toMatchObject({
      httpStatus: 503,
      errorType: 'upstream_error',
      attempts: 2,
    });
    expect(error.message).toContain('HTTP 503: upstream_error: proxy refused');
    expect(error.message).toContain('[REDACTED]');
  });

  it('bounds and sanitizes any body', () => {
    const long = `${'x'.repeat(2000)}`;
    const details = httpErrorDetails(502, long, []);
    expect(details.bodyChars).toBe(2000);
    expect(details.bodyPreview.length).toBeLessThan(600);
    expect(details.bodyPreview).toContain('[1500 more chars]');
    expect(details.errorMessage).toBeNull();
    expect(httpErrorDetails(500, '', [])).toMatchObject({
      bodyPreview: '',
      bodyChars: 0,
      errorType: null,
      errorMessage: null,
    });
    expect(httpErrorDetails(500, '{"error":"plain text"}', [])).toMatchObject({
      errorMessage: 'plain text',
    });
    expect(
      sanitizeDiagnostic(
        'Authorization: Basic dXNlcjpwYXNz\nproxy-authorization: Bearer abc password=hunter2 secret-value',
        500,
        ['secret-value']
      )
    ).not.toMatch(/dXNlcjpwYXNz|abc|hunter2|secret-value|\n/);
  });

  it('keeps 4xx bodies and does not retry them', async () => {
    const error4xx = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"bad tools","type":"invalid_request"}}');
      });
    });
    await new Promise((resolve) => error4xx.listen(0, '127.0.0.1', resolve));
    try {
      const bounds = { ...resolveBounds({}), maxRetries: 2 };
      const client = createClient({
        baseUrl: `http://127.0.0.1:${error4xx.address().port}`,
        bounds,
        deadline: Date.now() + bounds.timeoutMs,
      });
      const error = await client.complete(ask('x')).catch((e) => e);
      expect(error.message).toBe(
        'Formal AI returned HTTP 400: invalid_request: bad tools'
      );
      expect(error.details).toMatchObject({ httpStatus: 400, attempts: 1 });
      expect(client.requests).toBe(1);
    } finally {
      error4xx.close();
    }
  });

  it('records the cause in the task evidence and changes nothing', async () => {
    const cwd = receiptFixture();
    dirs.push(cwd);
    const before = snapshot(cwd);
    const bounds = {
      ...resolveBounds({}),
      maxRetries: 1,
      effects: 'workspace-write',
    };
    const client = createClient({
      baseUrl,
      bounds,
      deadline: Date.now() + bounds.timeoutMs,
    });
    const evidence = await runFormalAiTask({
      request: 'synthetic: server error (captured #257)',
      cwd,
      env: { PATH: process.env.PATH },
      bounds,
      client,
    });
    expect(evidence.outcome).toMatchObject({
      status: 'protocol-error',
      exitCode: EXIT.PROTOCOL,
      message: `Formal AI returned HTTP 500: formal_ai_error: ${CAUSE} (after 1 retry)`,
      diagnostics: {
        httpStatus: 500,
        errorType: 'formal_ai_error',
        errorMessage: CAUSE,
        attempts: 2,
      },
    });
    expect(evidence.steps.filter((s) => s.kind === 'tool')).toEqual([]);
    expect(snapshot(cwd)).toEqual(before);
  });
});

describe('5xx diagnostics through the CLI (#257)', () => {
  it('exits 70 with the cause in stderr, log and evidence', () => {
    const checkout = fakeCheckout();
    const root = tempDir('cli-257');
    const cwd = receiptFixture();
    dirs.push(checkout, root, cwd);
    const before = snapshot(cwd);
    const result = spawnSync(
      process.execPath,
      [CLI, '--use-formal-ai', '--', 'synthetic: server error (captured #257)'],
      {
        cwd,
        env: cliEnv(root, {
          START_FORMAL_AI_ROOT: checkout,
          START_FORMAL_AI_MAX_RETRIES: '0',
        }),
        encoding: 'utf8',
        timeout: 60000,
      }
    );
    expect(result.status).toBe(EXIT.PROTOCOL);
    expect(result.stderr).toContain(CAUSE);
    expect(sentRequests(root)).toHaveLength(1);
    expect(snapshot(cwd)).toEqual(before);
    const log = readLog(root);
    const evidence = readEvidence(log);
    expect(evidence.outcome).toMatchObject({
      status: 'protocol-error',
      exitCode: EXIT.PROTOCOL,
      message: `Formal AI returned HTTP 500: formal_ai_error: ${CAUSE}`,
      diagnostics: {
        httpStatus: 500,
        errorType: 'formal_ai_error',
        errorMessage: CAUSE,
        bodyPreview: CAPTURED_500,
        attempts: 1,
      },
    });
    expect(evidence.formalAiRequests).toBe(1);
    // The evidence never carries the environment.
    expect(JSON.stringify(evidence)).not.toContain(process.env.PATH);
  });
});
