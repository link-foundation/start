# Root Cause

Both argument parsers recognized only `--isolated`, `--isolated=<value>`, and
`-i` as isolation options. `--isolation` was not mapped to the same parser path.

With an explicit `--` separator, the parser split the invocation into wrapper
arguments and command arguments:

```bash
$ --isolation docker -- echo hi
```

Before the fix, `parseWrapperArgs()` called `parseOption()` for
`--isolation`, received `0` for "not recognized", and skipped it. The next
wrapper token, `docker`, was also skipped as a non-option. Validation then saw
no isolation request, so `echo hi` ran directly.

The same silent behavior existed for any unknown wrapper option before an
explicit separator:

```json
{
  "wrapperOptions": {
    "isolated": null
  },
  "command": "echo hi"
}
```

Without an explicit separator, the parsers also treated an unknown leading
dash-prefixed option as the beginning of the command. That made typos in wrapper
options dangerous because the intended execution condition could be dropped.

The root cause was therefore two related parser gaps:

1. Missing alias handling for `--isolation`.
2. Unknown wrapper options were recoverable fallthrough paths instead of
   validation errors.
