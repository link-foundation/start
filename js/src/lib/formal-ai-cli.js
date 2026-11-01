/**
 * CLI side of the experimental `--use-formal-ai` mode (issue #255): resolves
 * the bounds and the runtime, tracks the execution like a direct run (start
 * and finish blocks, log, execution record, START_* environment) and writes
 * the evidence of the run into its log.
 *
 * The log stays local: this mode never creates issues or uploads logs.
 */

const process = require('process');
const { EXIT, resolveBounds } = require('./formal-ai-policy');
const runtimeLib = require('./formal-ai-runtime');
const { createClient } = require('./formal-ai-client');
const { runFormalAiTask } = require('./formal-ai');
const { ExecutionRecord } = require('./execution-store');
const { createStartBlock, createFinishBlock } = require('./output-blocks');
const { appendLogFile } = require('./isolation-log-utils');
const launchIdentity = require('./launch-identity');

const EVIDENCE_SCHEMA = 'start-formal-ai-evidence/1';
const PREFIX = '[formal-ai]';
const { AbortController } = globalThis;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

/**
 * Text of the request: the argv after `--`, joined by single spaces. It is
 * only ever sent to Formal AI, never to a shell.
 * @param {string[]} rawCommand - Parsed command argv
 * @returns {string}
 */
function requestText(rawCommand) {
  return rawCommand.join(' ').trim();
}

/**
 * Run `--use-formal-ai`.
 * @param {object} options
 * @param {string} options.request - Request text
 * @param {string} options.sessionId - Execution UUID
 * @param {object} options.launch - prepareLaunch() result
 * @param {object|null} options.store - ExecutionStore, or null
 * @param {object} [options.config] - CLI configuration
 * @param {object} [options.env] - Environment (process.env)
 * @param {string} [options.cwd] - Working directory (process.cwd())
 * @param {object} [options.out] - stdout stream
 * @param {object} [options.err] - stderr stream
 * @returns {Promise<number>} Exit code
 */
async function runFormalAiCli(options) {
  const {
    request,
    sessionId,
    launch,
    store,
    config = {},
    env = process.env,
    cwd = process.cwd(),
    out = process.stdout,
    err = process.stderr,
  } = options;
  const note = (text) =>
    err.write(`${text.replace(/^/gm, `${PREFIX} `).replace(/ +$/gm, '')}\n`);
  let bounds;
  try {
    bounds = resolveBounds(env);
  } catch (error) {
    note(`Error: ${error.message}`);
    return error.exitCode || EXIT.CONFIG;
  }
  if (!request) {
    note('Error: --use-formal-ai needs a request after --');
    return EXIT.USAGE;
  }
  if (request.length > bounds.maxRequestChars) {
    note(
      `Error: the request has ${request.length} characters; START_FORMAL_AI_MAX_REQUEST_CHARS is ${bounds.maxRequestChars}`
    );
    return EXIT.USAGE;
  }
  const deadline = Date.now() + bounds.timeoutMs;
  let runtime;
  try {
    runtime = await runtimeLib.startRuntime({ env, bounds });
  } catch (error) {
    note(`Error: ${error.message}`);
    note(
      'No command was run: --use-formal-ai never falls back to aliases, a shell or an LLM.'
    );
    return error.exitCode || EXIT.UNAVAILABLE;
  }
  note(`runtime: ${runtimeLib.describeIdentity(runtime.identity)}`);
  note(`effects: ${bounds.effects}`);

  const logPath = launch.logPath;
  const startTime = timestamp();
  const startMs = Date.now();
  const record = store
    ? new ExecutionRecord({
        uuid: sessionId,
        command: request,
        logPath,
        shell: 'formal-ai',
        workingDirectory: cwd,
        options: {
          formalAi: {
            request,
            effects: bounds.effects,
            runtime: runtime.identity,
          },
        },
      })
    : null;
  if (record) {
    launchIdentity.applyLaunch(record, launch);
    launchIdentity.claimDirectLaunch(store, record, launch, config);
  }
  const header = [
    '=== Start Command Log ===',
    `Timestamp: ${startTime}`,
    `Session ID: ${sessionId}`,
    'Mode: --use-formal-ai (experimental)',
    `Request: ${request}`,
    `Formal AI: ${runtimeLib.describeIdentity(runtime.identity)}`,
    `Effects: ${bounds.effects}`,
    `Platform: ${process.platform}`,
    `Working Directory: ${cwd}`,
    '='.repeat(50),
    '',
    '',
  ].join('\n');
  launchIdentity.writeLaunchLog(logPath, header, launch, record);
  const logLine = (text) => appendLogFile(logPath, text);

  out.write(
    `${createStartBlock({ sessionId, timestamp: startTime, command: `--use-formal-ai -- ${request}` })}\n\n`
  );

  const evidence = {
    schema: EVIDENCE_SCHEMA,
    sessionId,
    runtime: runtime.identity,
  };
  const controller = new AbortController();
  let finalized = false;
  const finalize = (exitCode) => {
    if (finalized) {
      return;
    }
    finalized = true;
    runtime.stop();
    if (!evidence.outcome) {
      evidence.outcome = {
        status: 'cancelled',
        exitCode,
        message: 'start exited before the task finished',
        remainingObligations: [
          'the task was interrupted; later steps did not run',
        ],
      };
    }
    evidence.durationMs = Date.now() - startMs;
    const endTime = timestamp();
    logLine(
      `\n=== Formal AI Evidence ===\n${JSON.stringify(evidence, null, 2)}\n` +
        `\n${'='.repeat(50)}\nFinished: ${endTime}\nExit Code: ${exitCode}\n`
    );
    if (record) {
      record.options.formalAi.outcome = evidence.outcome.status;
      record.complete(exitCode);
      try {
        store.save(record);
      } catch (error) {
        if (config.verbose) {
          note(
            `[Tracking] Warning: Could not save execution record: ${error.message}`
          );
        }
      }
    }
    return endTime;
  };
  // Signals end start through process.exit() in the CLI; finish the
  // evidence, stop the tool's process group and the runtime synchronously.
  const onExit = (code) => {
    if (evidence.activeKill) {
      evidence.activeKill('SIGKILL');
    }
    finalize(code);
  };
  process.on('exit', onExit);
  try {
    const client = createClient({ baseUrl: runtime.baseUrl, bounds, deadline });
    await runFormalAiTask({
      request,
      cwd,
      env: launchIdentity.directLaunchEnv(sessionId, launch),
      bounds,
      client,
      deadline,
      signal: controller.signal,
      evidence,
      io: {
        stdout: out,
        stderr: err,
        note: (text) => {
          note(text);
          logLine(`${PREFIX} ${text}\n`);
        },
      },
    });
    evidence.formalAiRequests = client.requests;
  } catch (error) {
    evidence.outcome = {
      status: 'internal-error',
      exitCode: 1,
      message: error.message,
      remainingObligations: ['start failed; the task state is unknown'],
    };
  } finally {
    process.removeListener('exit', onExit);
  }
  const { outcome } = evidence;
  note(`${outcome.status}: ${outcome.message}`);
  for (const obligation of outcome.remainingObligations) {
    note(`remaining: ${obligation}`);
  }
  const endTime = finalize(outcome.exitCode);
  out.write(
    `\n${createFinishBlock({ sessionId, timestamp: endTime, exitCode: outcome.exitCode, logPath, durationMs: evidence.durationMs })}\n`
  );
  return outcome.exitCode;
}

module.exports = { EVIDENCE_SCHEMA, requestText, runFormalAiCli };
