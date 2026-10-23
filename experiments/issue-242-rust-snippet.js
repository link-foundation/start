// Prints the JavaScript sampler start snippet with the placeholders used by
// rust/src/lib/cgroup_memory.rs, so the Rust raw string can be checked for
// byte parity (issues #242 and #247): node experiments/issue-242-rust-snippet.js
const m = require('../js/src/lib/cgroup-memory');
const functions = m.buildCgroupFunctionsSnippet();
let s = m.buildCgroupSamplerStartSnippet('__SC_NAME__');
if (!s.startsWith(`${functions}; `)) {
  throw new Error('unexpected prefix');
}
s = s.slice(functions.length + 2);
const { shellQuote } = require('../js/src/lib/isolation-log-utils');
const i = m.CGROUP_SAMPLE_INTERVAL_SECONDS;
const remote = shellQuote(
  `${functions}; __start_command_cgroup_read /sys/fs/cgroup || exit ${m.CGROUP_UNREADABLE_EXIT}`
);
const b = m.CGROUP_SAMPLE_BACKOFF_MAX_SECONDS;
s = s
  .split(shellQuote(m.buildCgroupStreamScript())).join('__SC_STREAM__')
  .split(remote).join('__SC_REMOTE__')
  .split(m.CGROUP_STREAM_NAME).join('__SC_STREAM_NAME__')
  .split(shellQuote(m.CGROUP_SAMPLING_OFF_REASON)).join('__SC_OFF__')
  .split(`:-${i}}`).join(':-__SC_INTERVAL__}')
  .split(`__scs_interval=${i};`).join('__scs_interval=__SC_INTERVAL__;')
  .split(`-le ${b} ] || __scs_delay=${b};`).join('-le __SC_BACKOFF__ ] || __scs_delay=__SC_BACKOFF__;');
process.stdout.write(s);
