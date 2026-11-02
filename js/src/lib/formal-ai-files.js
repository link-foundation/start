/**
 * Structured `read`, `edit` and `write` tools of the experimental
 * `--use-formal-ai` mode (issue #258).
 *
 * The `bash` tool runs only programs without shell syntax, and its write
 * programs (cp, mkdir, mv, rm, rmdir, touch) cannot change the text of a
 * file. These three tools are the guarded replacement primitive instead of an
 * interpreter: start itself reads and writes the one named workspace file,
 * byte for byte, so comments, whitespace and unrelated content survive.
 *
 * - read: the exact UTF-8 text of a regular file, bounded by
 *   START_FORMAL_AI_MAX_FILE_BYTES; it observes the file for later changes.
 * - edit: replaces one literal occurrence of old_string (or every one with
 *   replace_all) in a file read before, atomically, then reads it back.
 * - write: replaces an observed file, or creates one in an observed
 *   directory, atomically, then reads it back.
 *
 * Paths follow the bash tool's workspace policy (no absolute, escaping or
 * symlinked-out paths), edit and write need START_FORMAL_AI_EFFECTS=
 * workspace-write and an earlier observation of the target, and a file that
 * changed since start read it is not overwritten.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const policy = require('./formal-ai-policy');

const { TextDecoder } = globalThis;

const PATH = {
  type: 'string',
  description: 'File path inside the working directory',
};
const FILE_TOOLS = Object.freeze({
  read: Object.freeze({
    type: 'function',
    function: {
      name: 'read',
      description: 'Read the exact text of one file in the working directory.',
      parameters: {
        type: 'object',
        properties: { path: PATH },
        required: ['path'],
      },
    },
  }),
  edit: Object.freeze({
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Replace the literal text old_string with new_string in one file read before; old_string must occur exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: PATH,
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  }),
  write: Object.freeze({
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write the whole text of one file: a file read before, or a new file in a directory listed before.',
      parameters: {
        type: 'object',
        properties: { path: PATH, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  }),
});

/** Argument names Formal AI and other agents use for the same field. */
const ALIASES = Object.freeze({
  path: ['path', 'filePath', 'file_path'],
  oldString: ['old_string', 'oldString', 'old_str', 'old'],
  newString: ['new_string', 'newString', 'new_str', 'new'],
  replaceAll: ['replace_all', 'replaceAll'],
  content: ['content'],
});
const FIELDS = Object.freeze({
  read: ['path'],
  edit: ['path', 'oldString', 'newString', 'replaceAll'],
  write: ['path', 'content'],
});
const REQUIRED = Object.freeze({
  read: ['path'],
  edit: ['path', 'oldString', 'newString'],
  write: ['path', 'content'],
});

/**
 * Normalize the JSON arguments of a file tool call.
 * @param {string} tool - read, edit or write
 * @param {object} args - Parsed arguments
 * @returns {{args?: object, problem?: string}}
 */
function normalizeFileArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { problem: `${tool} arguments are not a JSON object` };
  }
  const result = {};
  for (const field of FIELDS[tool]) {
    const type = field === 'replaceAll' ? 'boolean' : 'string';
    const values = ALIASES[field]
      .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
      .map((key) => args[key]);
    if (values.some((value) => typeof value !== type)) {
      return {
        problem: `${tool} argument ${ALIASES[field][0]} must be a ${type}`,
      };
    }
    if (values.some((value) => value !== values[0])) {
      return {
        problem: `${tool} received conflicting ${ALIASES[field][0]} values`,
      };
    }
    if (values.length) {
      result[field] = values[0];
    }
  }
  const missing = REQUIRED[tool].filter((field) => !(field in result));
  if (missing.length) {
    return {
      problem: `${tool} needs ${missing.map((f) => ALIASES[f][0]).join(', ')}`,
    };
  }
  if (!result.path.trim() || result.path.includes('\0')) {
    return { problem: `${tool} needs a non-empty path` };
  }
  return { args: { replaceAll: false, ...result } };
}

/** One-line rendering of a file call for notes and evidence. */
function describeFileCall(tool, args) {
  return `${tool} ${args.path}`;
}

/**
 * Decide whether a file tool call may run (the effect policy of #255).
 * @param {string} tool - read, edit or write
 * @param {object} args - normalizeFileArgs() result
 * @param {object} context - {cwd, effects, observed, observedDirs}
 * @returns {{allowed: boolean, reason?: string, kind?: string, target?: string}}
 */
