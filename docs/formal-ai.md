# `--use-formal-ai` (experimental)

```bash
$ --use-formal-ai -- print list of files in current directory
```

`--use-formal-ai` sends the natural-language request after `--` to a local
[Formal AI](https://github.com/link-assistant/formal-ai) runtime. Formal AI
interprets the request and chooses tool calls. start checks each call against
a small effect policy, runs it in the current directory and returns the
receipt to Formal AI. Both editions behave the same: JavaScript (`bun`/`npm`)
and Rust (`cargo`).

> **Experimental.** The option, its tool set, the exit statuses and the
> evidence schema (`start-formal-ai-evidence/1`) may change between releases.
> It was qualified against Formal AI **0.355.27**.

## What the mode guarantees

- **It is opt-in.** Without `--use-formal-ai`, start behaves exactly as before.
  `$ ls --use-formal-ai` still runs `ls` with the argument `--use-formal-ai`,
  because start only reads its own options before the command.
- **The request is text, never a command.** Everything after `--` is joined
  with single spaces and sent only to Formal AI, so `;`, `|`, `$(...)`, `*` and
  option-like words such as `--isolated` stay part of the request. start's
  aliases (`substitutions.lino`) and shell never see the request.
- **There is no fallback.** If no qualified runtime is available, start exits
  `69` and prints
  `No command was run: --use-formal-ai never falls back to aliases, a shell or an LLM.`
- **Formal AI decides and start executes.** Every `bash` tool call is a
  command line that start tokenizes itself, using POSIX quoting rules, and
  runs as an argv vector without a shell. The call runs in the current directory with start's
  usual `START_*` environment, its own process group, no stdin and the
  per-tool limits listed below. Its stdout and stderr stream to the terminal.
- **The status is real.** A finished task exits with the status of its last
  tool call, and a cancelled one with the signal status (`130` for SIGINT,
  `143` for SIGTERM). A read, a plan or an answer from Formal AI is never
  reported as a completed change: the outcome says which tools ran and which
  files changed.

## Supported behavior

The supported behavior is deliberately small. Requests that Formal AI maps to
these tools work. Anything else fails explicitly.

| Kind                                                     | Programs                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                                                     | `basename`, `cat`, `cmp`, `diff`, `dirname`, `du`, `file`, `find`, `grep`, `head`, `ls`, `md5sum`, `pwd`, `readlink`, `realpath`, `sha256sum`, `sort`, `stat`, `tail`, `test`, `tree`, `uniq`, `wc`, `git` (`branch` (listing only), `diff`, `log`, `ls-files`, `rev-parse`, `show`, `status`) |
| Change (needs `START_FORMAL_AI_EFFECTS=workspace-write`) | `cp`, `mkdir`, `mv`, `rm` (no recursion), `rmdir`, `touch`                                                                                                                                                                                                                                     |

The policy refuses the following calls (exit `77`). Nothing after a refused
call runs:

- shell syntax: operators, redirects, substitutions, variables, unquoted globs,
  `~` and comments;
- programs outside the table;
- flags that turn a reader into a writer or a waiter (`find -delete`/`-exec`,
  `sort -o`, `tail -f`, `git -c`, `rm -r` and others);
- any path outside the working directory, including absolute paths, `..` and
  symlinks that lead out of it.

### File tools

`bash` cannot change the text of a file: it has no redirects, no interpreters
and no editors. start therefore also offers Formal AI three structured tools.
start reads and writes the one named file itself, so it never runs an
interpreter (#258):

| Tool    | Offered                | Arguments                                                    | Effect                                                                               |
| ------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `read`  | always                 | `path`                                                       | the exact UTF-8 text of a regular file, as a numbered frame; it observes the file    |
| `edit`  | `workspace-write` mode | `path`, `old_string`, `new_string`, `replace_all` (optional) | replaces one literal occurrence (every one with `replace_all`) in a file read before |
| `write` | `workspace-write` mode | `path`, `content`                                            | replaces an observed file, or creates one in an observed directory                   |

- The paths follow the `bash` policy: nothing outside the working directory,
  no `~`, and no symlinks that lead out of it. A symlink inside it is followed,
  and the change is made to (and recorded for) the file it points to.
- `edit` refuses an `old_string` that is missing or ambiguous, an empty one,
  and a no-op. Nothing changes in those cases, and the call exits `1` with the
  reason.
- A file that changed since start read it is not overwritten. Formal AI must
  read it again first.
- The new text is written atomically, keeping the file mode. Comments,
  whitespace, line endings, a byte order mark and every unrelated byte stay
  as they were. The file is then read back, and the step records its byte
  count, the hashes before and after (`previousSha256`, `sha256`), the
  number of replacements, the effects and the verification.
- Files larger than `START_FORMAL_AI_MAX_FILE_BYTES` and files that are not
  valid UTF-8 are refused.
- `read` returns the complete text as a numbered frame,
  `<file>`, one `00001| line` per line, a blank line,
  `(End of file - total N lines)` and `</file>`. Formal AI decodes it back to
  the exact text, so a final newline, CR bytes and Unicode survive. This is
  the whole-file Read that Formal AI binds an edit to.
- Formal AI's argument aliases (`filePath`, `file_path`, `oldString`,
  `old_str`, `newString`, `replaceAll` and similar) are accepted. Conflicting
  or malformed arguments end the run with `70`.

### Bounded typed edits

An `edit` or `write` of an existing file is bound to its preimage (#261):

- **A fresh complete Read.** The preimage is the complete bytes the `read`
  tool returned for that exact path in this task. Listing the directory or
  `cat` observes the file but does not bind it, and the call exits `1`. A file
  that changed after the read is stale (`1`), and so is a target that is
  replaced while start writes.
- **Only the owned change.** `old_string` is matched in the preimage bytes.
  It must occur exactly once, or `replace_all` must be set. start applies the
  change to those byte regions only, writes atomically and refuses to replace
  a file that appeared or changed meanwhile.
- **Independent verification.** The file is read back and compared byte for
  byte with the preimage and the matches, not with a fingerprint and not with
  the text start computed. Every matched region must hold `new_string`, and
  every other byte must be unchanged and in place. Anything else ends the run
  with `70` (`unverified`).
- **The mutation receipt.** The step keeps `mutation`:
  `{tool, target, preimage, postimage, matches: [{offset, oldBytes, newBytes}], readback}`.
  The preimage, postimage and readback are each `{sha256, bytes}` (the
  preimage is `null` for a new file). `offset`, `oldBytes` and `newBytes` are
  byte offsets and lengths. A change that failed after it was bound keeps its
  receipt too, and says whether the file still holds its preimage. Formal AI gets the result
  `{ok, path, tool, preimage, postimage, replacements, verified}`.
- **Failures stay unresolved.** A failed `read`, `edit` or `write`, or a
  failed `bash` change, stays open until a later call meets its obligation:
  a verified `edit` or `write` of the same target (or a `read` of the same
  target for a failed read), or the same `bash` command succeeding. Another
  read, `cp`/`mv` over the file and Formal AI's final answer do not resolve
  it. The run then ends `incomplete` with the original failure and its exit
  status, for example
  `` `edit snippet.mjs` failed (snippet.mjs: old_string was not found; nothing changed) and no later call resolved it; no file changed ``.
  Each open failure is kept under `outcome.failures` and as a remaining
  obligation.
- There is still no shell fallback: `bash` cannot change a file's text, and
  interpreters such as `perl` or `sed -i` are refused (`77`).

### Capability gaps

When Formal AI cannot do a task with the tools it was offered, it may answer
with a capability-gap record instead of a tool call, for example:

```json
{
  "complete": false,
  "missingCapabilities": ["read", "edit"],
  "reason": "EditToolUnavailable",
  "schema": "workspace-edit-capability-gap/v1",
  "target": "snippet.mjs",
  "verified": false
}
```

start recognizes only the known schemas, `workspace-edit-capability-gap/v1`
and `workspace-change-verification-gap/v1`. The second includes
`SourcePreimageUnavailable`, which Formal AI reports when it cannot bind the
complete Read before its edit (#261). The record must be the whole
answer, `complete` and `verified` must both be `false`, the target must be
non-empty, and the missing capabilities must come from `read`, `edit`,
`multi_edit`, `write`, `run` and `bash`. A record that only repeats tool
output does not count. Such an answer becomes the outcome `capability-gap`
with exit `65`, for example
`Formal AI reported a capability gap for snippet.mjs (EditToolUnavailable; missing read, edit); nothing was verified as done`.
The remaining obligations say that the change was not made or not verified.
In read-only mode, when an edit or write tool is missing, they also say to set
`START_FORMAL_AI_EFFECTS=workspace-write`. Any other answer, such as a reply to
a question, still exits `0`.

When start changed files before such a gap, the message says
`Formal AI did not confirm the task as done; start observed: ...` instead of
`nothing was verified as done`.

Other gap records are never taken as success either (#261). This covers a JSON
answer whose `schema` names a gap with `complete`, `completed` or `verified`
`false`, and a Links Notation record whose `record_type` names one, such as
Formal AI's `obligation_gap` (`reason "no_artifact_in_clause"`). Such an
answer ends `incomplete` with exit `65`, keeps the record under
`outcome.gapRecord` and still reports what start observed. A record that only
repeats tool output (including the text of a read frame) does not count.

### Change rules

Changes must also follow these rules:

- **Observe before editing.** A change may only name targets that an earlier
  call in the same run has observed. For example, `ls` observes the
  directory's entries and `cat x` observes `x`. Mentioning a path in the
  request is not enough.
- **Preserve unrelated content.** The working directory is fingerprinted
  before and after every call (names, types, sizes and mtimes, up to
  `START_FORMAL_AI_MAX_FINGERPRINT_ENTRIES`). Every added, removed or changed
  path is recorded, including any change made during a read-only call.
- **Verify by readback.** After a change exits with `0`, start reads its
  targets back. An `edit` or `write` must leave exactly the text it wrote. If they are missing (or still present after `rm`/`rmdir`/`mv`),
  the run fails with `70` (`unverified`).

### Exit statuses

| Status                       | Meaning                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status of the last tool call | the task finished (`0` when that call succeeded); with a failed call that no later call resolved, its status (`incomplete`)                                                            |
| `0`                          | Formal AI answered without running a tool                                                                                                                                              |
| `64`                         | empty or overlong request, or an option that cannot be combined (`--isolated`, `--isolated-user`, `--detached`, `--use-command-stream`, `--status`/`--list` and the other query modes) |
| `65`                         | Formal AI did not understand the request, or reported a capability gap or another gap record; nothing was verified as done by Formal AI                                                |
| `69`                         | no qualified Formal AI runtime; nothing ran                                                                                                                                            |
| `70`                         | malformed Formal AI response, a Formal AI HTTP error (its cause is kept), or a change that failed its readback                                                                         |
| `77`                         | a tool call was refused by the effect policy                                                                                                                                           |
| `78`                         | invalid `START_FORMAL_AI_*` value                                                                                                                                                      |
| `124`                        | a step, time, tool or retry budget was exhausted                                                                                                                                       |
| `130`, `143`, `129`          | cancelled by SIGINT, SIGTERM or SIGHUP                                                                                                                                                 |

### Known limits (Formal AI 0.355.27)

Formal AI decides which tool runs. start only refuses unsafe calls and reports
the result truthfully, so some requests end with a real but unhelpful status:

- `print list of files in corrent directory` (note the typo) becomes
  `ls 'corrent'`, which exits `2`. start reports
  `the last tool call exited with 2`.
- `delete all files` becomes `ls`. start reports
  `finished after 1 tool call(s); no file changed`, not a deletion.

These limits were reported upstream in link-assistant/formal-ai; see
[the case study](case-studies/issue-255/README.md).

With Formal AI 0.355.29 and the file tools (#258):

- `In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.`
  in `workspace-write` mode runs `read snippet.mjs`, `edit snippet.mjs` and
  `sha256sum -- snippet.mjs`, and changes only that line. Formal AI then
  answers with an `obligation_gap` record for the clause
  `Preserve all other content.`. Since #261 the run therefore ends
  `incomplete` with `65`, `changed snippet.mjs`, instead of `0`.
- The same request in read-only mode is a capability gap (`65`, missing
  `edit`). Its obligations point to `START_FORMAL_AI_EFFECTS=workspace-write`.
- The looser wording `replace the before label declaration with the after label declaration`
  reads the file, then calls `edit` with text that does not occur in it. The
  file is untouched, and since #261 the run ends `incomplete` with `1` and
  that failure, not with the answer that follows it.
- `What is 2 + 2?` is answered and exits `0`.

With Formal AI 0.355.32 and bounded typed edits (#261), the held-out
requests behave as follows:

| Request (files)                                                                     | Mode              | Calls                       | Result                                                                        |
| ----------------------------------------------------------------------------------- | ----------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `In draft.txt, replace «draft» with «verified».` (`draft\n`, `verified-source.txt`) | `workspace-write` | `read`, `edit`, `sha256sum` | `0`; `draft.txt` is `verified\n`, the source is unchanged                     |
| the same                                                                            | read-only         | `read`                      | `65`, capability gap, missing `edit`                                          |
| `replace «drafted» …` (OLD not in the file)                                         | `workspace-write` | `read`                      | `0`, `no file changed`; Formal AI answers in prose without calling `edit`     |
| `replace «draft» …` (two occurrences)                                               | `workspace-write` | `read`, `perl -pi …`        | `77`; the interpreter is refused and the file is unchanged                    |
| `In unicode.txt, replace «café» with «naïve».` (CRLF)                               | `workspace-write` | `read`, `edit`, `sha256sum` | `0`; only the word changes, CRLF and the other Unicode stay                   |
| a symlink to a file inside the working directory                                    | `workspace-write` | `read`, `edit`, `sha256sum` | `0`; the file it points to changes                                            |
| a symlink that leaves the working directory                                         | `workspace-write` | `read` (refused)            | `77`; nothing outside is read                                                 |
| `In ../outside.txt, replace …`                                                      | `workspace-write` | none                        | `65`, Formal AI's `obligation_gap` (`no_artifact_in_clause`); nothing changes |

A mismatched OLD therefore ends `0` with `no file changed`: Formal AI does not
call `edit` and states the mismatch in prose, which start cannot tell from an
answer. When Formal AI does call `edit` with text that is not in the file,
the run ends `incomplete` with exit `1` and the original failure.

### Formal AI HTTP errors

When the runtime answers with an HTTP error, start keeps a sanitized, bounded
cause. 5xx responses are retried up to `START_FORMAL_AI_MAX_RETRIES` times;
4xx responses are not retried. The run exits `70` with, for example:

```text
Formal AI returned HTTP 500: formal_ai_error: Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info. (after 1 retry)
```

The evidence outcome gains `diagnostics`: `httpStatus`, `errorType` (at most
100 characters), `errorMessage` (300), `bodyPreview` (500), `bodyChars` and
`attempts`. Before anything is recorded, start masks the bearer token it sent,
authorization headers, bearer and basic credentials, and fields named like
`api_key`, `token`, `secret` or `password`, and replaces control characters.
Request headers and the environment are never recorded. There is still no
fallback (#257).

## Installing and resolving the runtime

Formal AI is not published to npm or crates.io, and start never downloads,
installs or guesses a runtime. start uses exactly one of these two sources:

1. **A checkout** (recommended). start spawns the checkout's JavaScript
   server, `node js/server/main.mjs --agent-mode`. It listens on a private
   loopback port, uses a private `HOME` and memory file, and is stopped when
   the run ends.

   ```bash
   git clone https://github.com/link-assistant/formal-ai.git ~/formal-ai
   export START_FORMAL_AI_ROOT=~/formal-ai
   $ --use-formal-ai -- print list of files in current directory
   ```

   The checkout must be version `0.355.27` or newer (from `rust/Cargo.toml`).
   Older checkouts are refused, never used silently.
   `START_FORMAL_AI_EXPECTED_REVISION=<commit prefix>` also pins the commit.
   `START_FORMAL_AI_NODE` selects the Node.js executable, `node` by default.
   `START_FORMAL_AI_MEMORY_PATH` replaces the private memory file.

2. **A running server.** Set `START_FORMAL_AI_URL=http://127.0.0.1:<port>`. Such
   a server reports no version, so start uses it only with
   `START_FORMAL_AI_ALLOW_UNVERIFIED=1`, and records it as
   `formal-ai at <url> (version unverified)`.

Setting both variables, or neither, is an error (`69`).

Every run prints the identity it used, for example:

```text
[formal-ai] runtime: formal-ai 0.355.27 (4d57ec7bda82, js server js/server/main.mjs, node v26.13.0)
```

## Resource controls

| Variable                                  | Default     | Bounds                                                       |
| ----------------------------------------- | ----------- | ------------------------------------------------------------ |
| `START_FORMAL_AI_MAX_STEPS`               | `8`         | Formal AI turns and tool calls (1–64)                        |
| `START_FORMAL_AI_MAX_RETRIES`             | `1`         | retries of a failed Formal AI request (0–5)                  |
| `START_FORMAL_AI_TIMEOUT_MS`              | `120000`    | whole task                                                   |
| `START_FORMAL_AI_TOOL_TIMEOUT_MS`         | `30000`     | one tool call (its process group gets SIGTERM, then SIGKILL) |
| `START_FORMAL_AI_STARTUP_TIMEOUT_MS`      | `30000`     | runtime startup                                              |
| `START_FORMAL_AI_MAX_OUTPUT_BYTES`        | `65536`     | captured stdout/stderr per tool call                         |
| `START_FORMAL_AI_MAX_REQUEST_CHARS`       | `4096`      | request length                                               |
| `START_FORMAL_AI_MAX_MEMORY_MB`           | `1024`      | heap of the spawned Formal AI server                         |
| `START_FORMAL_AI_MAX_FINGERPRINT_ENTRIES` | `5000`      | paths compared before and after each call                    |
| `START_FORMAL_AI_MAX_FILE_BYTES`          | `1048576`   | file size for `read`, `edit` and `write` (1–16777216)        |
| `START_FORMAL_AI_EFFECTS`                 | `read-only` | `read-only` or `workspace-write`                             |

## Logs and evidence

Each run is tracked like a direct command. It has the usual start and finish
blocks, an execution record (`$ --status <uuid>`) and a log in
`START_LOG_DIR`. The log ends with a `=== Formal AI Evidence ===` JSON block
that contains:

- the request, working directory, effect mode and bounds;
- the runtime identity: source, root, version, engine version, commit, dirty
  flag and Node.js version;
- every Formal AI response, including its finish reason, a text preview and
  the tool calls it asked for;
- every tool decision, as allowed or refused with the reason, argv, exit
  status, signal, timeout, duration, output previews, file effects and
  readback verification. File tools record the tool, path, byte count,
  hashes and replacements instead of an argv;
- the summed effects;
- the outcome: status, exit status, message and remaining obligations, plus
  `diagnostics` for a Formal AI HTTP error and `gap` for a capability gap;
- the number of Formal AI requests and the duration.

The evidence is privacy-conscious:

- The log stays on your machine. This mode never creates issues and never
  uploads logs, even if auto-reporting is configured.
- Tool output appears only as a preview of at most 2000 characters, and the
  environment is not recorded.
- Tool output returned to Formal AI is wrapped in `<untrusted_context>`, and
  any such tags inside the output are removed. File contents therefore cannot
  pose as instructions or as an exit status.

Review the log before sharing it. It contains your request, local paths and
output previews.

## Reproducible examples

- [`examples/formal-ai-list-files.sh`](../examples/formal-ai-list-files.sh)
  runs the issue's demo. It uses an isolated fixture whose names contain
  spaces and Unicode, compares the listing with an independent `ls -1A`,
  proves the fixture is unchanged and prints the evidence:

  ```bash
  START_FORMAL_AI_ROOT=~/formal-ai examples/formal-ai-list-files.sh
  ```

- [`examples/formal-ai-edit-file.sh`](../examples/formal-ai-edit-file.sh)
  runs the #258 demo against an isolated fixture. It runs a literal edit
  (read, edit and readback, changing only the declaration line), the same
  edit in read-only mode (capability gap, `65`), a read and a question:

  ```bash
  START_FORMAL_AI_ROOT=~/formal-ai examples/formal-ai-edit-file.sh
  ```

- [`experiments/issue-261/repro.sh`](../experiments/issue-261/repro.sh)
  runs the #261 reproduction (`draft.txt` and `verified-source.txt`) against
  a real runtime and prints the exit status, both files' bytes and the
  evidence.
- The offline tests replay receipts recorded from Formal AI 0.355.27,
  0.355.29 and 0.355.32, so they need no runtime. They are
  `js/test/regression-255-*.js`, `js/test/regression-257.js`,
  `js/test/regression-258*.js`, `js/test/regression-261.js`,
  `rust/tests/regression_255.rs` and the `formal_ai_*_cases.rs` unit tests.
  [`experiments/issue-258/capture-receipts.cjs`](../experiments/issue-258/capture-receipts.cjs)
  and
  [`experiments/issue-261/capture-receipts.cjs`](../experiments/issue-261/capture-receipts.cjs)
  re-record the receipts from a real runtime.
- The real end-to-end test is opt-in:

  ```bash
  cd js && START_FORMAL_AI_E2E=1 START_FORMAL_AI_ROOT=~/formal-ai \
    bun test ./test/regression-255-e2e.js
  ```
