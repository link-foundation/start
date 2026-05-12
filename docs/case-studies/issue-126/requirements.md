# Requirements

Source: issue #126 body, captured on 2026-05-12.

1. Fix the `commandPids` formatting so the opening `(` is indented under the
   `commandPids` key.
2. Preserve the surrounding status output structure and field content.
3. Check dependency versions and update to current releases where practical.
4. If the root cause is in a dependency, report an upstream issue with a
   reproducer and workaround.
5. If local code contains Links Notation logic that belongs in dependencies,
   evaluate whether an upstream issue is appropriate.
6. Download issue and related data into `docs/case-studies/issue-126`.
7. Reconstruct the timeline and root cause.
8. Propose solution options and implement the selected fix in one pull request.
9. Add diagnostics or tests sufficient to catch recurrence.

No screenshots or image attachments were present in the issue or PR comments.
