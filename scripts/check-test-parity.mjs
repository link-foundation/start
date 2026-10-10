#!/usr/bin/env node
/** Secondary diagnostic only: feature evidence and shared goldens enforce parity. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimumRustTestCount } from './parity-threshold.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function count(directory, extension, pattern) {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return ['target', 'node_modules'].includes(entry.name)
          ? total
          : total + count(path, extension, pattern);
      }
      return (
        total +
        (path.endsWith(extension)
          ? [...readFileSync(path, 'utf8').matchAll(pattern)].length
          : 0)
      );
    },
    0
  );
}
const javascript = count(
  resolve(root, 'js/test'),
  '.js',
  /\b(?:it|test)\s*\(/g
);
const rust = count(resolve(root, 'rust'), '.rs', /#\[test\]/g);
const minimum = Math.ceil(minimumRustTestCount(javascript));
console.log(
  JSON.stringify({
    javascript,
    rust,
    minimum,
    ratio: javascript ? rust / javascript : null,
  })
);
if (!javascript || !rust || rust < minimum) {
  console.warn(
    '::warning::Test-count disparity is a secondary signal. Review feature evidence and shared goldens; do not pad tests to satisfy a count.'
  );
}
