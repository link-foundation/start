---
'start-command': patch
---

Add CI/CD coverage enforcement and Rust/JS test parity checks (issue #93)

- Add `scripts/check-test-parity.mjs` script to enforce Rust/JS test count within 10%
- Add coverage job to JavaScript CI/CD workflow (80% minimum threshold)
- Update `ARCHITECTURE.md` to document dual-language sync requirements
- Update `REQUIREMENTS.md` to document test coverage requirements and parity rules
