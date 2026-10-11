#!/usr/bin/env python3
"""Finite cross-language Docker fixture: external limits and monitor death."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

mode, log = sys.argv[1:3]
state_file = Path(log + '.cpu-penalty.json')
lock_file = Path(str(state_file) + '.lock')
with tempfile.TemporaryDirectory(prefix='docker-207-') as root:
    root = Path(root)
    (root / 'limit').write_text('4')
    (root / 'busy').write_text('1')
    docker = root / 'docker'
    docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
r = pathlib.Path(os.environ['START_CPU_FIXTURE'])
a = sys.argv[1:]
n = float((r / 'limit').read_text())
if a[0] == 'inspect':
    if '.HostConfig' in a[2]:
        print(json.dumps({'CpuPeriod':200000,'CpuQuota':int(n*200000)} if os.environ['START_CPU_MODE']=='quota' else {'NanoCpus':int(n*1e9)}))
    else: print('false' if (r / 'stop').exists() else 'true')
elif a[0] == 'info': print('{"NCPU":6,"MemTotal":1073741824}')
elif a[0] == 'stats':
    assert len(a)==4
    print(json.dumps({'Name':'cpu-task','CPUPerc':'400.00%' if (r / 'busy').read_text()=='1' else '20.00%'}))
elif a[0] == 'update':
    n = float(a[2]) if a[1]=='--cpus' else int(a[2].split('=')[1])/100000
    (r / 'limit').write_text(str(n))
    with (r / 'updates').open('a') as f: f.write(str(n)+'\\n')
else: sys.exit(1)
''')
    docker.chmod(0o755)
    env = dict(os.environ, START_DOCKER_BIN=str(docker), START_CPU_FIXTURE=str(root), START_CPU_MODE=mode, START_DISABLE_TRACKING='true', START_DEBUG='1')
    child = None
    zombie = None
    reused = None
    def wait_for(predicate, description):
        end = time.monotonic() + 7
        while time.monotonic() < end:
            if predicate(): return
            if child is not None and child.poll() is not None:
                raise AssertionError('monitor exited: ' + description)
            time.sleep(.05)
        raise AssertionError('no progress: ' + description)
    def state():
        try: return json.loads(state_file.read_text())
        except (OSError, ValueError): return {}
    try:
        if mode in ('restart', 'zombie', 'reused'):
            (root / 'limit').write_text('2')
            (root / 'busy').write_text('0')
            state_file.write_text(json.dumps(dict(phase='penalized', since=int(time.time()*1000)-1000, limitCpus=2, baseCpus=4, penaltyCount=1, penalizedMs=1000, updatedAt=int(time.time()*1000), containerName='cpu-task', attemptNumber=1)))
            if mode == 'zombie':
                if not Path('/proc/self/stat').exists(): sys.exit(0)
                zombie = os.fork()
                if zombie == 0: os._exit(0)
                time.sleep(.1)
            if mode in ('zombie', 'reused'):
                if mode == 'reused': reused = subprocess.Popen(['sleep', '10'])
                lock_file.write_text(json.dumps(dict(pid=zombie or reused.pid, timestamp=int(time.time()*1000), hostname=os.uname().nodename)))
        child = subprocess.Popen(sys.argv[3:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        if mode not in ('restart', 'zombie', 'reused'):
            wait_for(lambda: state().get('phase') == 'penalized' and (root / 'limit').read_text() in ('2', '2.0'), 'apply at 95% of external 4-CPU base')
            assert float((root / 'limit').read_text()) == 2
            if mode == 'supervise':
                owner = json.loads(lock_file.read_text())['pid']
                os.kill(owner, signal.SIGKILL)
            if mode == 'graceful': child.send_signal(signal.SIGTERM)
            if mode == 'override': (root / 'limit').write_text('3')
            if mode == 'publish-fault':
                saved = state_file.read_text()
                state_file.unlink()
                state_file.mkdir()
                wait_for(lambda: '[DEBUG] CPU monitor: tick failed:' in Path(log).read_text(), 'publication failure is logged and retried')
                state_file.rmdir()
                state_file.write_text(saved)
            (root / 'busy').write_text('0')
        expected = 3 if mode == 'override' else 4
        wait_for(lambda: state().get('phase') == 'observing' and state().get('limitCpus') == expected, 'return to observed base ' + str(expected))
        assert state()['baseCpus'] == expected
        assert float((root / 'limit').read_text()) == expected
        (root / 'stop').touch()
        if mode == 'supervise': child.stdin.close()
        child.wait(timeout=4)
        sys.stderr.write(child.stderr.read().decode())
        assert child.returncode == 0
    finally:
        (root / 'stop').touch()
        if child is not None and child.poll() is None:
            if mode == 'supervise' and not child.stdin.closed: child.stdin.close()
            child.terminate()
            try: child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if zombie: os.waitpid(zombie, 0)
        if reused:
            reused.terminate()
            reused.wait()
