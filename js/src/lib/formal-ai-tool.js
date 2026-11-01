/**
 * Runs one Formal AI tool call for `--use-formal-ai` (issue #255).
 *
 * The call is the argv vector the effect policy approved, spawned without a
 * shell in the caller's working directory and with the execution's START_*
 * environment. It gets no stdin, its own process group, a time limit and an
 * output cap; stdout and stderr are mirrored live and the exit status is the
 * real one (a signal maps to 128+N like a direct run).
 */

const { spawn } = require('child_process');
const { resolveChildExitCode } = require('./exit-reason');

const { setTimeout, clearTimeout } = globalThis;

/**
 * @param {object} options
 * @param {string[]} options.argv - Approved argv
 * @param {string} options.cwd - Working directory
 * @param {object} options.env - Child environment
 * @param {number} options.timeoutMs - Time limit of the call
 * @param {number} options.maxOutputBytes - Captured/mirrored byte cap
 * @param {object} [options.stdout] - Mirror for stdout (process.stdout)
 * @param {object} [options.stderr] - Mirror for stderr (process.stderr)
 * @param {Function} [options.onSpawn] - Receives a kill(signal) function
 * @returns {Promise<object>} Receipt {argv, exitCode, signal, timedOut, stdout, stderr, truncated, durationMs, spawnError}
 */
function runTool(options) {
  const {
    argv,
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
    stdout: outMirror = null,
    stderr: errMirror = null,
    onSpawn = () => {},
  } = options;
  const started = Date.now();
  return new Promise((resolve) => {
    const groups = process.platform !== 'win32';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: groups,
        shell: false,
      });
    } catch (error) {
      resolve(spawnFailure(argv, error, started));
      return;
    }
    const captured = { stdout: [], stderr: [] };
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let finished = false;
    const kill = (signal = 'SIGTERM') => {
      if (finished) {
        return;
      }
      try {
        if (groups && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // already gone
      }
    };
    onSpawn(kill);
    const collect = (name, mirror) => (chunk) => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const part = chunk.subarray(0, maxOutputBytes - bytes);
      truncated = truncated || part.length < chunk.length;
      bytes += part.length;
      captured[name].push(part);
      if (mirror) {
        mirror.write(part);
      }
    };
    child.stdout.on('data', collect('stdout', outMirror));
    child.stderr.on('data', collect('stderr', errMirror));
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finished = true;
      resolve(spawnFailure(argv, error, started));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (finished) {
        return;
      }
      finished = true;
      resolve({
        argv,
        exitCode: resolveChildExitCode(code, signal),
        signal: signal || null,
        timedOut,
        stdout: Buffer.concat(captured.stdout).toString('utf8'),
        stderr: Buffer.concat(captured.stderr).toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
        spawnError: null,
      });
    });
  });
}

function spawnFailure(argv, error, started) {
  const missing = error.code === 'ENOENT';
  return {
    argv,
    exitCode: missing ? 127 : 126,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: `${argv[0]}: ${missing ? 'command not found' : error.message}\n`,
    truncated: false,
    durationMs: Date.now() - started,
    spawnError: error.code || error.message,
  };
}

const UNTRUSTED = /<\/?untrusted_context>/g;

/**
 * The result text sent back to Formal AI: the shell envelope its tool-result
 * reader parses (Command/Directory/Output/Error/Exit Code), wrapped as
 * untrusted context because the output is file data, not instructions.
 * @param {object} receipt - runTool() receipt
 * @param {string} command - Command line Formal AI asked for
 * @param {string} cwd - Working directory
 * @returns {string}
 */
function formatToolResult(receipt, command, cwd) {
  const clean = (text) => text.replace(UNTRUSTED, '[tag removed]');
  const lines = [
    `Command: ${command}`,
    `Directory: ${cwd}`,
    `Output: ${clean(receipt.stdout) || '(empty)'}${receipt.truncated ? '\n[output truncated by start]' : ''}`,
  ];
  // Always present: Formal AI reads the status fields backwards up to the
  // last `Error:` line, so output lines cannot pose as an exit status.
  lines.push(`Error: ${clean(receipt.stderr) || '(none)'}`);
  if (receipt.timedOut) {
    lines.push(`Signal: ${receipt.signal || 'SIGTERM'}`, 'Timeout: true');
  } else {
    lines.push(`Exit Code: ${receipt.exitCode}`);
  }
  return `<untrusted_context>\n${lines.join('\n')}\n</untrusted_context>`;
}

/**
 * Result text for a call start refused before running it.
 * @param {string} command - Command line Formal AI asked for
 * @param {string} reason - Policy reason
 * @param {string} cwd - Working directory
 * @returns {string}
 */
function formatRefusal(command, reason, cwd) {
  return [
    `Command: ${command}`,
    `Directory: ${cwd}`,
    'Output: ',
    `Error: refused by start: ${reason}`,
    'Exit Code: 126',
  ].join('\n');
}

module.exports = { formatRefusal, formatToolResult, runTool };
