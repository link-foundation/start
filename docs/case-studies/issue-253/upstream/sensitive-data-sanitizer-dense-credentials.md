## Summary

Sanitizing text with many credential matches takes quadratic time in 0.12.1. Each `RE2#exec` call of re2-wasm copies the whole scanned view into WASM again, and gitleaks rules call `exec` once per match.

- 128 KiB of `ghp_` tokens takes about 18 s.
- 256 KiB takes 72 s, about 3.6 KB/s.
- Plain log text of the same size takes about 1 s.

#47 sped up ordinary large logs. This case is separate: it scales with the number of matches.

## Reproduction

`@link-foundation/sensitive-data-sanitizer` 0.12.1, Node.js 22, Linux x64. Each test file is newline-separated random `ghp_` + 36 alphanumerics, sanitized with `redact - --credentials-only --allow-binary` (with or without `--stream`, same result):

| Input                                         | Time        |
| --------------------------------------------- | ----------- |
| 32 KiB of tokens                              | 2.1 s       |
| 64 KiB of tokens                              | 5.4–6.0 s   |
| 128 KiB of tokens                             | 17.7–19.3 s |
| 256 KiB of tokens (one line, space-separated) | 72.5 s      |
| 64 KiB of git SHAs / base64 / UUIDs           | about 1.0 s |
| 300 KB of ordinary log lines                  | 1.7 s       |

Each doubling of the input roughly triples or quadruples the time. Line breaks don't matter: 128 KiB with one token per line takes 18.6 s.

Script: [experiments/issue-253/sanitizer-findings.sh](https://github.com/link-foundation/start/blob/issue-253-480126f69838/experiments/issue-253/sanitizer-findings.sh)

## Cause

`node --cpu-prof` on the 64 KiB input shows the time going to `exec` in `src/re2.js`, called from `ruleMatches` in `src/gitleaks.js:157`:

```
1666 ms  wasm-function[72]   exec@src/re2.js < ruleMatches@src/gitleaks.js:157 < scanRule < detectGitleaks
 519 ms  stringToUTF8Array   toWireType < exec@src/re2.js < ruleMatches ...
 334 ms  lengthBytesUTF8     toWireType < exec@src/re2.js < ruleMatches ...
```

`ruleMatches` loops `pattern.exec(text)` with `lastIndex`. Every call converts the full `text` to UTF-8 and copies it into the WASM heap (`toWireType`), then searches from `lastIndex`. With N matches in a view of L bytes, that is O(N·L) work for each rule that matches.

## Suggested fix

Any of these would make it linear:

- Run the RE2JS path that `large` views already use (no copy into WASM) once a view has produced more than a few matches.
- Or scan bounded windows around each rule keyword hit (gitleaks rules carry `keywords`) instead of the whole view.
- Or copy the view into WASM once and search it with offsets, if re2-wasm can be driven that way.

Please add a throughput test with a dense-token input, for example 256 KiB of `ghp_` tokens under a few seconds.
