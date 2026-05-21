# Online And Repository Research

## gh-upload-log Package

- Repository: <https://github.com/link-foundation/gh-upload-log>
- npm package: <https://www.npmjs.com/package/gh-upload-log>
- Collected metadata shows latest version `0.8.0`, published as the `latest`
  npm dist-tag, with a `gh-upload-log` binary entry.
- The repository describes the tool as a log uploader for GitHub. That matches
  the issue's requested integration point.

## GitHub Gist Behavior

- GitHub CLI documentation for `gh gist create` says the command creates secret
  gists by default and uses `--public` for public gists:
  <https://cli.github.com/manual/gh_gist_create>
- GitHub's gist documentation distinguishes public and secret gists and notes
  that secret gists are reachable by URL:
  <https://docs.github.com/articles/creating-gists>

## Relevant Existing Components

- `ExecutionStore.get(identifier)` already supports UUID lookup and fallback to
  `options.sessionName`.
- `--status` already exposes `logPath`, proving the data is stored in execution
  records.
- Existing failure reporting already knows about `gh-upload-log`, but it only
  used the uploader opportunistically when installed. The new manual command
  adds on-demand installation because that is explicitly required for
  `--upload-log`.

## Related PR Style

Recent merged PRs show this repository keeps issue-specific case studies,
targeted regression tests, and release fragments in the same PR. See
[data/recent-merged-prs.json](data/recent-merged-prs.json).
