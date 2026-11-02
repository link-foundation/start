/**
 * Bounds and effect policy of the experimental `--use-formal-ai` mode
 * (issue #255).
 *
 * Formal AI owns the interpretation of a natural-language request and picks
 * the tool calls; start owns the permission to run them. Every tool call is a
 * POSIX command line that start tokenizes itself and runs as an argv vector,
 * never through a shell, so a call that needs shell syntax (pipes, redirects,
 * substitutions, globs, variables) is refused instead of being interpreted.
 */

const fs = require('fs');
const path = require('path');

/** Exit statuses of the mode; a finished task keeps its last tool's status. */
const EXIT = Object.freeze({
  USAGE: 64, // request text or option combination rejected
  UNSUPPORTED: 65, // Formal AI did not understand the task or reported a capability gap
  UNAVAILABLE: 69, // no qualified Formal AI runtime could be resolved
  PROTOCOL: 70, // malformed or 5xx response, unknown tool or unverified effect
  REFUSED: 77, // a tool call was refused by the effect policy
  CONFIG: 78, // invalid START_FORMAL_AI_* bound
  BUDGET: 124, // step, tool, time or retry budget exhausted
});

const EFFECT_MODES = ['read-only', 'workspace-write'];

const BOUND_DEFAULTS = Object.freeze({
  maxSteps: { env: 'START_FORMAL_AI_MAX_STEPS', value: 8, max: 64 },
  maxRetries: { env: 'START_FORMAL_AI_MAX_RETRIES', value: 1, max: 5, min: 0 },
  timeoutMs: { env: 'START_FORMAL_AI_TIMEOUT_MS', value: 120000 },
  toolTimeoutMs: { env: 'START_FORMAL_AI_TOOL_TIMEOUT_MS', value: 30000 },
  startupTimeoutMs: {
    env: 'START_FORMAL_AI_STARTUP_TIMEOUT_MS',
    value: 30000,
  },
  maxOutputBytes: {
    env: 'START_FORMAL_AI_MAX_OUTPUT_BYTES',
    value: 64 * 1024,
    max: 16 * 1024 * 1024,
  },
  maxFileBytes: {
    env: 'START_FORMAL_AI_MAX_FILE_BYTES',
    value: 1024 * 1024,
    max: 16 * 1024 * 1024,
  },
  maxRequestChars: { env: 'START_FORMAL_AI_MAX_REQUEST_CHARS', value: 4096 },
  maxMemoryMb: { env: 'START_FORMAL_AI_MAX_MEMORY_MB', value: 1024 },
  maxFingerprintEntries: {
    env: 'START_FORMAL_AI_MAX_FINGERPRINT_ENTRIES',
    value: 5000,
  },
});

/**
 * Resolve the bounds of one run from START_FORMAL_AI_* variables.
 * @param {object} [env] - Environment
 * @returns {object} Bounds plus `effects`
 * @throws {Error} With `exitCode` EXIT.CONFIG on an invalid value
 */
function resolveBounds(env = process.env) {
  const bounds = {};
  for (const [key, spec] of Object.entries(BOUND_DEFAULTS)) {
    const raw = env[spec.env];
    if (raw === undefined || raw === '') {
      bounds[key] = spec.value;
      continue;
    }
    const min = spec.min === undefined ? 1 : spec.min;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw.trim()) ||
      value < min ||
      (spec.max && value > spec.max)
    ) {
      throw configError(
        `${spec.env} must be an integer from ${min} to ${spec.max || 'any'}, got "${raw}"`
      );
    }
    bounds[key] = value;
  }
  const effects = (env.START_FORMAL_AI_EFFECTS || 'read-only').trim();
  if (!EFFECT_MODES.includes(effects)) {
    throw configError(
      `START_FORMAL_AI_EFFECTS must be one of ${EFFECT_MODES.join(', ')}, got "${effects}"`
    );
  }
  bounds.effects = effects;
  return bounds;
}

function configError(message) {
  return Object.assign(new Error(message), { exitCode: EXIT.CONFIG });
}

/**
 * Split a command line with POSIX quoting rules. Characters that would make a
 * shell do more than split words are reported instead of honoured.
 * @param {string} line - Command line from a tool call
 * @returns {{tokens: string[], problems: string[]}} Words and refused syntax
 */
