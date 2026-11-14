#!/usr/bin/env node
/**
 * Issue #263: generate the `pause-control` shared golden contracts.
 *
 * Runs each pause/unpause scenario through the JavaScript implementation
 * against the in-memory docker described in parity/fixtures/contracts.json
 * (`pause-control.docker`) and prints the normalized results. The output is
 * the candidate for `pause-control.cases[*].expected`; both
 * js/test/shared-golden.js and rust/tests/shared_golden.rs then hold the two
 * runtimes to it.
 *
 * Usage: node experiments/issue-263/pause-golden.js [--write]
 *   --write  replace the expectations in parity/fixtures/contracts.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const { ExecutionRecord, ExecutionStore } = require(
  path.join(root, 'js/src/lib/execution-store')
);
const pause = require(path.join(root, 'js/src/lib/execution-pause'));
const golden = require(path.join(root, 'js/test/fixtures/pause-golden.cjs'));

const contractsPath = path.join(root, 'parity/fixtures/contracts.json');
const contracts = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));
const section = contracts['pause-control'];

for (const fixture of section.cases) {
  const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'start-263-gold-'));
  try {
    const store = new ExecutionStore({ appFolder, useLinks: false });
    fixture.expected = golden.runPauseCase(
      { ExecutionRecord, pause },
      store,
      section,
      fixture
    );
  } finally {
    fs.rmSync(appFolder, { recursive: true, force: true });
  }
}

if (process.argv.includes('--write')) {
  // Splice only this (last) section: re-serialising the whole file would
  // rewrite unrelated fixtures (JSON.stringify prints 4.0 as 4).
  const original = fs.readFileSync(contractsPath, 'utf8');
  const marker = '\n  "pause-control": ';
  const start = original.indexOf(marker);
  if (start === -1 || !/\n\}\n?$/.test(original)) {
    throw new Error('pause-control must be the last section of contracts.json');
  }
  const body = JSON.stringify(section, null, 2).replace(/\n/g, '\n  ');
  fs.writeFileSync(
    contractsPath,
    `${original.slice(0, start)}${marker}${body}\n}\n`
  );
  console.log(`wrote ${section.cases.length} cases to ${contractsPath}`);
} else {
  console.log(JSON.stringify(section.cases, null, 2));
}
