// What does Bun.spawn's `proc.exited` resolve to for a signal-killed child?
// (run with bun)
const proc = Bun.spawn(['sh', '-c', 'kill -KILL $$']);
const exited = await proc.exited;
console.log(JSON.stringify({ exited, exitCode: proc.exitCode, signalCode: proc.signalCode }));
