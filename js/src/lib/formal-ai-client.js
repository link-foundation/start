/**
 * Minimal client of the OpenAI-compatible agent-mode endpoint of Formal AI
 * (`POST /api/openai/v1/chat/completions`), used by `--use-formal-ai`
 * (issue #255). It offers the `bash` tool and the structured `read` tool, plus
 * `edit` and `write` when workspace changes are allowed (issue #258): Formal
 * AI picks the call, start decides whether and how it runs.
 *
 * An HTTP error keeps a bounded, sanitized excerpt of its body (the error
 * type, message and a preview) and the attempt count, so a failing runtime
 * names its cause (issue #257).
 */

const { EXIT } = require('./formal-ai-policy');
const { API_PREFIX } = require('./formal-ai-runtime');
const {
  FILE_TOOLS,
  describeFileCall,
  normalizeFileArgs,
} = require('./formal-ai-files');

const { AbortSignal } = globalThis;

const BASH_NAMES = new Set(['bash', 'shell', 'run_command']);
const TOOL_NAMES = new Set([...BASH_NAMES, ...Object.keys(FILE_TOOLS)]);
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
  constructor(message, exitCode = EXIT.PROTOCOL, details = null) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

/**
 * Tools offered to Formal AI: the change tools only when the effect mode
 * allows changes, so the advertised contract matches the policy.
 * @param {string} effects - Effect mode
 * @returns {object[]}
 */
function offeredTools(effects) {
  return effects === 'workspace-write'
    ? [BASH_TOOL, FILE_TOOLS.read, FILE_TOOLS.edit, FILE_TOOLS.write]
    : [BASH_TOOL, FILE_TOOLS.read];
}

const PREVIEW_CHARS = 500;
const MESSAGE_CHARS = 300;
const REDACTED = '[REDACTED]';

/**
 * One line of untrusted diagnostic text, bounded and without credentials:
 * known secrets (the bearer token start sent), authorization headers, bearer
 * or basic credentials and credential-named fields are masked, and control
 * characters become spaces.
 * @param {string} text - Diagnostic text from the runtime
 * @param {number} limit - Maximum characters kept
 * @param {string[]} [secrets] - Values that must never appear
 * @returns {string}
 */
