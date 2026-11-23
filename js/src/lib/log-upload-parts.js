/** Publish verified log bytes through GitHub's Contents API without a checkout. */
const { spawnSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');

const MAX_PART_BYTES = 8 * 1024 * 1024;
const PARTS_PER_DIRECTORY = 1000;

function uploadError(message) {
  return Object.assign(new Error(message), { code: 'ERR_LOG_UPLOAD' });
}

function gh(args, body) {
  return spawnSync('gh', ['api', '--hostname', 'github.com', ...args], {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
}

function setting(name) {
  return (
    process.env[`GH_UPLOAD_${name}`] ?? process.env[`GH_UPLOAD_LOG_${name}`]
  );
}

function openRepository() {
  let repository = setting('REPOSITORY');
  if (!repository) {
    const user = gh(['user', '--jq', '.login']);
    const login = user.stdout?.trim();
    if (user.status !== 0 || !/^[\w-]+$/.test(login ?? '')) {
      throw uploadError('Authenticate with the GitHub CLI to upload logs.');
    }
    repository = `${login}/private-logs`;
  }
  if (!/^[\w-]+\/[\w.-]+$/.test(repository)) {
    throw uploadError('Log upload repository must be in OWNER/REPO format.');
  }

  const endpoint = `repos/${repository}`;
  const lookup = () => gh([endpoint, '--jq', '{visibility, default_branch}']);
  let result = lookup();
  if (
    result.status !== 0 &&
    !setting('REPOSITORY') &&
    /\(HTTP 404\)/.test(result.stderr ?? '')
  ) {
    gh([
      'user/repos',
      '--method',
      'POST',
      '-f',
      'name=private-logs',
      '-F',
      'private=true',
      '-F',
      'auto_init=true',
      '--silent',
    ]);
    // Read the created repository, including when a concurrent upload created it.
    result = lookup();
  }
  if (result.status !== 0) {
    throw uploadError('Could not open the private GitHub log repository.');
  }
  const info = JSON.parse(result.stdout);
  if (info.visibility !== 'private') {
    throw uploadError('Log upload requires a private GitHub repository.');
  }
  const branch = setting('BRANCH') || info.default_branch;
  if (!branch) {
    throw uploadError('The private GitHub log repository needs a branch.');
  }
  return { endpoint, repository, branch };
}

// Allow a few bytes of lookahead and keep an entire UTF-8 sequence together.
// Invalid bytes are preserved too, including NULs.
function partEnd(buffer, limit) {
  let start = limit;
  while (start > limit - 3 && (buffer[start] & 0xc0) === 0x80) {
    start--;
  }
  const lead = buffer[start];
  const width =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  return start + width > limit ? start : limit;
}

async function* logParts(source, limit) {
  const buffer = Buffer.allocUnsafe(limit + 3);
  let length = 0;
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length;) {
      const count = chunk.copy(
        buffer,
        length,
        offset,
        offset + buffer.length - length
      );
      length += count;
      offset += count;
      if (length === buffer.length) {
        const end = partEnd(buffer, limit);
        yield buffer.subarray(0, end);
        buffer.copyWithin(0, end, length);
        length -= end;
      }
    }
  }
  if (length > limit) {
    const end = partEnd(buffer, limit);
    yield buffer.subarray(0, end);
    buffer.copyWithin(0, end, length);
    length -= end;
  }
  if (length > 0) {
    yield buffer.subarray(0, length);
  }
}

function storePart({ endpoint, branch }, path, bytes) {
  const url = `${endpoint}/contents/${path}`;
  const body = {
    message: `Upload execution log ${path.split('/').pop()}`,
    content: bytes.toString('base64'),
    branch,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      gh([url, '--method', 'PUT', '--input', '-', '--silent'], body).status ===
      0
    ) {
      return;
    }
    // A lost HTTP response can hide a successful commit. Compare the Git blob ID
    // before retrying the create-only request.
    const existing = gh([
      url,
      '--method',
      'GET',
      '-f',
      `ref=${branch}`,
      '-H',
      'Accept: application/vnd.github.object+json',
      '--jq',
      '.sha',
    ]);
    const sha = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (existing.status === 0 && existing.stdout.trim() === sha) {
      return;
    }
  }
  throw uploadError('GitHub could not confirm the log part or index.');
}

function partPath(number) {
  const folder = Math.floor((number - 1) / PARTS_PER_DIRECTORY) + 1;
  return `parts/${String(folder).padStart(6, '0')}/part-${String(number).padStart(12, '0')}.log`;
}

function indexText(count, bytes) {
  const instructions =
    count === 0
      ? 'The verified log is empty.\n'
      : `Read [the parts](parts/) in numeric order and concatenate their bytes. Each
folder contains up to 1000 consecutive parts.\n`;
  return Buffer.from(`# Execution log

This upload contains ${count} part(s) and ${bytes} bytes.

${instructions}`);
}

async function publishLogParts(source, { noSanitize, verbose = false } = {}) {
  const configuredLimit = process.env.START_LOG_UPLOAD_PART_BYTES;
  const limit =
    configuredLimit === undefined
      ? MAX_PART_BYTES
      : /^[0-9]+$/.test(configuredLimit)
        ? Number(configuredLimit)
        : 0;
  if (!Number.isInteger(limit) || limit < 4 || limit > MAX_PART_BYTES) {
    throw uploadError(
      `START_LOG_UPLOAD_PART_BYTES must be 4–${MAX_PART_BYTES}.`
    );
  }
  if (verbose && noSanitize) {
    console.log('The upload still verifies credentials with --no-sanitize.');
  }
  const dryRun = /^(true|1)$/i.test(setting('DRY_MODE') ?? '');
  const folder = `start-upload-${randomUUID()}`;
  let target;
  let count = 0;
  let bytes = 0;
  let folderUrl;
  try {
    for await (const part of logParts(source, limit)) {
      count++;
      bytes += part.length;
      if (!dryRun) {
        target ??= openRepository();
        storePart(target, `${folder}/${partPath(count)}`, part);
        folderUrl ??= `https://github.com/${target.repository}/tree/${encodeURIComponent(target.branch)}/${folder}`;
        if (count === 1 || verbose) {
          console.log(`Published log part ${count}: ${folderUrl}`);
        }
      }
    }
    if (dryRun) {
      console.log(`Dry run: ${count} verified log part(s), ${bytes} bytes.`);
      return null;
    }
    target ??= openRepository();
    storePart(target, `${folder}/README.md`, indexText(count, bytes));
    const url = `https://github.com/${target.repository}/blob/${encodeURIComponent(target.branch)}/${folder}/README.md`;
    console.log(`Uploaded log: ${url}`);
    return url;
  } catch (error) {
    if (folderUrl) {
      console.error(`Partial log available: ${folderUrl}`);
    }
    throw error;
  }
}

module.exports = { publishLogParts };
