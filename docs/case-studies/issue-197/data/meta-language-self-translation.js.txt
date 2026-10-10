// Translates meta-language's own modules between JavaScript, TypeScript and
// Rust through meta-language links. The source is parsed losslessly with its
// native grammar; a translation into the same language writes the links back
// byte for byte, and a translation into the other language translates each
// top-level item the portable core can express and carries every other item
// verbatim in a marked comment. Both kinds of item keep their source as
// provenance, so translating an unedited translation back restores the
// source byte for byte.
import { createHash } from 'node:crypto';

import { decoratorSet } from './decorators.js';
import { decorateEmitted } from './grammar-emitters/common.js';
import { LinkNetwork } from './network.js';
import { parseProgrammingLanguage } from './programming-language-parser.js';
import { checkProgram } from './translation/check.js';
import { TranslationError } from './translation/diagnostics.js';
import { emitJavaScript } from './translation/emit-javascript.js';
import { emitRust, emitRustConstants } from './translation/emit-rust.js';
import { parseJavaScript } from './translation/javascript.js';
import { tokenize } from './translation/lexer.js';
import { parseRust } from './translation/rust.js';

/** The languages self-translation reads and writes. */
export const SELF_TRANSLATION_LANGUAGES = Object.freeze(['JavaScript', 'TypeScript', 'Rust']);

const HEADER = '// meta-language:self-translation:v1 ';
const CARRIED = '// meta-language:carried ';
const TRANSLATED = '// meta-language:translated ';
const SOURCE_LINE = '// |';
const PRELUDE_BEGIN = '// meta-language:prelude begin';
const PRELUDE_END = '// meta-language:prelude end';
// Portable-core Rust keeps the source's parentheses and names.
const RUST_ALLOW = '#![allow(unused, unreachable_patterns, non_snake_case, non_camel_case_types, invalid_nan_comparisons)]';
const ALIASES = new Map([
  ['javascript', 'JavaScript'], ['js', 'JavaScript'], ['mjs', 'JavaScript'],
  ['typescript', 'TypeScript'], ['ts', 'TypeScript'],
  ['rust', 'Rust'], ['rs', 'Rust'],
]);
const COMMENTS = new Set(['comment', 'line_comment', 'block_comment']);

/** Thrown for an unknown language or a source the links do not reproduce. */
export class SelfTranslationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelfTranslationError';
  }
}

/** The self-translation language `language` names, or `null`. */
export function selfTranslationLanguage(language) {
  return ALIASES.get(String(language).toLowerCase()) ?? null;
}

function required(language) {
  const name = selfTranslationLanguage(language);
  if (!name) throw new SelfTranslationError(`self-translation reads and writes ${SELF_TRANSLATION_LANGUAGES.join(', ')}, not ${language}`);
  return name;
}

// The family a language's code is written in: TypeScript items are read and
// written as JavaScript.
const family = (language) => (language === 'Rust' ? 'Rust' : 'JavaScript');
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/**
 * Translates `source` from `sourceLanguage` to `targetLanguage`, each one of
 * {@link SELF_TRANSLATION_LANGUAGES} or an alias of one.
 *
 * The result is `{ sourceLanguage, targetLanguage, code, items }`. Each item
 * `{ term, start, end, status, reason }` is a top-level item of the source
 * (byte offsets) with its status: `kept` (same language), `translated`,
 * `restored` (provenance gave back its source), `comment`, `provenance` (a
 * self-translation header or prelude) or `carried`, with the reason it was
 * carried.
 *
 * `options.decorators` (a DecoratorSet or an array of decorators) decorates
 * each translated item at the `emitter` level, one `{ format, number, line }`
 * record per line of its definitions with the target language as `format`,
 * before its provenance is recorded, so a translation can be brought to match
 * hand-written code and still restores its source.
 *
 * From JavaScript or TypeScript into Rust, an item may call and read the
 * module's other top-level items: each item is translated after the items it
 * names, with the signatures of those that translated bound, and the Rust
 * names them as its own translation does. `import { a, b as c } from
 * './m.mjs'` becomes `use crate::m::{a, b as c};`: `options.moduleDirectory`
 * (path segments, the crate root by default) is the module's directory inside
 * the crate, and `options.imports` maps an import specifier to the signatures
 * {@link selfTranslationSignatures} gives for that module, which bind the
 * imported names the same way.
 */
