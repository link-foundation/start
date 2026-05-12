# Root Cause

## Broken delimiter indentation

JavaScript status output formats non-`options` objects through
`formatAsNestedLinksNotation(value, 2, 2)`. The array branch returned:

```text
(
        667121
      )
```

The opening delimiter did not include the calculated block indentation, so it
started at column 1. Nested array items and the closing delimiter were indented
relative to depth, which made only the opening delimiter visibly wrong.

## Rust parity gap

Rust had separate Links Notation appenders for status/control output. Those
appenders treated arrays as complex scalar values through
`format_value_for_links_notation`, producing quoted JSON such as:

```text
commandPids [667121,667122]
```

That did not match the JavaScript default status output or the expected
multi-line Links Notation shape in the issue.

## Dependency assessment

The storage codecs are not on the failing output path. `lino-objects-codec` is
used for persisted `.lino` execution records, while the displayed `--status`
Links Notation is hand-formatted in `status-formatter` and `output-blocks`.

No upstream issue was filed because the root cause and workaround are local.
There is still an architectural opportunity to move this display formatting to
a shared Links Notation formatter dependency later, but the current issue does
not demonstrate a dependency bug.
