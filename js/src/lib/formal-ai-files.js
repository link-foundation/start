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
 *
 * Bounded typed source edits (issue #261): a change to an existing file is
 * bound to the complete bytes the read tool returned for it in this task
 * (listing it or `cat` is not enough), applied to exactly the matched regions
 * of those bytes, guarded against a change of the target until the new file
 * takes its place, and verified by reading it back: every matched region now
 * holds new_string and every other byte is unchanged and in place. The
 * mutation receipt (preimage, postimage and byte offsets of the matches) is
 * kept in the evidence and returned to Formal AI.
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
        'Replace the literal text old_string with new_string in one file read completely with read in this task, unchanged since; old_string must occur exactly once unless replace_all is true. Nothing else in the file changes.',
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
        'Write the whole text of one file: a file read completely with read in this task, unchanged since, or a new file in a directory listed before.',
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
// The final path component is opened without following a symbolic link: the
// policy resolved the target, so a link there now is a swapped path (#261).
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

class FileToolError extends Error {}

/** lstat of `file`, or null when it does not exist. */
function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null;
    }
    throw new FileToolError(
      `cannot inspect the file (${error.code || error.message})`
    );
  }
}

/**
 * The exact bytes of a regular workspace file, read through one descriptor
 * opened without following a symbolic link.
 */
function readBytes(file, maxFileBytes) {
  const link = lstatOrNull(file);
  if (link && link.isSymbolicLink()) {
    throw new FileToolError(
      'is a symbolic link that appeared after start resolved the path; nothing changed'
    );
  }
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    throw new FileToolError(
      error.code === 'ENOENT'
        ? 'no such file'
        : error.code === 'ELOOP'
          ? 'is a symbolic link that appeared after start resolved the path; nothing changed'
          : error.code === 'EISDIR'
            ? 'is a directory, not a file'
            : `cannot read the file (${error.code || error.message})`
    );
  }
  try {
    const stat = fs.fstatSync(handle);
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
    const bytes = fs.readFileSync(handle);
    if (bytes.length > maxFileBytes) {
      throw new FileToolError(
        `has ${bytes.length} bytes; START_FORMAL_AI_MAX_FILE_BYTES is ${maxFileBytes}`
      );
    }
    return { bytes, mode: stat.mode };
  } finally {
    fs.closeSync(handle);
  }
}

/** Text of a regular workspace file, refusing what read could not return exactly. */
function readText(file, maxFileBytes) {
  const { bytes, mode } = readBytes(file, maxFileBytes);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    text = null;
  }
  if (text === null || text.includes('\0')) {
    throw new FileToolError('is not UTF-8 text');
  }
  return { text, bytes, mode };
}

/** True when `text` has no lone UTF-16 surrogate (it encodes to UTF-8 exactly). */
function wellFormed(text) {
  return typeof text.isWellFormed === 'function'
    ? text.isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        text
      );
}

/**
 * Replace `file` by `content` through a temporary sibling. Just before the
 * temporary file takes the target's place, `guard()` checks that the target
 * still holds the preimage start bound the change to; a new file is linked in
 * place, so a file that appeared meanwhile is never overwritten.
 */
function writeAtomically(file, content, mode, guard, create) {
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
    guard();
    if (create) {
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new FileToolError(
            'was created while start was writing it; nothing changed'
          );
        }
        throw error;
      }
    } else {
      fs.renameSync(temporary, file);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Indices of the non-overlapping occurrences of `needle` in `text`. */
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

/** Byte-level splice of `preimage`: each match's old bytes become `newBytes`. */
function splice(preimage, matches, newBytes) {
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(preimage.subarray(cursor, match.offset), newBytes);
    cursor = match.offset + match.oldBytes;
  }
  parts.push(preimage.subarray(cursor));
  return Buffer.concat(parts);
}

/**
 * Check a readback against the mutation receipt, independently of how the
 * new text was computed: every matched preimage region held exactly the old
 * bytes, every other preimage byte is unchanged and in place, every replaced
 * region holds exactly the new bytes, and nothing else was added.
 * @param {Buffer} preimage - Bytes the change was bound to
 * @param {Buffer} readback - Bytes read back after the change
 * @param {object[]} matches - [{offset, oldBytes, newBytes}] in byte units
 * @param {Buffer} oldBytes - UTF-8 bytes of old_string
 * @param {Buffer} newBytes - UTF-8 bytes of new_string
 * @returns {{verified: boolean, detail: string}}
 */
