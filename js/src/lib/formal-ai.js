/**
 * The task loop of the experimental `--use-formal-ai` mode (issue #255).
 *
 * The natural-language request goes to Formal AI verbatim. Formal AI decides
 * what to observe and which tool calls to make; start checks every call
 * against the effect policy, runs approved calls, reports each receipt back
 * and keeps evidence of what actually happened. The run ends when Formal AI
 * gives its final answer, says it did not understand, or a bound, refusal,
 * protocol error or cancellation stops it, and the exit status says which.
 */

const policy = require('./formal-ai-policy');
const { formatToolResult, runTool } = require('./formal-ai-tool');

const { EXIT } = policy;
const PREVIEW_CHARS = 2000;
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function preview(text) {
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}… [${text.length - PREVIEW_CHARS} more chars]`
    : text;
}

/**
 * Run one request to completion.
 * @param {object} options
 * @param {string} options.request - Natural-language request, never executed
 * @param {string} options.cwd - Working directory of the tools
 * @param {object} options.env - Tool environment
 * @param {object} options.bounds - policy.resolveBounds() result
 * @param {object} options.client - formal-ai-client createClient() result
 * @param {object} [options.io] - {stdout, stderr, note(text)} mirrors
 * @param {AbortSignal} [options.signal] - Cancellation
 * @param {object} [options.evidence] - Evidence object to fill (for crash-safe writes)
 * @returns {Promise<object>} Evidence with `outcome`
 */
async function runFormalAiTask(options) {
  const { request, cwd, env, bounds, client, signal = null } = options;
  const io = options.io || {};
  const note = io.note || (() => {});
  const deadline = options.deadline || Date.now() + bounds.timeoutMs;
  const evidence = options.evidence || {};
  Object.assign(evidence, {
    request,
    cwd,
    effectsMode: bounds.effects,
    bounds: { ...bounds },
    steps: [],
    effects: { added: [], removed: [], changed: [], complete: true },
    outcome: null,
  });
  const context = {
    cwd,
    effects: bounds.effects,
    observed: new Set(),
    observedDirs: new Set(),
  };
  const finish = (status, exitCode, message, remaining = []) => {
    evidence.outcome = {
      status,
      exitCode,
      message,
      remainingObligations: remaining,
    };
    return evidence;
  };
  const cancelled = () =>
    finish(
      'cancelled',
      SIGNAL_EXIT[signal && signal.reason] || 130,
      `cancelled by ${(signal && signal.reason) || 'SIGINT'}`,
      ['the task was interrupted; later steps did not run']
    );
  if (signal) {
    // Cancellation stops the running tool's whole process group.
    signal.addEventListener('abort', () => {
      if (evidence.activeKill) {
        evidence.activeKill('SIGTERM');
      }
    });
  }
  const messages = [{ role: 'user', content: request }];
  let lastExit = null;
  let toolCalls = 0;

  for (let turn = 1; turn <= bounds.maxSteps; turn++) {
    if (signal && signal.aborted) {
      return cancelled();
    }
    if (Date.now() >= deadline) {
      return finish('budget-exhausted', EXIT.BUDGET, 'time budget exhausted', [
        'the task did not finish within START_FORMAL_AI_TIMEOUT_MS',
      ]);
    }
    let response;
    try {
      response = await client.complete(messages, { signal });
    } catch (error) {
      if (signal && signal.aborted) {
        return cancelled();
      }
      const status =
        error.exitCode === EXIT.BUDGET
          ? 'budget-exhausted'
          : error.exitCode === EXIT.UNAVAILABLE
            ? 'unavailable'
            : 'protocol-error';
      return finish(status, error.exitCode || EXIT.PROTOCOL, error.message, [
        'Formal AI did not complete the task',
      ]);
    }
    evidence.steps.push({
      kind: 'response',
      turn,
      finishReason: response.finishReason,
      handler: response.handler,
      content: preview(response.content),
      toolCalls: response.toolCalls.map((c) => c.command),
    });
    if (!response.toolCalls.length) {
      if (response.content) {
        note(response.content);
      }
      if (response.handler === 'unknown' && toolCalls === 0) {
        return finish(
          'unsupported',
          EXIT.UNSUPPORTED,
          'Formal AI did not understand the request; no tool ran',
          ['rephrase the request or perform it manually']
        );
      }
      if (lastExit === null) {
        return finish('answered', 0, 'Formal AI answered without tools');
      }
      return finish(
        'completed',
        lastExit,
        lastExit === 0
          ? `finished after ${toolCalls} tool call(s)`
          : `finished; the last tool call exited with ${lastExit}`,
        lastExit === 0 ? [] : ['the last tool call failed']
      );
    }
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls.map((call, index) => ({
        id: call.id || `call_${turn}_${index}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify({ command: call.command }),
        },
      })),
    });
    for (const [index, call] of response.toolCalls.entries()) {
      const callId = messages[messages.length - 1].tool_calls[index].id;
      toolCalls++;
      if (toolCalls > bounds.maxSteps) {
        return finish(
          'budget-exhausted',
          EXIT.BUDGET,
          `tool call budget of ${bounds.maxSteps} exhausted`,
          ['the task did not finish within START_FORMAL_AI_MAX_STEPS']
        );
      }
      const outcome = await runCall({
        call,
        context,
        cwd,
        env,
        bounds,
        deadline,
        io,
        note,
        evidence,
      });
      if (signal && signal.aborted) {
        return cancelled();
      }
      if (outcome.stop) {
        return finish(...outcome.stop);
      }
      lastExit = outcome.exitCode;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: outcome.result,
      });
    }
  }
  return finish(
    'budget-exhausted',
    EXIT.BUDGET,
    `step budget of ${bounds.maxSteps} exhausted`,
    ['the task did not finish within START_FORMAL_AI_MAX_STEPS']
  );
}

