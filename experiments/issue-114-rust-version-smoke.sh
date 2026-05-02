#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
remote_dir="${tmp_dir}/remote.git"
work_dir="${tmp_dir}/work"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

git init --bare "${remote_dir}" >/dev/null
git init "${work_dir}" >/dev/null
git -C "${work_dir}" checkout -b main >/dev/null
git -C "${work_dir}" config user.name "smoke-test"
git -C "${work_dir}" config user.email "smoke-test@example.com"

mkdir -p "${work_dir}/scripts" "${work_dir}/rust/changelog.d"
cp "${repo_root}/scripts/version-and-commit.mjs" "${work_dir}/scripts/version-and-commit.mjs"

cat >"${work_dir}/rust/Cargo.toml" <<'EOF'
[package]
name = "start-command"
version = "0.1.0"
edition = "2021"
EOF

cat >"${work_dir}/rust/changelog.d/114.md" <<'EOF'
---
bump: patch
---

Fix Rust release automation smoke test.
EOF

git -C "${work_dir}" add -A
git -C "${work_dir}" commit -m "seed" >/dev/null
git -C "${work_dir}" remote add origin "${remote_dir}"
git -C "${work_dir}" push -u origin main >/dev/null

(
  cd "${work_dir}"
  node scripts/version-and-commit.mjs \
    --mode changelog \
    --working-dir rust \
    --bump-type patch
)

grep -q 'version = "0.1.1"' "${work_dir}/rust/Cargo.toml"
grep -q '## \[0.1.1\]' "${work_dir}/rust/CHANGELOG.md"
test ! -f "${work_dir}/rust/changelog.d/114.md"
git -C "${work_dir}" ls-remote --exit-code --heads origin main >/dev/null

(
  cd "${work_dir}"
  node scripts/version-and-commit.mjs \
    --mode manual \
    --working-dir rust \
    --bump-type minor \
    --description "Manual Rust smoke release."
)

grep -q 'version = "0.2.0"' "${work_dir}/rust/Cargo.toml"
grep -q '## \[0.2.0\]' "${work_dir}/rust/CHANGELOG.md"
grep -q 'Manual Rust smoke release.' "${work_dir}/rust/CHANGELOG.md"

echo "Rust changelog and manual mode smoke tests passed"
