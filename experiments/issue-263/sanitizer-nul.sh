#!/bin/sh
# Reproduces sensitive-data-sanitizer dropping the bytes after a GitHub token
# when the next byte is NUL (start's --upload-log invocation).
# Usage: sanitizer-nul.sh <path-to-sensitive-data-sanitizer>
bin=${1:-sensitive-data-sanitizer}
token="ghp_$(printf 'x%.0s' $(seq 36))"
run() { "$bin" redact - --stream --allow-binary --credentials-only --max-bytes 4096; }
echo "version: $("$bin" --version)"
echo "NUL after token:";   printf 'line\000one %s\000two\n' "$token" | run | od -c | head -2
echo "space after token:"; printf 'one %s two\n' "$token" | run
