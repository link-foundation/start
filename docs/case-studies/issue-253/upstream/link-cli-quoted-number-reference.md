## Summary

In a clink query, a quoted reference made only of digits is read as a link address, not as a name:

- `"1"` silently resolves to the link at address 1.
- `"0"` fails with `Cannot ensure unsupported link address 0`.
- `"99"` becomes a new link named `99` only while no link has address 99.

So the meaning of a quoted value depends on how many links the store has.

Found in link-foundation/start#253. start stores execution records in clink, and its values include exit codes and pids (`exitCode "0"`, `pid "12345"`). #112 fixed the `--out` side of numeric names, but the query parser still treats quoting as meaningless for digits.

## Reproduction

clink 4.0.2+7f5dc4b4fd76c4b09ea783db81f801cc757cb4fb (`dotnet tool install --global clink`), with a fresh database:

```sh
A=--auto-create-missing-references
clink '() ((a: a a) (b: b b))' $A --db q.links
clink '() ((p: x "1"))'  $A --changes --db q.links   # () ((p: x a))   <- address 1, not a name "1"
clink "() ((p2: x '2'))" $A --changes --db q.links   # () ((p2: x b))  <- address 2
clink '() ((p3: x "99"))' $A --changes --db q.links  # () ((p3: x 99)) and () ((99: 99 99))
clink '() ((z: x "0"))'  $A --changes --db q.links
# Error: Query error: Cannot ensure unsupported link address 0. Only non-zero internal references in the supported range can be created.
```

Script and recorded output: [experiments/issue-253/clink-queries.sh](https://github.com/link-foundation/start/blob/issue-253-480126f69838/experiments/issue-253/clink-queries.sh), [data/clink-queries-4.0.2.txt](https://github.com/link-foundation/start/blob/issue-253-480126f69838/docs/case-studies/issue-253/data/clink-queries-4.0.2.txt)

## Expected

A quoted reference is always a name: `"1"` creates or finds the link named `1`, and `"0"` is a valid name. An unquoted `1` keeps meaning the address. This is also the quoting #112 proposed for the `--out` writer, so the export would round-trip through queries too.

## Workaround in start

start stores each property as one string, `key=value` (`exitCode=0`), so no value is a bare number.
