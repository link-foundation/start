# Repository workflow

Follow [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

JavaScript defines public behavior first. Keep Rust implementation or behavioral-test evidence in the same feature change and update `parity/features.json`. Run JavaScript checks locally by default; the successful JavaScript stage opens the same-commit Rust CI stage.

During multi-agent work, drafting agents never push. Exactly one designated CI/CD agent owns `git push`, waits for all drafts, downloads every failure from the completed latest run, coordinates all corrections and makes one bulk push. It must not push while a previous run on those branch commits is queued or in progress. Never cancel main or a started gated Rust stage.

Translate supported code with the pinned meta-language generator and verify regeneration produces no diff. Unsupported hand-written Rust must stay explicitly inventoried with actual construct evidence and upstream blocker issues. Use one bounded shared Cargo target only when Rust diagnosis is necessary; do not launch competing local builds.
