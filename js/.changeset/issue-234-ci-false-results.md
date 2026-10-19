---
'start-command': patch
---

CI/CD no longer reports false results (#234). A rejected `npm publish` or any failing release command now fails the release instead of printing success, and the published version is confirmed on the registry. A release push that loses the race for `main` is rebased and retried. Releases wait for every check their stage requires. A failing Rust test is reported as a failed test rather than as low coverage. `bun test -t <pattern>` keeps the 30s default timeout. Snapshot-resume tests in both languages use a private snapshot lock.
