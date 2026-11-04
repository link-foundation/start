---
bump: minor
---

### Changed

- `--use-formal-ai` bounded typed source edits (#261), mirroring the JavaScript implementation:
  - `edit` and `write` of an existing file are bound to the complete bytes `read` returned for that path in the same task, and stale or concurrently changed targets are refused. `read` returns the numbered frame Formal AI decodes back to the exact text.
  - Only the owned byte regions change. Each change keeps a mutation receipt (preimage, postimage, byte matches, readback) and is verified byte for byte against it by readback.
  - A failed file or `bash` change stays unresolved until a verified change of the same target resolves it, and the run then ends `incomplete` with the original failure.
  - `SourcePreimageUnavailable` gaps, other JSON gap records and Links Notation `obligation_gap` answers end `incomplete` with exit 65, unless they only repeat tool output.
- Log sanitization now requires `@link-foundation/sensitive-data-sanitizer` 0.14.0 or later (the installer and version check ask for the same release as the JavaScript package).
