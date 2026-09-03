/**
 * Tests for the --attach/--resume/--resume-all/--running options (issue #162)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseArgs, validateOptions } = require('../src/lib/args-parser');

function parse(args) {
  const result = parseArgs(args);
  validateOptions(result.wrapperOptions);
  return result;
}

describe('--attach', () => {
  test('accepts a session identifier as a separate argument', () => {
    const { wrapperOptions } = parse(['--attach', 'my-session']);
    assert.strictEqual(wrapperOptions.attach, 'my-session');
    assert.strictEqual(wrapperOptions.readOnly, false);
  });

  test('accepts the --attach=<id> form', () => {
    const { wrapperOptions } = parse([
      '--attach=dd1acfbe-3c01-4ffa-8c78-f825457f5813',
    ]);
    assert.strictEqual(
      wrapperOptions.attach,
      'dd1acfbe-3c01-4ffa-8c78-f825457f5813'
    );
  });

  test('supports --read-only', () => {
    const { wrapperOptions } = parse(['--attach', 'my-session', '--read-only']);
    assert.strictEqual(wrapperOptions.attach, 'my-session');
    assert.strictEqual(wrapperOptions.readOnly, true);
  });

  test('rejects --read-only without --attach', () => {
    assert.throws(() => {
      parse(['--read-only', '--status', 'my-session']);
    }, /--read-only option is only valid with --attach/);
  });

  test('requires an identifier argument', () => {
    assert.throws(() => {
      parseArgs(['--attach']);
    }, /Option --attach requires a UUID or session name argument/);
  });

  test('rejects an empty --attach= value', () => {
    assert.throws(() => {
      parseArgs(['--attach=']);
    }, /Option --attach requires a UUID or session name argument/);
  });
});

describe('--resume', () => {
  test('accepts a session identifier', () => {
    const { wrapperOptions, command } = parse(['--resume', 'my-session']);
    assert.strictEqual(wrapperOptions.resume, 'my-session');
    assert.strictEqual(command, '');
  });

  test('accepts a replacement command after the -- separator', () => {
    const { wrapperOptions, command, rawCommand } = parse([
      '--resume',
      'my-session',
      '--',
      'echo',
      'hello world',
    ]);
    assert.strictEqual(wrapperOptions.resume, 'my-session');
    // Quoted argv elements stay quoted so the inner shell keeps the
    // boundaries the user typed (issue #164).
    assert.strictEqual(command, "echo 'hello world'");
    assert.deepStrictEqual(rawCommand, ['echo', 'hello world']);
  });

  test('accepts the --resume=<id> form with a replacement command', () => {
    const { wrapperOptions, rawCommand } = parse([
      '--resume=my-session',
      '--',
      'npm',
      'test',
    ]);
    assert.strictEqual(wrapperOptions.resume, 'my-session');
    assert.deepStrictEqual(rawCommand, ['npm', 'test']);
  });

  test('supports --output-format', () => {
    const { wrapperOptions } = parse([
      '--resume',
      'my-session',
      '--output-format',
      'json',
    ]);
    assert.strictEqual(wrapperOptions.outputFormat, 'json');
  });
});

describe('--resume-all', () => {
  test('is a boolean flag', () => {
    const { wrapperOptions } = parse(['--resume-all']);
    assert.strictEqual(wrapperOptions.resumeAll, true);
  });

  test('supports --output-format', () => {
    const { wrapperOptions } = parse([
      '--resume-all',
      '--output-format',
      'json',
    ]);
    assert.strictEqual(wrapperOptions.resumeAll, true);
    assert.strictEqual(wrapperOptions.outputFormat, 'json');
  });
});

describe('--list --running', () => {
  test('sets the running filter', () => {
    const { wrapperOptions } = parse(['--list', '--running']);
    assert.strictEqual(wrapperOptions.list, true);
    assert.strictEqual(wrapperOptions.running, true);
  });

  test('rejects --running without --list', () => {
    assert.throws(() => {
      parse(['--running']);
    }, /--running option is only valid with --list/);
  });
});

describe('query mode exclusivity', () => {
  const combinations = [
    ['--attach', 'a', '--resume', 'b'],
    ['--attach', 'a', '--status', 'b'],
    ['--resume', 'a', '--terminate', 'b'],
    ['--resume-all', '--list'],
    ['--resume-all', '--cleanup'],
  ];

  for (const args of combinations) {
    test(`rejects ${args.join(' ')}`, () => {
      assert.throws(() => {
        parse(args);
      }, /Cannot combine --status, --list, --upload-log, --stop, --terminate, --attach, --resume, --resume-all, or --cleanup/);
    });
  }
});

describe('defaults', () => {
  test('are all inactive without query options', () => {
    const { wrapperOptions } = parse(['echo', 'hi']);
    assert.strictEqual(wrapperOptions.attach, null);
    assert.strictEqual(wrapperOptions.readOnly, false);
    assert.strictEqual(wrapperOptions.resume, null);
    assert.strictEqual(wrapperOptions.resumeAll, false);
    assert.strictEqual(wrapperOptions.running, false);
  });
});
