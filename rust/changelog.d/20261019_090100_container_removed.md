---
bump: patch
---

`start --status` reports `containerState removed` and `containerRemovedObservedAt` for a finished detached docker execution whose container was removed, by the cleanup policy or later by hand, as in the JavaScript edition (#225).
