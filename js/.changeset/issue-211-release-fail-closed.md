---
'start-command': patch
---

CI/CD: the release script checks the exit code of every git command and verifies the version commit reached main before publishing. The Rust bump skips versions crates.io already has (#211).