export function selfTranslate(source, sourceLanguage, targetLanguage, options = {}) {
  return translateModule(source, sourceLanguage, targetLanguage, options).translation;
}

/**
 * The signatures of the exported items of the JavaScript or TypeScript module
 * `source` that translate into Rust, in source order, for
 * {@link selfTranslate}'s `options.imports` of a module that imports them:
 * `{ k: 'fn', name, params: [{ name, type }], ret }` for a function and
 * `{ k: 'const', name, type, literal }` for a constant, where `literal` tells
 * whether a literal gives its value. `options` are {@link selfTranslate}'s.
 */
export function selfTranslationSignatures(source, language, options = {}) {
  if (family(required(language)) !== 'JavaScript') {
    throw new SelfTranslationError(`signatures are read from JavaScript or TypeScript modules, not ${language}`);
  }
  return translateModule(source, language, 'Rust', options).signatures;
}

function translateModule(source, sourceLanguage, targetLanguage, { decorators, moduleDirectory = [], imports = {} } = {}) {
  const from = required(sourceLanguage);
  const to = required(targetLanguage);
  const set = decoratorSet(decorators);
  const text = String(source);
  const reconstructed = LinkNetwork.parse(text, from).reconstructText();
  if (reconstructed !== text) {
    throw new SelfTranslationError(`the ${from} links of the source do not reproduce it`);
  }
  const bytes = Buffer.from(text, 'utf8');
  const items = topLevelItems(text, from, bytes);
  if (family(from) === family(to)) {
    return { translation: freeze(from, to, reconstructed, items.map(({ term, start, end }) => ({ term, start, end, status: 'kept', reason: null }))), signatures: [] };
  }
  const blocks = [];
  const preludes = [];
  const recorded = [];
  let gap = '';
  const groups = groupItems(items, bytes);
  const { outs, scans } = family(to) === 'Rust'
    ? translateBound(groups, from, to, set, { moduleDirectory, imports })
    : { outs: groups.map((group) => translateGroup(group, from, to, set)), scans: [] };
  const signatures = outs.flatMap((out, index) => (scans[index]?.exported && out.status === 'translated' ? out.signatures : []));
  for (const [index, group] of groups.entries()) {
    const out = outs[index];
    for (const prelude of out.preludes ?? []) if (!preludes.includes(prelude)) preludes.push(prelude);
    for (const { term, start, end } of group.items) recorded.push({ term, start, end, status: out.status, reason: out.reason ?? null });
    if (out.code !== null) {
      blocks.push(`${blocks.length ? breaks(gap) : ''}${out.code}`);
      gap = group.after;
    } else if (!gap) {
      // A dropped group keeps the layout before it.
      gap = group.after;
    }
  }
  const body = `${blocks.join('')}\n`;
  // An unedited translation back gives the source its header describes.
  const header = items.find((item) => item.comment && item.text.startsWith(HEADER));
  if (header && header.text.includes(` source=${to} `) && header.text.includes(` sha256=${sha256(body)} `)) {
    return { translation: freeze(from, to, body, recorded), signatures };
  }
  if (family(to) === 'Rust' && recorded.some(({ status }) => status === 'translated')) preludes.unshift(RUST_ALLOW);
  const lines = [`${HEADER}source=${from} target=${to} sha256=${sha256(text)} bytes=${bytes.length}`, ''];
  if (preludes.length) lines.push(PRELUDE_BEGIN, ...preludes.flatMap((prelude, index) => (index ? ['', prelude] : [prelude])), PRELUDE_END, '');
  return { translation: freeze(from, to, `${lines.join('\n')}\n${body}`, recorded), signatures };
}

/**
 * Translates the groups of a JavaScript module into Rust, each item after the
 * items it names, with the signatures of the ones that translated bound. A
 * name that a cycle of items leaves untranslated stays unbound, so its
 * callers are carried with the checker's diagnostic.
 */
