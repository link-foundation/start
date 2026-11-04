/**
 * The task loop of the experimental `--use-formal-ai` mode (issue #255).
 *
 * The natural-language request goes to Formal AI verbatim. Formal AI decides
 * what to observe and which tool calls to make; start checks every call
 * against the effect policy, runs approved calls, reports each receipt back
 * and keeps evidence of what actually happened. The run ends when Formal AI
 * gives its final answer, says it did not understand, or a bound, refusal,
 * protocol error or cancellation stops it, and the exit status says which.
 * A final answer that is a known capability gap (issue #258) is reported as
 * incomplete with its obligations, never as an answer.
 *
 * A failed change stays unresolved until the same typed tool changes the same
 * target and its readback is verified (issue #261): a later read, a copy over
 * the file or Formal AI's final answer does not resolve it, and the run then
 * ends `incomplete` with the original failure and its exit status.
 */

const policy = require('./formal-ai-policy');
const { formatToolResult, runTool } = require('./formal-ai-tool');
const files = require('./formal-ai-files');
const { recognizeCapabilityGap } = require('./formal-ai-client');

const { EXIT } = policy;
const PREVIEW_CHARS = 2000;
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function preview(text) {
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}… [${text.length - PREVIEW_CHARS} more chars]`
    : text;
}

/** Observed working-directory changes, in words. */
function describeEffects(effects) {
  const parts = ['added', 'removed', 'changed']
    .filter((key) => effects[key].length)
    .map((key) => {
      const names = effects[key];
      const more = names.length > 10 ? ` and ${names.length - 10} more` : '';
      return `${key} ${names.slice(0, 10).join(', ')}${more}`;
    });
  const text = parts.length ? parts.join('; ') : 'no file changed';
  return effects.complete ? text : `${text} (fingerprint incomplete)`;
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
    contents: new Map(),
  };
  // Failed calls whose obligation no later verified call met (#261).
  const unresolved = [];
  const finish = (status, exitCode, message, remaining = [], extra = {}) => {
    const open = unresolved.map(failureObligation);
    evidence.outcome = {
      status,
      exitCode,
      message,
      remainingObligations: [
        ...remaining,
        ...open.filter((item) => !remaining.includes(item)),
      ],
      ...(unresolved.length
        ? { failures: unresolved.map((f) => ({ ...f })) }
        : {}),
      ...extra,
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
      // The cause and attempt count of a runtime failure stay in the
      // evidence (issue #257); they are sanitized and bounded by the client.
      return finish(
        status,
        error.exitCode || EXIT.PROTOCOL,
        error.message,
        ['Formal AI did not complete the task'],
        error.details ? { diagnostics: { ...error.details } } : {}
      );
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
      const gap = recognizeCapabilityGap(response.content, messages);
      if (gap) {
        return finish(
          'capability-gap',
          EXIT.UNSUPPORTED,
          describeGap(gap, evidence.effects),
          gapObligations(gap, bounds.effects),
          { gap }
        );
      }
      if (unresolved.length) {
        const [first] = unresolved;
        return finish(
          'incomplete',
          first.exitCode || 1,
          `\`${first.command}\` failed (${first.error}) and no later call resolved it; ${describeEffects(evidence.effects)}`
        );
      }
      const record = unrecognizedGapRecord(response.content, messages);
      if (record) {
        return finish(
          'incomplete',
          EXIT.UNSUPPORTED,
          `Formal AI reported ${record.schema}${record.reason ? ` (${record.reason})` : ''}${record.target ? ` for ${record.target}` : ''}${record.clause ? ` for the clause ${JSON.stringify(record.clause)}` : ''}; nothing was verified as done by Formal AI; ${describeEffects(evidence.effects)}`,
          ['Formal AI did not confirm the requested change'],
          { gapRecord: record }
        );
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
      // The status reports what the tools did, not what Formal AI claims:
      // a run of reads is never presented as a completed change.
      const status =
        lastExit === 0
          ? `finished after ${toolCalls} tool call(s)`
          : `finished; the last tool call exited with ${lastExit}`;
      return finish(
        'completed',
        lastExit,
        `${status}; ${describeEffects(evidence.effects)}`,
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
          arguments:
            call.tool === 'bash'
              ? JSON.stringify({ command: call.command })
              : call.arguments,
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
      trackFailures(unresolved, evidence.steps[evidence.steps.length - 1]);
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

/**
 * Keep the failed calls of a run until a later call meets their obligation
 * (issue #261). A failed edit or write is resolved only by a verified edit or
 * write of the same target (a write also resolves a failed read of the file
 * it created); a failed read by a read of the same target; a failed write
 * command only by the same command succeeding. A copy or move over the target
 * never counts as the edit.
 */
function trackFailures(unresolved, step) {
  if (!step || step.kind !== 'tool' || step.decision !== 'allowed') {
    return;
  }
  const typed = step.tool !== undefined;
  const changed = typed && step.tool !== 'read';
  if (step.exitCode !== 0 && (typed || step.effect === 'write')) {
    unresolved.push({
      command: step.command,
      ...(typed ? { tool: step.tool, target: step.target } : {}),
      exitCode: step.exitCode ?? 1,
      error:
        step.error ||
        (step.signal
          ? `stopped by ${step.signal}`
          : `exited with ${step.exitCode}`),
    });
    return;
  }
  if (step.exitCode !== 0) {
    return;
  }
  const verified = changed && step.verification && step.verification.verified;
  for (let index = unresolved.length - 1; index >= 0; index--) {
    const failure = unresolved[index];
    const resolved = typed
      ? failure.target === step.target &&
        (failure.tool === 'read'
          ? step.tool === 'read' || verified
          : verified && (failure.tool === step.tool || step.tool === 'edit'))
      : failure.tool === undefined && failure.command === step.command;
    if (resolved) {
      unresolved.splice(index, 1);
    }
  }
}

function failureObligation(failure) {
  return `\`${failure.command}\` failed: ${failure.error}`;
}

/**
 * A final answer that is exactly one Links Notation record whose record_type
 * names a gap, as Formal AI's task obligations answer (`obligation_gap`, e.g.
 * reason `no_artifact_in_clause`): an id line, then `  key "value"` lines.
 * Returned in the JSON gap shape (schema = record_type, never complete), so
 * a gap Formal AI states in its own notation is never taken as success, even
 * when start verified every change it made (#261).
 * @param {string} text - Trimmed final answer
 * @returns {object|null} {schema, reason?, clause?, complete: false}
 */
function linoGapRecord(text) {
  const [id, ...lines] = text.split('\n');
  if (!/^[A-Za-z0-9_]+$/.test(id) || !lines.length) {
    return null;
  }
  const fields = {};
  for (const line of lines) {
    const match = /^ {2}([a-z_]+) (?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) {
      return null;
    }
    fields[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  if (typeof fields.record_type !== 'string') {
    return null;
  }
  return {
    schema: fields.record_type,
    ...(fields.reason ? { reason: fields.reason } : {}),
    ...(fields.clause ? { clause: fields.clause } : {}),
    complete: false,
  };
}

/**
 * A final answer that is a JSON record of a gap start does not know: it is
 * never taken as success, though its schema grants no recognized gap.
 */
function unrecognizedGapRecord(content, messages) {
  let value;
  try {
    value = JSON.parse(String(content || '').trim());
  } catch {
    value = linoGapRecord(String(content || '').trim());
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.schema !== 'string' ||
    !/gap/i.test(value.schema) ||
    !(
      value.verified === false ||
      value.complete === false ||
      value.completed === false
    )
  ) {
    return null;
  }
  if (files.echoedByTool(String(content).trim(), messages)) {
    return null;
  }
  return {
    schema: value.schema,
    ...(typeof value.target === 'string' ? { target: value.target } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.clause === 'string' ? { clause: value.clause } : {}),
  };
}

/**
 * Capability gap, in words. When tools changed the working directory, the
 * message keeps what start observed: Formal AI's gap still means the task is
 * not confirmed, whatever start verified on its own (#261).
 */
function describeGap(gap, effects) {
  const missing = gap.missingCapabilities.length
    ? `; missing ${gap.missingCapabilities.join(', ')}`
    : '';
  const head = `Formal AI reported a capability gap for ${gap.target} (${gap.reason}${missing})`;
  return effects && policy.hasEffects(effects)
    ? `${head}; Formal AI did not confirm the task as done; start observed: ${describeEffects(effects)}`
    : `${head}; nothing was verified as done`;
}

function gapObligations(gap, effects) {
  const obligations = [
    `the requested change to ${gap.target} was not made or not verified`,
  ];
  const changes = ['edit', 'write', 'multi_edit'];
  if (
    effects !== 'workspace-write' &&
    gap.missingCapabilities.some((c) => changes.includes(c))
  ) {
    obligations.push(
      'set START_FORMAL_AI_EFFECTS=workspace-write to offer the edit and write tools'
    );
  }
  return obligations;
}

function runCall(options) {
  return options.call.tool === 'bash'
    ? runBashCall(options)
    : runFileToolCall(options);
}

/** Record a call's working-directory diff in its step and the run. */
function recordEffects(step, diff, evidence) {
  step.effects = diff;
  for (const key of ['added', 'removed', 'changed']) {
    evidence.effects[key].push(...diff[key]);
  }
  evidence.effects.complete = evidence.effects.complete && diff.complete;
}

/** A structured read, edit or write call (issue #258). */
function runFileToolCall({ call, context, cwd, bounds, io, note, evidence }) {
  const decision = files.evaluateFileCall(call.tool, call.args, context);
  const step = {
    kind: 'tool',
    tool: call.tool,
    command: call.command,
    path: call.args.path,
  };
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
  Object.assign(step, {
    decision: 'allowed',
    effect: decision.kind,
    target: decision.target,
  });
  note(call.command);
  const started = Date.now();
  const before = policy.fingerprint(cwd, bounds.maxFingerprintEntries);
  const receipt = files.runFileCall(
    call.tool,
    call.args,
    decision,
    context,
    bounds
  );
  const diff = policy.diffFingerprints(
    before,
    policy.fingerprint(cwd, bounds.maxFingerprintEntries)
  );
  Object.assign(step, {
    exitCode: receipt.exitCode,
    durationMs: Date.now() - started,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(receipt.bytes !== undefined ? { bytes: receipt.bytes } : {}),
    ...(receipt.sha256 ? { sha256: receipt.sha256 } : {}),
    ...(receipt.previousSha256
      ? { previousSha256: receipt.previousSha256 }
      : {}),
    ...(receipt.replacements ? { replacements: receipt.replacements } : {}),
    ...(receipt.mutation ? { mutation: receipt.mutation } : {}),
  });
  recordEffects(step, diff, evidence);
  if (receipt.error) {
    note(`${call.tool} failed: ${receipt.error}`);
  } else if (call.tool === 'read') {
    mirrorRead(receipt.text, bounds, io, note);
    if (policy.hasEffects(diff)) {
      step.unexpectedEffects = true;
    }
  } else {
    step.verification = receipt.verification;
    if (!receipt.verification.verified) {
      return {
        stop: [
          'unverified',
          EXIT.PROTOCOL,
          `\`${call.command}\` ran but ${receipt.verification.detail}`,
          ['the change could not be confirmed by readback'],
        ],
      };
    }
    note(receipt.verification.detail);
  }
  return {
    exitCode: receipt.exitCode,
    result: receipt.result,
  };
}

/** Show what a read returned, like the stdout of `cat`, within the output cap. */
function mirrorRead(text, bounds, io, note) {
  if (!io.stdout || !text) {
    return;
  }
  const bytes = Buffer.from(text, 'utf8');
  const shown = bytes.subarray(0, bounds.maxOutputBytes).toString('utf8');
  io.stdout.write(shown.endsWith('\n') ? shown : `${shown}\n`);
  if (bytes.length > bounds.maxOutputBytes) {
    note(
      `output truncated at START_FORMAL_AI_MAX_OUTPUT_BYTES=${bounds.maxOutputBytes}`
    );
  }
}

async function runBashCall({
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
  });
  recordEffects(step, diff, evidence);
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

module.exports = { SIGNAL_EXIT, describeEffects, runFormalAiTask };
