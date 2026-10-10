// Safe local reproducer: a fake uploader records bytes and arguments; no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-200-'));
try {
  const log = path.join(dir, 'execution.log');
  const token = 'gh' + 'p_' + 'a'.repeat(36);
  fs.writeFileSync(log, `GITHUB_TOKEN=${token}\n`);
  fs.writeFileSync(
    path.join(dir, 'gh-upload-log'),
    '#!/bin/sh\ncat "$1" > "$CAPTURE_LOG"\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n',
    { mode: 0o755 }
  );
  const modulePath = require.resolve('../../js/src/lib/log-uploader');
  execFileSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(modulePath)}).uploadLogPath(process.env.SOURCE_LOG)`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        SOURCE_LOG: log,
        CAPTURE_LOG: path.join(dir, 'uploaded'),
        CAPTURE_ARGS: path.join(dir, 'args'),
      },
      stdio: 'pipe',
    }
  );
  const bytes = fs.readFileSync(path.join(dir, 'uploaded'), 'utf8');
  const args = fs
    .readFileSync(path.join(dir, 'args'), 'utf8')
    .trim()
    .split('\n');
  console.log(
    JSON.stringify({
      secretLeaked: bytes.includes(token),
      uploadedOriginal: args[0] === log,
      explicitlyPrivate: args.includes('--private'),
    })
  );
  process.exitCode = bytes.includes(token) ? 1 : 0;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
