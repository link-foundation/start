#!/usr/bin/env node
// The `meta-language` command-line tool. `meta-language grammar ...` imports,
// validates, converts, merges, renames, exports and round-trips grammars; see
// runGrammarCommand in grammar-interchange.js, which the Rust binary mirrors.
// `meta-language translate` translates meta-language's own modules between
// JavaScript, TypeScript and Rust; see self-translation.js.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runGrammarCommand } from './grammar-interchange.js';
import { SelfTranslationError, selfTranslate, selfTranslationLanguage } from './self-translation.js';

const USAGE = 'usage: meta-language grammar <command> [options]; run meta-language grammar help\n'
  + '       meta-language translate --to <language> [--from <language>] [--items] <file>\n';
const TRANSLATE_USAGE = 'usage: meta-language translate --to <language> [--from <language>] [--items] <file>\n'
  + 'Translates a module between JavaScript, TypeScript and Rust; --from defaults to the file\'s extension\n'
  + 'and --items prints each top-level item\'s status instead of the translation.\n';

/** Runs `meta-language translate` over `args`. */
function runTranslateCommand(args, { readFile }) {
  const options = { from: null, to: null, items: false, file: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { exitCode: 0, stdout: TRANSLATE_USAGE, stderr: '' };
    if (arg === '--items') options.items = true;
    else if ((arg === '--from' || arg === '--to') && index + 1 < args.length) options[arg.slice(2)] = args[++index];
    else if (!arg.startsWith('--') && options.file === null) options.file = arg;
    else return { exitCode: 2, stdout: '', stderr: `error: unexpected argument ${arg}\n${TRANSLATE_USAGE}` };
  }
  if (options.file === null || options.to === null) return { exitCode: 2, stdout: '', stderr: TRANSLATE_USAGE };
  const from = options.from ?? selfTranslationLanguage(options.file.split('.').pop());
  if (from === null) return { exitCode: 2, stdout: '', stderr: `error: pass --from; the extension of ${options.file} names no language\n` };
  try {
    const result = selfTranslate(readFile(options.file), from, options.to);
    const stdout = options.items
      ? result.items.map(({ term, start, end, status, reason }) => `${start}..${end} ${term} ${status}${reason ? ` (${reason})` : ''}\n`).join('')
      : result.code;
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    if (!(error instanceof SelfTranslationError)) throw error;
    return { exitCode: 1, stdout: '', stderr: `error: ${error.message}\n` };
  }
}

/** Runs the tool over `args` and returns `{ exitCode, stdout, stderr }`. */
export function runCommandLine(args, { readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const [group, ...rest] = args;
  if (group === 'grammar') return runGrammarCommand(rest, { readFile });
  if (group === 'translate') return runTranslateCommand(rest, { readFile });
  if (group === '--help' || group === '-h' || group === 'help') return { exitCode: 0, stdout: USAGE, stderr: '' };
  return { exitCode: 2, stdout: '', stderr: group === undefined ? USAGE : `error: unknown command ${group}\n${USAGE}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { exitCode, stdout, stderr } = runCommandLine(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
}
