#!/usr/bin/env node
/**
 * Reproduces issue #120 by spawning `scripts/preflight-credentials.mjs`
 * with a fake `gh` on $PATH that mimics the *installation token* behaviour:
 *
 *   - `gh api user`   → exits non-zero with "Resource not accessible by
 *                       integration"  (this is what the real Actions runner
 *                       does for `secrets.GITHUB_TOKEN`).
 *   - `gh api repos/<owner>/<repo>` → exits 0 and prints the slug.
 *   - `gh auth status`             → exits 0.
 *
 * The OLD preflight calls `gh api user` and fails. The NEW preflight calls
 * `gh api repos/<owner>/<repo>` and passes. This experiment proves that the
 * fix in this PR resolves the regression captured in run 25282945820.
 *
 * Usage:
 *   node experiments/preflight-token-validation.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const preflight = join(repoRoot, "scripts", "preflight-credentials.mjs");

const sandboxBin = mkdtempSync(join(tmpdir(), "fake-gh-"));
const fakeGhPath = join(sandboxBin, "gh");

writeFileSync(
  fakeGhPath,
  `#!/usr/bin/env bash
# Fake \`gh\` mimicking an installation token (Actions GITHUB_TOKEN).
case "$*" in
  "api user --jq .login")
    echo "gh: Resource not accessible by integration (HTTP 403)" >&2
    exit 1
    ;;
  "api repos/"*" --jq .full_name")
    # Echo back the repo slug from the second arg, dropping "repos/".
    echo "\${2#repos/}"
    exit 0
    ;;
  "auth status")
    echo "github.com → fake installation token" >&2
    exit 0
    ;;
  *)
    echo "fake gh: unhandled args: $*" >&2
    exit 99
    ;;
esac
`,
);
chmodSync(fakeGhPath, 0o755);

function runPreflight() {
  return spawnSync(
    process.execPath,
    [preflight, "--require", "gh-token"],
    {
      env: {
        ...process.env,
        PATH: `${sandboxBin}:${process.env.PATH}`,
        GH_TOKEN: "fake-installation-token",
        GITHUB_REPOSITORY: "link-foundation/start",
      },
      encoding: "utf8",
    },
  );
}

const result = runPreflight();
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status !== 0) {
  console.error(`\n✗ preflight failed with exit ${result.status}`);
  process.exit(1);
}
console.log("\n✓ preflight succeeded against installation-token-style gh");
