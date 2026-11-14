// Finite public-adapter probe. Run with `bun experiments/issue-267/repro.cjs`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sanitizeText,
  sanitizeLogToTemp,
} = require('../../js/src/lib/log-sanitizer');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'start-267-'));
const env = { GH_CONFIG_DIR: directory };
for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
const input = 'Authorization: Bearer abc\0 tail\r\n';
const expected = 'Authorization: Bearer [REDACTED]\0 tail\r\n';
try {
  const source = path.join(directory, 'source.log');
  fs.writeFileSync(source, input);
  const copy = sanitizeLogToTemp(source, { env });
  try {
    assert.equal(fs.readFileSync(copy.path, 'utf8'), expected);
    console.log('stream: exact NUL and following bytes preserved');
  } finally {
    copy.cleanup();
  }
  assert.equal(sanitizeText(input, { env }), expected);
  console.log('issue text: exact NUL and following bytes preserved');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
