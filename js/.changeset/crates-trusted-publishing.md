---
'start-command': patch
---

CI/CD: publish start-command to crates.io through trusted publishing (OIDC, `rust-lang/crates-io-auth-action`) instead of the long-lived `CARGO_TOKEN` / `CARGO_REGISTRY_TOKEN` secrets.
