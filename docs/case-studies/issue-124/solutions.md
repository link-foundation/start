# Solution Options And Selected Plan

## Option A: Documentation-Only Rewrite

Update stale prose and add better Docker examples.

Pros:

- Fast and low risk.
- Improves the immediate user-facing docs.

Cons:

- Does not prevent future drift.
- Does not verify output against real CLI behavior.

Decision: insufficient for issue #124 because the issue explicitly asked for
tested examples and output matching real output.

## Option B: Execute Every Documented Example In CI

Run every command exactly as written in all docs.

Pros:

- Strong validation.
- Catches environment assumptions early.

Cons:

- Docker box images can be large and unavailable in local or CI environments.
- Commands such as `--list` depend on local execution store state.
- Some docs include illustrative examples for remote SSH or user isolation that
  cannot be safely executed everywhere.

Decision: too brittle for the full documentation set.

## Option C: Manifest-Based Checked Examples

Create a manifest for examples that should be stable, verify their presence in
docs, execute stable direct commands, normalize dynamic output, and parser-check
examples that depend on Docker or local state.

Pros:

- Keeps the examples that matter under automated control.
- Verifies real CLI output where output should be deterministic.
- Keeps Docker examples useful without forcing large image pulls in CI.
- Can be extended one example at a time.

Cons:

- It covers selected examples, not every code block in the repository.
- Docker examples are parser-compatible checks rather than full container runs.

Decision: selected.

## Implemented Plan

1. Add `docs/examples/tested-examples.json` as the checked-example manifest.
2. Add `scripts/check-doc-examples.mjs` to verify references, parser behavior,
   and normalized direct-command output.
3. Add `docs/EXAMPLES.md` with documented output placeholders.
4. Add `examples/docker-isolation-box.sh` for local box-based Docker examples.
5. Update README, package READMEs, requirements, architecture docs, and
   JavaScript help text.
6. Wire JavaScript and Rust CI workflows to run the documentation checker on
   Linux and to start for docs/example changes.
