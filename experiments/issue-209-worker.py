"""Finite OOM probe: run ONLY in the experiment's 128 MiB Docker container."""
import json
import signal
import subprocess
import sys
import time

signal.signal(signal.SIGALRM, lambda *_: sys.exit(124))
signal.alarm(70)
root = "/sys/fs/cgroup/"
limit = int(open(root + "memory.max").read())
assert 0 < limit <= 128 * 1024 * 1024, "refuse an unbounded allocation probe"
child = subprocess.run([sys.executable, "-c", """
import signal
signal.alarm(10)
open('/proc/self/oom_score_adj', 'w').write('1000')
allocations = [bytearray(8 * 1024 * 1024) for _ in range(64)]
"""])
assert child.returncode == -9, child.returncode
events = dict(line.split() for line in open(root + "memory.events"))
at = int(time.time())
sample = " ".join(map(str, [limit, int(open(root + "memory.peak").read()),
                          events["oom"], events["oom_kill"], at, at]))
print(json.dumps({"sample": sample, "childExit": child.returncode}), flush=True)
time.sleep(30)
if sys.argv[1] == "main-oom":
    allocations = [bytearray(8 * 1024 * 1024) for _ in range(64)]
    sys.exit(2)  # Finite fallback: never allocate endlessly if the OOM is absent.
if sys.argv[1] == "external-kill":
    # Namespace PID 1 ignores an in-namespace SIGKILL. The runner kills it
    # through Docker from the ancestor namespace; the alarm bounds failures.
    time.sleep(35)
sys.exit(1)
