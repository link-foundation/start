/**
 * Resolution and identity of the Formal AI runtime used by `--use-formal-ai`
 * (issue #255).
 *
 * Formal AI is not published to npm, so start never installs or guesses a
 * runtime. It uses exactly one of:
 * - START_FORMAL_AI_ROOT: a link-assistant/formal-ai checkout whose
 *   JavaScript server (`js/server/main.mjs --agent-mode`) start spawns on a
 *   private loopback port with a private memory directory;
 * - START_FORMAL_AI_URL: an already running Formal AI server, which reports
 *   no version, so it is used only with START_FORMAL_AI_ALLOW_UNVERIFIED=1.
 * Without either, or with a runtime older than the qualified version, the
 * mode fails; it never falls back to an LLM, the alias table or a shell.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EXIT } = require('./formal-ai-policy');

const { AbortSignal, setTimeout } = globalThis;

/** The Formal AI release this mode was qualified against. */
const MIN_FORMAL_AI_VERSION = '0.355.27';
const SERVER_ENTRY = path.join('js', 'server', 'main.mjs');
const API_PREFIX = '/api/openai/v1';
const INSTALL_HINT =
  'Install Formal AI from https://github.com/link-assistant/formal-ai ' +
  '(git clone https://github.com/link-assistant/formal-ai.git) and set ' +
  'START_FORMAL_AI_ROOT to the checkout, or set START_FORMAL_AI_URL to a ' +
  'running server. See docs/formal-ai.md.';

class RuntimeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = EXIT.UNAVAILABLE;
  }
}

/** Compare dotted numeric versions; null when either is not one. */
function compareVersions(left, right) {
  const parse = (v) =>
    /^\d+(\.\d+)*$/.test(String(v || '')) ? v.split('.').map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) {
      return Math.sign(diff);
    }
  }
  return 0;
}

function readCargoVersion(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'rust', 'Cargo.toml'), 'utf8');
    const pkg = text.split(/^\[/m).find((s) => s.startsWith('package]'));
    return (pkg && pkg.match(/^version\s*=\s*"([^"]+)"/m)?.[1]) || null;
  } catch {
    return null;
  }
}

function readJsonVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Source identity of a Formal AI checkout.
 * @param {string} root - Checkout directory
 * @param {string} node - Node executable used to run its server
 * @returns {object} Identity
 */
function checkoutIdentity(root, node) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  const status = commit === null ? null : git(root, ['status', '--porcelain']);
  const nodeVersion = spawnSync(node, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    source: 'checkout',
    root,
    entry: SERVER_ENTRY,
    version: readCargoVersion(root),
    engineVersion: readJsonVersion(
      path.join(root, 'packages', 'formal-ai-engine', 'package.json')
    ),
    commit,
    dirty: status === null ? null : status.length > 0,
    node,
    nodeVersion: nodeVersion.status === 0 ? nodeVersion.stdout.trim() : null,
  };
}

/** One-line rendering of an identity for terminals and logs. */
function describeIdentity(identity) {
  if (identity.source === 'url') {
    return `formal-ai at ${identity.url} (version unverified)`;
  }
  const commit = identity.commit
    ? `${identity.commit.slice(0, 12)}${identity.dirty ? '+dirty' : ''}`
    : 'no git commit';
  return `formal-ai ${identity.version || 'unknown'} (${commit}, js server ${identity.entry}, node ${identity.nodeVersion || 'unknown'})`;
}

/**
 * Check a resolved identity against the qualified version and an optional
 * START_FORMAL_AI_EXPECTED_REVISION pin.
 * @throws {RuntimeUnavailableError} Synchronously, or by rejecting
 */
