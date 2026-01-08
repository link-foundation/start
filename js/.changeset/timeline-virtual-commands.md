---
'start-command': patch
---

feat: Sync JS implementation with Rust for timeline naming and virtual commands

- Renamed "spine" terminology to "timeline" throughout the codebase
  - `SPINE` constant → `TIMELINE_MARKER` (old name deprecated)
  - `createSpineLine()` → `createTimelineLine()` (old name deprecated)
  - `createEmptySpineLine()` → `createEmptyTimelineLine()` (old name deprecated)
- Added virtual command visualization for Docker image pulls
  - When Docker isolation requires pulling an image, it's shown as `$ docker pull <image>`
  - Pull output is streamed in real-time with result markers (✓/✗)
  - Only displayed when image actually needs to be pulled (conditional display)
- New API additions:
  - `createVirtualCommandBlock()` - for formatting virtual commands
  - `createVirtualCommandResult()` - for result markers
  - `createTimelineSeparator()` - for separator between virtual and user commands
  - `dockerImageExists()` - check if image is available locally
  - `dockerPullImage()` - pull with streaming output
  - `createStartBlock({ deferCommand })` - defer command display for multi-step execution
- Renamed "isolation backend" to "isolation environment" in docs and error messages
- All deprecated items have backward-compatible aliases for smooth migration

Fixes #70
