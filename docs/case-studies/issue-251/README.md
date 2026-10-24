# Issue #251: shared log sanitizer for `$ --upload-log` (#249, #250)

[Issue #251](https://github.com/link-foundation/start/issues/251) groups two issues:

- [#249](https://github.com/link-foundation/start/issues/249): the sanitizer behind `--upload-log` removes content that is not a secret.
- [#250](https://github.com/link-foundation/start/issues/250): replace start-command's own sanitizer with [link-foundation/sensitive-data-sanitizer](https://github.com/link-foundation/sensitive-data-sanitizer), the sanitizer shared with gh-upload-log and hive-mind.

Both are done in [PR #252](https://github.com/link-foundation/start/pull/252), in JavaScript and Rust. The issue text and comments are in `issue-249.json`, `issue-250.json` and `issue-251.json`.

## Timeline

- 2026-10-10: issue #200 asks for logs to be sanitized before upload. PR #204 adds `js/src/lib/log-sanitizer.js` and `rust/src/lib/log_sanitizer.rs` (see `docs/case-studies/issue-200`).
- 2026-10-23: #249 reports that 0.37.8 removed 2,885,698 of 4,489,431 bytes (64%) from one hive-mind log. A comment confirms the problem is still on main (0.39.1, 943e4ec). It notes that the library masks only the double-quoted header value, but has the same `sk-` bug (sensitive-data-sanitizer#40).
- 2026-10-23: #250 asks to use the library instead. sensitive-data-sanitizer#40, #41 and #42 are closed at 18:08 UTC, and 0.12.0 is published to npm at 19:08 UTC. 0.12.0 adds `--credentials-only`, `--env-secrets`, `--gh-config`, `--stream`, the preservation of non-UTF-8 bytes, and `--output`, which writes a private file atomically.

## Root causes (#249)

Run the issue's reproduction through the old module (`experiments/issue-251/issue-249-before-after.sh`; output in `data/issue-249-before-after.txt`):

```
== before (704a644, own sanitizer)
gate='/tmp/hive-mind-di[REDACTED]'
🧠 Formal AI: endpoint [REDACTED]
{"bodyPreview":"{\"messages\":[{\"content\":\"use: curl -L -H \\\"[REDACTED]
curl -H "[REDACTED]
token [REDACTED] end
== after (sensitive-data-sanitizer)
gate='/tmp/hive-mind-disk-baseline-0ce9e170-e6d3-494d-91e1-0d820245d34b'
🧠 Formal AI: endpoint http://172.18.0.2:8080/api/openai/v1
{"bodyPreview":"{\"messages\":[{\"content\":\"use: curl -L -H \\\"Authorization: token $(gh auth token)\\\" -o <filename> <url>\\n...the rest of a 100 KB prompt...\"}]}"}
curl -H "Authorization: [REDACTED]" -o out.txt https://api.github.com
token [REDACTED] end
```

The three old rules were:

1. `/(?:Proxy-)?Authorization[ \t]{0,32}:[^\r\n]*/gi` masked to the end of the line. In a one-line JSON request body, that line runs to the end of the prompt.
2. `/(?:https?|git|ssh):\/\/[^\s:/@]{1,256}:[^\s@]*/g` did not require the `@` of `user:password@`, so it matched every URL with a port.
3. `/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]*/g` had no left boundary, so `disk-baseline-` matched at `sk-`.

Patching these rules would have kept a second sanitizer next to the shared one. Following #250, the old rule set is removed instead.

## Requirements and how they are met

| Requirement | Source | Implementation | Evidence |
| --- | --- | --- | --- |
| Use sensitive-data-sanitizer instead of start's own sanitizer | #250 | JS depends on `@link-foundation/sensitive-data-sanitizer@^0.12.0` and runs its bundled CLI with the current runtime. The old rules, `StreamingSanitizer` and the Rust rule set are removed | `js/src/lib/log-sanitizer.js`, `rust/src/lib/log_sanitizer.rs` |
| Rust gets the same result | #250 | No crate exists and gh-upload-log does not sanitize yet (gh-upload-log#55 is open). Rust calls the same CLI: `START_SENSITIVE_DATA_SANITIZER`, then `sensitive-data-sanitizer` on PATH (`.exe`, `.cmd`, `.bat` on Windows), then `bun`/`npm install -g` for an interactive upload | `rust/tests/log_sanitizer.rs`; Rust CI installs the version `js/package.json` names |
| Credentials only; public account details stay | #250 | `--credentials-only` | Both suites check that `konard@example.com`, `https://github.com/konard` and local URLs with ports stay |
| Secret-named environment values, gh `hosts.yml`, non-UTF-8 bytes, 64 KB streaming, fail-closed private file | #250, sensitive-data-sanitizer#42 | `--env-secrets --gh-config --stream --max-bytes --output`. The source log is never modified. start writes a 0600 stage file in a 0700 `start-sanitized-*` directory, and the library writes `execution.log` next to it. Any failure deletes the directory and stops the upload | Invalid UTF-8, CRLF, empty-file, permission, umask and cleanup tests; failure codes `ERR_SOURCE`, `ERR_BINARY`, `ERR_UNAVAILABLE`, `ERR_WORKER`, `ERR_OUTPUT`; read, write and fsync failure injection (JS) |
| `Authorization:` masks only the scheme and token | #249 | The library does this only for double-quoted values. start masks `Authorization: <scheme> <token>` itself before calling the CLI (`AuthorizationHeaderMask`), with bounded holdback and continuation state. Shell expressions and placeholders (`$(...)`, `<token>`, `[REDACTED]`, `{...}`) are left alone | Tests at block sizes 1, 7, 31, 256 and 65,536 bytes, plus a 200 KB token |
| URL rule needs `@`; token prefixes need a left boundary | #249 | Library 0.12.0 (sensitive-data-sanitizer#40) | The three #249 lines come out unchanged in both suites |
| The #249 cases become regression tests | #249, #250 | `keeps every line from issue #249 …` (JS) and `keeps_every_line_from_issue_249_and_public_account_details` (Rust) | `js/test/log-sanitizer.js`, `rust/tests/log_sanitizer.rs` |
| Same rules for the issue text quoted from a failed command | #200 behaviour kept | `sanitizeText` / `sanitize_text` | `sanitizes issue text with the same rules` |
| Explicit `--no-sanitize` | #200 behaviour kept | Unchanged: manual upload only, `--private` always | Fake gh-upload-log tests for manual, automatic and opt-out uploads |

## Library evaluation

- **sensitive-data-sanitizer 0.12.0** is the one #250 asks for. It is ESM-only and requires Node ≥ 22.13, so the CommonJS package cannot `require()` it. Both languages run its CLI as a child process. The CLI prints only fixed `ERR_*` codes, and start passes along only that code.
- **No Rust crate or port exists** (crates.io has nothing named sensitive-data-sanitizer). Porting the library was out of scope for #250, which names "calls its CLI" as an acceptable option.
- **gh-upload-log** might do the masking later (gh-upload-log#55, open). Until then, start sanitizes before calling it.
- **hive-mind** is moving to the same library (hive-mind#3740, open).

## Library behaviour found while integrating

`experiments/issue-251/upstream-repro.sh` reproduces each item with 0.12.0. Output from `LARGE_MIB=80`:

```
curl -H "Authorization: [REDACTED]" keep-after
curl -H 'Authorization: [REDACTED]
Authorization: [REDACTED]
Sanitization failed; output was blocked (ERR_BINARY).
git remote: https://[REDACTED]/owner/repo        (GIT_AUTH_TRANSPORT=github.com)
Sanitization failed; output was blocked (ERR_WORKER).
file mode exit=2 seconds=61
stdin mode exit=0 seconds=208
```

1. Single-quoted and unquoted `Authorization` values are masked to the end of the line: the `context` rule and `src/detection.js:191`. start's pre-pass handled this until sensitive-data-sanitizer 0.12.1 fixed it; issue #253 removed the pre-pass.
2. File mode stops after 60 s (`workerTimeoutMs ?? 60000` in `src/stream.js`) with `ERR_WORKER`. start therefore streams the log through stdin, with `--max-bytes` set to the file size.
3. A NUL byte blocks the whole log (`ERR_BINARY`). start fails closed and does not upload.
4. `--env-secrets` takes values of names such as `*_AUTH_TRANSPORT`, so `HIVE_MIND_GIT_AUTH_TRANSPORT=github.com` masks every `github.com`. start's old rule used the same name pattern, so this is not new.
5. Throughput is about 1 MB/s on ordinary log text, plus about 4 s of CLI startup. It drops sharply when credentials are dense. `experiments/issue-200/large-log.js` puts a `ghp_` token on every 60-byte line of a 110 MiB log. Start's Authorization pre-pass finished it in about a minute, but in 66 minutes the CLI wrote only 8,978,218 bytes (about 2.2 KB/s), and the run was stopped. start sets no time limit, because a limit would block the upload. A real log rarely has a token on every line.

Reported upstream: item 1 as [sensitive-data-sanitizer#45](https://github.com/link-foundation/sensitive-data-sanitizer/issues/45), 4 as [#46](https://github.com/link-foundation/sensitive-data-sanitizer/issues/46), and 2, 3 and 5 as [#47](https://github.com/link-foundation/sensitive-data-sanitizer/issues/47).

## Not done here

#249 lists 9 private gists made with 0.37.8. Its follow-up is to upload those logs again from the Hive Mind server (`/tmp/start-command/logs/isolation/docker/<execution>.log`) once this is released. That needs access to that server and a released version, so it is not part of this pull request.

## Verification

```
cd js && bun run check && bun run test
bun test ./js/test/log-sanitizer.js
node --test js/test/log-sanitizer.js
START_CARGO_MAX_GIB=4 START_CARGO_MEMORY_GIB=2 node scripts/bounded-cargo.mjs test --test log_sanitizer
START_SENSITIVE_DATA_SANITIZER=$PWD/js/node_modules/.bin/sensitive-data-sanitizer \
  START_CARGO_MAX_GIB=4 START_CARGO_MEMORY_GIB=2 node scripts/bounded-cargo.mjs test --test failure_handler
experiments/issue-251/issue-249-before-after.sh
experiments/issue-251/upstream-repro.sh
```
