"""Reproduce the JavaScript-first workflow migration without rewriting YAML style."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
directory = root / ".github/workflows"
for path in directory.glob("*.yml"):
    text = path.read_text().replace("cancel-in-progress: true", "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}")
    path.write_text(text)

js = (directory / "js.yml").read_text()
js = re.sub(r"    paths:\n(?:      - .*\n)+", "", js)
js = re.sub(r"(  lint:\n.*?    needs: \[detect-changes\]\n)    if: \|\n.*?(?=    steps:)", r"\1    if: ${{ !cancelled() }}\n", js, flags=re.S)
parity = """  # Behavioral parity and generated Rust are checked before any Rust tooling.
  parity:
    name: Behavioral Parity and Translation
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency:
      group: check-js-parity-${{ github.ref }}
      cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: '24.x'
      - uses: oven-sh/setup-bun@0c5075e804ab39b94bc4cea7bf9f6b7de4e7e0c88 # v2
      - name: Check the JavaScript gate across every workflow
        run: bun scripts/check-javascript-first.mjs
      - name: Verify per-feature evidence and changes in both languages
        env:
          PARITY_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}
        run: node scripts/check-feature-parity.mjs
      - name: Prepare pinned meta-language translation tooling
        run: node scripts/setup-translation.mjs
      - name: Regenerate Rust and compare exact output
        run: node scripts/generate-rust.mjs --check
      - name: Check shared JavaScript golden contracts
        run: bun test ./js/test/shared-golden.js ./js/test/javascript-first-ci.js

"""
# Use the existing pinned Bun action rather than introducing a new mutable ref.
bun_ref = re.search(r"uses: (oven-sh/setup-bun@\S+)", js).group(1)
parity = re.sub(r"oven-sh/setup-bun@\S+ # v2", bun_ref, parity)
js = js.replace("  # === PIPELINE STATUS ===", parity + "  # === PIPELINE STATUS ===")
js = js.replace("    name: Pipeline Status", "    name: JavaScript Stage")
js = js.replace("      - coverage\n      - release", "      - coverage\n      - parity\n      - release")
js = js.replace("run: bash scripts/check-pipeline-status.sh", "run: node scripts/check-stage-status.mjs --required syntax-check,lint,test,coverage,parity")
js += """
  # Same checkout SHA and event context; skipped/failed/cancelled JS never calls Rust.
  rust-stage:
    name: Rust CI/CD
    needs: [pipeline-status]
    if: ${{ !cancelled() && needs.pipeline-status.result == 'success' }}
    uses: ./.github/workflows/rust.yml
    permissions:
      contents: write
      actions: read
      security-events: write
    secrets: inherit
    concurrency:
      group: check-rust-stage-${{ github.ref }}
      cancel-in-progress: false
    with:
      release_mode: ${{ inputs.release_mode || 'instant' }}
      bump_type: ${{ inputs.bump_type || 'patch' }}
      description: ${{ inputs.description || '' }}
"""
(directory / "js.yml").write_text(js)

rust = (directory / "rust.yml").read_text()
rust = re.sub(r"on:\n.*?(?=# Least-privilege)", """# Only the JavaScript workflow calls this after its complete successful stage.
# A relative reusable-workflow call uses exactly the caller's commit and event.
on:
  workflow_call:
    inputs:
      release_mode:
        type: string
        default: instant
      bump_type:
        type: string
        default: patch
      description:
        type: string
        default: ''

""", rust, flags=re.S)
rust = rust.replace("CARGO_TERM_COLOR: always", "CARGO_TERM_COLOR: always\n  CARGO_INCREMENTAL: '0'\n  CARGO_BUILD_JOBS: '2'")
# Called workflows inherit github.workflow: separate names prevent concurrency collisions.
rust = rust.replace("check-${{ github.workflow }}-", "check-rust-")
rust = rust.replace("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}", "cancel-in-progress: false")
# Never carry compiled target artifacts between cache generations.
rust = rust.replace("            rust/target\n", "")
rust = re.sub(r"          restore-keys: \|\n(?:            .*\n)+", "", rust)
rust = rust.replace("${{ hashFiles('rust/Cargo.lock') }}", "${{ hashFiles('rust/Cargo.lock', 'rust/Cargo.toml') }}")
rust = re.sub(r"(  lint:\n.*?    needs: \[detect-changes\]\n)    if: \|\n.*?(?=    steps:)", r"\1    if: ${{ !cancelled() }}\n", rust, flags=re.S)
rust = rust.replace("    if: ${{ !cancelled() && (github.event_name == 'push' || github.event_name == 'workflow_dispatch' || needs.detect-changes.outputs.any-rust-code-changed == 'true') }}\n", "")
rust = rust.replace("      - name: Check Rust/JS test count parity\n", """      - name: Verify per-feature evidence
        run: node scripts/check-feature-parity.mjs --manifest-only

      - name: Check Rust/JS test count parity (secondary signal)
""")
rust = rust.replace("github.event_name == 'push' && needs.lint.result", "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && needs.lint.result")
rust = rust.replace("github.event_name == 'workflow_dispatch' &&\n      needs.build.result", "github.event_name == 'workflow_dispatch' &&\n      inputs.release_mode == 'instant' &&\n      needs.build.result")
rust = rust.replace("${{ github.event.inputs.bump_type }}", "${{ inputs.bump_type }}").replace("${{ github.event.inputs.description }}", "${{ inputs.description }}")
rust = rust.replace("    name: Pipeline Status", "    name: Rust Stage")
rust = rust.replace("      - manual-release\n", "      - manual-release\n      - cargo-audit\n      - rust-codeql\n")
rust = rust.replace("run: bash scripts/check-pipeline-status.sh", "run: node scripts/check-stage-status.mjs --required syntax-check,lint,test,test-parity,coverage,cargo-audit,rust-codeql")

security = (directory / "security.yml").read_text()
cargo = re.search(r"  cargo-audit:\n.*?(?=  npm-audit:)", security, re.S).group(0)
security = security.replace(cargo, "")
cargo = cargo.replace("check-${{ github.workflow }}-", "check-rust-").replace("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}", "cancel-in-progress: false")
codeql = re.search(r"  codeql:\n.*?(?=  dependency-review:)", security, re.S).group(0)
rust_codeql = codeql.replace("  codeql:", "  rust-codeql:").replace("CodeQL (${{ matrix.language }})", "CodeQL (Rust)")
rust_codeql = re.sub(r"    strategy:\n.*?(?=    steps:)", "", rust_codeql, flags=re.S)
rust_codeql = rust_codeql.replace("${{ matrix.language }}", "rust").replace("check-${{ github.workflow }}-", "check-rust-")
rust_codeql = rust_codeql.replace("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}", "cancel-in-progress: false")
security = security.replace("[javascript-typescript, actions, rust]", "[javascript-typescript, actions]")
security = security.replace("[cargo-audit, npm-audit, codeql, dependency-review, secrets-scan]", "[npm-audit, codeql, dependency-review, secrets-scan]")
rust = rust.replace("  # === PIPELINE STATUS ===", cargo + rust_codeql + "  # === PIPELINE STATUS ===")
(directory / "rust.yml").write_text(rust)
(directory / "security.yml").write_text(security)
