---
bump: minor
---

Require and install sensitive-data-sanitizer ^0.22.5, adopting the 0.22.x output
for published logs and issue text: Authorization schemes and URL usernames
remain visible while their secrets become [REDACTED]. Preserve NUL bytes and
following text in both paths with --allow-binary, including the upstream 0.22.4
fix for truncated logs (#267).
