#!/usr/bin/env python3
"""Finite real-Docker acceptance probe. Requires Bun, Docker and alpine:3.23."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
cli = ['bun', str(repo / 'js/src/bin/cli.js')]
name = 'issue-207-real-' + str(os.getpid())

def command(args, env=None):
    result = subprocess.run(args, env=env, capture_output=True, text=True)
    print('$ ' + ' '.join(args), flush=True)
    print(result.stdout + result.stderr, flush=True)
    if result.returncode: raise RuntimeError('exit ' + str(result.returncode))
    return result.stdout

def parent(pid):
    data = Path('/proc/' + str(pid) + '/stat').read_text()
    return int(data[data.rfind(')') + 2:].split()[1])

with tempfile.TemporaryDirectory(prefix='issue-207-real-') as folder:
    env = dict(os.environ, START_APP_FOLDER=folder, START_DEBUG='1')
    orphaned = []
    try:
        # Eight tiny shell loops run for at most 22s, followed by 33s of idle.
        # The container exits independently even if the host-side probe fails.
        work = 'pids=""; for i in 1 2 3 4 5 6 7 8; do (while :; do :; done) & pids="$pids $!"; done; sleep 22; kill $pids; wait $pids; echo idle; sleep 33'
        command(cli + ['--isolated', 'docker', '--image', 'alpine:3.23', '--detached', '--session', name, '--keep-container', '--cpu-penalty', '--cpu-penalty-trigger-window', '2s', '--cpu-penalty-release-window', '2s', '--', work], env)
        command(['docker', 'update', '--cpus', '4', name])
        records = json.loads(command(cli + ['--list', '--output-format', 'json'], env))['executions']
        record = next(r for r in records if r['options']['sessionName'] == name)
        sidecar = Path(record['logPath'] + '.cpu-penalty.json')
        def state():
            try: return json.loads(sidecar.read_text())
            except (OSError, ValueError): return {}
        def wait_for(predicate, seconds, label):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if predicate():
                    print(label + ': ' + json.dumps(state()), flush=True)
                    return
                time.sleep(.2)
            print(Path(record['logPath']).read_text(), flush=True)
            raise AssertionError(label + ': ' + json.dumps(state()))
        wait_for(lambda: state().get('phase') == 'penalized', 16, 'applied at 95% of external base')
        monitor = json.loads(Path(str(sidecar) + '.lock').read_text())['pid']
        supervisor = parent(monitor)
        watcher = parent(supervisor)
        assert 'docker logs -f' in Path('/proc/' + str(watcher) + '/cmdline').read_text()
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                try:
                    if parent(int(entry.name)) == watcher: orphaned.append(int(entry.name))
                except (OSError, ValueError): pass
        # Stop every CPU supervisor, preserving the workload and its 2-CPU cap.
        for pid in (watcher, supervisor, monitor): os.kill(pid, signal.SIGKILL)
        print('Killed watcher/supervisor/monitor: ' + str((watcher, supervisor, monitor)), flush=True)
        command(cli + ['--resume-all', '--output-format', 'json'], env)
        wait_for(lambda: state().get('phase') == 'observing' and state().get('limitCpus') == 4, 35, 'resumed idle monitor restored base')
        assert state()['baseCpus'] == 4
        host = json.loads(command(['docker', 'inspect', '-f', '{{json .HostConfig}}', name]))
        assert host['NanoCpus'] == 4000000000
        status = json.loads(command(cli + ['--status', name, '--output-format', 'json'], env))
        assert status['cpuPenalty']['baseCpus'] == 4
        print(Path(record['logPath']).read_text(), flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        # Killing the old watcher also orphans its sampler/log subprocesses.
        for pid in orphaned:
            try:
                if name in Path('/proc/' + str(pid) + '/cmdline').read_text(): os.kill(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError): pass
        # Give the reattached watcher time to reap the monitor and finalize.
        time.sleep(4)
