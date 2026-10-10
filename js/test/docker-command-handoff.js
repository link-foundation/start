const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildCommandHandoffArgs,
  buildCommandHandoffScript,
  commandHandoffPath,
  writeCommandHandoff,
} = require('../src/lib/docker-command-handoff');
const { buildResumePlan, ResumeMode } = require('../src/lib/execution-resume');
const { SessionState } = require('../src/lib/session-probe');

test('new stopped containers choose a copy-free command handoff', () => {
  const plan = buildResumePlan(
    {
      uuid: 'uuid',
      command: 'old-command',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'box',
        commandHandoff: true,
      },
    },
    'printf new-command',
    { state: SessionState.STOPPED, alive: false }
  );
  assert.equal(plan.mode, ResumeMode.DOCKER_START);
  assert.equal(plan.handoffCommand, 'printf new-command');
  assert.deepEqual(
    plan.steps.map((step) => step.args),
    [['start', 'box']]
  );
  assert.equal(plan.snapshotImage, undefined);
});

test('handoff preserves argv and accepts a replacement without executing it on the host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  const marker = path.join(dir, 'command');
  try {
    const args = buildCommandHandoffArgs(
      ['sh', '-c', 'printf original'],
      'command'
    );
    const shellOptions = { cwd: dir, encoding: 'utf8' };
    assert.equal(
      spawnSync(args[0], args.slice(1), shellOptions).stdout,
      'original'
    );
    let script;
    const copied = writeCommandHandoff(
      'box',
      "printf '%s' 'new $value'",
      (_bin, argv) => {
        assert.equal(argv[0], 'cp');
        assert.equal(argv[2], `box:${commandHandoffPath('box')}`);
        script = fs.readFileSync(argv[1], 'utf8');
        fs.copyFileSync(argv[1], marker);
        fs.accessSync(argv[1], fs.constants.R_OK);
        // Windows chmod supports write permission, not Unix mode bits.
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(argv[1]).mode & 0o777, 0o644);
        }
        return { success: true };
      },
      { shell: 'sh' }
    );
    assert.equal(copied.success, true);
    assert.ok(script.includes('new $value'));
    assert.equal(
      spawnSync(args[0], args.slice(1), shellOptions).stdout,
      'new $value'
    );
    // docker start without another replacement runs the current stored command.
    assert.equal(
      spawnSync(args[0], args.slice(1), shellOptions).stdout,
      'new $value'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff preserves direct shell positional argv and evaluates compound commands as scripts', () => {
  for (const [command, expected] of [
    ['sh -c \'printf "%s:%s" "$0" "$1"\' tag \'two words\'', 'tag:two words'],
    ["sh -c 'exit 7'; printf 'after%s' \"$?\"", 'after7'],
  ]) {
    const script = buildCommandHandoffScript(command, { shell: 'sh' });
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('auto handoff chooses an installed shell inside the existing container', () => {
  const script = buildCommandHandoffScript('printf auto');
  assert.ok(
    script.includes('command -v bash || command -v zsh || command -v sh')
  );
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'auto');
});
