# Root cause analysis — Issue #120

## RC-1 — `gh api user` is not callable with the workflow `GITHUB_TOKEN`

**Failing step (verbatim from `ci-logs/rust-25282945820.log`):**

```
##[group]Run node scripts/preflight-credentials.mjs \
  --require gh-token \
  --require crates-io
shell: /usr/bin/bash -e {0}
env:
  …
  GH_TOKEN: ***
  PREFLIGHT_PACKAGE_NAME: start-command
##[endgroup]
##[error]Preflight check failed (gh-token): `gh api user` rejected the token
(HTTP error or expired). Underlying: Command failed: gh api user --jq .login
❌ gh-token: `gh api user` rejected the token (HTTP error or expired).
   Underlying: Command failed: gh api user --jq .login
✅ crates-io: https://crates.io/api/v1/crates/start-command → HTTP 404
Preflight failed: 1 check(s) did not pass.
##[error]Process completed with exit code 1.
```

The same failure is in `ci-logs/js-25282945817.log` for the *Release* job.

**Why it fails:** the runner's job summary explicitly logs the token scope:

```
##[group]GITHUB_TOKEN Permissions
Contents: write
Metadata: read
##[endgroup]
```

`secrets.GITHUB_TOKEN` is the auto-minted **installation token** issued to the
GitHub Actions app. Installation tokens do **not** have a user identity, so
`GET /user` returns HTTP 403 with `"Resource not accessible by integration"`.
This is documented behaviour:

> The GITHUB_TOKEN secret is a GitHub App installation access token. […] You
> cannot access the GitHub REST API endpoints that require a user account.
> — *GitHub Docs, "Automatic token authentication"*, https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication

Personal access tokens (classic or fine-grained, on a user account) **do**
have a user identity, so `gh api user --jq .login` returns the username.
That is why this script appeared to work during development — the author's
local `gh` was authenticated with a PAT.

**Why this was not caught before merge:** `release` and `auto-release` are
gated on `github.event_name == 'push' && github.ref == 'refs/heads/main'`.
PR check runs never invoke them, so the preflight check ran for the first
time on the production token immediately after merging PR #119.

## RC-2 — Crates.io probe gives a misleading "OK" on HTTP 404

The same logs end the preflight with:

```
✅ crates-io: https://crates.io/api/v1/crates/start-command → HTTP 404
```

The crates-io check passes on **any** non-5xx response, including 404. That
is intentional for a *reachability* probe (DNS/HTTPS works) but the message
is misleading because it labels a 404 as success without explaining that
404 = "package not yet published, that's fine for first-release runs". The
fix in this PR adjusts the message so the 404 case is annotated explicitly,
without changing the pass/fail semantics. (Issue ##120 did not ask for this,
but it's a one-liner while we're in the file and would have shortened
debugging.)

## RC-3 — Release jobs do not surface the *credential check that should have
fired* for `npm-oidc` and `crates-io`

The `gh-token` step short-circuited so quickly that the operator never sees
which other credentials are or are not OK. After this fix, even when one
sub-check fails, the script runs every requested check before exiting —
already the existing behaviour, but worth recording as a deliberate property.

## What is *not* a root cause

- **Token rotation**: not the cause. The job log shows `GH_TOKEN: ***` was
  delivered to the step; only the `/user` call rejected it.
- **Network outage to api.github.com**: not the cause. The same job
  successfully fetched 50+ branches and 30+ tags via `actions/checkout`
  *before* the preflight ran.
- **Trusted publishing misconfiguration**: not the cause. The `npm-oidc`
  check was not even reached on the JS run; the `gh-token` failure aborted
  preflight first.
