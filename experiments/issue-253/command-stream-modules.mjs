// Issue #253: count the modules (and their source size) an ESM import loads.
// Usage: node experiments/issue-253/command-stream-modules.mjs <entry-file>
// LIST=1 also prints each command-stream file.
import { registerHooks } from 'node:module';
const seen = new Map();
registerHooks({ load(url, ctx, next) { const r = next(url, ctx); if (url.startsWith('file:')) seen.set(url, r.source ? r.source.length : 0); return r; } });
const s = performance.now();
await import(process.argv[2]);
const ms = performance.now() - s;
const by = new Map();
for (const [u, n] of seen) { const k = (u.match(/node_modules\/((@[^/]+\/)?[^/]+)\/(src\/)?([^/]+)?/) || []).slice(1).filter(Boolean).join('/').replace(/\/src/, ''); const kk = k.split('/').slice(0, k.startsWith('@') ? 2 : 2).join('/'); by.set(kk, [(by.get(kk)?.[0] || 0) + 1, (by.get(kk)?.[1] || 0) + n]); }
if (process.env.LIST) for (const [u] of seen) if (u.includes("command-stream/src")) console.log(u.split("command-stream/src/")[1]);
console.log(`modules=${seen.size} ms=${ms | 0}`);
[...by].sort((a, b) => b[1][1] - a[1][1]).slice(0, 15).forEach(([k, [c, n]]) => console.log(c, (n / 1024) | 0, 'KiB', k));
