#!/usr/bin/env node
/**
 * Dependency freshness gate (issue #253).
 *
 * Every dependency this repository declares must be the latest release, so an
 * obsolete version - and the features it lacks - cannot stay in use unnoticed.
 * "Dependency" covers everything that is pinned somewhere in the tree:
 *
 * - npm `dependencies`, `devDependencies`, `optionalDependencies` and
 *   `overrides` in js/package.json, and the versions both lockfiles resolve;
 * - crates in every dependency table of rust/Cargo.toml, and Cargo.lock;
 * - GitHub Actions (`uses:` tags and commit pins with a `# vX.Y.Z` comment);
 * - CI tools with explicit versions (`npx -p`, `pip ==`, `tool:`,
 *   `cargo install --version`, the actionlint release in a script);
 * - runtimes and runner images (`node-version`, `bun-version`,
 *   `dotnet-version`, `runs-on`);
 * - the meta-language translator revision in parity/translation.json.
 *
 * A declaration is fresh when its lower bound equals the latest stable
 * release, so a caret range cannot hide a stale floor and a new major release
 * is reported too. A dependency that cannot move yet needs a blocker: an open
 * GitHub issue explaining why. Put the issue URL in a comment on the same line
 * (Cargo.toml, workflows, scripts) or in .github/dependency-blockers.json,
 * keyed `ecosystem:name`, for JSON manifests. A closed issue fails the check.
 *
 * `--lockfiles` additionally checks that the JavaScript lockfiles already
 * contain the newest versions the declared ranges allow, transitive
 * dependencies included. Cargo.lock gets the same check from
 * `cargo update --dry-run` in the Rust lint job (rust.yml), because cargo
 * belongs to the Rust stage only (scripts/check-javascript-first.mjs).
 *
 * Usage: node scripts/check-dependency-freshness.mjs [--report] [--lockfiles]
 *
 * By default stale or unverifiable dependencies fail the run. `--report`
 * prints them as warnings and exits 0; CI uses it outside pull requests so a
 * release published after a merge cannot block the release of main.
 */

