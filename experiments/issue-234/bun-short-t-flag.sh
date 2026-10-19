#!/usr/bin/env bash
# Is bun's `-t` a timeout or a test-name pattern? (issue #234)
# scripts/run-js-tests.mjs treated `-t` as "timeout already given" and dropped
# its 30s default, so `-t <pattern>` ran with bun's 5s default instead.
set -u
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cat > "$dir/t.test.js" <<'JS'
import { test } from 'bun:test';
test('slow six seconds', async () => { await Bun.sleep(6000); });
test('other', () => {});
JS
cd "$dir"
bun --version
echo "--- bun test -t slow (bun default timeout):"
bun test -t slow 2>&1 | grep -E 'pass|fail|timed out|filtered' | head
echo "--- node run-js-tests applyDefaultTimeout(['-t','slow']):"
node -e "import('$OLDPWD/scripts/run-js-tests.mjs').then(m => console.log(JSON.stringify(m.applyDefaultTimeout(['-t','slow']))))"
