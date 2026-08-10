#!/usr/bin/env python3
"""One-off transformation that hardened .github/workflows/{js,rust}.yml for issue #158.

Kept for reproducibility of the diff. Re-running it on already-hardened
workflows is a no-op for every rule except the `always()` rewrite, which is
idempotent as well.

- drops workflow-level `concurrency` (it would also cancel started writers)
- adds top-level least-privilege `permissions: contents: read`
- adds GIT_CONFIG_* so `actions/checkout` stops emitting git-init hints
- gives every read-only job a cancellable `check-...` group and every job that
  writes to main the shared `main-writer-${{ github.repository }}-main` group
- rewrites `always() && !cancelled()` to plain `!cancelled()`
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CHECK_JOBS = {
    "js.yml": [
        ("syntax-check", None),
        ("detect-changes", None),
        ("version-check", None),
        ("changeset-check", None),
        ("lint", None),
        ("test", "${{ matrix.os }}"),
        ("coverage", None),
    ],
    "rust.yml": [
        ("syntax-check", None),
        ("detect-changes", None),
        ("version-check", None),
        ("changelog", None),
        ("lint", None),
        ("test", "${{ matrix.os }}"),
        ("test-parity", None),
        ("coverage", None),
        ("build", None),
    ],
}

WRITER_JOBS = {
    "js.yml": ["release", "instant-release", "changeset-pr"],
    "rust.yml": ["auto-release", "manual-release"],
}

GIT_CONFIG_ENV = """  # Silence the `hint: Using 'master' as the name for the initial branch`
  # block that `actions/checkout` printed 15 times in run 31380353470.
  GIT_CONFIG_COUNT: '1'
  GIT_CONFIG_KEY_0: init.defaultBranch
  GIT_CONFIG_VALUE_0: main
"""

PERMISSIONS_BLOCK = """# Least-privilege default; jobs that publish or push to main opt back in to
# `contents: write` individually.
permissions:
  contents: read

"""


def transform(path: Path) -> None:
    text = path.read_text()
    name = path.name

    # 1. Drop the workflow-level concurrency block, replacing it with the
    #    top-level permissions block in the same position.
    text = re.sub(
        r"concurrency:\n(?:  .*\n|\n(?=  ))*",
        PERMISSIONS_BLOCK,
        text,
        count=1,
    )

    # 2. Extend the top-level env block.
    text = text.replace(
        "  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n",
        "  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n" + GIT_CONFIG_ENV,
        1,
    )

    # 3. Per-job concurrency.
    for job, matrix_suffix in CHECK_JOBS[name]:
        suffix = job if matrix_suffix is None else f"{job}-{matrix_suffix}"
        block = (
            f"  {job}:\n"
            "    concurrency:\n"
            f"      group: check-${{{{ github.workflow }}}}-${{{{ github.ref }}}}-{suffix}\n"
            "      cancel-in-progress: true\n"
        )
        text = text.replace(f"  {job}:\n", block, 1)

    for job in WRITER_JOBS[name]:
        block = (
            f"  {job}:\n"
            "    # Shared with every other job that writes to main, including\n"
            "    # jobs in the other workflow file, so releases never race.\n"
            "    concurrency:\n"
            "      group: main-writer-${{ github.repository }}-main\n"
            "      cancel-in-progress: false\n"
        )
        text = text.replace(f"  {job}:\n", block, 1)

    # 4. `always() && !cancelled()` is just `!cancelled()`.
    text = text.replace("always() && !cancelled()", "!cancelled()")
    text = text.replace("always() &&\n      !cancelled() &&", "!cancelled() &&")

    path.write_text(text)
    print(f"transformed {path.relative_to(ROOT)}")


def main() -> int:
    for name in ("js.yml", "rust.yml"):
        transform(ROOT / ".github" / "workflows" / name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
