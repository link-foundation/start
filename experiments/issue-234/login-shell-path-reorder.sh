#!/usr/bin/env bash
# Reproduce on Linux what macOS does to js/test/npm-publish.mjs (issue #234).
# command-stream runs every command as `/bin/sh -l -c`; a login shell reads
# /etc/profile, where macOS runs path_helper and puts the system directories
# (/usr/local/bin holds the real npm) before the caller's PATH entries. Here a
# $HOME/.profile does the same reordering: the directory of the real npm goes
# first, so a test that relies on PATH order runs the real npm.
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
real_npm_dir=$(dirname "$(command -v npm)")
printf 'PATH="%s:$PATH"; export PATH\n' "$real_npm_dir" > "$home/.profile"
echo "login profile: $(cat "$home/.profile")"
echo "PATH seen by /bin/sh -l: $(HOME=$home PATH="/fake-first:$PATH" /bin/sh -l -c 'echo "$PATH"' | cut -c1-80)..."
cd "$repo/js" && HOME=$home bun test ./test/npm-publish.mjs 2>&1 | grep -E '^\((pass|fail)\)| pass$| fail$'
