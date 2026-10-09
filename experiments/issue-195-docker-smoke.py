#!/usr/bin/env python3
"""Ordinary finite Docker smoke test for runners without usable controllers."""
import json, os, pathlib, subprocess, tempfile, time
root=pathlib.Path(__file__).resolve().parents[1]
results=[]
for impl,cli in [('js',['bun',str(root/'js/src/bin/cli.js')]),('rust',[str(root/'rust/target/debug/start')])]:
 with tempfile.TemporaryDirectory(prefix='start-195-smoke-') as folder:
  env=dict(os.environ,START_APP_FOLDER=folder,START_LOG_DIR=folder,START_DISABLE_AUTO_ISSUE='1',START_DISABLE_LOG_UPLOAD='1')
  name=f'start-195-smoke-{impl}-{os.getpid()}'
  def run(args):
   p=subprocess.run(args,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   if p.returncode: raise RuntimeError(p.stdout+p.stderr)
   return p.stdout
  try:
   run(cli+['-i','docker','-d','--image','alpine:3.23','--session',name,'--keep-container','--','sleep 3; echo smoke-complete'])
   run(['docker','wait',name])
   for _ in range(40):
    status=json.loads(run(cli+['--status',name,'--output-format','json']))
    if status['status']=='executed': break
    time.sleep(.25)
   assert status['status']=='executed' and status['exitCode']==0,status
   # The watcher writes diagnostics just after status can finalize the record.
   for _ in range(40):
    log=pathlib.Path(status['logPath']).read_text()
    if 'Memory:' in log: break
    time.sleep(.25)
   assert 'Memory:' in log and ('memory.limit=' in log or 'memory.max=' in log),log
   run(cli+['-i','docker','--image','alpine:3.23','--','echo attached-smoke'])
   attached=[]
   for p in pathlib.Path(folder).rglob('*.log'):
    contents=p.read_text()
    if 'attached-smoke' in contents: attached.append(contents)
   assert any('Memory:' in s for s in attached),attached
   results.append({'implementation':impl,'status':status['status'],'exitCode':status['exitCode'],'memoryLines':[s for s in log.splitlines() if s.startswith('Memory:')],'attachedMemoryLine':next(s for text in attached for s in text.splitlines() if s.startswith('Memory:'))})
  finally:
   subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps(results,indent=2))
