#!/usr/bin/env bun

/**
 * Update npm for OIDC trusted publishing
 * npm trusted publishing requires npm >= 11.5.1
 * Node.js 20.x ships with npm 10.x, so we need to update
 *
 * Uses link-foundation libraries:
 * - use-m: Dynamic package loading without package.json dependencies
 * - command-stream: Modern shell command execution with streaming support
 */

import { loadCommandStream } from './load-command-stream.mjs';
import { checked } from './release-git.mjs';

// Load use-m dynamically
const { use } = eval(
  await (await fetch('https://unpkg.com/use-m/use.js')).text()
);

// Import command-stream for shell command execution
const { $ } = await loadCommandStream(use);

try {
  // Get current npm version
  // checked(): command-stream resolves on a non-zero exit (#234).
  const currentResult = await checked(
    $`npm --version`.run({ capture: true }),
    'npm --version'
  );
  const currentVersion = currentResult.stdout.trim();
  console.log(`Current npm version: ${currentVersion}`);

  // Update npm to latest
  await checked($`npm install -g npm@latest`, 'npm install -g npm@latest');

  // Get updated npm version
  const updatedResult = await checked(
    $`npm --version`.run({ capture: true }),
    'npm --version'
  );
  const updatedVersion = updatedResult.stdout.trim();
  console.log(`Updated npm version: ${updatedVersion}`);
} catch (error) {
  console.error('Error updating npm:', error.message);
  process.exit(1);
}
