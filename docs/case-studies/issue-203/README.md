# Issue 203: one pull request for six open issues

The parent issue requires every requirement of issues 197–202 in PR 204,
including all comments, with individual `Fixes` references for all seven issues.
The issue snapshots and comments are saved under each issue's `data/` directory.
None contained comments at the initial read on 2026-10-10.

## Execution plan

1. Read all seven issues, the router 759 standard, PR conversation/reviews/inline
   comments, repository instructions, recent related PRs, and current workflows.
2. Preserve incident evidence and research primary documentation and reusable
   components. Reconstruct timelines and enumerate every requirement in the
   individual case studies, including implementation alternatives and decisions.
3. Write minimal failing regressions before changing behavior. Keep probes in
   `experiments/`, bounded in input size and resource use; save large test logs.
4. Draft independent changes in parallel as required by issue 197: Docker resume,
   log publication, and CI/parity. The primary agent integrates help, labels,
   shell semantics, shared option schemas, and final documentation. Drafting
   agents never push; the CI owner is the single push owner.
5. Implement JavaScript first, mirror every relevant path in Rust, and preserve
   existing recovery, resources, nested isolation, reporting, and release behavior.
6. Verify focused regressions, all local JavaScript checks/tests, behavior fixtures,
   workflow invariants and translation checks. Use bounded Rust checks when needed
   to verify the changed native implementation. Add both release fragments.
7. Review the entire diff, merge current main, commit useful atomic steps, update
   PR 204's title/body with reproduction, tests, limitations and all closing words.
8. The CI owner waits for previous runs, pushes the completed batch, lists recent
   runs with timestamps/SHA, downloads every failed job log to `ci-logs/`, fixes
   all failures together, and verifies a fully green final commit.
9. Check issue/PR comments again, the clean working tree and head SHA, branch
   protection, requirement coverage and feature preservation, then mark PR ready.

## Scope map

| Issue | Required result | Detailed evidence and requirement checklist |
| --- | --- | --- |
| 197 | JavaScript-first CI, behavior parity, translation boundaries, bounded Rust builds, agent/push rules, main protection, measurements | [Case study](../issue-197/README.md) |
| 198 | Copy-free Docker command resume; guarded, serialized legacy snapshots; cleanup and accurate hints | [Case study](../issue-198/README.md) |
| 199 | Repeated Docker labels, durable attribution and resume inheritance | [Case study](../issue-199/README.md) |
| 200 | Streaming, private, fail-closed sanitized uploads everywhere, explicit opt-out | [Case study](../issue-200/README.md) |
| 201 | Successful wrapper help in JavaScript and Rust, command help preserved | [Case study](../issue-201/README.md) |
| 202 | Preserve shell script/positional argv, compound command semantics and exit codes in every backend/display path | [Case study](../issue-202/README.md) |

## Initial observations

The prepared branch was `issue-203-b56519b4c758`, with a clean tree and only the
prepared placeholder commit beyond main. PR 204 was draft with no discussion or
reviews. Main branch protection returned HTTP 404 (`Branch not protected`).
The relevant source exists in both `js/` and `rust/`; none of these runtime fixes
can be considered complete by changing only one implementation.

## Final local verification

The stable implementation passed all 1,193 JavaScript tests across 76 files and
all 1,026 Rust tests across 53 suites. Two native experiments remain explicitly
ignored in the ordinary suite; the finite 110 MiB sanitizer experiment was run
separately under its memory limit. JavaScript lint, formatting, script checks
and the 1,000-line source limit passed. Rust formatting and all-target/all-feature Clippy with denied warnings passed. Complete passing
outputs are preserved in `data/local-js-passing.txt`,
`data/local-rust-passing.txt` and `data/local-checks-passing.txt`.

Real Docker evidence covers all twelve JS/Rust attached/detached shell cases
with matching stored exit codes, and a separate bounded resume/snapshot/cleanup
smoke. Main was freshly fetched and already an ancestor of this branch. Final
reads of all seven issue comment lists and all three PR comment/review endpoints
returned no additional requirements. Final same-SHA CI is recorded after the coordinated verification batch.
