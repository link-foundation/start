# Issue #255: experimental `--use-formal-ai` mode

[Issue #255](https://github.com/link-foundation/start/issues/255) asks for an
opt-in mode in which start runs a natural-language task through
[Formal AI](https://github.com/link-assistant/formal-ai) only:

```bash
$ --use-formal-ai -- print list of files in current directory
```

[PR #256](https://github.com/link-foundation/start/pull/256) implements it in
JavaScript and Rust. The issue text is in `issue-255.json`. The user
documentation is in [`docs/formal-ai.md`](../../formal-ai.md).

## Authorship

Claude, the AI issue solver working on this pull request, wrote the
implementation, tests and documentation. Formal AI is the runtime the mode
calls. It wrote none of this code and gets no authorship credit.

## Design

Each side owns one job:

- **Formal AI** interprets the request and chooses tool calls. start talks to
  its OpenAI-compatible agent endpoint (`/api/openai/v1/chat/completions`) and
  offers one `bash` tool whose argument is a command line.
- **start** owns the permission to run each call and the execution:

  1. It tokenizes the command line with POSIX quoting rules and refuses any
     shell syntax.
  2. It checks the call against an effect policy (read-only by default).
  3. It runs the argv without a shell, in the current directory, in its own
     process group, with start's usual environment.
  4. It fingerprints the directory before and after the call.
  5. It returns a receipt wrapped in `<untrusted_context>` to Formal AI.

The loop ends when Formal AI stops asking for tools, when a budget is
exhausted, when a call is refused or fails its readback, or on a signal.

Three properties come from the issue:

- **No fallback.** Without a qualified runtime (a checkout of version
  0.355.27 or newer, or an explicitly unverified URL), start exits `69` before
  anything runs.
- **Truthful status.** A finished run exits with its last tool's status. A
  read is never reported as a change: the outcome message names the tool
  count and the observed file changes.
- **Local evidence.** The log ends with a versioned JSON evidence block. The
  mode never uploads logs or opens issues.

## Requirements and how they are met

| Requirement                                                                                                                                            | Implementation                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ --use-formal-ai -- <request>`, opt-in, behavior unchanged without it                                                                                | `useFormalAi` / `use_formal_ai` in the argument parsers. The request is everything after `--`                                                                                                                                          | `js/test/regression-255-cli.js` and `rust/tests/regression_255.rs`: `keeps everything after -- as request text`, `is off unless requested`; three new `cli-parsing` fixtures in `parity/fixtures/contracts.json` |
| Request never interpreted by a shell or the alias table                                                                                                | The request is sent only to Formal AI. Tool calls run as argv vectors                                                                                                                                                                  | `never applies aliases or a shell to the request`: Formal AI receives the request verbatim, and a HOME canary survives `ls; rm -rf ~`, whose call is refused with `77`                                           |
| Current runtime with exact version and source; never an older one                                                                                      | `formal-ai-runtime.js` / `formal_ai_runtime.rs`: `START_FORMAL_AI_ROOT` (spawned `js/server/main.mjs`), the `0.355.27` minimum, an optional commit pin, and `START_FORMAL_AI_URL` only with `START_FORMAL_AI_ALLOW_UNVERIFIED=1`       | `never qualifies an older, unpinned or unverifiable runtime`; `runs nothing without a qualified runtime` (5 cases, exit `69`, no log written)                                                                    |
| No silent fallback to an LLM, aliases or a shell                                                                                                       | Every runtime error ends with `No command was run: --use-formal-ai never falls back to aliases, a shell or an LLM.`                                                                                                                    | `has no runtime, and no fallback, without configuration`                                                                                                                                                         |
| JS and Rust parity                                                                                                                                     | `formal-ai*.js` mirrored by `formal_ai*.rs`, plus the `formal-ai` feature in `parity/features.json`                                                                                                                                    | Shared receipts (`js/test/fixtures/formal-ai/receipts.json`) are used by both suites, and both suites read the shared golden fixtures                                                                            |
| Preserve cwd, env, cancellation, stdout/stderr and the real exit status                                                                                | Calls run in the cwd with `START_*` env. Stdout and stderr stream to the terminal. SIGINT and SIGTERM stop the call's process group and end with `130`/`143`                                                                           | `ends with the signal status and evidence when cancelled` (CLI, both editions); `cancels the running tool and reports the signal`                                                                                |
| Small, reusable capability set; unsupported or ambiguous requests fail explicitly                                                                      | Read and change tool tables in `formal-ai-policy.js`. Formal AI's `unknown` handler maps to `65`                                                                                                                                       | `fails explicitly when Formal AI does not understand`; `reports unsupported requests explicitly`                                                                                                                 |
| Bounds on steps, retries, output, duration and resources                                                                                               | `START_FORMAL_AI_*` bounds with validated defaults; the server heap is capped                                                                                                                                                          | `stops at the step budget`, `stops at the time budget`, `caps tool output`, `has defaults and validates overrides`                                                                                               |
| Observe before edit, preserve unrelated content, verify by readback                                                                                    | Observation set, before/after fingerprints and `verifyChange`                                                                                                                                                                          | `lets a change name only targets observed before it`, `fingerprints, diffs and reads changes back`, plus the change tests in `regression-255-loop.js`                                                            |
| Inspectable, privacy-conscious evidence                                                                                                                | `=== Formal AI Evidence ===` (`start-formal-ai-evidence/1`): the request, runtime identity, responses, tool decisions, effects, outcome and remaining obligations. Output appears only as previews; the env is not recorded; no upload | `lists the working directory, leaves it unchanged and keeps evidence`                                                                                                                                            |
| A read, plan or echo is not a completed mutation                                                                                                       | The outcome reports tool count and observed effects                                                                                                                                                                                    | `never presents a read as a completed deletion`                                                                                                                                                                  |
| Demo on an isolated fixture with spaces and Unicode, an independent listing and an unchanged directory                                                 | `examples/formal-ai-list-files.sh` and the opt-in `js/test/regression-255-e2e.js`                                                                                                                                                      | `data/demo-formal-ai-0.355.27.log` (real Formal AI 0.355.27)                                                                                                                                                     |
| Offline tests: paraphrases, novel directory, missing or ambiguous paths, unsupported requests, failed tools, cancellation, budgets, malicious contents | Receipts recorded from Formal AI 0.355.27 (`experiments/issue-255/capture-receipts.cjs`) and replayed by a fake server                                                                                                                 | `regression-255-loop.js`; Rust `formal_ai_cases.rs`                                                                                                                                                              |
| Parsing tests: `--`, option-like text, metacharacters, no fallback                                                                                     | Parser and tokenizer tests                                                                                                                                                                                                             | `keeps everything after -- as request text`; `reports shell syntax instead of honouring it`                                                                                                                      |
| Real e2e tests are opt-in only                                                                                                                         | `START_FORMAL_AI_E2E=1` plus `START_FORMAL_AI_ROOT`                                                                                                                                                                                    | `js/test/regression-255-e2e.js` is skipped by default                                                                                                                                                            |
| Rust is not built or tested locally                                                                                                                    | Rust is checked only in CI                                                                                                                                                                                                             | Rust CI on PR #256                                                                                                                                                                                               |
| Docs: status, supported and unsupported behavior, install, logs, resource controls, examples                                                           | `docs/formal-ai.md` and a README section                                                                                                                                                                                               | —                                                                                                                                                                                                                |
| Report Formal AI bugs upstream                                                                                                                         | link-assistant/formal-ai#1501                                                                                                                                                                                                          | `data/paraphrases-formal-ai-0.355.27.log`                                                                                                                                                                        |

## Real runtime results (Formal AI 0.355.27, commit 4d57ec7b)

`data/demo-formal-ai-0.355.27.log` records the issue's request:

- Formal AI asked for `ls`, and start ran it.
- The output matched an independent `ls -1A` of a fixture containing
  `a b.txt`, `ünï cødé.md` and `sub dir`.
- The fixture was unchanged (names, types, sizes and mtimes).
- The run exited `0`, and the evidence block records the runtime identity.

`data/paraphrases-formal-ai-0.355.27.log`
(`experiments/issue-255/paraphrases.sh`) records how paraphrases were handled:

| Request                                    | Formal AI's tool call | start's outcome                                          |
| ------------------------------------------ | --------------------- | -------------------------------------------------------- |
| `print list of files in current directory` | `ls`                  | exit 0                                                   |
| `list files here`                          | `ls`                  | exit 0                                                   |
| `show me the files in this folder`         | `ls`                  | exit 0                                                   |
| `what files are in the current directory`  | `ls`                  | exit 0                                                   |
| `print list of files in corrent directory` | `ls 'corrent'`        | exit 2, `the last tool call failed`                      |
| `delete all files`                         | `ls`                  | exit 0, `finished after 1 tool call(s); no file changed` |

The typo and the misrouted `delete all files` come from Formal AI's
interpretation, not from start. They are reported in
link-assistant/formal-ai#1501, together with:

- `search for TODO` runs `ls`;
- `how many files` runs `pwd`;
- `first 5 lines` runs a full `cat`;
- shell lines are passed through verbatim.

start does not try to correct Formal AI's interpretation. Guessing would be a
fallback, which the issue rules out. Instead, start reports these outcomes
truthfully.

## Remaining items

- **"corrent" typo:** blocked upstream. `print list of files in corrent directory`
  will list the directory once link-assistant/formal-ai#1501 is fixed. Until
  then, start exits with `ls`'s real status (`2`).
- **Released CLI:** verifying the option in a released CLI can only happen after
  this PR is merged and published. The changeset (`minor`) and the Rust
  changelog fragment trigger that release.
