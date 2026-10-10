const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const path = require('path');
const { parseArgs } = require('../src/lib/args-parser');

describe('wrapper help (#201)', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} prints the no-argument usage and exits successfully`, () => {
      const cli = path.join(__dirname, '../src/bin/cli.js');
      const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
      const result = spawnSync(process.execPath, [cli, flag], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(usage.stdout);
      expect(parseArgs([flag]).wrapperOptions.help).toBe(true);
    });
    it(`${flag} after the separator remains part of the command`, () => {
      const result = parseArgs(['--', 'grep', flag]);
      expect(result.wrapperOptions.help).toBe(false);
      expect(result.rawCommand).toEqual(['grep', flag]);
    });
  }
});
