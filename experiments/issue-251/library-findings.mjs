// Prints the library's findings for each input line (issue #249 / #250 probes).
// Usage: node library-findings.mjs <path-to-sensitive-data-sanitizer> < lines.txt
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const lib = await import(pathToFileURL(path.join(process.argv[2], 'src/index.js')).href);
for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
  const found = lib.inspect(line, { credentialsOnly: true });
  console.log(JSON.stringify(line));
  for (const f of found) console.log('   ', f.rule, JSON.stringify(line.slice(f.start, f.end)));
}