function sanitizeDiagnostic(text, limit, secrets = []) {
  let clean = String(text);
  for (const secret of secrets) {
    if (secret) {
      clean = clean.split(secret).join(REDACTED);
    }
  }
  clean = clean
    .replace(
      /((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^"'\r\n,;}]*/gi,
      `$1${REDACTED}`
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${REDACTED}`)
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      `$1${REDACTED}`
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return clean.length > limit
    ? `${clean.slice(0, limit)}… [${clean.length - limit} more chars]`
    : clean;
}

/**
 * Structured diagnostics of an HTTP error response.
 * @param {number} status - HTTP status
 * @param {string} text - Response body
 * @param {string[]} [secrets] - Values to mask
 * @returns {{httpStatus: number, errorType: string|null, errorMessage: string|null, bodyPreview: string, bodyChars: number}}
 */
function httpErrorDetails(status, text, secrets = []) {
  let type = null;
  let message = null;
  try {
    const body = JSON.parse(text);
    const error = body && typeof body === 'object' ? body.error : null;
    if (error && typeof error === 'object') {
      type = typeof error.type === 'string' ? error.type : null;
      message = typeof error.message === 'string' ? error.message : null;
    } else if (typeof error === 'string') {
      message = error;
    } else if (body && typeof body.message === 'string') {
      message = body.message;
    }
  } catch {
    // Not JSON: the preview carries the body.
  }
  return {
    httpStatus: status,
    errorType: type === null ? null : sanitizeDiagnostic(type, 100, secrets),
    errorMessage:
      message === null
        ? null
        : sanitizeDiagnostic(message, MESSAGE_CHARS, secrets),
    bodyPreview: sanitizeDiagnostic(text, PREVIEW_CHARS, secrets),
    bodyChars: text.length,
  };
}

function httpErrorMessage(details) {
  const cause = details.errorMessage
    ? `${details.errorType ? `${details.errorType}: ` : ''}${details.errorMessage}`
    : details.bodyPreview.slice(0, MESSAGE_CHARS) || '(empty body)';
  return `Formal AI returned HTTP ${details.httpStatus}: ${cause}`;
}

/** Known structured gaps Formal AI answers instead of claiming success. */
const GAP_SCHEMAS = Object.freeze({
  'workspace-edit-capability-gap/v1': [
    'EditToolUnavailable',
    'ReadToolUnavailable',
  ],
  'workspace-change-verification-gap/v1': ['VerificationRunToolUnavailable'],
});
const CAPABILITIES = new Set([
  'read',
  'edit',
  'multi_edit',
  'write',
  'run',
  'bash',
]);

/**
 * Recognize a final answer that is exactly a known Formal AI capability gap.
 * Only the runtime's own answer counts: text that a tool result in this run
 * contained (file data echoed back) is never taken as a gap.
 * @param {string} content - Final answer content
 * @param {object[]} [messages] - Conversation so far
 * @returns {object|null} {schema, target, reason, missingCapabilities}
 */
function recognizeCapabilityGap(content, messages = []) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  let gap;
  try {
    gap = JSON.parse(text);
  } catch {
    return null;
  }
  const reasons =
    gap &&
    typeof gap.schema === 'string' &&
    Object.hasOwn(GAP_SCHEMAS, gap.schema)
      ? GAP_SCHEMAS[gap.schema]
      : null;
  const missing =
    gap && gap.missingCapabilities === undefined
      ? []
      : gap && gap.missingCapabilities;
  if (
    !reasons ||
    !reasons.includes(gap.reason) ||
    gap.complete !== false ||
    gap.verified !== false ||
    typeof gap.target !== 'string' ||
    !gap.target.trim() ||
    !Array.isArray(missing) ||
    !missing.every((c) => CAPABILITIES.has(c))
  ) {
    return null;
  }
  const echoed = messages.some(
    (m) => m && m.role === 'tool' && String(m.content || '').includes(text)
  );
  if (echoed) {
    return null;
  }
  return {
    schema: gap.schema,
    target: gap.target,
    reason: gap.reason,
    missingCapabilities: missing,
    complete: false,
    verified: false,
  };
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
    const raw = call.function.arguments || '{}';
    let args;
    try {
      args = JSON.parse(raw);
    } catch {
      throw new ProtocolError(`Formal AI sent non-JSON arguments for ${name}`);
    }
    if (!BASH_NAMES.has(name)) {
      const normalized = normalizeFileArgs(name, args);
      if (normalized.problem) {
        throw new ProtocolError(`Formal AI called ${normalized.problem}`);
      }
      return {
        id: call.id || null,
        name,
        tool: name,
        args: normalized.args,
        arguments: raw,
        command: describeFileCall(name, normalized.args),
      };
    }
    const command = args && (args.command ?? args.cmd);
    if (typeof command !== 'string' || !command.trim()) {
      throw new ProtocolError(`Formal AI called ${name} without a command`);
    }
    return { id: call.id || null, name, tool: 'bash', command };
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
 * @param {object} options - {baseUrl, bounds, deadline, token, tools}
 * @returns {{complete: Function, requests: number}}
 */
function createClient({
  baseUrl,
  bounds,
  deadline,
  token = null,
  tools = offeredTools(bounds.effects),
}) {
  const secrets = token ? [token] : [];
  const client = {
    requests: 0,
    async complete(messages, { signal } = {}) {
      let lastError = null;
      let attempts = 0;
      for (let attempt = 0; attempt <= bounds.maxRetries; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ProtocolError(
            'time budget exhausted while waiting for Formal AI',
            EXIT.BUDGET
          );
        }
        client.requests++;
        attempts++;
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
                tools,
              }),
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
                : AbortSignal.timeout(remaining),
            }
          );
          const text = await response.text();
          if (!response.ok) {
            const details = {
              ...httpErrorDetails(response.status, text, secrets),
              attempts,
            };
            const error = new ProtocolError(
              httpErrorMessage(details),
              EXIT.PROTOCOL,
              details
            );
            // A server error may be transient: retry it within the bounds,
            // keeping the latest diagnostics.
            if (response.status >= 500) {
              lastError = error;
              continue;
            }
            throw error;
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
          const cause = sanitizeDiagnostic(
            error.message,
            MESSAGE_CHARS,
            secrets
          );
          lastError = new ProtocolError(
            `Formal AI request failed: ${cause}`,
            EXIT.UNAVAILABLE,
            { cause, attempts }
          );
        }
      }
      const retries = attempts - 1;
      if (retries > 0) {
        lastError.message += ` (after ${retries} retr${retries === 1 ? 'y' : 'ies'})`;
      }
      lastError.details.attempts = attempts;
      throw lastError;
    },
  };
  return client;
}

module.exports = {
  BASH_TOOL,
  GAP_SCHEMAS,
  ProtocolError,
  TOOL_NAMES,
  createClient,
  httpErrorDetails,
  offeredTools,
  parseCompletion,
  recognizeCapabilityGap,
  sanitizeDiagnostic,
};
