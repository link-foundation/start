# Online And Repository Research

## CLI Option Conventions

- GNU libc's argument syntax conventions describe dash-prefixed arguments as
  options and `--` as the terminator after which following arguments are treated
  as non-options, even when they begin with a hyphen:
  <https://sourceware.org/glibc/manual/2.22/html_node/Argument-Syntax.html>
- This supports the selected behavior: unknown dash-prefixed wrapper tokens are
  treated as wrapper option errors, while the explicit separator remains the
  escape hatch for dash-prefixed commands.

## Alias Patterns

- The Rust `clap` parser exposes long-option aliases and visible aliases as
  first-class concepts:
  <https://docs.rs/clap/latest/clap/struct.Arg.html#method.visible_alias>
- `start-command` uses custom parsers rather than `clap` or a JavaScript parser
  library, so the equivalent alias support was implemented directly in both
  parser branches.

## Repository Research

- `data/code-search-isolation.json` showed no existing repository support for
  the requested `--isolation` spelling before this fix.
- `data/code-search-isolated.json` showed the existing `--isolated` parser,
  docs, and tests that the alias needed to match.
- `data/recent-isolation-prs.json` highlighted prior isolation parser work,
  especially PR #78 for isolation stacking and PR #129 for case-study and
  release-metadata style.

## Existing Components Used

- JavaScript: `js/src/lib/args-parser.js` already centralized wrapper option
  parsing and validation.
- Rust: `rust/src/lib/args_parser.rs` already mirrored the JavaScript parser for
  the Rust CLI.
- Existing parser test files provided the narrowest regression surface:
  `js/test/args-parser.js` and `rust/tests/args_parser.rs`.
