// Bounded fixture and scanner experiment; run with node --max-old-space-size=96.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeLogToTemp } = require('../../js/src/lib/log-sanitizer');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-200-large-'));
let copy;
try {
  const source = path.join(directory, 'large.log');
  const fd = fs.openSync(source, 'wx');
  const token = `gh${'p_'}${'a'.repeat(36)}`;
  const sample = Buffer.from(`ordinary output café 😀 ${token}\n`);
  const block = Buffer.alloc(64 * 1024, 32);
  for (let offset = 0; offset + sample.length < block.length; offset += sample.length) sample.copy(block, offset);
  for (let count = 0; count < 1760; count++) fs.writeSync(fd, block);
  fs.closeSync(fd);
  const begin = performance.now();
  copy = sanitizeLogToTemp(source, { env: {} });
  const uploaded = fs.openSync(copy.path, 'r');
  const read = Buffer.alloc(64 * 1024);
  let tail = '';
  let leaked = false;
  for (;;) {
    const length = fs.readSync(uploaded, read, 0, read.length, null);
    if (!length) break;
    const text = tail + read.subarray(0, length).toString();
    leaked ||= text.includes(token);
    tail = text.slice(-token.length);
  }
  fs.closeSync(uploaded);
  console.log(JSON.stringify({ sourceBytes: fs.statSync(source).size, sanitizedBytes: fs.statSync(copy.path).size, secretLeaked: leaked, elapsedMs: Math.round(performance.now() - begin), maxRssKiB: process.resourceUsage().maxRSS, heapLimitMiB: 96 }));
  process.exitCode = leaked ? 1 : 0;
} finally {
  if (copy) copy.cleanup();
  fs.rmSync(directory, { recursive: true, force: true });
}