function translateBound(groups, from, to, decorators, { moduleDirectory, imports }) {
  const scans = groups.map((group) => (group.kind === 'item' ? scanItem(group.text) : null));
  const owners = new Map();
  scans.forEach((scan, index) => {
    const names = scan?.imports ? scan.imports.names.map(({ local }) => local) : scan?.declares ? [scan.declares] : [];
    for (const name of names) if (!owners.has(name)) owners.set(name, index);
  });
  const outs = new Array(groups.length);
  const visiting = new Set();
  const visit = (index) => {
    if (outs[index] || visiting.has(index)) return;
    const scan = scans[index];
    if (!scan) {
      outs[index] = translateGroup(groups[index], from, to, decorators);
      return;
    }
    visiting.add(index);
    const externals = [];
    if (scan.imports) {
      const { specifier, names } = scan.imports;
      const provided = Object.hasOwn(imports, specifier) ? imports[specifier] : [];
      for (const { imported, local } of names) {
        const signature = provided.find(({ name }) => name === imported);
        if (signature) externals.push({ ...signature, name: local });
      }
    } else {
      for (const name of scan.mentions) {
        const owner = owners.get(name);
        if (owner === undefined || owner === index) continue;
        visit(owner);
        if (outs[owner]?.status !== 'translated' || scans[owner].async) continue;
        const signature = outs[owner].signatures.find((candidate) => candidate.name === name);
        if (signature) externals.push(signature);
      }
    }
    outs[index] = translateGroup(groups[index], from, to, decorators, { externals, moduleDirectory });
    visiting.delete(index);
  };
  groups.forEach((_, index) => visit(index));
  return { outs, scans };
}

/**
 * What a JavaScript item declares and names, read from its tokens: the name
 * of the function or constant it declares, whether it is exported or async,
 * the identifiers it mentions, and the specifier and names of a named import.
 * Null when the item does not tokenize.
 */
function scanItem(text) {
  let tokens;
  try {
    ({ tokens } = tokenize(text, 'JavaScript'));
  } catch (error) {
    if (error instanceof TranslationError) return null;
    throw error;
  }
  const at = (index) => tokens[Math.min(index, tokens.length - 1)];
  const word = (index, value) => at(index).kind === 'identifier' && at(index).value === value;
  const exported = word(0, 'export');
  let index = exported ? 1 : 0;
  let declares = null;
  let isAsync = false;
  let imports = null;
  if (word(index, 'async') && word(index + 1, 'function')) {
    isAsync = true;
    index += 1;
  }
  if (word(index, 'function') && at(index + 1).kind === 'identifier') {
    declares = at(index + 1).value;
  } else if (word(index, 'const') && at(index + 1).kind === 'identifier' && at(index + 2).value === '=') {
    declares = at(index + 1).value;
    isAsync = word(index + 3, 'async');
  } else if (word(0, 'import') && at(1).value === '{') {
    const names = [];
    let next = 2;
    while (at(next).kind === 'identifier') {
      const imported = at(next).value;
      const aliased = word(next + 1, 'as') && at(next + 2).kind === 'identifier';
      names.push({ imported, local: aliased ? at(next + 2).value : imported });
      next += aliased ? 3 : 1;
      if (at(next).value !== ',') break;
      next += 1;
    }
    if (at(next).value === '}' && word(next + 1, 'from') && at(next + 2).kind === 'string') imports = { specifier: at(next + 2).value, names };
  }
  const mentions = [...new Set(tokens.filter((token) => token.kind === 'identifier').map((token) => token.value))];
  return { declares, exported, async: isAsync, mentions, imports };
}

/**
 * The signatures a translated item gives the other items of its module: its
 * functions at the top level, other than the ones the translator makes up,
 * or its constant, when no data type is among their types and no parameter
 * is a guarded natural number.
 */
function declaredSignatures(program, constants) {
  const portable = (type) => (type.kind === 'array' ? portable(type.element) : type.kind !== 'data');
  if (constants) {
    const [{ name, value }] = program.main.effects;
    return portable(value.type) ? [{ k: 'const', name, type: value.type, literal: value.k === 'lit' }] : [];
  }
  return [...program.declarations.values()]
    .filter((entry) => entry.k === 'fn' && entry.modulePath.length === 0 && !entry.name.startsWith('ml_')
      && entry.params.every((param) => !param.guard && portable(param.type)) && portable(entry.ret))
    .map((entry) => ({ k: 'fn', name: entry.name, params: entry.params.map(({ name, type }) => ({ name, type })), ret: entry.ret }));
}

