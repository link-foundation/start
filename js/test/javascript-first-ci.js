const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { YAML } = require('bun');
const { spawnSync } = require('node:child_process');
const {
  checkJavaScriptFirst,
} = require('../../scripts/check-javascript-first.mjs');
const {
  checkFeatureChanges,
  checkRegressionPairs,
} = require('../../scripts/check-feature-parity.mjs');

const root = resolve(__dirname, '../..');
function workflows() {
  return Object.fromEntries(
    readdirSync(resolve(root, '.github/workflows'))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => [
        name,
        YAML.parse(
          readFileSync(resolve(root, '.github/workflows', name), 'utf8')
        ),
      ])
  );
}

describe('JavaScript first CI gate', () => {
  it('validates every current workflow using parsed YAML', () => {
    assert.deepEqual(checkJavaScriptFirst(workflows()), []);
  });

  for (const [name, mutate] of [
    [
      'independent Rust PR trigger',
      (files) => {
        files['rust.yml'].on.pull_request = {};
      },
    ],
    [
      'removed successful-stage condition',
      (files) => {
        files['js.yml'].jobs['rust-stage'].if = 'always()';
      },
    ],
    [
      'an alternative that bypasses the successful stage',
      (files) => {
        files['js.yml'].jobs['rust-stage'].if =
          "${{ !cancelled() && needs.pipeline-status.result == 'success' || true }}";
      },
    ],
    [
      'Rust-only path filter',
      (files) => {
        files['js.yml'].on.pull_request.paths = ['js/**'];
      },
    ],
    [
      'Rust security matrix bypass',
      (files) => {
        files['security.yml'].jobs.codeql.strategy.matrix.language.push('rust');
      },
    ],
    [
      'direct Rust CodeQL bypass',
      (files) => {
        files['new.yml'] = {
          jobs: {
            scan: {
              steps: [
                {
                  uses: 'github/codeql-action/init@v4',
                  with: { languages: 'rust' },
                },
              ],
            },
          },
        };
      },
    ],
    [
      'comma-delimited Rust CodeQL bypass',
      (files) => {
        files['new.yml'] = {
          jobs: {
            scan: {
              steps: [
                {
                  uses: 'github/codeql-action/init@v4',
                  with: { languages: 'javascript-typescript,rust' },
                },
              ],
            },
          },
        };
      },
    ],
    [
      'Rust CodeQL matrix include bypass',
      (files) => {
        files['security.yml'].jobs.codeql.strategy.matrix = {
          include: [{ language: 'rust' }],
        };
      },
    ],
    [
      'independent Rustup tooling',
      (files) => {
        files['new.yml'] = {
          jobs: {
            install: {
              steps: [{ run: 'rustup toolchain install stable' }],
            },
          },
        };
      },
    ],
    [
      'release key outside main environment',
      (files) => {
        delete files['js.yml'].jobs.release.environment;
      },
    ],
    [
      'a new ungated Rust workflow',
      (files) => {
        files['new.yml'] = {
          on: { push: {} },
          jobs: { build: { steps: [{ run: 'cargo build' }] } },
        };
      },
    ],
    [
      'conditional parity',
      (files) => {
        files['js.yml'].jobs.parity.if = 'false';
      },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const files = workflows();
      mutate(files);
      assert.ok(checkJavaScriptFirst(files).length > 0);
    });
  }

  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`rejects a ${result} required JavaScript check`, () => {
      const check = spawnSync(
        process.execPath,
        [resolve(root, 'scripts/check-stage-status.mjs'), '--required', 'test'],
        {
          env: {
            ...process.env,
            NEEDS_JSON: JSON.stringify({ test: { result } }),
          },
        }
      );
      assert.equal(check.status, 1);
    });
  }

  it('opens the gate only after all required checks succeed', () => {
    const check = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/check-stage-status.mjs'), '--required', 'test'],
      {
        env: {
          ...process.env,
          NEEDS_JSON: JSON.stringify({
            test: { result: 'success' },
            release: { result: 'skipped' },
          }),
        },
      }
    );
    assert.equal(check.status, 0);
  });

  const releaseCheck = (isMain, release, test = 'success') =>
    spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/check-stage-status.mjs'),
        '--required',
        'test',
        '--release',
        'release:test',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          IS_MAIN: String(isMain),
          NEEDS_JSON: JSON.stringify({
            test: { result: test },
            release: { result: release },
          }),
        },
      }
    );

  it('fails a main push whose release was skipped after its needs passed', () => {
    // Every main release was silently skipped since #234 (issue #240).
    const check = releaseCheck(true, 'skipped');
    assert.equal(check.status, 1);
    assert.match(check.stderr, /release was skipped on a main push/);
    // The terms of the release condition are printed for the next skip.
    assert.match(check.stdout, /needs\.test\.result=success/);
    assert.match(check.stdout, /release: skipped; expected to run: true/);
  });

  it('accepts a skipped release outside main pushes and a run release on main', () => {
    assert.equal(releaseCheck(false, 'skipped').status, 0);
    assert.equal(releaseCheck(true, 'success').status, 0);
  });

  it('rejects a change to only one implementation of a feature', () => {
    const features = [
      {
        id: 'sample',
        javascript: { implementation: ['js/source.js'], tests: ['js/test.js'] },
        rust: { implementation: ['rust/source.rs'], tests: ['rust/test.rs'] },
      },
    ];
    assert.equal(checkFeatureChanges(features, ['rust/source.rs']).length, 1);
    assert.equal(checkFeatureChanges(features, ['js/source.js']).length, 1);
    assert.deepEqual(
      checkFeatureChanges(features, ['js/source.js', 'rust/test.rs']),
      []
    );
  });

  it('treats generated Rust regenerated by a translator bump as no change', () => {
    const features = [
      {
        id: 'generated',
        javascript: { implementation: ['js/source.mjs'], tests: [] },
        rust: { implementation: ['rust/generated.rs'], tests: [] },
      },
    ];
    const generated = [
      { javascript: 'js/source.mjs', rust: 'rust/generated.rs' },
    ];
    assert.deepEqual(
      checkFeatureChanges(features, ['rust/generated.rs'], generated),
      []
    );
    assert.deepEqual(
      checkFeatureChanges(
        features,
        ['js/source.mjs', 'rust/generated.rs'],
        generated
      ),
      []
    );
    assert.equal(
      checkFeatureChanges(features, ['rust/generated.rs']).length,
      1
    );
  });

  it('keeps both halves of a regression test under one feature', () => {
    const feature = (id, js, rust) => ({
      id,
      javascript: { implementation: [], tests: js },
      rust: { implementation: [], tests: rust },
    });
    assert.equal(
      checkRegressionPairs([
        feature('a', ['js/test/regression-193.js'], []),
        feature('b', [], ['rust/tests/regression_193.rs']),
      ]).length,
      1
    );
    assert.deepEqual(
      checkRegressionPairs([
        feature(
          'a',
          ['js/test/regression-201.js'],
          ['rust/tests/regression_201.rs']
        ),
        feature('b', [], ['rust/tests/regression_201.rs']),
      ]),
      []
    );
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'parity/features.json'), 'utf8')
    );
    assert.deepEqual(checkRegressionPairs(manifest.features), []);
  });

  it('makes Rust callable only after the complete JavaScript stage', () => {
    const files = workflows();
    assert.deepEqual(Object.keys(files['rust.yml'].on), ['workflow_call']);
    const call = files['js.yml'].jobs['rust-stage'];
    assert.equal(call.uses, './.github/workflows/rust.yml');
    assert.deepEqual(call.needs, ['pipeline-status']);
    assert.match(call.if, /needs\.pipeline-status\.result == 'success'/);
    assert.equal(call.concurrency['cancel-in-progress'], false);
  });

  it('always runs JavaScript and its behavioral parity gate on Rust-only changes', () => {
    const js = workflows()['js.yml'];
    for (const trigger of ['push', 'pull_request']) {
      assert.equal(js.on[trigger].paths, undefined);
      assert.equal(js.on[trigger]['paths-ignore'], undefined);
    }
    assert.ok(js.jobs.parity);
    assert.equal(js.jobs.parity.if, undefined);
  });
});
