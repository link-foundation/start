---
bump: minor
---

Upgrade every crate to its latest release: `lino-objects-codec` 0.9.2, `dirs` 7, `sha2` 0.11, `chrono`, `regex`, `serde`, `serde_json`, `uuid`, `libc`, `tempfile`. CI now rejects pull requests whose `Cargo.lock` is behind (#253).

- **Store format:** the execution store is now written in lino-objects-codec 0.9's readable format. It is byte-identical to the JavaScript output. Older stores are still read, but older releases of start cannot read a store written by this one.
- **Links database:** the store had stayed empty, because clink 4.x rejected every query it sent. It now writes one record-scoped link per property and verifies the writes.
- **Sanitizer:** uploads require `sensitive-data-sanitizer` 0.12.1 or later. An older or missing CLI on PATH is upgraded or installed with bun or npm before the upload, so a NUL byte no longer blocks it (`--allow-binary`). The built-in `Authorization` masking pass is removed, because 0.12.1 masks only the scheme and token itself.
