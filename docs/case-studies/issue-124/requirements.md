# Requirements

Source: issue #124 body collected in `issue-data.json`.

## R1: Sync Docs With Codebase

Audit user-facing docs, requirements, architecture notes, and CLI help output
against current JavaScript and Rust behavior.

Status: addressed by updating Docker image wording, supported backends, coverage
thresholds, architecture Docker lifecycle notes, and package README usage
examples.

## R2: Use `link-foundation/box` For Docker Isolation Examples

Add Docker isolation examples that use `link-foundation/box` images and are
useful for AI coding or experiments.

Status: addressed with examples for `ghcr.io/link-foundation/box-js:latest` and
`ghcr.io/link-foundation/box:latest` in the main README, `docs/EXAMPLES.md`, and
`examples/docker-isolation-box.sh`.

## R3: Test Documented Examples

Examples in docs should be covered by tests so documentation cannot drift from
the actual CLI behavior.

Status: addressed with `docs/examples/tested-examples.json` and
`scripts/check-doc-examples.mjs`. CI now runs the checker for JavaScript and Rust
direct-command output on Linux, and parser-checks Docker/status examples that
depend on local Docker or local execution store state.

## R4: Match Real Command Output

Documented command output should match real output.

Status: addressed for the direct command timeline output. The checker executes
both implementations, normalizes UUIDs, timestamps, durations, and log paths,
and compares the result with the documented output.

## R5: Collect Issue Data In Case Study Folder

Collect issue-related data in `docs/case-studies/issue-124`.

Status: addressed with raw issue, comment, PR, code search, PR search, and
`link-foundation/box` repository data files.

## R6: Search Online For Additional Facts And Data

Use external sources and known existing components/libraries to guide the
solution.

Status: addressed in `online-research.md`, using Docker documentation, GNU
Screen documentation, tmux documentation, Bun documentation,
`link-foundation/box`, and Sysbox documentation referenced by box for Docker in
Docker use cases.

## R7: Propose Possible Solutions And Plans

List possible solutions and plan how each requirement can be addressed.

Status: addressed in `solutions.md`.
