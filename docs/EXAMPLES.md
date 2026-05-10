# Tested Examples

This page contains the examples that are checked by
`scripts/check-doc-examples.mjs`. Dynamic values in command output are shown as
placeholders: `<uuid>`, `<timestamp>`, `<duration>`, and `<log-path>`.

## Direct Command Logging

JavaScript package:

```bash
$ echo "Hello World"
```

Rust crate:

```bash
start echo "Hello World"
```

Normalized output for both implementations:

```text
│ session   <uuid>
│ start     <timestamp>
│
$ echo Hello World

Hello World

✓
│ finish    <timestamp>
│ duration  <duration>
│ exit      0
│
│ log       <log-path>
│ session   <uuid>
```

## Docker Isolation

Use the default OS-matched image when you only need a shell-compatible
container:

```bash
$ --isolated docker -- echo "hello from docker"
```

Use the `link-foundation/box` images when an AI coding experiment needs a
preloaded development environment. The `box-js` image is the smallest match for
JavaScript/Bun workflows:

```bash
$ --isolated docker --image ghcr.io/link-foundation/box-js:latest -- bun --version
```

Use the full box when the command needs multiple language runtimes:

```bash
$ --isolated docker --image ghcr.io/link-foundation/box:latest -- bash -lc 'node --version && python --version && rustc --version'
```

`box-dind` images contain a Docker daemon, but they need elevated Docker runtime
configuration. Use plain Docker for those containers unless `start-command`
gains Docker runtime flag support.

## Execution Store Query

```bash
$ --list --output-format json
```

The exact output depends on the local execution store, so the documentation
check verifies parser compatibility rather than a fixed output body.
