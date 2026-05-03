#!/bin/bash
# Verify which gh API endpoints work with the GitHub Actions GITHUB_TOKEN.
# Run inside an Actions job or with a token that mimics the workflow scope.
echo "--- gh api user (should fail with GITHUB_TOKEN, fine with PAT) ---"
gh api user --jq .login || echo "FAILED"
echo "--- gh api meta (should always work) ---"
gh api meta --jq .verifiable_password_authentication || echo "FAILED"
echo "--- gh api repos/{owner}/{repo} (works with installation tokens) ---"
gh api "repos/${GITHUB_REPOSITORY:-link-foundation/start}" --jq .full_name || echo "FAILED"
