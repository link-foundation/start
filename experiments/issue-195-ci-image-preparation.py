#!/usr/bin/env python3
"""Bounded, offline regression for cached images, registry outages and retries."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="start-195-ci-images-") as folder:
    folder = Path(folder)
    docker = folder / "docker"
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['IMAGE_PREP_CALLS'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
mode = os.environ['IMAGE_PREP_MODE']
if args[:2] == ['image', 'inspect']:
    sys.exit(0 if mode == 'cached' else 1)
if args[0] == 'pull':
    if mode == 'fallback' and args[1].startswith('public.ecr.aws/'):
        sys.exit(0)
    print('toomanyrequests: Rate exceeded', file=sys.stderr)
    sys.exit(1)
sys.exit(0)
''')
    docker.chmod(0o755)
    # Exhaustion is finite; remove backoff delays in this offline fixture.
    sleep = folder / "sleep"
    sleep.write_text("#!/bin/sh\nexit 0\n")
    sleep.chmod(0o755)
    for mode in ["fallback", "cached", "unavailable"]:
        calls = folder / f"{mode}.jsonl"
        env = dict(os.environ, PATH=f"{folder}:{os.environ['PATH']}",
                   IMAGE_PREP_CALLS=str(calls), IMAGE_PREP_MODE=mode)
        result = subprocess.run(["bash", str(root / "scripts/prepare-docker-test-images.sh")],
                                env=env, capture_output=True, text=True)
        verbs = [json.loads(line) for line in calls.read_text().splitlines()]
        if mode == "fallback":
            assert result.returncode == 0, result.stderr
            assert sum(call[0] == "tag" for call in verbs) == 3
            assert any(call[0] == "pull" and call[1].startswith("mirror.gcr.io/") for call in verbs)
        elif mode == "cached":
            assert result.returncode == 0
            assert all(call[:2] == ["image", "inspect"] for call in verbs)
        else:
            assert result.returncode != 0
            assert sum(call[0] == "pull" for call in verbs) == 9, verbs
        print(f"PASS {mode}: {len(verbs)} Docker calls")