function verifyMutation(preimage, readback, matches, oldBytes, newBytes) {
  const bad = (detail) => ({ verified: false, detail });
  if (!matches.length) {
    return bad('the mutation receipt has no matched region');
  }
  const delta = matches.length * (newBytes.length - oldBytes.length);
  if (readback.length !== preimage.length + delta) {
    return bad(
      `readback has ${readback.length} bytes, expected ${preimage.length + delta}`
    );
  }
  let before = 0;
  let after = 0;
  for (const [index, match] of matches.entries()) {
    if (
      match.offset < before ||
      match.oldBytes !== oldBytes.length ||
      match.newBytes !== newBytes.length ||
      match.offset + match.oldBytes > preimage.length
    ) {
      return bad(`match ${index + 1} of the mutation receipt is malformed`);
    }
    const keep = match.offset - before;
    if (
      !preimage
        .subarray(before, match.offset)
        .equals(readback.subarray(after, after + keep))
    ) {
      return bad(`bytes before match ${index + 1} changed`);
    }
    after += keep;
    if (
      !preimage
        .subarray(match.offset, match.offset + match.oldBytes)
        .equals(oldBytes)
    ) {
      return bad(`match ${index + 1} did not hold old_string in the preimage`);
    }
    if (!readback.subarray(after, after + newBytes.length).equals(newBytes)) {
      return bad(
        `match ${index + 1} does not hold new_string after the change`
      );
    }
    before = match.offset + match.oldBytes;
    after += newBytes.length;
  }
  if (!preimage.subarray(before).equals(readback.subarray(after))) {
    return bad('bytes after the last match changed');
  }
  return {
    verified: true,
    detail: `${matches.length} replacement(s); every other byte unchanged`,
  };
}

const digest = (bytes) => ({ sha256: sha256(bytes), bytes: bytes.length });

/**
 * The complete text of a read as the numbered frame Formal AI binds as a
 * whole-file Read (#261): one `NNNNN| line` per `\n`-separated line and a
 * trailer with the line count. Formal AI decodes it back to exactly `text`
 * (lines joined with `\n`, so a missing or present final newline, CR bytes
 * and Unicode survive); its OpenAI-compatible request parser drops any other
 * metadata on a tool message, so the frame is the only binding it accepts.
 * @param {string} text - Complete file text
 * @returns {string} Framed read result
 */
function readFrame(text) {
  const lines = text.split('\n');
  const width = Math.max(5, String(lines.length).length);
  const numbered = lines.map(
    (line, index) => `${String(index + 1).padStart(width, '0')}| ${line}`
  );
  return `<file>\n${numbered.join('\n')}\n\n(End of file - total ${lines.length} lines)\n</file>`;
}

/**
 * The exact text a readFrame() result frames, or null when it is not one.
 * @param {string} frame - Read result
 * @returns {string|null} Decoded text
 */
function readFrameText(frame) {
  const open = '<file>\n';
  const marker = '\n\n(End of file - total ';
  if (!frame.startsWith(open) || !frame.endsWith('</file>')) {
    return null;
  }
  const at = frame.lastIndexOf(marker);
  if (at < 0) {
    return null;
  }
  const lines = frame.slice(open.length, at).split('\n');
  const count = Number(frame.slice(at + marker.length).split(/\s+/u)[0]);
  if (count !== lines.length) {
    return null;
  }
  const out = [];
  for (const [index, line] of lines.entries()) {
    const split = line.indexOf('| ');
    if (split < 0 || Number(line.slice(0, split)) !== index + 1) {
      return null;
    }
    out.push(line.slice(split + 2));
  }
  return out.join('\n');
}

