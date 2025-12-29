---
'start-command': minor
---

Add Rust translation of start-command CLI

This update adds a complete Rust implementation of the start-command CLI tool, providing:

- Full feature parity with the JavaScript implementation
- 42 unit tests covering core functionality
- Clean error handling using Rust's Result type
- Process isolation support (screen, tmux, docker, ssh)
- Natural language command substitution via .lino files
- User isolation management for secure command execution
- GitHub issue auto-reporting on command failures

The JavaScript implementation has been reorganized into a `js/` folder to separate it from the new `rust/` implementation. Case study documentation is included in `docs/case-studies/issue-38/`.
