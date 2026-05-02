#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
work_dir="${tmp_dir}/work"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

git init --initial-branch=main "${work_dir}" >/dev/null
git -C "${work_dir}" config user.name "smoke-test"
git -C "${work_dir}" config user.email "smoke-test@example.com"

mkdir -p "${work_dir}/scripts" "${work_dir}/js/.changeset"
cp "${repo_root}/scripts/validate-changeset.mjs" "${work_dir}/scripts/validate-changeset.mjs"

cat >"${work_dir}/js/.changeset/existing-on-main.md" <<'EOF'
---
'start-command': patch
---

Existing unreleased base-branch changeset.
EOF

git -C "${work_dir}" add -A
git -C "${work_dir}" commit -m "seed base changeset" >/dev/null
base_sha="$(git -C "${work_dir}" rev-parse HEAD)"

cat >"${work_dir}/js/.changeset/pr-change.md" <<'EOF'
---
'start-command': patch
---

Fix release automation changeset validation.
EOF

git -C "${work_dir}" add -A
git -C "${work_dir}" commit -m "add pr changeset" >/dev/null
head_sha="$(git -C "${work_dir}" rev-parse HEAD)"

(
  cd "${work_dir}"
  GITHUB_BASE_SHA="${base_sha}" \
    GITHUB_HEAD_SHA="${head_sha}" \
    node scripts/validate-changeset.mjs --working-dir js
)

echo "Changeset PR diff smoke test passed"
