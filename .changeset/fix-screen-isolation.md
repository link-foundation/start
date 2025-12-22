---
'start-command': patch
---

Fix screen isolation not capturing output on macOS (issue #15)

- Added version detection for GNU Screen to handle differences between versions
- Screen >= 4.5.1 uses native `-L -Logfile` for log capture
- Screen < 4.5.1 (like macOS bundled 4.0.3) uses `tee` command fallback
- Added tests for version detection and -Logfile support checking
- Updated case study documentation with root cause analysis
