# Issue #124 Case Study: Make Docs Better

Issue: https://github.com/link-foundation/start/issues/124

Pull request: https://github.com/link-foundation/start/pull/125

## Summary

Issue #124 asked for a documentation sync pass, Docker isolation examples based
on `link-foundation/box`, tested examples whose output matches real command
output, and a case-study folder containing issue data plus analysis.

The main code/documentation drift found during the audit was Docker image
handling. Both implementations already assign a default OS-matched Docker image
when `--isolated docker` is used without `--image`, but several docs and the
JavaScript help text still described `--image` as required.

This case study records the requirements, raw GitHub data, related research,
root cause, solution options, and the implemented plan.

## Files

- `issue-data.json`: raw issue metadata and body collected with GitHub CLI.
- `issue-comments.json`: raw issue comments collected with GitHub CLI.
- `pr-125.json`: raw prepared PR metadata.
- `data/`: supporting GitHub searches and `link-foundation/box` repository data.
- `requirements.md`: all issue requirements mapped to implementation work.
- `timeline.md`: issue and implementation timeline.
- `root-cause.md`: why the docs drifted and why examples were not checked.
- `online-research.md`: external sources and facts used for Docker examples.
- `docs-sync-audit.md`: stale documentation findings and fixes.
- `solutions.md`: considered solution plans and selected plan.
