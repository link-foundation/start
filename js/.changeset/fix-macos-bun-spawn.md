---
'start-command': patch
---

fix: Use Bun.spawn for reliable stdout capture on macOS (Issue #57)

The previous fix (v0.17.2) using `close` event instead of `exit` did not resolve the issue on macOS. After deeper investigation, we discovered the root cause: Bun's event loop may exit before the `close` event callback can be scheduled, especially for fast commands like `echo`.

This fix uses Bun's native `Bun.spawn` API with async/await for stream handling when running on Bun runtime. This approach keeps the event loop alive until all streams are consumed and the process exits.

- Use `Bun.spawn` instead of `node:child_process` when running on Bun
- Use async stream readers with `getReader()` for real-time output display
- Use `await proc.exited` to ensure process completion before exiting
- Fall back to `node:child_process` with `close` event for Node.js compatibility
- Add verbose logging with `--verbose` flag for debugging
