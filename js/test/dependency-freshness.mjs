/**
 * Issue #253: the dependency freshness gate. The registry is mocked, so these
 * tests need no network.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bunLockVersions,
  cargoDependencies,
  cargoLockVersions,
  checkDependencies,
  collectAll,
  createRegistry,
  evaluate,
  lineDependencies,
  lowerBound,
  newestRunners,
  newestTag,
  npmLockVersions,
  parseStable,
  versionChanges,
} from '../../scripts/check-dependency-freshness.mjs';

const ISSUE = 'https://github.com/owner/repo/issues/7';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A registry whose answers come from plain objects. */
function mockRegistry({
  npm = {},
  crate = {},
  pypi = {},
  tags = {},
  branches = {},
  heads = {},
  nodeLts = '24',
  dotnetLts = '10.0',
  runners = {
    ubuntu: 'ubuntu-26.04',
    macos: 'macos-26',
    windows: 'windows-2025',
  },
  issues = {},
} = {}) {
  const lookup = (table, key) => {
    if (!(key in table)) {
      throw new Error(`unexpected lookup ${key}`);
    }
    return table[key];
  };
  return {
    npm: async (name) => lookup(npm, name),
    crate: async (name) => lookup(crate, name),
    pypi: async (name) => lookup(pypi, name),
    tag: async (repo) => newestTag(lookup(tags, repo)),
    branch: async (repo, branch) => lookup(branches, `${repo}#${branch}`),
    head: async (url) => lookup(heads, url),
    nodeLts: async () => nodeLts,
    dotnetLts: async () => dotnetLts,
    runners: async () => runners,
    issue: async (url) => lookup(issues, url),
  };
}