function tokenizeCommand(line) {
  const tokens = [];
  const problems = new Set();
  let current = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (
        ch === '\\' &&
        i + 1 < line.length &&
        '"\\$`'.includes(line[i + 1])
      ) {
        current += line[++i];
      } else if (ch === '$' || ch === '`') {
        problems.add(`expansion "${ch}"`);
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current !== null) {
        tokens.push(current);
        current = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current = current === null ? '' : current;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < line.length && line[i + 1] !== '\n') {
        current = (current === null ? '' : current) + line[++i];
        continue;
      }
      problems.add('line continuation');
      continue;
    }
    if ('\n\r;&|<>()$`'.includes(ch)) {
      problems.add(`shell operator "${ch === '\n' ? '\\n' : ch}"`);
    } else if ('*?[]{}'.includes(ch)) {
      problems.add(`unquoted pattern "${ch}"`);
    } else if (ch === '~' && current === null) {
      problems.add('home directory expansion "~"');
    } else if (ch === '#' && current === null) {
      problems.add('comment "#"');
    }
    current = (current === null ? '' : current) + ch;
  }
  if (quote) {
    problems.add('unterminated quote');
  }
  if (current !== null) {
    tokens.push(current);
  }
  return { tokens, problems: [...problems] };
}

const READ_PROGRAMS = new Set([
  'basename',
  'cat',
  'cmp',
  'diff',
  'dirname',
  'du',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'md5sum',
  'pwd',
  'readlink',
  'realpath',
  'sha256sum',
  'sort',
  'stat',
  'tail',
  'test',
  'tree',
  'uniq',
  'wc',
]);
const WRITE_PROGRAMS = new Set(['cp', 'mkdir', 'mv', 'rm', 'rmdir', 'touch']);
const LISTING_PROGRAMS = new Set(['ls', 'find', 'tree', 'du']);

/** Flags that turn an otherwise read-only program into a writer or waiter. */
const FORBIDDEN_FLAGS = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o.*|--output.*)$/,
  tree: /^(-o.*|--output.*)$/,
  file: /^(-C|--compile)$/,
  tail: /^(-f|-F|--follow.*|--retry)$/,
  git: /^(--output.*|--ext-diff|-c|--exec-path.*|--git-dir.*|--work-tree.*)$/,
  rm: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--no-preserve-root)$/,
  cp: /^(-[a-zA-Z]*[l][a-zA-Z]*|--link|-s|--symbolic-link)$/,
};
const GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);
const GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--list',
  '--show-current',
]);

function isInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** Real path of `target`, resolving its nearest existing ancestor. */
function realTarget(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return target;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

/** Path-like operands of a call (values of `--opt=value` included). */
function operands(tokens) {
  const values = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      if (eq > 0 && token.startsWith('--')) {
        values.push(token.slice(eq + 1));
      }
      continue;
    }
    values.push(token);
  }
  return values;
}

/**
 * Normalized workspace-relative path of an operand, or null outside it.
 * @param {string} cwd - Working directory
 * @param {string} operand - Operand text
 * @returns {string|null}
 */
function workspacePath(cwd, operand) {
  const root = fs.realpathSync(cwd);
  const resolved = realTarget(path.resolve(cwd, operand));
  if (!isInside(root, resolved)) {
    return null;
  }
  return path.relative(root, resolved) || '.';
}

/**
 * Decide whether a tool call may run.
 * @param {string} line - Command line of the call
 * @param {object} context - {cwd, effects, observed: Set<string>, observedDirs: Set<string>}
 * @returns {{allowed: boolean, reason?: string, tokens: string[], kind?: string, targets?: string[]}}
 */
function evaluateCommand(line, context) {
  const { tokens, problems } = tokenizeCommand(line);
  const refuse = (reason) => ({ allowed: false, reason, tokens });
  if (problems.length) {
    return refuse(
      `needs shell syntax start does not run: ${problems.join(', ')}`
    );
  }
  if (!tokens.length) {
    return refuse('empty command');
  }
  const program = tokens[0];
  const isWrite = WRITE_PROGRAMS.has(program);
  if (!READ_PROGRAMS.has(program) && !isWrite) {
    return refuse(`program "${program}" is not in the supported tool set`);
  }
  if (isWrite && context.effects !== 'workspace-write') {
    return refuse(
      `"${program}" changes files; the effect mode is read-only (set START_FORMAL_AI_EFFECTS=workspace-write to allow workspace changes)`
    );
  }
  const forbidden = FORBIDDEN_FLAGS[program];
  const flag = forbidden && tokens.slice(1).find((t) => forbidden.test(t));
  if (flag) {
    return refuse(`option "${flag}" of ${program} is not allowed`);
  }
  if (program === 'git') {
    const sub = tokens[1];
    if (!GIT_SUBCOMMANDS.has(sub)) {
      return refuse(`git subcommand "${sub || ''}" is not read-only`);
    }
    if (
      sub === 'branch' &&
      tokens.slice(2).some((t) => !GIT_BRANCH_FLAGS.has(t))
    ) {
      return refuse('git branch may only list branches');
    }
  }
  const targets = [];
  for (const operand of operands(tokens)) {
    if (operand.startsWith('~')) {
      return refuse(`"${operand}" is outside the working directory`);
    }
    // Absolute, escaping and symlinked-out operands are refused: reads and
    // changes stay inside the working directory.
    const relative = workspacePath(context.cwd, operand);
    if (relative === null) {
      return refuse(`"${operand}" is outside the working directory`);
    }
    targets.push(relative);
  }
  if (isWrite) {
    if (!targets.length) {
      return refuse(`${program} needs an explicit target`);
    }
    const unobserved = targets.filter(
      (t) =>
        t === '.' ||
        !(context.observed.has(t) || context.observedDirs.has(path.dirname(t)))
    );
    if (unobserved.length) {
      return refuse(
        `target ${unobserved.map((t) => `"${t}"`).join(', ')} was not observed before the change`
      );
    }
  }
  return { allowed: true, tokens, kind: isWrite ? 'write' : 'read', targets };
}

