# JavaScript-first collaboration

Implement public behavior in JavaScript first, then maintain Rust evidence in the same change. `parity/features.json` inventories every runtime source file and its behavioral tests. Update the feature entry when adding modules, and extend the shared contracts when CLI parsing, isolation arguments, status output or records change. Test counts are a secondary diagnostic, never proof of behavioral equivalence.

For multi-agent issue work, appoint one CI/CD agent as the only owner of `git push`. Drafting agents may investigate, edit and commit coherent steps; they never push. Send completed drafts and local results to the owner. The owner waits for every draft, collects **all** failures from the latest completed run, assigns a bulk correction, and pushes once when all corrections are complete. Never push while earlier runs for the same branch/commits remain queued or in progress. Preserve commit history and raw CI logs; do not replace repeated timeouts with longer timeouts without tracing their cause.

Run JavaScript checks locally by default (`cd js && bun run check && bun run test`). CI runs Rust only after the entire JavaScript stage succeeds on the same commit. A failed, cancelled or skipped required JavaScript job keeps Rust closed. Do not add standalone Cargo, Rust CodeQL or Rust reusable-workflow callers. The workflow guard checks every workflow, including new files.

Rust remains manual only for the explicit per-file/per-construct blockers listed in the manifest and [translation analysis](docs/case-studies/issue-197/translation.md). Generate supported policy code with `node scripts/setup-translation.mjs` and `bun scripts/generate-rust.mjs`; verify with `--check`. Never count carried source comments as executable generated Rust.

If a focused Rust investigation is necessary, use the shared bounded target described in [CONTRIBUTING.md](CONTRIBUTING.md), rather than starting independent compile trees in drafting agents. Keep finite reproduction scripts under `experiments/` and real use-case examples under `examples/`.

Work on the prepared pull-request branch, preserve unrelated changes, and use pull requests for default-branch changes. The CI owner checks the final diff, a clean worktree, current main ancestry, every required check and the complete issue requirements before marking a draft ready.
