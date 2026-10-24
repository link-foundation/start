// Issue #253: write the legacy store fixture with lino-objects-codec 0.4.0, the
// release start-command <= 0.39.2 used. Usage: node gen-store-legacy.cjs <codec-0.4.0-path>
const codec = require(process.argv[2]);
const records = [{
  uuid: '25300000-0000-4000-8000-000000000253', pid: 4242, status: 'executed', exitCode: 0,
  command: 'echo "legacy store"', logPath: '/tmp/start-253.log',
  startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-01T00:00:01.000Z',
  workingDirectory: '/tmp', shell: '/bin/sh', platform: 'linux', options: { isolated: null },
}];
process.stdout.write(codec.encode({ obj: records }));
