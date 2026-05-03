# Case Study — Issue #120: We need to fix CI/CD fully

- Issue: https://github.com/link-foundation/start/issues/120
- Pull Request: https://github.com/link-foundation/start/pull/121
- Failing runs cited in the issue:
  - Rust CI/CD: https://github.com/link-foundation/start/actions/runs/25282945820 (job 74123130954)
  - JavaScript CI/CD: https://github.com/link-foundation/start/actions/runs/25282945817 (job 74123037678)

## Documents in this folder

| File | Purpose |
|---|---|
| `timeline.md` | What happened, in order, and which commits introduced the regression. |
| `requirements.md` | Each explicit and implicit ask in issue #120, and how it is addressed. |
| `root-cause.md` | Why the failing runs failed (with quoted log lines). |
| `solutions.md` | Concrete fix in this PR plus alternatives that were considered. |
| `comparison-with-templates.md` | Diff against `link-foundation/*-pipeline-template` and `link-assistant/hive-mind`. |
| `ci-logs/` | Raw `gh run view --log-failed` dumps preserved for offline analysis. |
| `recent-runs.json` | Snapshot of `gh run list` at the time the case study was authored. |
| `issue-data.json` | Snapshot of the issue metadata (title, author, created-at). |

## TL;DR

The release jobs in both workflows fail at the **Preflight credential checks**
step with:

```
::error::Preflight check failed (gh-token): `gh api user` rejected the token
(HTTP error or expired). Underlying: Command failed: gh api user --jq .login
```

Root cause: `scripts/preflight-credentials.mjs` validates the token by calling
`gh api user`. That endpoint requires a **user** identity. The auto-issued
`secrets.GITHUB_TOKEN` is an **installation** token without a user identity —
calling `/user` returns HTTP 403 ("Resource not accessible by integration").
Personal access tokens happen to work, which is why the script passed every
sanity-test the author ran locally and on PR runs (which used a different code
path).

Fix: validate the token using an endpoint that works for both PATs and the
installation token issued to GitHub Actions — `gh api repos/{owner}/{repo}` is
both reachable and authenticated for any token that has at least
`metadata: read`, which the workflow already grants.

The issue also asks us to compare against the upstream pipeline templates and
adopt anything missing. The comparison is in
[`comparison-with-templates.md`](./comparison-with-templates.md). Two
template-shaped follow-ups are reported upstream — see that file for the
issue links.
