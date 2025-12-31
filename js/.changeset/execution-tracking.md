---
'start-command': minor
---

Add dual storage system for command execution tracking using links notation

This update implements a comprehensive execution tracking system that stores information about each called command:

**New Features:**

- Dual storage system: text (.lino files) via lino-objects-codec and binary (.links) via clink
- Each execution record includes:
  - UUID of the command call
  - Process ID (PID) for process management
  - Status (executing/executed)
  - Exit code
  - Log file path
  - Working directory, shell, platform info
  - Additional execution options and metadata
- File-based locking mechanism to ensure single-writer access
- Verification system to check consistency between text and binary databases
- Integration with clink's string aliases for readable identifiers

**Configuration:**

- `START_DISABLE_TRACKING=1` - Disable execution tracking
- `START_APP_FOLDER` - Custom folder for storing execution records
- `START_VERBOSE=1` - Show execution IDs during command execution

**Dependencies:**

- Added `lino-objects-codec` for links notation serialization
- Optional `clink` CLI tool for binary database support

**Testing:**

- 24 new unit tests for execution store operations
- CI/CD updated to install clink for integration testing on Linux and macOS
