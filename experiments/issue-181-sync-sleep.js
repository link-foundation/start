// Checks that Atomics.wait blocks the main thread under both node and bun,
// so the synchronous recovery entry point can wait out --on-kill-resume-delay.
const cell = new Int32Array(new SharedArrayBuffer(4));
const t0 = Date.now();
const result = Atomics.wait(cell, 0, 0, 300);
console.log(`${typeof Bun !== 'undefined' ? 'bun' : 'node'}: ${result} after ${Date.now() - t0}ms`);
