#!/usr/bin/env python3
"""An installed Docker client must not run Alpine probes without a Linux daemon."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="start-195-ci-capability-") as folder:
    folder = Path(folder)
    docker = folder / "docker"
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_CAPABILITY_CALLS'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] == 'info':
    if os.environ['DOCKER_CAPABILITY_MODE'] == 'windows':
        print('windows')
        sys.exit(0)
    sys.exit(1)
sys.exit(1)
''')
    docker.chmod(0o755)
    where = folder / "where"
    where.write_text("#!/bin/sh\nexit 0\n")
    where.chmod(0o755)
    preload = folder / "windows.cjs"
    preload.write_text("Object.defineProperty(process, 'platform', {value: 'win32'});\n")
    for mode in ["unavailable", "windows"]:
        calls = folder / f"{mode}.jsonl"
        env = dict(os.environ, PATH=f"{folder}:{os.environ['PATH']}",
                   DOCKER_CAPABILITY_CALLS=str(calls), DOCKER_CAPABILITY_MODE=mode)
        command = ["bun", "test", "./test/isolation.js", "--test-name-pattern",
                   "auto-detect shell in docker|accept shell option in options object"]
        if mode == "windows":
            command += ["--preload", str(preload)]
        result = subprocess.run(command, cwd=root / "js", env=env,
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        verbs = [json.loads(line) for line in calls.read_text().splitlines()]
        assert verbs, "The Docker daemon capability must be checked"
        assert all(call[0] == "info" for call in verbs), verbs
        print(f"PASS {mode}: {len(verbs)} capability checks, no image pulls or runs")
