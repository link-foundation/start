/**
 * Minimal client of the OpenAI-compatible agent-mode endpoint of Formal AI
 * (`POST /api/openai/v1/chat/completions`), used by `--use-formal-ai`
 * (issue #255). Only the `bash` function tool is offered: Formal AI picks the
 * command, start decides whether and how it runs.
 */

const { EXIT } = require('./formal-ai-policy');
const { API_PREFIX } = require('./formal-ai-runtime');

const { AbortSignal } = globalThis;

const TOOL_NAMES = new Set(['bash', 'shell', 'run_command']);
const BASH_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'bash',
    description:
      'Run one command in the working directory. Pipes, redirects, globs and variables are not supported.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
});

class ProtocolError extends Error {
  constructor(message, exitCode = EXIT.PROTOCOL) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Normalize one chat completion into what the loop needs.
 * @param {object} body - Parsed JSON response
 * @returns {{content: string, finishReason: string|null, toolCalls: object[], handler: string|null}}
 */
function parseCompletion(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  if (!choice || typeof choice.message !== 'object' || !choice.message) {
    throw new ProtocolError('Formal AI response has no choices[0].message');
  }
  const { message } = choice;
  const steps = Array.isArray(message.thinking_steps)
    ? message.thinking_steps
    : [];
  const dispatch = steps.find((s) => s && s.step === 'dispatch_handler');
  const toolCalls = (message.tool_calls || []).map((call) => {
    const name = call && call.function && call.function.name;
    if (!TOOL_NAMES.has(name)) {
      throw new ProtocolError(`Formal AI called an unsupported tool "${name}"`);
    }
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      throw new ProtocolError(`Formal AI sent non-JSON arguments for ${name}`);
    }
    const command = args.command ?? args.cmd;
    if (typeof command !== 'string' || !command.trim()) {
      throw new ProtocolError(`Formal AI called ${name} without a command`);
    }
    return { id: call.id || null, name, command };
  });
  return {
    content: typeof message.content === 'string' ? message.content : '',
    finishReason: choice.finish_reason || null,
    toolCalls,
    handler: dispatch ? String(dispatch.detail) : null,
  };
}

/**
 * Create a client bound to one runtime.
 * @param {object} options - {baseUrl, bounds, deadline, token}
 * @returns {{complete: Function, requests: number}}
 */
function createClient({ baseUrl, bounds, deadline, token = null }) {
  const client = {
    requests: 0,
    async complete(messages, { signal } = {}) {
      let lastError = null;
      for (let attempt = 0; attempt <= bounds.maxRetries; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ProtocolError(
            'time budget exhausted while waiting for Formal AI',
            EXIT.BUDGET
          );
        }
        client.requests++;
        try {
          const response = await fetch(
            `${baseUrl}${API_PREFIX}/chat/completions`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                model: 'formal-ai',
                messages,
                tools: [BASH_TOOL],
              }),
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
                : AbortSignal.timeout(remaining),
            }
          );
          const text = await response.text();
          if (response.status >= 500) {
            lastError = new ProtocolError(
              `Formal AI returned HTTP ${response.status}`
            );
            continue;
          }
          if (!response.ok) {
            throw new ProtocolError(
              `Formal AI returned HTTP ${response.status}: ${text.slice(0, 300)}`
            );
          }
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            throw new ProtocolError('Formal AI returned a non-JSON response');
          }
          return { raw: body, ...parseCompletion(body) };
        } catch (error) {
          if (error instanceof ProtocolError) {
            throw error;
          }
          if (signal && signal.aborted) {
            throw error;
          }
          if (error.name === 'TimeoutError') {
            throw new ProtocolError(
              'time budget exhausted while waiting for Formal AI',
              EXIT.BUDGET
            );
          }
          lastError = new ProtocolError(
            `Formal AI request failed: ${error.message}`,
            EXIT.UNAVAILABLE
          );
        }
      }
      if (bounds.maxRetries > 0) {
        lastError.message += ` (after ${bounds.maxRetries} retr${bounds.maxRetries === 1 ? 'y' : 'ies'})`;
      }
      throw lastError;
    },
  };
  return client;
}

module.exports = {
  BASH_TOOL,
  ProtocolError,
  TOOL_NAMES,
  createClient,
  parseCompletion,
};
