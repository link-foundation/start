// Prints the options block of a record with nested options in links and text
// formats; used to author the `status-nested-options` shared golden fixture.
const { ExecutionRecord } = require('../js/src/lib/execution-store');
const { formatRecord } = require('../js/src/lib/status-formatter');

const record = new ExecutionRecord({
  uuid: '123e4567-e89b-42d3-a456-426614174226',
  command: "sh -c 'exit 1'",
  status: 'executed',
  exitCode: 1,
  logPath: '/tmp/start-golden-226.log',
  startTime: '2026-10-10T00:00:00Z',
  endTime: '2026-10-10T00:00:01Z',
  options: {
    exitEvidence: { daemonRestart: false, mainOom: false },
    isolated: 'docker',
    launchOwner: { hostname: '70a2c2990824', pid: 522913 },
    ports: ['8080:80'],
    resolvedLimits: { cpus: 2, memory: '4g' },
    resourceLimitSpecs: { memory: { source: 'flag', value: '4g' } },
  },
});
function block(text, start, isEnd) {
  const lines = text.split('\n');
  const from = lines.indexOf(start);
  const rest = lines.slice(from + 1);
  const end = rest.findIndex(isEnd);
  return [start, ...(end === -1 ? rest : rest.slice(0, end))];
}
console.log(
  JSON.stringify(
    {
      record: record.toObject(),
      links: block(formatRecord(record, 'links-notation'), '  options', (l) =>
        /^ {2}\S/.test(l)
      ),
      text: block(formatRecord(record, 'text'), 'Options:', (l) => /^\S/.test(l)),
    },
    null,
    2
  )
);