function freeze(sourceLanguage, targetLanguage, code, items) {
  return Object.freeze({
    sourceLanguage,
    targetLanguage,
    code,
    items: Object.freeze(items.map((item) => Object.freeze(item))),
  });
}

// The layout between two emitted blocks: its line breaks, at least one.
function breaks(gap) {
  return '\n'.repeat(Math.max(1, (gap.match(/\n/gu) ?? []).length));
}

/** The top-level items of `text`, with their text and the layout after each. */
function topLevelItems(text, language, bytes) {
  const parsed = parseProgrammingLanguage(text, language);
  const children = (parsed?.tree.children ?? [])
    .filter((child) => child.term !== 'whitespace')
    .map((child) => {
      const { start } = child.span.byteRange;
      let { end } = child.span.byteRange;
      // A Rust line comment ends with its line break, which is layout here.
      if (COMMENTS.has(child.term) && bytes[end - 1] === 0x0a) end -= bytes[end - 2] === 0x0d ? 2 : 1;
      return { term: child.term, start, end };
    });
  return children.map((item, index) => ({
    ...item,
    comment: COMMENTS.has(item.term),
    text: bytes.subarray(item.start, item.end).toString('utf8'),
    after: bytes.subarray(item.end, children[index + 1]?.start ?? bytes.length).toString('utf8'),
  }));
}

const lineBreak = (layout) => /^\r?\n$/u.test(layout);
const sourceLines = (lines) => lines.map(({ text }) => text.slice(SOURCE_LINE.length).replace(/^ /u, ''));

/**
 * Groups the items: a self-translation header, a prelude block, a carried or
 * translated item with its provenance, and an item with the comments directly
 * before it are one group each.
 */
function groupItems(items, bytes) {
  const groups = [];
  const textBetween = (first, last) => bytes.subarray(first.start, last.end).toString('utf8');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const take = (end, fields) => {
      groups.push({ ...fields, items: items.slice(index, end + 1), after: items[end].after });
      index = end;
    };
    // The `// |` source lines that follow the item at `at` line by line.
    const linesAfter = (at) => {
      let end = at;
      while (end + 1 < items.length && items[end + 1].comment && items[end + 1].text.startsWith(SOURCE_LINE) && lineBreak(items[end].after)) end += 1;
      return end;
    };
    if (item.comment && item.text.startsWith(HEADER)) {
      take(index, { kind: 'provenance' });
    } else if (item.comment && item.text === PRELUDE_BEGIN) {
      let end = index;
      while (end + 1 < items.length && items[end].text !== PRELUDE_END) end += 1;
      take(end, { kind: 'provenance' });
    } else if (item.comment && item.text.startsWith(CARRIED)) {
      const end = linesAfter(index);
      const [language] = item.text.slice(CARRIED.length).split(' ');
      take(end, { kind: 'carried', language, marker: item.text, lines: sourceLines(items.slice(index + 1, end + 1)) });
    } else if (item.comment && item.text.startsWith(TRANSLATED)) {
      const fields = Object.fromEntries(item.text.slice(TRANSLATED.length).split(' ').slice(2).map((field) => field.split('=')));
      const linesEnd = linesAfter(index);
      const last = definitionsEnd(items, linesEnd, Number(fields.items));
      if (last >= 0) {
        const code = textBetween(items[linesEnd + 1], items[last]);
        const [language] = item.text.slice(TRANSLATED.length).split(' ');
        const lines = sourceLines(items.slice(index + 1, linesEnd + 1));
        if (sha256(code) === fields.sha256) {
          take(last, { kind: 'carried', language, lines });
          continue;
        }
        // An edited translation is translated again; its provenance is dropped.
        take(linesEnd, { kind: 'provenance' });
        continue;
      }
      take(index, { kind: 'comment', text: item.text, term: item.term });
    } else {
      // Comments directly before an item document it and travel with it.
      let end = index;
      while (items[end].comment && end + 1 < items.length && lineBreak(items[end].after) && !isMarker(items[end + 1])) end += 1;
      // A run of comments no item follows is one comment group.
      take(end, { kind: items[end].comment ? 'comment' : 'item', text: textBetween(item, items[end]), term: items[end].term });
    }
  }
  return groups;
}

