/** Finite probe of the command-stream adapter's existing shell helpers. */
const assert = require('node:assert/strict');
const stream = require('../../js/src/lib/command-stream');

(async () => {
  for (const name of ['execCommand', 'execCommandAsync']) {
    const result = await stream[name]('echo helper-253');
    console.log(name, JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'helper-253');
    const nonzero = await stream[name](
      `node -e "process.stdout.write('out-253');process.stderr.write('err-253');process.exit(7)"`
    );
    assert.deepEqual(nonzero, { stdout: 'out-253', stderr: 'err-253', code: 7 });
  }
  const running = await stream.runCommand('echo runner-253', { mirror: false });
  assert.equal(stream.outputText(running.stdout).trim(), 'runner-253');
  let stdout = '';
  let ended = false;
  const handled = await stream.runWithHandlers('echo handlers-253', {
    onStdout: (chunk) => { stdout += chunk; },
    onExit: () => { ended = true; },
  });
  assert.equal(handled.code, 0);
  assert.equal(stdout.trim(), 'handlers-253');
  assert.equal(ended, true);
  assert.equal(await stream.commandExists('node'), true);
  assert.ok(await stream.getCommandPath('node'));
  assert.match(await stream.getToolVersion('node', '--version'), /^v\d+/);
  console.log('Both execution helpers preserve streams and exit 7; runner, handlers, existence, path and version helpers passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
