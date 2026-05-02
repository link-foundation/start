# Online research

Only primary documentation was used for CI/CD behavior and release mechanics.

## GitHub Actions outputs

Source: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions

The release scripts communicate `new_version`, `version_committed`, and
`already_released` to later workflow steps through the `GITHUB_OUTPUT`
environment file. The fix preserves this mechanism when adding Rust modes.

## GitHub Releases API

Source: https://docs.github.com/en/rest/releases/releases#create-a-release

The release creation script continues to create releases through `gh api` with a
JSON payload. Building the payload in JavaScript avoids shell-escaping release
note content.

## npm trusted publishing

Source: https://docs.npmjs.com/trusted-publishers

The JavaScript workflow already uses GitHub Actions OIDC permissions and an npm
setup step. The fix keeps that publish path intact and changes only the
post-publish release note source and badge formatting.

## shields.io static badges

Source: https://shields.io/badges/static-badge

Static badge path segments use delimiter characters, so helper code escapes
literal hyphens and underscores before interpolating version text into
`/badge/<label>-<message>-<color>.svg`. This matters for prerelease versions
such as `1.0.0-alpha.1`.
