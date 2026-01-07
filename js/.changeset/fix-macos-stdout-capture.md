---
'start-command': patch
---

fix: Use 'close' event instead of 'exit' for reliable stdout capture on macOS

The 'exit' event fires when the process terminates, but stdio streams may still have buffered data. On macOS, fast-executing commands like 'echo hi' could exit before stdout data events fired, causing no output to be displayed and no finish block shown.

- Changed from 'exit' to 'close' event in JavaScript for reliable output capture
- Updated Rust to use piped stdout/stderr with threads for real-time display and capture
- Added case study documentation for Issue #57 root cause analysis
