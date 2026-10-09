// Keep the identical POSIX runtime snippets synchronized for this change.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const js = require('../js/src/lib/cgroup-memory.js');
const file = new URL('../rust/src/lib/cgroup_memory.rs', import.meta.url);
let rust = fs.readFileSync(file, 'utf8');
const functions = [
  ['build_cgroup_functions_snippet', '', js.buildCgroupFunctionsSnippet(), 'to_string()'],
  ['build_cgroup_sampler_start_snippet', 'container_name: &str', js.buildCgroupSamplerStartSnippet('__SC_NAME__'), 'replace("\'__SC_NAME__\'", &shell_quote(container_name))'],
  ['build_cgroup_sampler_stop_snippet', '', js.buildCgroupSamplerStopSnippet(), 'to_string()'],
  ['build_cgroup_memory_log_snippet', 'quoted_log_path: &str', js.buildCgroupMemoryLogSnippet('__SC_LOG__'), 'replace("__SC_LOG__", quoted_log_path)'],
];
for (const [name, args, body, convert] of functions) {
  rust = rust.replace(new RegExp(`pub fn ${name}\\([^)]*\\) -> String \\{[\\s\\S]*?\\n\\}`), `pub fn ${name}(${args}) -> String {\n    r###"${body}"###.${convert}\n}`);
}
fs.writeFileSync(file, rust);