import { execFile, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUE_PATTERN =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/;
const BLOCKERS_FILE = '.github/dependency-blockers.json';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;
const RUNNER_IMAGES_README =
  'https://raw.githubusercontent.com/actions/runner-images/main/README.md';

// === Versions ===

/** Parse a stable `X.Y.Z` (optionally `v`-prefixed) version, else null. */
export function parseStable(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

/** The lower bound of a requirement such as `^1.2.3`, `~1.2`, `=1` or `>=1`. */
export function lowerBound(requirement) {
  return String(requirement)
    .trim()
    .replace(/^(?:[~^=]|>=)\s*/, '')
    .split(/[\s,+]/)[0];
}

function issueOf(text) {
  return text?.match(ISSUE_PATTERN)?.[0];
}

function commentOf(line) {
  const index = line.search(/\s#/);
  return index === -1 ? '' : line.slice(index);
}

function lineOf(lines, predicate) {
  const index = lines.findIndex(predicate);
  return index === -1 ? 1 : index + 1;
}

// === Collectors (no network) ===

export function readBlockers(root = repoRoot) {
  const file = join(root, BLOCKERS_FILE);
  if (!existsSync(file)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(JSON.parse(readFileSync(file, 'utf8'))).map(
      ([key, note]) => [key, issueOf(String(note))]
    )
  );
}

/**
 * Versions bun.lock resolves, keyed like package-lock.json paths
 * (`node_modules/a`, `node_modules/a/node_modules/b`). bun.lock is JSON with
 * trailing commas; nested keys use `a/b` for b nested under a.
 */
export function bunLockVersions(text) {
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  const versions = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const spec = String(entry[0]);
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const prefix = key.slice(0, key.length - name.length).replace(/\/$/, '');
    const parents = prefix ? splitBunPath(prefix) : [];
    const path = [...parents, name].map((n) => `node_modules/${n}`).join('/');
    versions[path] = spec.slice(at + 1);
  }
  return versions;
}

function splitBunPath(prefix) {
  const parts = prefix.split('/');
  const names = [];
  for (let index = 0; index < parts.length; index++) {
    names.push(
      parts[index].startsWith('@')
        ? `${parts[index]}/${parts[++index]}`
        : parts[index]
    );
  }
  return names;
}

export function npmLockVersions(text) {
  const lock = JSON.parse(text);
  return Object.fromEntries(
    Object.entries(lock.packages ?? {})
      .filter(([path, entry]) => path && entry.version && !entry.link)
      .map(([path, entry]) => [path, entry.version])
  );
}

/** Direct npm declarations with the versions both lockfiles resolve. */
export function collectNpm(root = repoRoot) {
  const file = 'js/package.json';
  const text = readFileSync(join(root, file), 'utf8');
  const lines = text.split('\n');
  const manifest = JSON.parse(text);
  const blockers = readBlockers(root);
  const lockfiles = [
    ['js/package-lock.json', npmLockVersions],
    ['js/bun.lock', bunLockVersions],
  ]
    .filter(([lockFile]) => existsSync(join(root, lockFile)))
    .map(([lockFile, parse]) => [
      lockFile,
      parse(readFileSync(join(root, lockFile), 'utf8')),
    ]);
  const deps = [];
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'overrides',
  ]) {
    for (const [name, declared] of Object.entries(manifest[section] ?? {})) {
      if (typeof declared !== 'string') {
        throw new Error(`${file}: ${section}.${name} must be a version string`);
      }
      deps.push({
        kind: 'npm',
        name,
        declared,
        file,
        line: lineOf(lines, (row) => row.includes(`"${name}":`)),
        blocker: blockers[`npm:${name}`],
        locked: lockfiles.map(([lockFile, versions]) => ({
          file: lockFile,
          version: versions[`node_modules/${name}`],
        })),
      });
    }
  }
  return deps;
}

/**
 * Dependency declarations of a Cargo manifest. Supports `name = "1"`,
 * `name = { version = "1", ... }` and `[dependencies.name]` tables in
 * `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`,
 * `[workspace.dependencies]` and their `[target.'cfg'.*]` forms.
 */
