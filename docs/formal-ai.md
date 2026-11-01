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
- **Formal AI decides and start executes.** Every tool call is a command line
  that start tokenizes itself, using POSIX quoting rules, and runs as an argv
  vector without a shell. The call runs in the current directory with start's
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
  targets back. If they are missing (or still present after `rm`/`rmdir`/`mv`),
  the run fails with `70` (`unverified`).

### Exit statuses

| Status                       | Meaning                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status of the last tool call | the task finished (`0` when that call succeeded)                                                                                                                                       |
| `0`                          | Formal AI answered without running a tool                                                                                                                                              |
| `64`                         | empty or overlong request, or an option that cannot be combined (`--isolated`, `--isolated-user`, `--detached`, `--use-command-stream`, `--status`/`--list` and the other query modes) |
| `65`                         | Formal AI did not understand the request; no tool ran                                                                                                                                  |
| `69`                         | no qualified Formal AI runtime; nothing ran                                                                                                                                            |
| `70`                         | malformed Formal AI response, or a change that failed its readback                                                                                                                     |
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
  readback verification;
- the summed effects;
- the outcome: status, exit status, message and remaining obligations;
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

- The offline tests replay receipts recorded from Formal AI 0.355.27, so they
  need no runtime. They are `js/test/regression-255-*.js` and
  `rust/tests/regression_255.rs`.
- The real end-to-end test is opt-in:

  ```bash
  cd js && START_FORMAL_AI_E2E=1 START_FORMAL_AI_ROOT=~/formal-ai \
    bun test ./test/regression-255-e2e.js
  ```
