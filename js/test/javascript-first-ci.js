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
