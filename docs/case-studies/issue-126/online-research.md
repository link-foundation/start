# Online Research

Checked on 2026-05-12.

## Links Notation

The `link-foundation/links-notation` repository describes Links Notation as a
format for references and links, with support for nested structures and
indentation:

- https://github.com/link-foundation/links-notation

Relevant observation: the issue is about rendering an indented status view, so
the expected output should keep nested delimiters aligned with the surrounding
structure.

## `lino-objects-codec`

The Rust docs for `lino-objects-codec` describe it as an object encoder/decoder
for Links Notation and list support for common JSON-like types:

- https://docs.rs/lino-objects-codec/latest/lino_objects_codec/

Relevant observation: this dependency supports object serialization, but
`start-command` does not use it for the displayed `--status` formatter path
that produced the broken `commandPids` block.

## Version Checks

Commands used locally:

- `npm view command-stream version`: `0.9.4`
- `npm view lino-objects-codec version`: `0.4.0`
- `npm view @changesets/cli version`: `2.31.0`
- `npm view @eslint/js version`: `10.0.1`
- `npm view eslint version`: `10.3.0`
- `npm view eslint-plugin-prettier version`: `5.5.5`
- `npm view prettier version`: `3.8.3`
- `cargo search lino-objects-codec --limit 5`: `0.2.1`
- `cargo info dirs`: installed constraint was `5`, current latest is `6.0.0`

The JS lockfiles also use an override for `flatted` `^3.4.2` because `npm audit`
reported advisories for older transitive versions before the final lockfile
update.
