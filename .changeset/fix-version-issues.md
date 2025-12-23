---
'start-command': patch
---

Fix all --version detection issues

- Fix screen version detection by capturing stderr
- Show Bun version instead of Node.js version when running with Bun
- Show macOS ProductVersion instead of kernel version
- Fix argument parsing to handle `$ --version --` same as `$ --version`
- Update all scripts and examples to use Bun instead of Node.js
- Add comprehensive tests for --version flag
