#!/usr/bin/env python3
"""Finite cross-language fixture for issues 218 and 219: graceful stop of a
penalized monitor whose tick is 30 s (15-minute windows).

The monitor must lift the cap well before its tick ends (219) and the published
penalizedMs must not fall below what `$ --status` reported just before (218).

Usage: issue-218-monitor.py <graceful|supervise> <log> <monitor command...>
In supervise mode the command is a shell that stops the monitor on stdin EOF.
"""
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
with tempfile.TemporaryDirectory(prefix='docker-218-') as root:
    root = Path(root)
    (root / 'limit').write_text('2')
    docker = root / 'docker'
    docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
r = pathlib.Path(os.environ['START_CPU_FIXTURE'])
a = sys.argv[1:]
n = float((r / 'limit').read_text())
if a[0] == 'inspect':
    if '.HostConfig' in a[2]: print(json.dumps({'NanoCpus':int(n*1e9)}))
    else: print('false' if (r / 'stop').exists() else 'true')
elif a[0] == 'info': print('{"NCPU":6,"MemTotal":1073741824}')
elif a[0] == 'stats': print(json.dumps({'Name':'cpu-task','CPUPerc':'20.00%'}))
elif a[0] == 'update':
    (r / 'limit').write_text(str(float(a[2])))
else: sys.exit(1)
''')
    docker.chmod(0o755)
    env = dict(os.environ, START_DOCKER_BIN=str(docker), START_CPU_FIXTURE=str(root), START_DISABLE_TRACKING='true', START_DEBUG='1')
    now = lambda: int(time.time() * 1000)
    def state():
        try: return json.loads(state_file.read_text())
        except (OSError, ValueError): return {}
    def wait_for(predicate, description, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if predicate(): return
            time.sleep(.02)
        raise AssertionError('no progress: ' + description)
    def status_penalized_ms():
        # The same extrapolation as readState/read_state for a running task.
        s = state()
        return s['penalizedMs'] + max(0, now() - s['updatedAt']) if s.get('phase') == 'penalized' else s['penalizedMs']
    # A cap applied 5 s ago that no tick has accounted for yet.
    seeded = now() - 5000
    state_file.write_text(json.dumps(dict(phase='penalized', since=seeded, limitCpus=2, baseCpus=4, penaltyCount=1, penalizedMs=0, updatedAt=seeded, containerName='cpu-task', attemptNumber=1)))
    child = subprocess.Popen(sys.argv[3:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        wait_for(lambda: state().get('updatedAt', seeded) != seeded, 'first tick publishes', 7)
        assert state()['phase'] == 'penalized', state()
        time.sleep(1.5)
        before = status_penalized_ms()
        assert before >= 6000, before
        stopped = time.monotonic()
        if mode == 'supervise': child.stdin.close()
        else: child.send_signal(signal.SIGTERM)
        # 219: a 30 s tick must not delay the lift.
        wait_for(lambda: float((root / 'limit').read_text()) == 4, 'cap lifted after the stop signal', 5)
        lifted = time.monotonic() - stopped
        child.wait(timeout=5)
        after = state()
        sys.stderr.write(child.stderr.read().decode())
        print(json.dumps(dict(liftedAfterSeconds=round(lifted, 3), statusBefore=before, after=after)))
        assert after['phase'] == 'observing' and after['limitCpus'] == 4, after
        # 218: the time since the last tick is kept.
        assert after['penalizedMs'] >= before, (before, after['penalizedMs'])
        assert child.returncode == 0, child.returncode
    finally:
        (root / 'stop').touch()
        if child.poll() is None:
            if not child.stdin.closed: child.stdin.close()
            child.terminate()
            try: child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
