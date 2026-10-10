#!/usr/bin/env bash
# Finite 110MiB fixture; the sanitizer test runs under a 256MiB address-space cap.
set -eu
sanitizer_build_metadata=$(mktemp)
trap 'rm -f "$sanitizer_build_metadata"' EXIT
cargo test --manifest-path rust/Cargo.toml --test log_sanitizer --no-run --message-format=json > "$sanitizer_build_metadata"
sanitizer_test_binary=$(python3 - "$sanitizer_build_metadata" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    message=json.loads(line)
    if message.get('reason')=='compiler-artifact' and message.get('target',{}).get('name')=='log_sanitizer' and message.get('executable'):
        print(message['executable'])
PY
)
(ulimit -v 262144; "$sanitizer_test_binary" --ignored --exact large_log_experiment --nocapture)
