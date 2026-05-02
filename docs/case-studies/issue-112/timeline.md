# Timeline

1. Read issue #112 and confirmed there are no issue comments.
2. Reviewed PR #113 state and verified it was a draft placeholder for branch
   `issue-112-46af7527c0d9`.
3. Reviewed related work:
   - #69 exposed native isolation session/container names.
   - #102 added session-name lookup and detached lifecycle enrichment.
   - #104 improved detached logs and stable log paths.
   - #106/#107 added `currentTime` status enrichment in JS/Rust.
4. Inspected parser, CLI, execution store, isolation, and status formatter code
   in both JavaScript and Rust.
5. Confirmed the missing feature was not backend support itself, but the absence
   of a query/control mode that maps stored records to native backend commands.
6. Added reproducing parser/status/control tests for JS and Rust.
7. Added JS detached execution control helper and CLI dispatch.
8. Added Rust detached execution control helper and CLI dispatch.
9. Enriched `--status` and `--list` with best-effort `processIds`.
10. Updated usage text, README, changeset/changelog, and this case study.
