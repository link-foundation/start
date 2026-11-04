---
'start-command': minor
---

`--use-formal-ai`: bounded typed source edits (#261).

- **Bound preimage:** an `edit` or `write` of an existing file is bound to the complete bytes the `read` tool returned for that exact path in the same task. `cat`, a directory listing or a stale read is not enough, and a change of the target while start writes is refused. `read` returns the text as the numbered frame Formal AI binds as a whole-file Read and decodes back exactly.
- **Owned change only:** `old_string` must occur exactly once (or `replace_all` is set), and only those byte regions change. Unicode, CRLF, a byte order mark and a missing final newline are preserved, and symlinks are followed only inside the working directory.
- **Receipt and verification:** each change keeps a mutation receipt (`tool`, `target`, `preimage`, `postimage`, byte `matches`, `readback`) in the evidence and returns it to Formal AI. The readback is verified byte for byte against the preimage and the matches, independently of fingerprints; any other byte change ends the run with 70.
- **Unresolved failures:** a failed `read`, `edit`, `write` or `bash` change stays open until a verified change of the same target (or the same command) resolves it. A later read, a `cp`/`mv` over the file or Formal AI's answer does not resolve it, and the run ends `incomplete` with the original failure and its exit status.
- **Gap records:** `SourcePreimageUnavailable` is a known `workspace-change-verification-gap/v1` reason. Other JSON gap records and Formal AI's Links Notation `obligation_gap` answers end `incomplete` with exit 65 instead of success, unless they only repeat tool output (including a read frame's text). There is still no shell or vendor fallback.
- **Dependency:** log sanitization now depends on `@link-foundation/sensitive-data-sanitizer` ^0.14.0, its current release.