async function runCall({
  call,
  context,
  cwd,
  env,
  bounds,
  deadline,
  io,
  note,
  evidence,
}) {
  const decision = policy.evaluateCommand(call.command, context);
  const step = { kind: 'tool', command: call.command, argv: decision.tokens };
  evidence.steps.push(step);
  if (!decision.allowed) {
    step.decision = 'refused';
    step.reason = decision.reason;
    note(`refused \`${call.command}\`: ${decision.reason}`);
    return {
      stop: [
        'refused',
        EXIT.REFUSED,
        `refused \`${call.command}\`: ${decision.reason}`,
        ['the refused call did not run; nothing after it ran either'],
      ],
    };
  }
  step.decision = 'allowed';
  step.effect = decision.kind;
  note(`$ ${call.command}`);
  const before = policy.fingerprint(cwd, bounds.maxFingerprintEntries);
  const receipt = await runTool({
    argv: decision.tokens,
    cwd,
    env,
    timeoutMs: Math.max(
      1,
      Math.min(bounds.toolTimeoutMs, deadline - Date.now())
    ),
    maxOutputBytes: bounds.maxOutputBytes,
    stdout: io.stdout,
    stderr: io.stderr,
    onSpawn: (kill) => {
      evidence.activeKill = kill;
    },
  });
  delete evidence.activeKill;
  const diff = policy.diffFingerprints(
    before,
    policy.fingerprint(cwd, bounds.maxFingerprintEntries)
  );
  Object.assign(step, {
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    timedOut: receipt.timedOut,
    durationMs: receipt.durationMs,
    truncated: receipt.truncated,
    spawnError: receipt.spawnError,
    stdout: preview(receipt.stdout),
    stderr: preview(receipt.stderr),
    effects: diff,
  });
  for (const key of ['added', 'removed', 'changed']) {
    evidence.effects[key].push(...diff[key]);
  }
  evidence.effects.complete = evidence.effects.complete && diff.complete;
  if (receipt.truncated) {
    note(
      `output truncated at START_FORMAL_AI_MAX_OUTPUT_BYTES=${bounds.maxOutputBytes}`
    );
  }
  if (receipt.timedOut) {
    return {
      stop: [
        'budget-exhausted',
        EXIT.BUDGET,
        `\`${call.command}\` exceeded the tool time limit and was stopped`,
        ['the stopped call may have done part of its work'],
      ],
    };
  }
  if (decision.kind === 'read') {
    policy.recordObservation(decision, context);
    if (policy.hasEffects(diff)) {
      step.unexpectedEffects = true;
      note(
        `warning: the working directory changed during a read-only call (${[...diff.added, ...diff.removed, ...diff.changed].slice(0, 5).join(', ')})`
      );
    }
  } else if (receipt.exitCode === 0) {
    step.verification = policy.verifyChange(decision.tokens, cwd);
    if (!step.verification.verified) {
      return {
        stop: [
          'unverified',
          EXIT.PROTOCOL,
          `\`${call.command}\` exited 0 but ${step.verification.detail}`,
          ['the change could not be confirmed by readback'],
        ],
      };
    }
    for (const target of decision.targets) {
      context.observed.add(target);
    }
  }
  return {
    exitCode: receipt.exitCode,
    result: formatToolResult(receipt, call.command, cwd),
  };
}

module.exports = { SIGNAL_EXIT, runFormalAiTask };
