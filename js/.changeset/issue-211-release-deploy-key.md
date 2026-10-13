---
'start-command': patch
---

CI/CD: the Rust release jobs receive the release deploy key again (the called workflow inherits secrets), and a rejected version push now fails the release instead of reporting success (#211).