function evaluateFileCall(tool, args, context) {
  const refuse = (reason) => ({ allowed: false, reason });
  const kind = tool === 'read' ? 'read' : 'write';
  if (kind === 'write' && context.effects !== 'workspace-write') {
    return refuse(
      `"${tool}" changes files; the effect mode is read-only (set START_FORMAL_AI_EFFECTS=workspace-write to allow workspace changes)`
    );
  }
  if (args.path.startsWith('~')) {
    return refuse(`"${args.path}" is outside the working directory`);
  }
  const target = policy.workspacePath(context.cwd, args.path);
  if (target === null) {
    return refuse(`"${args.path}" is outside the working directory`);
  }
  if (target === '.') {
    return refuse(`"${args.path}" is the working directory, not a file`);
  }
  if (kind === 'write') {
    const exists = fs.existsSync(
      path.join(fs.realpathSync(context.cwd), target)
    );
    const observed =
      context.observed.has(target) ||
      (tool === 'write' &&
        !exists &&
        context.observedDirs.has(path.dirname(target)));
    if (!observed) {
      return refuse(
        `target "${target}" was not ${tool === 'edit' ? 'read' : 'observed'} before the change`
      );
    }
  }
  return { allowed: true, kind, target };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
// ignoreBOM keeps a byte order mark in the text, so an edit writes it back.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class FileToolError extends Error {}

/** Text of a regular workspace file, refusing what read could not return exactly. */
function readText(file, maxFileBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw new FileToolError(
      error.code === 'ENOENT'
        ? 'no such file'
        : `cannot read the file (${error.code || error.message})`
    );
  }
  if (stat.isDirectory()) {
    throw new FileToolError('is a directory, not a file');
  }
  if (!stat.isFile()) {
    throw new FileToolError('is not a regular file');
  }
  if (stat.size > maxFileBytes) {
    throw new FileToolError(
      `has ${stat.size} bytes; START_FORMAL_AI_MAX_FILE_BYTES is ${maxFileBytes}`
    );
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxFileBytes) {
    throw new FileToolError(
      `has ${bytes.length} bytes; START_FORMAL_AI_MAX_FILE_BYTES is ${maxFileBytes}`
    );
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    text = null;
  }
  if (text === null || text.includes('\0')) {
    throw new FileToolError('is not UTF-8 text');
  }
  return { text, bytes, mode: stat.mode };
}

/** Replace `file` by `content` through a temporary sibling and a rename. */
function writeAtomically(file, content, mode) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.start-tmp`
  );
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) {
      fs.chmodSync(temporary, mode & 0o7777);
    }
    const handle = fs.openSync(temporary, 'r+');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function occurrences(text, needle) {
  const found = [];
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + needle.length)
  ) {
    found.push(at);
  }
  return found;
}

/**
 * Run an approved file tool call.
 * @param {string} tool - read, edit or write
 * @param {object} args - normalizeFileArgs() result
 * @param {object} decision - evaluateFileCall() result
 * @param {object} context - Loop context; `contents` maps paths to the sha256 start last saw
 * @param {object} bounds - {maxFileBytes}
 * @returns {object} Receipt {exitCode, result, error?, bytes?, sha256?, replacements?, verification?}
 */
function runFileCall(tool, args, decision, context, bounds) {
  const file = path.join(fs.realpathSync(context.cwd), decision.target);
  const { target } = decision;
  const fail = (message) => ({
    exitCode: 1,
    error: `${target}: ${message}`,
    result: JSON.stringify({
      ok: false,
      is_error: true,
      error: `${target}: ${message}`,
    }),
  });
  try {
    if (tool === 'read') {
      const { text, bytes } = readText(file, bounds.maxFileBytes);
      context.observed.add(target);
      context.contents.set(target, sha256(bytes));
      return {
        exitCode: 0,
        result: text,
        text,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    }
    let current = null;
    if (tool === 'edit' || fs.existsSync(file)) {
      current = readText(file, bounds.maxFileBytes);
      const seen = context.contents.get(target);
      if (seen !== undefined && seen !== sha256(current.bytes)) {
        return fail(
          'changed since start read it; read it again before changing it'
        );
      }
    } else if (
      !fs.statSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory()
    ) {
      return fail('its directory does not exist');
    }
    let updated;
    let replacements = null;
    if (tool === 'edit') {
      if (args.oldString === '') {
        return fail('old_string is empty');
      }
      if (args.oldString === args.newString) {
        return fail('old_string and new_string are the same');
      }
      const found = occurrences(current.text, args.oldString);
      if (!found.length) {
        return fail('old_string was not found; nothing changed');
      }
      if (found.length > 1 && !args.replaceAll) {
        return fail(
          `old_string occurs ${found.length} times; give more surrounding text or set replace_all; nothing changed`
        );
      }
      replacements = args.replaceAll ? found.length : 1;
      updated = args.replaceAll
        ? current.text.split(args.oldString).join(args.newString)
        : `${current.text.slice(0, found[0])}${args.newString}${current.text.slice(found[0] + args.oldString.length)}`;
    } else {
      updated = args.content;
    }
    const expected = Buffer.from(updated, 'utf8');
    if (expected.length > bounds.maxFileBytes) {
      return fail(
        `the new text has ${expected.length} bytes; START_FORMAL_AI_MAX_FILE_BYTES is ${bounds.maxFileBytes}`
      );
    }
    writeAtomically(file, expected, current ? current.mode : undefined);
    const readback = fs.readFileSync(file);
    const verified = readback.equals(expected);
    context.observed.add(target);
    context.contents.set(target, sha256(readback));
    return {
      exitCode: 0,
      result: '',
      bytes: expected.length,
      sha256: sha256(readback),
      previousSha256: current ? sha256(current.bytes) : null,
      replacements,
      verification: {
        verified,
        detail: verified
          ? `readback confirmed ${tool} ${target} (${expected.length} bytes)`
          : `readback of ${target} differs from the written text`,
      },
    };
  } catch (error) {
    if (error instanceof FileToolError) {
      return fail(error.message);
    }
    return fail(`failed (${error.code || error.message})`);
  }
}

module.exports = {
  FILE_TOOLS,
  describeFileCall,
  evaluateFileCall,
  normalizeFileArgs,
  runFileCall,
};