/**
 * Run an approved file tool call.
 *
 * A change is bound to the complete bytes of the target that this task last
 * read with the read tool (or wrote and verified): the edit is applied to
 * those bytes only, the target is checked to still hold them just before the
 * new file takes its place, and the readback is verified byte for byte
 * against the mutation receipt (edit) or the whole intended text (write).
 * @param {string} tool - read, edit or write
 * @param {object} args - normalizeFileArgs() result
 * @param {object} decision - evaluateFileCall() result
 * @param {object} context - Loop context; `contents` maps paths to the sha256
 *   of the complete bytes start last read or verified; optional
 *   `beforeReplace(file)` and `afterReplace(file)` hooks run just before the
 *   guard and just before the readback (tests)
 * @param {object} bounds - {maxFileBytes}
 * @returns {object} Receipt {exitCode, result, error?, bytes?, sha256?,
 *   previousSha256?, replacements?, mutation?, verification?}
 */
function runFileCall(tool, args, decision, context, bounds) {
  const file = path.join(fs.realpathSync(context.cwd), decision.target);
  const { target } = decision;
  const fail = (message, extra = {}) => ({
    exitCode: 1,
    error: `${target}: ${message}`,
    result: JSON.stringify({
      ok: false,
      is_error: true,
      error: `${target}: ${message}`,
    }),
    ...extra,
  });
  if (tool === 'read') {
    try {
      const { text, bytes } = readText(file, bounds.maxFileBytes);
      context.observed.add(target);
      context.contents.set(target, sha256(bytes));
      return {
        exitCode: 0,
        result: readFrame(text),
        text,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    } catch (error) {
      return fail(
        error instanceof FileToolError
          ? error.message
          : `failed (${error.code || error.message})`
      );
    }
  }
  let current = null;
  let mutation;
  let expected;
  try {
    const existing = lstatOrNull(file);
    if (existing && existing.isSymbolicLink()) {
      return fail(
        'is a symbolic link start cannot resolve inside the working directory; nothing changed'
      );
    }
    if (tool === 'edit' || existing) {
      const seen = context.contents.get(target);
      if (seen === undefined) {
        return fail(
          'was not read completely with the read tool in this task; read it before changing it; nothing changed'
        );
      }
      current = readText(file, bounds.maxFileBytes);
      if (seen !== sha256(current.bytes)) {
        return fail(
          'changed since start read it; read it again before changing it; nothing changed'
        );
      }
    } else if (
      !fs.statSync(path.dirname(file), { throwIfNoEntry: false })?.isDirectory()
    ) {
      return fail('its directory does not exist');
    }
    let matches = null;
    if (tool === 'edit') {
      if (args.oldString === '') {
        return fail('old_string is empty; nothing changed');
      }
      if (args.oldString === args.newString) {
        return fail('old_string and new_string are the same; nothing changed');
      }
      if (!wellFormed(args.oldString) || !wellFormed(args.newString)) {
        return fail(
          'old_string or new_string is not valid Unicode text; nothing changed'
        );
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
      const oldBytes = Buffer.from(args.oldString, 'utf8');
      const newBytes = Buffer.from(args.newString, 'utf8');
      matches = (args.replaceAll ? found : found.slice(0, 1)).map((at) => ({
        offset: Buffer.byteLength(current.text.slice(0, at), 'utf8'),
        oldBytes: oldBytes.length,
        newBytes: newBytes.length,
      }));
      expected = splice(current.bytes, matches, newBytes);
      // The byte splice and the text replacement must agree exactly.
      const text = args.replaceAll
        ? current.text.split(args.oldString).join(args.newString)
        : `${current.text.slice(0, found[0])}${args.newString}${current.text.slice(found[0] + args.oldString.length)}`;
      if (!expected.equals(Buffer.from(text, 'utf8'))) {
        return fail(
          'the replacement does not map to whole UTF-8 characters; nothing changed'
        );
      }
      mutation = { oldBytes, newBytes };
    } else {
      if (!wellFormed(args.content)) {
        return fail('content is not valid Unicode text; nothing changed');
      }
      expected = Buffer.from(args.content, 'utf8');
    }
    if (expected.length > bounds.maxFileBytes) {
      return fail(
        `the new text has ${expected.length} bytes; START_FORMAL_AI_MAX_FILE_BYTES is ${bounds.maxFileBytes}; nothing changed`
      );
    }
    mutation = {
      tool,
      target,
      preimage: current ? digest(current.bytes) : null,
      postimage: digest(expected),
      ...(matches ? { matches } : {}),
      ...(mutation ? { _old: mutation.oldBytes, _new: mutation.newBytes } : {}),
    };
    const guard = () => {
      if (context.beforeReplace) {
        context.beforeReplace(file);
      }
      const now = lstatOrNull(file);
      const unchanged = current
        ? now &&
          !now.isSymbolicLink() &&
          readBytes(file, bounds.maxFileBytes).bytes.equals(current.bytes)
        : now === null;
      if (!unchanged) {
        throw new FileToolError(
          current
            ? 'changed while start was changing it; read it again; nothing changed'
            : 'was created while start was writing it; nothing changed'
        );
      }
    };
    writeAtomically(
      file,
      expected,
      current ? current.mode : undefined,
      guard,
      !current
    );
  } catch (error) {
    const message =
      error instanceof FileToolError
        ? error.message
        : `failed (${error.code || error.message})`;
    if (!mutation) {
      return fail(message);
    }
    // The change did not complete: say truthfully whether the target still
    // holds its preimage, and forget a preimage that no longer holds.
    const intact = stillHolds(file, current, bounds);
    if (!intact) {
      context.contents.delete(target);
    }
    return fail(
      intact || /nothing changed$/.test(message)
        ? `${message.replace(/; nothing changed$/, '')}; nothing changed`
        : `${message}; the file may have changed; read it again`,
      { mutation: publicMutation(mutation) }
    );
  }
  context.observed.add(target);
  const receipt = publicMutation(mutation);
  let readback;
  try {
    if (context.afterReplace) {
      context.afterReplace(file);
    }
    readback = readBytes(file, bounds.maxFileBytes).bytes;
  } catch (error) {
    context.contents.delete(target);
    return {
      exitCode: 0,
      result: changeResult(receipt, false),
      bytes: expected.length,
      previousSha256: current ? sha256(current.bytes) : null,
      replacements: receipt.matches ? receipt.matches.length : null,
      mutation: receipt,
      verification: {
        verified: false,
        detail: `readback of ${target} failed (${error.message})`,
      },
    };
  }
  const check =
    tool === 'edit'
      ? verifyMutation(
          current.bytes,
          readback,
          receipt.matches,
          mutation._old,
          mutation._new
        )
      : { verified: true, detail: 'whole text' };
  const verified = check.verified && readback.equals(expected);
  receipt.readback = digest(readback);
  if (verified) {
    context.contents.set(target, sha256(readback));
  } else {
    context.contents.delete(target);
  }
  return {
    exitCode: 0,
    result: changeResult(receipt, verified),
    bytes: expected.length,
    sha256: sha256(readback),
    previousSha256: current ? sha256(current.bytes) : null,
    replacements: receipt.matches ? receipt.matches.length : null,
    mutation: receipt,
    verification: {
      verified,
      detail: verified
        ? `readback confirmed ${tool} ${target} (${expected.length} bytes; ${check.detail})`
        : `readback of ${target} differs from the intended text${check.verified ? '' : ` (${check.detail})`}`,
    },
  };
}

/** Whether `file` still holds the bound preimage (or is still absent). */
function stillHolds(file, current, bounds) {
  try {
    const now = lstatOrNull(file);
    if (!current) {
      return now === null;
    }
    return (
      now !== null &&
      !now.isSymbolicLink() &&
      readBytes(file, bounds.maxFileBytes).bytes.equals(current.bytes)
    );
  } catch {
    return false;
  }
}

/** The mutation receipt without its internal byte buffers. */
function publicMutation(mutation) {
  return Object.fromEntries(
    Object.entries(mutation).filter(([key]) => key !== '_old' && key !== '_new')
  );
}

/** The tool result Formal AI receives for a change: its receipt, as JSON. */
function changeResult(receipt, verified) {
  return JSON.stringify({
    ok: verified,
    path: receipt.target,
    tool: receipt.tool,
    preimage: receipt.preimage,
    postimage: receipt.postimage,
    ...(receipt.matches ? { replacements: receipt.matches.length } : {}),
    verified,
  });
}

module.exports = {
  FILE_TOOLS,
  describeFileCall,
  evaluateFileCall,
  normalizeFileArgs,
  readFrame,
  readFrameText,
  runFileCall,
  verifyMutation,
};