export function cargoDependencies(text, file) {
  const lines = text.split('\n');
  const deps = [];
  const sectionPattern =
    /^\[(?:target\.(?:'[^']*'|"[^"]*"|[^\].]+)\.|workspace\.)?(?:dev-|build-)?dependencies(?:\.([\w-]+))?\]$/;
  let inSection = false;
  let table = null;
  for (const [index, raw] of lines.entries()) {
    const row = raw.trim();
    if (row.startsWith('[')) {
      const match = sectionPattern.exec(row.replace(/\s+#.*$/, ''));
      inSection = Boolean(match) && !match[1];
      table = match?.[1]
        ? {
            alias: match[1],
            line: index + 1,
            blocker: issueOf(commentOf(raw)),
          }
        : null;
      if (table) {
        deps.push(table);
      }
      continue;
    }
    const assignment = /^([\w-]+|"[^"]+")\s*=\s*(.+)$/.exec(row);
    if (!assignment) {
      continue;
    }
    const key = assignment[1].replace(/^"|"$/g, '');
    const value = assignment[2].replace(/\s+#.*$/, '');
    if (table) {
      if (key === 'version' || key === 'package' || key === 'path') {
        table[key] = JSON.parse(value);
      }
      continue;
    }
    if (!inSection) {
      continue;
    }
    const inline = value.startsWith('{')
      ? Object.fromEntries(
          [...value.matchAll(/([\w-]+)\s*=\s*("[^"]*")/g)].map((m) => [
            m[1],
            JSON.parse(m[2]),
          ])
        )
      : { version: JSON.parse(value) };
    deps.push({
      alias: key,
      line: index + 1,
      blocker: issueOf(commentOf(raw)),
      ...inline,
    });
  }
  return deps
    .filter((dep) => !dep.path || dep.version)
    .map((dep) => ({
      kind: 'crate',
      name: dep.package ?? dep.alias,
      declared: dep.version,
      file,
      line: dep.line,
      blocker: dep.blocker,
    }));
}

/** Every version of each package in a Cargo.lock. */
export function cargoLockVersions(text) {
  const versions = {};
  for (const block of text.split(/\n\[\[package\]\]\n/).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) {
      (versions[name] ??= []).push(version);
    }
  }
  return versions;
}

export function collectCargo(root = repoRoot) {
  const file = 'rust/Cargo.toml';
  const lockFile = 'rust/Cargo.lock';
  const deps = cargoDependencies(readFileSync(join(root, file), 'utf8'), file);
  const locked = existsSync(join(root, lockFile))
    ? cargoLockVersions(readFileSync(join(root, lockFile), 'utf8'))
    : {};
  for (const dep of deps) {
    if (dep.declared === undefined) {
      throw new Error(`${file}:${dep.line}: ${dep.name} has no version`);
    }
    // The lockfile may hold several versions of a crate that is also a
    // transitive dependency; the newest one is the direct dependency.
    const newest = (locked[dep.name] ?? [])
      .map((version) => [version, parseStable(version)])
      .filter(([, parsed]) => parsed)
      .sort((a, b) => compareVersions(b[1], a[1]))[0]?.[0];
    dep.locked = [{ file: lockFile, version: newest }];
  }
  return deps;
}

/** One line of a workflow or script, turned into zero or more dependencies. */
export function lineDependencies(row, file, line, env = {}) {
  const blocker = issueOf(commentOf(row));
  const code = row.replace(/^\s*-?\s*/, '');
  const at = (dep) => ({ file, line, blocker, ...dep });
  const deps = [];
  const uses = /^uses:\s*([^\s@#]+)@([^\s#]+)\s*(#.*)?$/.exec(code);
  if (uses && !uses[1].startsWith('.') && !uses[1].startsWith('docker:')) {
    const [owner, repo] = uses[1].split('/');
    const note = (uses[3] ?? '').replace(/^#\s*/, '');
    deps.push(
      at({
        kind: 'action',
        name: `${owner}/${repo}`,
        declared: uses[2],
        // `# v1.2.3` or `# master @ 2026-10-09` documents a commit pin.
        pinnedTag: /^(v\d+\.\d+\.\d+)\b/.exec(note)?.[1],
        pinnedBranch: /^([\w./-]+) @ \d{4}-\d{2}-\d{2}/.exec(note)?.[1],
      })
    );
  }
  for (const npx of code.matchAll(/(?:^|\s)-p\s+(@?[\w./-]+)@(\d[\w.-]*)/g)) {
    deps.push(at({ kind: 'npm', name: npx[1], declared: npx[2] }));
  }
  for (const pip of code.matchAll(/\bpip install\b.*?\s([\w.-]+)==([\w.]+)/g)) {
    deps.push(at({ kind: 'pypi', name: pip[1], declared: pip[2] }));
  }
  const tool = /^tool:\s*([\w-]+)@([\w.]+)/.exec(code);
  if (tool) {
    deps.push(at({ kind: 'crate', name: tool[1], declared: tool[2] }));
  }
  const cargo = /cargo install\s+([\w-]+)\s+--version\s+"?([^"\s]+)"?/.exec(
    code
  );
  if (cargo) {
    const variable = /^\$\{?(\w+)\}?$/.exec(cargo[2])?.[1];
    const resolved = variable ? env[variable] : null;
    deps.push({
      ...at({ kind: 'crate', name: cargo[1], declared: cargo[2] }),
      ...(resolved ?? {}),
    });
  }
  const release =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/(v?\d+\.\d+\.\d+)/.exec(
      code
    );
  if (release) {
    deps.push(at({ kind: 'release', name: release[1], declared: release[2] }));
  }
  const runtime = /^(node|bun|dotnet)-version:\s*['"]?([\w.]+)['"]?/.exec(code);
  if (runtime) {
    deps.push(at({ kind: runtime[1], name: runtime[1], declared: runtime[2] }));
  }
  for (const label of code.matchAll(
    /\b(ubuntu-\d+\.\d+|macos-\d+|windows-\d{4})\b/g
  )) {
    if (/^(runs-on|os):/.test(code)) {
      deps.push(at({ kind: 'runner', name: label[1], declared: label[1] }));
    }
  }
  return deps;
}

function textDependencies(file, text) {
  const lines = text.split('\n');
  // `cargo install X --version "${VAR}"` takes its version from an env entry.
  const env = {};
  for (const [index, row] of lines.entries()) {
    const entry = /^\s*([A-Z][A-Z0-9_]*_VERSION):\s*['"]?([\w.]+)['"]?/.exec(
      row
    );
    if (entry) {
      env[entry[1]] = {
        declared: entry[2],
        line: index + 1,
        blocker: issueOf(commentOf(row)),
      };
    }
  }
  return lines.flatMap((row, index) =>
    lineDependencies(row, file, index + 1, env)
  );
}

export function collectWorkflows(root = repoRoot) {
  const files = readdirSync(join(root, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  const scripts = readdirSync(join(root, 'scripts'))
    .filter((name) => name.endsWith('.sh'))
    .sort()
    .map((name) => `scripts/${name}`);
  return [...files, ...scripts].flatMap((file) =>
    textDependencies(file, readFileSync(join(root, file), 'utf8'))
  );
}

export function collectTranslator(root = repoRoot) {
  const file = 'parity/translation.json';
  if (!existsSync(join(root, file))) {
    return [];
  }
  const text = readFileSync(join(root, file), 'utf8');
  const { repository, revision } = JSON.parse(text);
  return [
    {
      kind: 'git',
      name: repository,
      declared: revision,
      file,
      line: lineOf(text.split('\n'), (row) => row.includes('"revision"')),
      blocker: readBlockers(root)[`git:${repository}`],
    },
  ];
}

export function collectAll(root = repoRoot) {
  return [
    ...collectNpm(root),
    ...collectCargo(root),
    ...collectWorkflows(root),
    ...collectTranslator(root),
  ];
}

// === Registries ===

async function retrying(task) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (error.permanent || attempt === FETCH_ATTEMPTS) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

function fetchText(url) {
  return retrying(async () => {
    const headers = { 'User-Agent': 'link-foundation-start-freshness' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token && url.startsWith('https://api.github.com/')) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new Error(`${url}: HTTP ${response.status}`);
      error.permanent = response.status < 500 && response.status !== 429;
      throw error;
    }
    return response.text();
  });
}

/** `git ls-remote` as `{ ref: sha }`; annotated tags resolve to commits. */
function gitRefs(url, patterns) {
  return retrying(async () => {
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(
        'git',
        ['ls-remote', url, ...patterns],
        {
          encoding: 'utf8',
          timeout: FETCH_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }
      ));
    } catch (error) {
      throw new Error(
        `git ls-remote ${url}: ${error.stderr || error.message}`,
        {
          cause: error,
        }
      );
    }
    const refs = {};
    for (const row of stdout.trim().split('\n').filter(Boolean)) {
      const [sha, ref] = row.split('\t');
      const peeled = ref.endsWith('^{}');
      const name = peeled ? ref.slice(0, -3) : ref;
      if (peeled || !refs[name]) {
        refs[name] = sha;
      }
    }
    return refs;
  });
}

/** The newest stable `vX.Y.Z` tag of a repository and its commit. */
export function newestTag(refs) {
  return Object.entries(refs)
    .filter(([ref]) => ref.startsWith('refs/tags/'))
    .map(([ref, sha]) => ({ tag: ref.slice(10), sha }))
    .map((entry) => ({ ...entry, parsed: parseStable(entry.tag) }))
    .filter((entry) => entry.parsed && entry.tag.startsWith('v'))
    .sort((a, b) => compareVersions(b.parsed, a.parsed))[0];
}

/**
 * Newest generally available runner label per family, from the runner-images
 * README table. Rows marked beta, preview or deprecated are skipped.
 */
export function newestRunners(readme) {
  const families = {
    ubuntu: /^ubuntu-(\d+)\.(\d+)$/,
    macos: /^macos-(\d+)$/,
    windows: /^windows-(\d{4})$/,
  };
  const newest = {};
  for (const row of readme.split('\n').filter((r) => r.startsWith('|'))) {
    const [image] = row.split('|').slice(1);
    if (/badge\/(beta|preview|deprecated)/i.test(image ?? '')) {
      continue;
    }
    for (const [, label] of row.matchAll(/`([\w.-]+)`/g)) {
      for (const [family, pattern] of Object.entries(families)) {
        const match = pattern.exec(label);
        if (!match) {
          continue;
        }
        const rank = Number(match[1]) * 100 + Number(match[2] ?? 0);
        if (!newest[family] || rank > newest[family].rank) {
          newest[family] = { label, rank };
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(newest).map(([family, { label }]) => [family, label])
  );
}

export function createRegistry({
  getText = fetchText,
  getRefs = gitRefs,
} = {}) {
  const cache = new Map();
  const once = (key, task) => {
    if (!cache.has(key)) {
      cache.set(key, task());
    }
    return cache.get(key);
  };
  const json = (url) => once(url, async () => JSON.parse(await getText(url)));
  const refs = (repo, patterns = []) =>
    once(`refs:${repo}:${patterns}`, () =>
      getRefs(`https://github.com/${repo}.git`, patterns)
    );
  return {
    async npm(name) {
      const data = await json(
        `https://registry.npmjs.org/${name.replaceAll('/', '%2F')}/latest`
      );
      return data.version;
    },
    async crate(name) {
      const data = await json(`https://crates.io/api/v1/crates/${name}`);
      return data.crate?.max_stable_version;
    },
    async pypi(name) {
      const data = await json(`https://pypi.org/pypi/${name}/json`);
      return data.info?.version;
    },
    async tag(repo) {
      return newestTag(await refs(repo, ['refs/tags/*']));
    },
    async branch(repo, branch) {
      const found = await refs(repo, [`refs/heads/${branch}`]);
      return found[`refs/heads/${branch}`];
    },
    async head(url) {
      const found = await once(`head:${url}`, () => getRefs(url, ['HEAD']));
      return found.HEAD;
    },
    async nodeLts() {
      const index = await json('https://nodejs.org/dist/index.json');
      return /^v(\d+)\./.exec(index.find((release) => release.lts).version)[1];
    },
    async dotnetLts() {
      const data = await json(
        'https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json'
      );
      return data['releases-index'].find(
        (r) => r['release-type'] === 'lts' && r['support-phase'] === 'active'
      )['channel-version'];
    },
    runners() {
      return once('runners', async () =>
        newestRunners(await getText(RUNNER_IMAGES_README))
      );
    },
    issue(url) {
      const [, owner, repo, number] = url.match(ISSUE_PATTERN);
      return json(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`
      );
    },
  };
}

// === Checks ===

/**
 * Compare one dependency with its latest release. Returns null when fresh,
 * otherwise `{ latest, problems }` describing what is stale.
 */
export async function evaluate(dep, registry) {
  const exact = (latest) => {
    const problems = [];
    if (lowerBound(dep.declared) !== latest) {
      problems.push(`declared ${dep.declared}`);
    }
    for (const { file, version } of dep.locked ?? []) {
      if (version !== latest) {
        problems.push(`${file} resolves ${version ?? 'nothing'}`);
      }
    }
    return { latest, problems };
  };
  switch (dep.kind) {
    case 'npm':
      return exact(await registry.npm(dep.name));
    case 'crate':
      return exact(await registry.crate(dep.name));
    case 'pypi':
      return exact(await registry.pypi(dep.name));
    case 'release': {
      const newest = await registry.tag(dep.name);
      const fresh = dep.declared.replace(/^v/, '') === newest.tag.slice(1);
      return {
        latest: newest.tag,
        problems: fresh ? [] : [`declared ${dep.declared}`],
      };
    }
    case 'action':
      return evaluateAction(dep, registry);
    case 'git': {
      const latest = await registry.head(dep.name);
      return {
        latest,
        problems: dep.declared === latest ? [] : [`revision ${dep.declared}`],
      };
    }
    case 'node':
      return major(dep, await registry.nodeLts(), /^(\d+)/);
    case 'bun':
      return major(dep, (await registry.npm('bun')).split('.')[0], /^(\d+)/);
    case 'dotnet':
      return major(dep, await registry.dotnetLts(), /^(\d+\.\d+)/);
    case 'runner': {
      const family = dep.name.split('-')[0];
      const latest = (await registry.runners())[family];
      return {
        latest,
        problems: latest === dep.name ? [] : [`uses ${dep.name}`],
      };
    }
    default:
      throw new Error(`unknown dependency kind ${dep.kind}`);
  }
}

function major(dep, latest, pattern) {
  const declared = pattern.exec(dep.declared)?.[1];
  return {
    latest,
    problems: declared === latest ? [] : [`declared ${dep.declared}`],
  };
}

async function evaluateAction(dep, registry) {
  const { declared } = dep;
  if (SHA_PATTERN.test(declared) && dep.pinnedBranch) {
    const head = await registry.branch(dep.name, dep.pinnedBranch);
    return {
      latest: `${dep.pinnedBranch} ${head}`,
      problems: head === declared ? [] : [`pinned ${declared}`],
    };
  }
  const newest = await registry.tag(dep.name);
  if (!newest) {
    throw new Error('no stable vX.Y.Z release tag');
  }
  if (SHA_PATTERN.test(declared)) {
    if (!dep.pinnedTag) {
      return {
        latest: newest.tag,
        problems: ['commit pin needs a `# vX.Y.Z` comment naming its release'],
      };
    }
    const problems = [];
    if (dep.pinnedTag !== newest.tag) {
      problems.push(`pinned ${dep.pinnedTag}`);
    } else if (declared !== newest.sha) {
      problems.push(`pinned ${declared}, not the ${newest.tag} commit`);
    }
    return { latest: `${newest.tag} (${newest.sha})`, problems };
  }
  const parsed = /^v(\d+)(?:\.(\d+)\.(\d+))?$/.exec(declared);
  if (!parsed) {
    return {
      latest: newest.tag,
      problems: [`unsupported ref ${declared}`],
    };
  }
  const fresh = parsed[2]
    ? declared === newest.tag
    : Number(parsed[1]) === newest.parsed[0];
  return {
    latest: newest.tag,
    problems: fresh ? [] : [`uses ${declared}`],
  };
}

/**
 * Check every dependency. Stale ones without an open blocker issue and ones
 * that cannot be verified (network, parse) become failures.
 */
export async function checkDependencies(deps, registry = createRegistry()) {
  // Results land in declaration order, whatever order the lookups finish in.
  const outcomes = new Array(deps.length);
  const checkOne = async (dep) => {
    const where = `${dep.file}:${dep.line} ${dep.kind} ${dep.name}`;
    try {
      const result = await evaluate(dep, registry);
      if (!result.problems.length) {
        return null;
      }
      const message = `${where}: ${result.problems.join('; ')}; latest is ${result.latest}`;
      if (!dep.blocker) {
        return { failure: message };
      }
      const issue = await registry.issue(dep.blocker);
      if (issue.state === 'open' && !issue.pull_request) {
        return { exemption: `${message}, blocked by ${dep.blocker}` };
      }
      return {
        failure: `${message}; blocker ${dep.blocker} is not an open issue`,
      };
    } catch (error) {
      return { failure: `${where}: cannot verify: ${error.message}` };
    }
  };
  for (let index = 0; index < deps.length; index += CONCURRENCY) {
    const batch = deps.slice(index, index + CONCURRENCY);
    const results = await Promise.all(batch.map(checkOne));
    outcomes.splice(index, results.length, ...results);
  }
  const present = outcomes.filter(Boolean);
  return {
    checked: deps.length,
    failures: present.map((o) => o.failure).filter(Boolean),
    exemptions: present.map((o) => o.exemption).filter(Boolean),
  };
}

// === Lockfile refresh (transitive dependencies) ===

/** Version differences between two `{ path: version }` maps. */
export function versionChanges(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((path) => before[path] !== after[path])
    .sort()
    .map(
      (path) =>
        `${path}: ${before[path] ?? 'absent'} -> ${after[path] ?? 'absent'}`
    );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.error}`
    );
  }
}

/**
 * Refresh copies of the JavaScript lockfiles within the declared ranges and
 * report every resolved version that moves. Comparing resolved versions, not
 * bytes, keeps formatting differences between npm or bun releases out.
 */
export function checkJsLockfiles(root = repoRoot) {
  const work = mkdtempSync(join(tmpdir(), 'start-freshness-'));
  try {
    for (const name of ['package.json', 'package-lock.json', 'bun.lock']) {
      copyFileSync(join(root, 'js', name), join(work, name));
    }
    run(
      'npm',
      [
        'update',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      work
    );
    run('bun', ['update', '--lockfile-only', '--ignore-scripts'], work);
    const read = (name) => readFileSync(join(work, name), 'utf8');
    const original = (name) => readFileSync(join(root, 'js', name), 'utf8');
    return [
      ...versionChanges(
        npmLockVersions(original('package-lock.json')),
        npmLockVersions(read('package-lock.json'))
      ).map((change) => `js/package-lock.json ${change}`),
      ...versionChanges(
        bunLockVersions(original('bun.lock')),
        bunLockVersions(read('bun.lock'))
      ).map((change) => `js/bun.lock ${change}`),
    ];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// === CLI ===

function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const [, file, line] = /^([^:\s]+):(\d+)/.exec(message) ?? [];
    const location = file ? ` file=${file},line=${line}` : '';
    console.log(`::${level}${location}::${message}`);
  } else {
    console[level === 'error' ? 'error' : 'log'](`${level}: ${message}`);
  }
}

async function main(args) {
  const report = args.includes('--report');
  const deps = collectAll();
  const result = await checkDependencies(deps);
  if (args.includes('--lockfiles')) {
    try {
      const changes = checkJsLockfiles();
      result.failures.push(
        ...changes.map(
          (change) =>
            `${change} (run: cd js && npm update --package-lock-only && bun update --lockfile-only)`
        )
      );
    } catch (error) {
      result.failures.push(`js lockfiles: cannot refresh: ${error.message}`);
    }
  }
  for (const exemption of result.exemptions) {
    annotate('notice', exemption);
  }
  for (const failure of result.failures) {
    annotate(report ? 'warning' : 'error', failure);
  }
  console.log(
    `Checked ${result.checked} dependencies: ${result.failures.length} stale or unverifiable, ${result.exemptions.length} blocked by open issues.`
  );
  if (result.failures.length && !report) {
    console.log(
      `Update them to the latest release, or add an open issue URL explaining the blocker (a comment on the line, or ${BLOCKERS_FILE}).`
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