describe('versions', () => {
  it('parses stable versions only', () => {
    expect(parseStable('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseStable('1.2.3-beta.1')).toBeNull();
    expect(parseStable('1.2')).toBeNull();
  });

  it('takes the lower bound of a requirement', () => {
    expect(lowerBound('^1.2.3')).toBe('1.2.3');
    expect(lowerBound('~0.4')).toBe('0.4');
    expect(lowerBound('>= 2.0.0')).toBe('2.0.0');
    expect(lowerBound('1.0.229')).toBe('1.0.229');
    expect(lowerBound('1.2.3+build')).toBe('1.2.3');
  });

  it('picks the newest stable v-tag and its peeled commit', () => {
    const newest = newestTag({
      'refs/tags/v1.9.0': SHA_A,
      'refs/tags/v1.10.0': SHA_B,
      'refs/tags/v2.0.0-rc.1': SHA_A,
      'refs/tags/v1': SHA_A,
      'refs/heads/main': SHA_A,
    });
    expect(newest.tag).toBe('v1.10.0');
    expect(newest.sha).toBe(SHA_B);
  });

  it('lists version moves between two lockfile maps', () => {
    expect(
      versionChanges(
        { 'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0' },
        { 'node_modules/a': '1.1.0', 'node_modules/c': '2.0.0' }
      )
    ).toEqual([
      'node_modules/a: 1.0.0 -> 1.1.0',
      'node_modules/b: 1.0.0 -> absent',
      'node_modules/c: absent -> 2.0.0',
    ]);
  });
});

describe('lockfiles', () => {
  it('maps bun.lock keys to package-lock paths', () => {
    const lock = `{
      "lockfileVersion": 1,
      "packages": {
        "a": ["a@1.0.0", "", {}, "sha512-x"],
        "@s/b": ["@s/b@2.0.0", "", {}, "sha512-y"],
        "a/@s/b": ["@s/b@1.5.0", "", {}, "sha512-z"],
        "@s/b/c": ["c@3.0.0", "", {}, "sha512-w"],
      },
    }`;
    expect(bunLockVersions(lock)).toEqual({
      'node_modules/a': '1.0.0',
      'node_modules/@s/b': '2.0.0',
      'node_modules/a/node_modules/@s/b': '1.5.0',
      'node_modules/@s/b/node_modules/c': '3.0.0',
    });
  });

  it('reads package-lock.json packages and skips the root and links', () => {
    const lock = JSON.stringify({
      packages: {
        '': { version: '0.0.1' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/l': { link: true, resolved: '../l' },
      },
    });
    expect(npmLockVersions(lock)).toEqual({ 'node_modules/a': '1.0.0' });
  });

  it('collects every version of a crate in Cargo.lock', () => {
    const lock =
      'version = 4\n\n[[package]]\nname = "a"\nversion = "1.0.0"\n\n[[package]]\nname = "a"\nversion = "2.0.0"\n';
    expect(cargoLockVersions(lock)).toEqual({ a: ['1.0.0', '2.0.0'] });
  });
});

describe('Cargo.toml', () => {
  it('reads every dependency table form and line blockers', () => {
    const toml = [
      '[package]',
      'version = "9.9.9"',
      '[dependencies]',
      'a = "1.2.3"',
      `b = { version = "0.4", features = ["x"] } # ${ISSUE}`,
      'local = { path = "../local" }',
      'renamed = { package = "real", version = "2.0.0" }',
      "[target.'cfg(unix)'.dependencies]",
      'libc = "0.2.191"',
      '[dev-dependencies]',
      'tempfile = "3"',
      '[dependencies.table]',
      'version = "5.0.0"',
      '[features]',
      'default = []',
    ].join('\n');
    expect(
      cargoDependencies(toml, 'Cargo.toml').map((d) => [
        d.name,
        d.declared,
        d.line,
        d.blocker,
      ])
    ).toEqual([
      ['a', '1.2.3', 4, undefined],
      ['b', '0.4', 5, ISSUE],
      ['real', '2.0.0', 7, undefined],
      ['libc', '0.2.191', 9, undefined],
      ['tempfile', '3', 11, undefined],
      ['table', '5.0.0', 12, undefined],
    ]);
  });
});

describe('workflow lines', () => {
  const kinds = (row, env) =>
    lineDependencies(row, 'w.yml', 3, env).map((d) => [
      d.kind,
      d.name,
      d.declared,
    ]);

  it('recognises actions, tags and commit pins', () => {
    expect(kinds('      - uses: actions/checkout@v7')).toEqual([
      ['action', 'actions/checkout', 'v7'],
    ]);
    const [pin] = lineDependencies(
      `      - uses: o/r@${SHA_A} # v1.2.3`,
      'w.yml',
      3
    );
    expect(pin.pinnedTag).toBe('v1.2.3');
    const [branch] = lineDependencies(
      `      - uses: o/r@${SHA_A} # master @ 2026-10-24`,
      'w.yml',
      3
    );
    expect(branch.pinnedBranch).toBe('master');
    expect(kinds('      - uses: ./.github/actions/local')).toEqual([]);
    expect(kinds('      uses: ./.github/workflows/rust.yml')).toEqual([]);
  });

  it('recognises CI tools and runtimes', () => {
    expect(kinds('run: npx --yes -p a@1.0.0 -p @s/b@2.0.0 a')).toEqual([
      ['npm', 'a', '1.0.0'],
      ['npm', '@s/b', '2.0.0'],
    ]);
    expect(kinds('python -m pip install --user pyflakes==4.0.3')).toEqual([
      ['pypi', 'pyflakes', '4.0.3'],
    ]);
    expect(kinds('          tool: cargo-audit@0.22.2')).toEqual([
      ['crate', 'cargo-audit', '0.22.2'],
    ]);
    expect(
      kinds(
        '    curl -L https://github.com/rhysd/actionlint/releases/download/v1.7.12/x.tgz'
      )
    ).toEqual([['release', 'rhysd/actionlint', 'v1.7.12']]);
    expect(kinds("          node-version: '24.x'")).toEqual([
      ['node', 'node', '24.x'],
    ]);
    expect(kinds("          dotnet-version: '10.0.x'")).toEqual([
      ['dotnet', 'dotnet', '10.0.x'],
    ]);
    expect(kinds('    runs-on: ubuntu-26.04')).toEqual([
      ['runner', 'ubuntu-26.04', 'ubuntu-26.04'],
    ]);
    expect(kinds('        os: [ubuntu-26.04, macos-26, windows-2025]')).toEqual(
      [
        ['runner', 'ubuntu-26.04', 'ubuntu-26.04'],
        ['runner', 'macos-26', 'macos-26'],
        ['runner', 'windows-2025', 'windows-2025'],
      ]
    );
    expect(kinds('  # mentions ubuntu-22.04 in prose')).toEqual([]);
  });

  it('resolves cargo install --version from an env entry', () => {
    const [dep] = lineDependencies(
      'run: cargo install cargo-tarpaulin --version "${TARPAULIN_VERSION}" --locked',
      'w.yml',
      9,
      { TARPAULIN_VERSION: { declared: '0.37.5', line: 4, blocker: ISSUE } }
    );
    expect(dep).toMatchObject({
      kind: 'crate',
      name: 'cargo-tarpaulin',
      declared: '0.37.5',
      line: 4,
      blocker: ISSUE,
    });
  });
});

describe('runner images', () => {
  it('picks the newest generally available label of each family', () => {
    const readme = [
      '| Image | YAML Label | Included Software |',
      '| --- | --- | --- |',
      '| Ubuntu 26.04 ![beta](https://img.shields.io/badge/beta-yellow) | `ubuntu-26.04-arm` | x |',
      '| Ubuntu 26.04 | `ubuntu-latest` or `ubuntu-26.04` | x |',
      '| Ubuntu 24.04 | `ubuntu-24.04` | x |',
      '| macOS 27 ![preview](https://img.shields.io/badge/preview-blue) | `macos-27` | x |',
      '| macOS 26 | `macos-latest` or `macos-26` | x |',
      '| Windows Server 2025 | `windows-latest` or `windows-2025` | x |',
      '| Windows Server 2022 ![deprecated](https://img.shields.io/badge/deprecated-red) | `windows-2022` | x |',
    ].join('\n');
    expect(newestRunners(readme)).toEqual({
      ubuntu: 'ubuntu-26.04',
      macos: 'macos-26',
      windows: 'windows-2025',
    });
  });
});

describe('evaluate', () => {
  const registry = mockRegistry({
    npm: { a: '2.0.0', bun: '1.4.3' },
    crate: { c: '1.0.229' },
    pypi: { p: '4.0.3' },
    tags: {
      'o/r': { 'refs/tags/v7.0.1': SHA_A, 'refs/tags/v6.0.0': SHA_B },
    },
    branches: { 'o/t#master': SHA_A },
    heads: { 'https://github.com/o/m': SHA_A },
  });
  const problems = async (dep) => (await evaluate(dep, registry)).problems;

  it('requires the declared floor and every locked version to be latest', async () => {
    expect(
      await problems({
        kind: 'npm',
        name: 'a',
        declared: '^2.0.0',
        locked: [{ file: 'l', version: '2.0.0' }],
      })
    ).toEqual([]);
    expect(
      await problems({
        kind: 'npm',
        name: 'a',
        declared: '^1.0.0',
        locked: [{ file: 'l', version: '1.9.0' }, { file: 'm' }],
      })
    ).toEqual(['declared ^1.0.0', 'l resolves 1.9.0', 'm resolves nothing']);
    expect(await problems({ kind: 'crate', name: 'c', declared: '1' })).toEqual(
      ['declared 1']
    );
    expect(
      await problems({ kind: 'pypi', name: 'p', declared: '4.0.3' })
    ).toEqual([]);
  });

  it('checks action majors, exact tags and commit pins', async () => {
    const action = (declared, extra = {}) =>
      problems({ kind: 'action', name: 'o/r', declared, ...extra });
    expect(await action('v7')).toEqual([]);
    expect(await action('v6')).toEqual(['uses v6']);
    expect(await action('v7.0.1')).toEqual([]);
    expect(await action('v7.0.0')).toEqual(['uses v7.0.0']);
    expect(await action(SHA_A, { pinnedTag: 'v7.0.1' })).toEqual([]);
    expect(await action(SHA_B, { pinnedTag: 'v7.0.1' })).toEqual([
      `pinned ${SHA_B}, not the v7.0.1 commit`,
    ]);
    expect(await action(SHA_B, { pinnedTag: 'v6.0.0' })).toEqual([
      'pinned v6.0.0',
    ]);
    expect(await action(SHA_A)).toEqual([
      'commit pin needs a `# vX.Y.Z` comment naming its release',
    ]);
    expect(
      await problems({
        kind: 'action',
        name: 'o/t',
        declared: SHA_B,
        pinnedBranch: 'master',
      })
    ).toEqual([`pinned ${SHA_B}`]);
  });

  it('checks runtimes, runners, releases and git revisions', async () => {
    expect(
      await problems({ kind: 'node', name: 'node', declared: '24.x' })
    ).toEqual([]);
    expect(
      await problems({ kind: 'node', name: 'node', declared: '22' })
    ).toEqual(['declared 22']);
    expect(
      await problems({ kind: 'bun', name: 'bun', declared: 'latest' })
    ).toEqual(['declared latest']);
    expect(
      await problems({ kind: 'dotnet', name: 'dotnet', declared: '8.0.x' })
    ).toEqual(['declared 8.0.x']);
    expect(
      await problems({ kind: 'dotnet', name: 'dotnet', declared: '10.0.x' })
    ).toEqual([]);
    expect(
      await problems({
        kind: 'runner',
        name: 'ubuntu-24.04',
        declared: 'ubuntu-24.04',
      })
    ).toEqual(['uses ubuntu-24.04']);
    expect(
      await problems({ kind: 'release', name: 'o/r', declared: 'v7.0.1' })
    ).toEqual([]);
    expect(
      await problems({
        kind: 'git',
        name: 'https://github.com/o/m',
        declared: SHA_B,
      })
    ).toEqual([`revision ${SHA_B}`]);
  });
});

describe('checkDependencies', () => {
  const stale = (blocker) => ({
    kind: 'npm',
    name: 'a',
    declared: '^1.0.0',
    file: 'js/package.json',
    line: 5,
    blocker,
  });

  it('fails a stale dependency with its location and the latest version', async () => {
    const report = await checkDependencies(
      [stale()],
      mockRegistry({ npm: { a: '2.0.0' } })
    );
    expect(report.failures).toEqual([
      'js/package.json:5 npm a: declared ^1.0.0; latest is 2.0.0',
    ]);
  });

  it('exempts a stale dependency only while its blocker issue is open', async () => {
    const open = await checkDependencies(
      [stale(ISSUE)],
      mockRegistry({
        npm: { a: '2.0.0' },
        issues: { [ISSUE]: { state: 'open' } },
      })
    );
    expect(open.failures).toEqual([]);
    expect(open.exemptions[0]).toContain(`blocked by ${ISSUE}`);
    for (const issue of [
      { state: 'closed' },
      { state: 'open', pull_request: {} },
    ]) {
      const report = await checkDependencies(
        [stale(ISSUE)],
        mockRegistry({ npm: { a: '2.0.0' }, issues: { [ISSUE]: issue } })
      );
      expect(report.failures[0]).toContain('is not an open issue');
    }
  });

  it('reports in declaration order, not lookup completion order', async () => {
    const deps = ['slow', 'fast'].map((name, index) => ({
      ...stale(),
      name,
      line: index + 1,
    }));
    const delays = { slow: 30, fast: 0 };
    const registry = {
      npm: (name) =>
        new Promise((resolve) => setTimeout(resolve, delays[name], '2.0.0')),
    };
    const report = await checkDependencies(deps, registry);
    expect(report.failures.map((failure) => failure.split(' ')[0])).toEqual([
      'js/package.json:1',
      'js/package.json:2',
    ]);
  });

  it('fails a dependency it cannot verify', async () => {
    const report = await checkDependencies([stale()], mockRegistry());
    expect(report.failures[0]).toContain('cannot verify: unexpected lookup a');
  });

  it('caches registry lookups', async () => {
    const urls = [];
    const registry = createRegistry({
      getText: async (url) => {
        urls.push(url);
        return JSON.stringify({ version: '2.0.0' });
      },
      getRefs: async () => ({}),
    });
    await checkDependencies(
      [
        { ...stale(), declared: '^2.0.0' },
        { ...stale(), declared: '^2.0.0' },
      ],
      registry
    );
    expect(urls).toEqual(['https://registry.npmjs.org/a/latest']);
  });
});

describe('collectAll', () => {
  it('collects manifests, lockfiles, workflows, scripts and the translator', () => {
    const root = mkdtempSync(join(tmpdir(), 'freshness-'));
    try {
      for (const dir of [
        'js',
        'rust',
        '.github/workflows',
        'scripts',
        'parity',
      ]) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'js/package.json'),
        JSON.stringify(
          { dependencies: { a: '^1.0.0' }, overrides: { b: '^2.0.0' } },
          null,
          2
        )
      );
      writeFileSync(
        join(root, 'js/package-lock.json'),
        JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' } } })
      );
      writeFileSync(
        join(root, '.github/dependency-blockers.json'),
        JSON.stringify({ 'npm:b': `waiting for ${ISSUE}` })
      );
      writeFileSync(
        join(root, 'rust/Cargo.toml'),
        '[dependencies]\nserde = "1.0.229"\n'
      );
      writeFileSync(
        join(root, '.github/workflows/ci.yml'),
        'jobs:\n  a:\n    runs-on: ubuntu-26.04\n    steps:\n      - uses: actions/checkout@v7\n'
      );
      writeFileSync(
        join(root, 'scripts/install.sh'),
        'curl https://github.com/o/r/releases/download/v1.0.0/x\n'
      );
      writeFileSync(
        join(root, 'parity/translation.json'),
        JSON.stringify({
          repository: 'https://github.com/o/m',
          revision: SHA_A,
        })
      );
      const deps = collectAll(root).map(
        (d) => `${d.kind}:${d.name}@${d.file}:${d.line}`
      );
      expect(deps).toEqual([
        'npm:a@js/package.json:3',
        'npm:b@js/package.json:6',
        'crate:serde@rust/Cargo.toml:2',
        'runner:ubuntu-26.04@.github/workflows/ci.yml:3',
        'action:actions/checkout@.github/workflows/ci.yml:5',
        'release:o/r@scripts/install.sh:1',
        'git:https://github.com/o/m@parity/translation.json:1',
      ]);
      const [a, b] = collectAll(root);
      expect(a.locked).toEqual([
        { file: 'js/package-lock.json', version: '1.0.0' },
      ]);
      expect(b.blocker).toBe(ISSUE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses this repository without errors', () => {
    const deps = collectAll();
    const names = new Set(deps.map((d) => d.name));
    for (const name of [
      '@link-foundation/sensitive-data-sanitizer',
      'command-stream',
      'lino-objects-codec',
      'actions/checkout',
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
