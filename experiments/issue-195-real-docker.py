#!/usr/bin/env python3
"""Finite integration probe: <=1 CPU and 64 MiB per task; no host OOM/restart."""
import json, os, pathlib, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
results = []
def run(argv, env=None):
    p = subprocess.run(argv, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if p.returncode:
        raise RuntimeError(f'{argv[0:4]}: {p.stdout}')
    return p.stdout
for impl, cli in [('js', ['bun', str(ROOT/'js/src/bin/cli.js')]), ('rust', [str(ROOT/'rust/target/debug/start')])]:
    with tempfile.TemporaryDirectory(prefix=f'start-195-{impl}-') as folder:
        env = dict(os.environ, START_APP_FOLDER=folder, START_LOG_DIR=folder, START_DISABLE_AUTO_ISSUE='1', START_DISABLE_LOG_UPLOAD='1')
        name = f'start-195-{impl}-{os.getpid()}'
        snapshot = None
        try:
            workload = "sh -c '(while :; do :; done) & p=$!; sleep 10; kill $p; wait $p 2>/dev/null; sleep 8; echo finite-done'"
            launch = run(cli+['-i','docker','-d','--image','alpine:3.23','--session',name,'--keep-container','--memory','64m','--cpus','1','--cpu-penalty','--cpu-penalty-cpus','0.5','--cpu-penalty-trigger','20%','--cpu-penalty-trigger-window','1s','--cpu-penalty-release-window','1s','--',workload],env)
            limits = json.loads(run(['docker','inspect','-f','{{json .HostConfig}}',name]))
            assert limits['Memory']==67108864 and limits['MemorySwap']==67108864 and limits['NanoCpus']==1000000000, limits
            assert run(['docker','wait',name]).strip()=='0'
            # Finite polling of the completion watcher; wait for final persisted facts.
            for _ in range(40):
                status = json.loads(run(cli+['--status',name,'--output-format','json'],env))
                if status['status']=='executed': break
                time.sleep(.25)
            assert status['status']=='executed', status
            log = pathlib.Path(status['logPath']).read_text()
            assert 'CPU penalty applied:' in log and 'CPU penalty lifted:' in log, log
            assert 'Memory:' in log and 'memory.limit=67108864' in log, log
            penalty=status['cpuPenalty']; assert penalty['penaltyCount']>=1 and penalty['baseCpus']==1, penalty
            resume = json.loads(run(cli+['--resume',name,'--memory','128m','--output-format','json','--','echo resumed'],env))
            resumed=resume['sessionName']; snapshot=resume.get('snapshotImage')
            limits2=json.loads(run(['docker','inspect','-f','{{json .HostConfig}}',resumed]))
            assert limits2['Memory']==134217728 and limits2['MemorySwap']==134217728 and limits2['NanoCpus']==1000000000, limits2
            run(['docker','wait',resumed])
            for _ in range(40):
                after=json.loads(run(cli+['--status',name,'--output-format','json'],env))
                if after['status']=='executed': break
                time.sleep(.25)
            assert after['status']=='executed'
            results.append({'implementation':impl,'launchMemory':limits['Memory'],'swap':limits['MemorySwap'],'cpuTransitions':[line for line in log.splitlines() if '[start] CPU penalty' in line],'cpuPenalty':penalty,'memoryLines':[line for line in log.splitlines() if line.startswith('Memory:')],'resumeMemory':limits2['Memory'],'resumeBaseNanoCpus':limits2['NanoCpus'],'status':after['status']})
            run(['docker','rm','-f',resumed])
        finally:
            subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if snapshot: subprocess.run(['docker','image','rm',snapshot],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps(results,indent=2))
