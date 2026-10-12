---
'start-command': patch
---

CI/CD: pass the crates.io token through CARGO_REGISTRY_TOKEN instead of the deprecated `cargo publish --token` flag, and pin GitHub runner images (ubuntu-24.04, macos-15, windows-2025).
