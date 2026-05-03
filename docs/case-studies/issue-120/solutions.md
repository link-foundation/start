# Solution plan — Issue #120

## Fix

Replace the `/user` validation in `scripts/preflight-credentials.mjs` with a
call that succeeds for both kinds of token Actions can carry:

- the auto-issued installation `GITHUB_TOKEN` (no user identity), and
- a personal access token, classic or fine-grained.

The chosen replacement is `gh api repos/{owner}/{repo}` because:

- It returns 200 for **any** token with at least `metadata: read` on the
  current repo. The Actions runner's job summary literally tells us this is
  granted: `Metadata: read`.
- It does not require `id-token`, `pull-requests`, `contents:write`, or any
  other elevated scope; we are only verifying that the token is alive and
  pointed at the right repo.
- It returns the token *kind* implicitly via the `permissions` field of the
  response (`{"admin": true, "push": true, "pull": true}` for write-capable
  tokens, smaller subset for read-only) — useful for future debugging.
- `${{ github.repository }}` is always present; no extra wiring is needed.

When the env var `GITHUB_REPOSITORY` is missing (e.g. running the script
locally outside a runner) the script falls back to a `gh auth status`
sanity check, which works for any locally configured `gh` install.

## Why not `/installation/repositories`, `/rate_limit`, or `/octocat`?

| Endpoint | Verifies token is valid | Verifies it can hit *this* repo | Notes |
|---|:--:|:--:|---|
| `/user` | only for PATs | no | the bug we're fixing |
| `/octocat` | only for authenticated requests | no | unauthenticated 200 too — no signal |
| `/rate_limit` | yes | no | useful but doesn't catch wrong-repo tokens |
| `/installation/repositories` | only for app/installation tokens | yes-ish | breaks for PATs |
| **`/repos/{owner}/{repo}`** | yes (any token) | yes | chosen |

## Code change

In `scripts/preflight-credentials.mjs`, the `checkGhToken` function is
rewritten to:

```js
function checkGhToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) { fail("gh-token", "…"); return; }

  const repository = process.env.GITHUB_REPOSITORY;
  const probeArgs = repository
    ? ["api", `repos/${repository}`, "--jq", ".full_name"]
    : ["auth", "status"];

  try {
    execFileSync("gh", probeArgs, { stdio: ["ignore", "pipe", "pipe"], … });
    logCheck("gh-token", "ok", repository
      ? `authenticated for ${repository}`
      : "authenticated (gh auth status)");
  } catch (error) {
    fail("gh-token", `\`gh ${probeArgs.join(" ")}\` rejected the token. …`);
  }
}
```

Note: switched from `execSync` to `execFileSync` so the repository slug is
passed as a literal arg, not interpolated into a shell string. `repository`
in `${{ github.repository }}` is `owner/repo` which is shell-safe, but using
`execFileSync` removes the foot-gun for any future change.

## Prior art

We surveyed three published patterns before settling on the one above:

1. **`actions/github-script@v8` `with: { script: 'await github.rest.repos.get(…)' }`** —
   functionally identical, but pulls in a 12 MB action just to do an
   authenticated GET. Not justified.
2. **`gh secret list` / `gh repo view`** — both work but `gh repo view`
   shells out to the same `repos/{owner}/{repo}` underneath; we removed the
   indirection.
3. **`actions-ecosystem/action-validate-token`** — a third-party action
   that wraps `gh api user`. Same bug as ours; not adopted.

Sources consulted:

- GitHub Docs, *"Automatic token authentication"*:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
- GitHub Docs, *"Permissions for the GITHUB_TOKEN"*:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#permissions-for-the-github_token
- GitHub REST API reference, *"Get a repository"*:
  https://docs.github.com/en/rest/repos/repos#get-a-repository

## Future work (not in this PR)

### F-1 — Dry-run release on PRs

A separate PR-only job that *parses* the release config but stops short of
publishing would have caught this regression on PR #119 itself. The shape
would be:

- Trigger: `pull_request` events that touch any of
  `scripts/preflight-credentials.mjs`, `scripts/version-and-commit.mjs`,
  `scripts/publish-to-npm.mjs`, `scripts/create-github-release.mjs`,
  `.github/workflows/{js,rust}.yml`.
- Steps: run the preflight in `--dry-run` mode (skip the actual push/publish
  but exercise every credential check). Fail the check on any real
  failure.

This is recorded for follow-up in this PR's description.

### F-2 — Post-condition assertion on the version bump

`verify-release-badge.mjs` already checks the *result* of the release (the
badge made it into the GitHub release body). We should mirror that idea on
the version step: after `version-and-commit.mjs` runs, query the npm /
crates.io registry and assert the new version is exactly one ahead of the
last published version. Not in scope here.
