// Runs the #182 cgroup sampler shell against a fake cgroup tree and a fake
// `docker`, then prints the sample and the `Memory:` log line.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../js/src/lib/cgroup-memory');

const id = 'c0ffee' + '0'.repeat(58);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg182-'));
const cg = path.join(root, 'cgroup', 'system.slice', `docker-${id}.scope`);
fs.mkdirSync(cg, { recursive: true });
fs.writeFileSync(path.join(cg, 'memory.events'), 'low 0\nhigh 0\nmax 12\noom 1\noom_kill 3\noom_group_kill 0\n');
fs.writeFileSync(path.join(cg, 'memory.max'), '268435456\n');
fs.writeFileSync(path.join(cg, 'memory.peak'), '268300000\n');
fs.mkdirSync(path.join(root, 'proc', '4242'), { recursive: true });
fs.writeFileSync(path.join(root, 'proc', '4242', 'cgroup'), `0::/system.slice/docker-${id}.scope\n`);
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\ncase "$3" in *Id*) echo ${id};; *Pid*) echo 4242;; esac\n`, { mode: 0o755 });
const log = path.join(root, 'log');
const script = [
  m.buildCgroupSamplerStartSnippet('box'),
  'sleep 1.5',
  // the container stops: its cgroup disappears before the final read
  `rm -rf ${JSON.stringify(cg)}`,
  m.buildCgroupSamplerStopSnippet(),
  `printf 'sample=[%s]\\n' "$__start_command_cgroup"`,
  m.buildCgroupMemoryLogSnippet(JSON.stringify(log)),
].join('; ');
const out = execFileSync('sh', ['-c', script], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, START_COMMAND_CGROUP_ROOT: path.join(root, 'cgroup'), START_COMMAND_PROC_ROOT: path.join(root, 'proc'), TMPDIR: root },
}).toString();
console.log(out + fs.readFileSync(log, 'utf8'));
console.log(m.parseCgroupMemorySample(out.match(/\[(.*)\]/)[1]));
console.log(fs.readdirSync(root));
fs.rmSync(root, { recursive: true, force: true });