/**
 * The last item of the `count` definitions after the item at `after`, or -1:
 * a definition's attributes (`#[derive(…)]`) are items of their own in Rust.
 */
function definitionsEnd(items, after, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return -1;
  let left = count;
  for (let at = after + 1; at < items.length; at += 1) {
    if (items[at].term !== 'attribute_item') left -= 1;
    if (left === 0) return at;
  }
  return -1;
}

const isMarker = (item) => item.comment && [HEADER, CARRIED, TRANSLATED, PRELUDE_BEGIN].some((marker) => item.text.startsWith(marker));

function translateGroup(group, from, to, decorators, context = {}) {
  if (group.kind === 'provenance') return { code: null, status: 'provenance' };
  if (group.kind === 'carried') {
    if (family(group.language) === family(to)) return { code: group.lines.join('\n'), status: 'restored' };
    const marker = group.items[0].text;
    return { code: [marker, ...group.lines.map(sourceLine)].join('\n'), status: 'carried', reason: 'carried from another language' };
  }
  const { text, term } = group;
  if (group.kind === 'comment') {
    // A copied comment has no provenance, so it must also fit the source.
    if (group.items.every((item) => commentFits(item.text, from) && commentFits(item.text, to))) return { code: text, status: 'comment' };
    return carry(text, term, from, 'comment the target cannot hold');
  }
  let emitted;
  let signatures;
  try {
    // The Rust frontend reads a program, so an item alone gets an empty main.
    const program = checkProgram(family(from) === 'Rust'
      ? parseRust(/\bfn\s+main\s*\(/u.test(text) ? text : `${text}\nfn main() {}\n`)
      : parseJavaScript(text, context));
    // A top-level constant is a Rust constant; other top-level statements run once, as a program.
    const constants = family(to) === 'Rust' ? emitRustConstants(program) : null;
    if (!constants && program.main.effects.length > 0) return carry(text, term, from, 'top-level statement');
    emitted = constants ?? (family(to) === 'Rust' ? emitRust : emitJavaScript)(program);
    signatures = program.imports ? context.externals : declaredSignatures(program, constants);
  } catch (error) {
    if (!(error instanceof TranslationError)) throw error;
    return carry(text, term, from, error.kind);
  }
  if (emitted.definitions.length === 0) return carry(text, term, from, 'no definition');
  const exported = family(to) === 'JavaScript' && (family(from) === 'Rust' ? /^pub(\([^)]*\))?\s/mu : /^export\s/mu).test(text);
  const generic = emitted.definitions.map((definition) => (exported ? `export ${definition}` : definition)).join('\n\n');
  const code = decorateEmitted(to, { source: generic }, decorators).source;
  if (code.trim() === '') return carry(text, term, from, 'dropped by a decorator');
  const count = emitted.definitions.length;
  const marker = `${TRANSLATED}${from} ${term} items=${count} sha256=${sha256(code)}`;
  return {
    code: [marker, ...text.split(/\r?\n/u).map(sourceLine), code].join('\n'),
    preludes: emitted.preludes,
    status: 'translated',
    signatures,
  };
}

function carry(text, term, from, reason) {
  return {
    code: [`${CARRIED}${from} ${term} (${reason})`, ...text.split(/\r?\n/u).map(sourceLine)].join('\n'),
    status: 'carried',
    reason,
  };
}

const sourceLine = (line) => (line === '' ? SOURCE_LINE : `${SOURCE_LINE} ${line}`);

// A comment keeps its text when the target reads it as an ordinary comment:
// a Rust doc comment needs an item after it, and Rust block comments nest.
function commentFits(text, to) {
  if (text.startsWith('/*') && /\/\*|\*\//u.test(text.slice(2, -2))) return false;
  return family(to) !== 'Rust' || !/^(\/\/[/!]|\/\*[*!])/u.test(text);
}
