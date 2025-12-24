---
'start-command': patch
---

Add documentation for piping with `$` command

- Created `docs/PIPES.md` with detailed guide on pipe usage
- Preferred approach: `echo "hi" | $ agent` (pipe TO the $-wrapped command)
- Alternative approach: `$ 'echo "hi" | agent'` (quoting)
- Updated `docs/USAGE.md` with brief pipe reference
- Updated `README.md` with piping examples
- Updated case study for issue #28 with new recommended approach
