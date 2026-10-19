import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// command-stream's `$` resolves with a non-zero `code` instead of throwing, so
// a bare `await $`...`` - or one inside try/catch - silently ignores a failed
// command. That made a rejected `npm publish` print "✅ Published" and a failed
// GitHub API call print "✅ Formatted release notes" (issue #234). Every call in
// scripts/ must either go through checked() or read the result's `.code`.

const scriptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts'
);

/**
 * Find `$` template calls whose exit code nobody looks at.
 * @param {string} source
 * @returns {string[]} offending lines, prefixed with their line number
 */
export function findUncheckedCommands(source) {
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (
      !trimmed.includes('$`') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('//')
    ) {
      return;
    }
    const previous = index > 0 ? lines[index - 1] : '';
    if (/\bchecked\(/.test(line) || /\bchecked\(\s*$/.test(previous)) {
      return;
    }
    const assigned = `${previous}\n${line}`.match(
      /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?$|(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?\$`/m
    );
    const name = assigned && (assigned[1] || assigned[2]);
    const rest = lines.slice(index + 1).join('\n');
    if (name && new RegExp(`\\b${name}\\.code\\b`).test(rest)) {
      return;
    }
    offenders.push(`${index + 1}: ${trimmed}`);
  });
  return offenders;
}

describe('command exit codes in release scripts', () => {
  it('flags a bare call and a try/catch-wrapped call', () => {
    const source = [
      'try {',
      '  await $`npm run changeset:publish`;',
      '} catch {}',
      'const r = await $`gh api x`.run({ capture: true });',
      'console.log(r.stdout);',
    ].join('\n');
    expect(findUncheckedCommands(source)).toEqual([
      '2: await $`npm run changeset:publish`;',
      '4: const r = await $`gh api x`.run({ capture: true });',
    ]);
  });

  it('accepts checked() and an inspected .code', () => {
    const source = [
      'await checked($`git push`, "git push");',
      'await checked(',
      '  $`git fetch`,',
      '  "git fetch"',
      ');',
      'const ancestry =',
      '  await $`git merge-base --is-ancestor a b`.run({ capture: true });',
      'if (ancestry.code !== 0) throw new Error("x");',
      '// await $`ignored in a comment`',
    ].join('\n');
    expect(findUncheckedCommands(source)).toEqual([]);
  });

  it('every command in scripts/*.mjs has its exit code checked', () => {
    const offenders = readdirSync(scriptsDir)
      .filter((file) => file.endsWith('.mjs'))
      .flatMap((file) =>
        findUncheckedCommands(readFileSync(join(scriptsDir, file), 'utf8')).map(
          (offender) => `scripts/${file}:${offender}`
        )
      );
    expect(offenders).toEqual([]);
  });
});