/**
 * Remember what a read call observed, so a later change may name it.
 * @param {object} decision - evaluateCommand() result of the read call
 * @param {object} context - Same context object
 */
function recordObservation(decision, context) {
  const listed = decision.targets.length ? decision.targets : ['.'];
  for (const target of decision.targets) {
    context.observed.add(target);
  }
  if (LISTING_PROGRAMS.has(decision.tokens[0])) {
    for (const target of listed) {
      context.observedDirs.add(target);
    }
  }
}

/**
 * Bounded fingerprint of the working directory (names, types, sizes, mtimes).
 * @param {string} cwd - Directory
 * @param {number} limit - Maximum entries
 * @returns {{entries: Map<string,string>, complete: boolean}}
 */
function fingerprint(cwd, limit) {
  const entries = new Map();
  const queue = [''];
  while (queue.length) {
    const relative = queue.shift();
    let names;
    try {
      names = fs.readdirSync(path.join(cwd, relative)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (entries.size >= limit) {
        return { entries, complete: false };
      }
      const child = relative ? `${relative}/${name}` : name;
      let stat;
      try {
        stat = fs.lstatSync(path.join(cwd, child));
      } catch {
        continue;
      }
      const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f';
      entries.set(child, `${type}:${stat.size}:${stat.mtimeMs}`);
      if (type === 'd' && name !== '.git') {
        queue.push(child);
      }
    }
  }
  return { entries, complete: true };
}

/**
 * Differences between two fingerprints.
 * @returns {{added: string[], removed: string[], changed: string[], complete: boolean}}
 */
function diffFingerprints(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, value] of after.entries) {
    if (!before.entries.has(name)) {
      added.push(name);
    } else if (before.entries.get(name) !== value) {
      changed.push(name);
    }
  }
  for (const name of before.entries.keys()) {
    if (!after.entries.has(name)) {
      removed.push(name);
    }
  }
  return {
    added,
    removed,
    changed,
    complete: before.complete && after.complete,
  };
}

function hasEffects(diff) {
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

/**
 * Read the result of a successful change back from the filesystem.
 * @param {string[]} tokens - Argv of the change
 * @param {string} cwd - Working directory
 * @returns {{verified: boolean, detail: string}}
 */
function verifyChange(tokens, cwd) {
  const program = tokens[0];
  const args = operands(tokens);
  const exists = (p) => fs.existsSync(path.resolve(cwd, p));
  const isDir = (p) =>
    exists(p) && fs.statSync(path.resolve(cwd, p)).isDirectory();
  let missing = [];
  if (program === 'mkdir') {
    missing = args.filter((p) => !isDir(p));
  } else if (program === 'touch') {
    missing = args.filter((p) => !exists(p));
  } else if (program === 'rm' || program === 'rmdir') {
    missing = args.filter((p) => exists(p)).map((p) => `${p} (still present)`);
  } else if (program === 'cp' || program === 'mv') {
    const dest = args[args.length - 1];
    const sources = args.slice(0, -1);
    const expected =
      isDir(dest) && sources.length
        ? sources.map((s) => path.join(dest, path.basename(s)))
        : [dest];
    missing = expected.filter((p) => !exists(p));
    if (program === 'mv') {
      missing.push(
        ...sources
          .filter((s) => exists(s) && !expected.includes(s))
          .map((s) => `${s} (still present)`)
      );
    }
  }
  return missing.length
    ? { verified: false, detail: `readback failed: ${missing.join(', ')}` }
    : {
        verified: true,
        detail: `readback confirmed ${program} ${args.join(' ')}`,
      };
}

module.exports = {
  BOUND_DEFAULTS,
  EFFECT_MODES,
  EXIT,
  READ_PROGRAMS,
  WRITE_PROGRAMS,
  diffFingerprints,
  evaluateCommand,
  fingerprint,
  hasEffects,
  recordObservation,
  resolveBounds,
  tokenizeCommand,
  verifyChange,
  workspacePath,
};
