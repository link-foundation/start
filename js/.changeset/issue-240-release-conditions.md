---
'start-command': patch
---

Main pushes publish again (#240). Since #234 the Release job was skipped on every push to `main`: at job level the wildcard `needs.*.result` list also saw the deliberately skipped changeset check behind `test`/`coverage`. Release now compares each needed job by name, and the JavaScript Stage prints every term of the release condition and fails a main push whose release was skipped although all of its needs succeeded.
