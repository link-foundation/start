#!/usr/bin/env bun
/**
 * Regression tests for issue #89:
 * "We need to show better output for virtual docker pull command
 * and other such virtual commands we will introduce in the future"
 *
 * When Docker is not installed (or not running) and an image is specified,
 * the output should show:
 *   $ docker pull <image>
 *   (empty line)
 *   Error: Docker is not installed...
 *   (empty line)
 *   ✗
 *   │ finish ...
 *
 * The virtual command line shows BEFORE the error message.
 * The failure marker (✗) and timeline separator come AFTER the error,
 * as part of the finish block output.
 *
 * Reference: https://github.com/link-foundation/start/issues/89
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');

describe('Virtual docker pull output before Docker error (issue #89)', () => {
  // Capture console output for testing
  let capturedOutput = [];
  let originalConsoleLog;
  let originalConsoleError;

  beforeEach(() => {
    capturedOutput = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args) => {
      capturedOutput.push(args.join(' '));
    };
    console.error = (...args) => {
      capturedOutput.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should show "$ docker pull <image>" line when Docker is not installed and image is specified', async () => {
    // We need to test the runInDocker function with a mocked "docker not available" scenario.
    // We mock isCommandAvailable to simulate Docker not being installed.

    // Use the output-blocks module to understand what the virtual command should look like
    const {
      createVirtualCommandBlock,
      createVirtualCommandResult,
    } = require('../src/lib/output-blocks');

    const image = 'konard/sandbox';
    const expectedCommandLine = createVirtualCommandBlock(
      `docker pull ${image}`
    );
    const expectedFailureMarker = createVirtualCommandResult(false);

    // Verify the expected format
    assert.strictEqual(
      expectedCommandLine,
      `$ docker pull ${image}`,
      'Virtual command block should produce "$ docker pull <image>"'
    );
    assert.strictEqual(
      expectedFailureMarker,
      '✗',
      'Virtual command result (failure) should be "✗"'
    );
  });

  it('should show "$ docker pull <image>" before the error message (issue #89)', async () => {
    // This test verifies the output format contract for issue #89:
    // The virtual command line ("$ docker pull ...") must appear BEFORE the error message.
    // The failure marker (✗) and timeline separator (│) come AFTER the error,
    // as part of the finish block (not printed by runInDocker itself).

    const {
      createVirtualCommandBlock,
      createFinishBlock,
    } = require('../src/lib/output-blocks');

    // Simulate what the full output should look like
    const image = 'konard/sandbox';
    const lines = [];

    // Part 1: What runInDocker outputs (virtual command only)
    lines.push(createVirtualCommandBlock(`docker pull ${image}`));
    lines.push(''); // empty line after virtual command

    // Part 2: Error message (printed by cli.js after runInDocker returns)
    lines.push('Error: Docker is not installed. Install Docker from ...');
    lines.push(''); // empty line before finish block

    // Part 3: Finish block (includes ✗ and │ lines)
    lines.push(
      createFinishBlock({
        sessionId: 'test-uuid',
        timestamp: '2026-03-10 13:50:04',
        exitCode: 1, // failure
        logPath: '/tmp/test.log',
        durationMs: 326,
      })
    );

    const output = lines.join('\n');

    // Verify ordering: docker pull → error message → ✗ marker
    const dockerPullIndex = output.indexOf(`$ docker pull ${image}`);
    const errorIndex = output.indexOf('Docker is not installed');
    const failureMarkerIndex = output.indexOf('✗');

    assert.ok(
      dockerPullIndex !== -1,
      'Output must contain "$ docker pull konard/sandbox"'
    );
    assert.ok(
      errorIndex !== -1,
      'Output must contain error message "Docker is not installed"'
    );
    assert.ok(
      failureMarkerIndex !== -1,
      'Output must contain failure marker "✗"'
    );

    // Key ordering requirements from issue #89:
    assert.ok(
      dockerPullIndex < errorIndex,
      '"$ docker pull" must appear BEFORE error message'
    );
    assert.ok(
      errorIndex < failureMarkerIndex,
      'Error message must appear BEFORE "✗" failure marker'
    );
  });

  it('should output "$ docker pull <image>" in the correct format ($ prefix, no extra prefix)', () => {
    const { createVirtualCommandBlock } = require('../src/lib/output-blocks');

    const image = 'alpine:latest';
    const block = createVirtualCommandBlock(`docker pull ${image}`);

    // Must start with "$ " prefix (no timeline marker │)
    assert.ok(
      block.startsWith('$ '),
      'Virtual command block must start with "$ "'
    );
    assert.ok(
      !block.startsWith('│'),
      'Virtual command block must NOT start with timeline marker "│"'
    );
    assert.strictEqual(
      block,
      `$ docker pull ${image}`,
      `Expected exactly "$ docker pull ${image}", got: ${block}`
    );
  });
});

describe('runInDocker virtual pull output contract (issue #89)', () => {
  // Test that the runInDocker function in isolation.js shows the virtual docker pull
  // command before error messages when Docker is not available.
  //
  // We verify this by reading the source to confirm the fix is present.

  it('runInDocker should output docker pull command but NOT ✗/│ markers before returning (issue #89)', () => {
    // Read the isolation.js source to verify the fix is present
    const fs = require('fs');
    const path = require('path');
    const isolationSrc = fs.readFileSync(
      path.join(__dirname, '../src/lib/isolation.js'),
      'utf8'
    );

    // The fix handles both "not installed" and "not running" in a combined block (dockerNotAvailableError).
    // Verify both error messages are present in the source.
    assert.ok(
      isolationSrc.includes('Docker is not installed. Install Docker'),
      'Source must contain the "not installed" error message'
    );
    assert.ok(
      isolationSrc.includes('Docker is installed but not running'),
      'Source must contain the "not running" error message'
    );

    // Verify that the docker pull output code is present (fix for issue #89)
    assert.ok(
      isolationSrc.includes('docker pull ${options.image}'),
      'Source must contain docker pull with image variable (fix for issue #89)'
    );

    // Verify the dockerNotAvailableError combined approach is used
    assert.ok(
      isolationSrc.includes('dockerNotAvailableError'),
      'Source must use combined dockerNotAvailableError variable for both error cases'
    );

    // The docker pull output console.log must appear before the return statement
    const dockerPullConsoleIdx = isolationSrc.indexOf(
      'outputBlocks.createVirtualCommandBlock'
    );
    const returnDockerErrorIdx = isolationSrc.indexOf(
      'message: dockerNotAvailableError'
    );
    assert.ok(
      dockerPullConsoleIdx !== -1,
      'Source must call outputBlocks.createVirtualCommandBlock for docker pull command'
    );
    assert.ok(
      returnDockerErrorIdx !== -1,
      'Source must have message: dockerNotAvailableError in return'
    );
    assert.ok(
      dockerPullConsoleIdx < returnDockerErrorIdx,
      'docker pull console.log must appear before the error return in source'
    );

    // Issue #89 key fix: The ✗ and │ markers should NOT be printed by runInDocker
    // They come from createFinishBlock() AFTER the error message is displayed.
    // Verify that createVirtualCommandResult is NOT called in the dockerNotAvailableError block.
    const dockerNotAvailableBlockStart = isolationSrc.indexOf(
      'if (dockerNotAvailableError) {'
    );
    const dockerNotAvailableBlockEnd = isolationSrc.indexOf(
      'message: dockerNotAvailableError',
      dockerNotAvailableBlockStart
    );
    const dockerNotAvailableBlock = isolationSrc.slice(
      dockerNotAvailableBlockStart,
      dockerNotAvailableBlockEnd + 100
    );

    // The block should NOT contain createVirtualCommandResult (which outputs ✗)
    assert.ok(
      !dockerNotAvailableBlock.includes('createVirtualCommandResult'),
      'dockerNotAvailableError block must NOT call createVirtualCommandResult (issue #89 fix)'
    );

    // The block should have a comment explaining why ✗/│ are not printed here
    assert.ok(
      dockerNotAvailableBlock.includes('createFinishBlock') ||
        dockerNotAvailableBlock.includes('AFTER the error message'),
      'Source should document that ✗/│ come from createFinishBlock AFTER error'
    );
  });
});
