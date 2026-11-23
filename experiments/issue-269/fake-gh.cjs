// Model the GitHub Contents API for both CLI regression tests.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const args = process.argv.slice(2);
const [api, flag, host, endpoint] = args;
const capture = process.env.UPLOAD_CAPTURE;
const mode = process.env.UPLOAD_TEST_MODE;
if (
  api !== 'api' ||
  flag !== '--hostname' ||
  host !== 'github.com' ||
  !capture
) {
  process.exit(2);
}
const status = (code) => {
  console.error(`gh: fixture HTTP error (HTTP ${code})`);
  process.exit(1);
};
if (endpoint === 'user') {
  console.log('octocat');
} else if (endpoint === 'user/repos' && args.includes('private=true')) {
  fs.writeFileSync(path.join(capture, 'repo-created'), '');
} else if (endpoint === 'repos/octocat/private-logs') {
  if (
    mode === 'missing' &&
    !fs.existsSync(path.join(capture, 'repo-created'))
  ) {
    status(404);
  }
  console.log(
    JSON.stringify({
      visibility: mode === 'public' ? 'public' : 'private',
      default_branch: 'main',
    })
  );
} else if (
  endpoint.startsWith('repos/octocat/private-logs/contents/start-upload-')
) {
  const name = path.posix.basename(endpoint);
  const dest = path.join(capture, name);
  const method = args[args.indexOf('--method') + 1];
  if (method === 'GET') {
    if (!fs.existsSync(dest)) status(404);
    const bytes = fs.readFileSync(dest);
    console.log(
      createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex')
    );
  } else if (method === 'PUT' && args.includes('--input')) {
    const { content, branch } = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (branch !== 'main' || fs.existsSync(dest)) status(409);
    if (mode === 'interrupt' && name === 'part-000000000002.log') status(500);
    fs.writeFileSync(dest, Buffer.from(content, 'base64'));
    if (mode === 'lost-response' && name === 'part-000000000001.log')
      status(500);
  } else {
    status(400);
  }
} else {
  status(404);
}
