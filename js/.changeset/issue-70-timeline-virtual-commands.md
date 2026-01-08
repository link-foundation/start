---
'start-command': minor
---

feat: Rename spine to timeline, add virtual command visualization for Docker

This release updates the internal terminology from "spine" to "timeline" for the status output format, and adds automatic visualization of Docker image pull operations as virtual commands.

Timeline terminology changes:

- The `│` prefixed output format is now consistently referred to as "timeline" format throughout the codebase
- All deprecated "spine" names remain available for backwards compatibility
- API changes are reflected in the Rust library (no breaking changes in JS)

Virtual command visualization for Docker:

- When Docker isolation requires pulling an image, it now appears as a separate `$ docker pull <image>` command
- Pull output is streamed in real-time with success (✓) or failure (✗) markers
- Only shown when the image actually needs to be pulled (not when using cached images)
- Provides better visibility into what's happening during Docker-based command execution

Version bumped to 0.20.0 to match the Rust library version.

Fixes #70