function qualifyIdentity(identity, env) {
  const expected = (env.START_FORMAL_AI_EXPECTED_REVISION || '').trim();
  if (identity.source === 'url') {
    if (env.START_FORMAL_AI_ALLOW_UNVERIFIED !== '1') {
      throw new RuntimeUnavailableError(
        `START_FORMAL_AI_URL=${identity.url} does not report its Formal AI version, so it cannot be qualified. ` +
          'Set START_FORMAL_AI_ALLOW_UNVERIFIED=1 to use it anyway, or use START_FORMAL_AI_ROOT.'
      );
    }
    return;
  }
  if (!identity.nodeVersion) {
    throw new RuntimeUnavailableError(
      `Cannot run "${identity.node} --version"; set START_FORMAL_AI_NODE to a Node.js executable.`
    );
  }
  const order = compareVersions(identity.version, MIN_FORMAL_AI_VERSION);
  if (order === null || order < 0) {
    throw new RuntimeUnavailableError(
      `Formal AI at ${identity.root} is version ${identity.version || 'unknown'}; ` +
        `--use-formal-ai needs ${MIN_FORMAL_AI_VERSION} or newer. Update the checkout (git pull).`
    );
  }
  if (
    expected &&
    !(identity.commit && identity.commit.startsWith(expected.toLowerCase()))
  ) {
    throw new RuntimeUnavailableError(
      `Formal AI at ${identity.root} is at commit ${identity.commit || 'unknown'}, not START_FORMAL_AI_EXPECTED_REVISION=${expected}.`
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(baseUrl, child, deadline) {
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RuntimeUnavailableError(
        `Formal AI server exited during startup (${child.exitCode ?? child.signalCode})`
      );
    }
    try {
      const response = await fetch(`${baseUrl}${API_PREFIX}/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RuntimeUnavailableError(
    `Formal AI server did not become ready in time (${lastError})`
  );
}

/**
 * Resolve, qualify and (for a checkout) start the runtime.
 * @param {object} options - {env, bounds}
 * @returns {Promise<{baseUrl: string, identity: object, stop: Function}>}
 * @throws {RuntimeUnavailableError} Synchronously, or by rejecting
 */
function startRuntime({ env = process.env, bounds }) {
  const url = (env.START_FORMAL_AI_URL || '').trim();
  const root = (env.START_FORMAL_AI_ROOT || '').trim();
  if (url && root) {
    throw new RuntimeUnavailableError(
      'Set only one of START_FORMAL_AI_URL and START_FORMAL_AI_ROOT.'
    );
  }
  if (url) {
    if (!/^https?:\/\//.test(url)) {
      throw new RuntimeUnavailableError(
        `START_FORMAL_AI_URL must be an http(s) URL, got "${url}"`
      );
    }
    const identity = { source: 'url', url: url.replace(/\/+$/, '') };
    qualifyIdentity(identity, env);
    return Promise.resolve({ baseUrl: identity.url, identity, stop: () => {} });
  }
  if (!root) {
    throw new RuntimeUnavailableError(
      `--use-formal-ai needs a Formal AI runtime and has no fallback. ${INSTALL_HINT}`
    );
  }
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(path.join(absoluteRoot, SERVER_ENTRY))) {
    throw new RuntimeUnavailableError(
      `START_FORMAL_AI_ROOT=${root} has no ${SERVER_ENTRY}. ${INSTALL_HINT}`
    );
  }
  const node = (env.START_FORMAL_AI_NODE || 'node').trim();
  const identity = checkoutIdentity(absoluteRoot, node);
  qualifyIdentity(identity, env);
  return spawnServer(absoluteRoot, node, identity, env, bounds);
}

async function spawnServer(root, node, identity, env, bounds) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'start-formal-ai-'));
  const memory = (env.START_FORMAL_AI_MEMORY_PATH || '').trim();
  const childEnv = {
    PATH: env.PATH || '',
    HOME: home,
    FORMAL_AI_MEMORY_PATH: memory || path.join(home, 'memory.lino'),
    ...(env.LANG ? { LANG: env.LANG } : {}),
    ...(env.SYSTEMROOT ? { SYSTEMROOT: env.SYSTEMROOT } : {}),
  };
  identity.memory = memory ? 'START_FORMAL_AI_MEMORY_PATH' : 'private';
  const child = spawn(
    node,
    [
      `--max-old-space-size=${bounds.maxMemoryMb}`,
      path.join(root, SERVER_ENTRY),
      '--agent-mode',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--silent',
    ],
    { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.on('error', (error) => {
    stderr += error.message;
  });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitReady(baseUrl, child, Date.now() + bounds.startupTimeoutMs);
  } catch (error) {
    stop();
    error.message += stderr.trim() ? `: ${stderr.trim().slice(-500)}` : '';
    throw error;
  }
  identity.port = port;
  return { baseUrl, identity, stop };
}

module.exports = {
  API_PREFIX,
  INSTALL_HINT,
  MIN_FORMAL_AI_VERSION,
  RuntimeUnavailableError,
  compareVersions,
  describeIdentity,
  qualifyIdentity,
  startRuntime,
};
