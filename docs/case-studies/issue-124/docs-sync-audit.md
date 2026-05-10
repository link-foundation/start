# Docs Sync Audit

## Findings And Fixes

| Area                | Finding                                                                  | Fix                                                                                  |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Root README         | Docker table said `--image` was required.                                | Updated to say Docker uses an OS-matched default image unless `--image` is provided. |
| Root README         | Docker example used only a generic Bun image.                            | Added default-image, `box-js`, and full `box` examples.                              |
| Root README         | Usage examples did not include the checked `echo "Hello World"` example. | Added the checked example and linked `docs/EXAMPLES.md`.                             |
| JavaScript README   | Usage examples used `npm test` as the package-level example.             | Switched package development examples to Bun and linked checked examples.            |
| Rust README         | Usage examples did not include the checked direct command.               | Added `start echo "Hello World"` and linked checked examples.                        |
| JavaScript CLI help | `--image` was described as required.                                     | Updated help text to optional/default behavior and added box Docker example.         |
| Requirements        | Docker backend and coverage thresholds were stale.                       | Updated Docker, SSH, coverage, test-count, and documented-example requirements.      |
| Architecture        | Docker flow still showed unconditional `--rm`.                           | Updated Docker lifecycle notes to match preserved container filesystem by default.   |
| CI path filters     | Docs-only changes did not start workflows.                               | Added top-level docs, `docs/**`, and `examples/**` to JS and Rust workflow paths.    |

## Still Intentional

- Some tests and historical case studies still contain `npm test` because they
  verify command parsing, shell wrapping, or preserve old issue data. Those are
  not package development recommendations.
- Docker examples in CI are parser-checked rather than executed with
  `link-foundation/box`, because pulling large images and depending on Docker
  availability would make documentation validation slow and flaky.
