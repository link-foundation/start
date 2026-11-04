# Issue #261 experiments

These scripts talk to a real Formal AI runtime. Point `START_FORMAL_AI_ROOT` at
a [link-assistant/formal-ai](https://github.com/link-assistant/formal-ai)
checkout. The receipts in the tests were recorded with 0.355.32
(`08ca27d1ee0560fb56450ad798f3a79c684404ed`).

- `repro.sh` runs the exact reproduction from the issue through the CLI.
  `draft.txt` holds `draft\n`, `verified-source.txt` holds `verified\n`, and
  the request is `In draft.txt, replace «draft» with «verified».`. It prints
  the exit status, both files' bytes and the evidence steps and outcome.

  ```bash
  START_FORMAL_AI_ROOT=/path/to/formal-ai experiments/issue-261/repro.sh
  ```

- `frame-roundtrip.mjs` checks that Formal AI's own source-read parser
  (`sourceReadObservation` in `js/agentic/tool_result.mjs`) decodes start's
  read frame back to the exact text, with Unicode, CRLF and missing final
  newlines, and treats it as a complete whole-file Read. The runtime's
  OpenAI-compatible request parser drops any other metadata on a tool
  message, so the frame is the only binding of a Read that Formal AI accepts.

  ```bash
  node experiments/issue-261/frame-roundtrip.mjs /path/to/formal-ai
  ```

- `capture-receipts.cjs` runs each held-out request through start's real
  task loop on a fresh fixture, with the tools offered for its effect mode. It
  writes the responses, tool steps, outcomes and resulting file bytes to
  `js/test/fixtures/formal-ai/receipts-261.json`. Format that file with
  prettier afterwards. The offline tests replay it in JavaScript
  (`js/test/regression-261.js`) and Rust
  (`rust/src/lib/formal_ai_261_cases.rs`,
  `rust/src/lib/formal_ai_261_loop_cases.rs`, `rust/tests/regression_255.rs`).

  ```bash
  START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-261/capture-receipts.cjs
  ```

Findings with Formal AI 0.355.32:

| Held-out case                 | Effects         | Calls                          | Outcome                                                         |
| ----------------------------- | --------------- | ------------------------------ | --------------------------------------------------------------- |
| issue reproduction            | workspace-write | `read`, `edit`, `sha256sum`    | exit 0; `draft.txt` is `verified\n`, the source is unchanged    |
| issue reproduction            | read-only       | `read`                         | capability gap (missing `edit`), exit 65                        |
| mismatched OLD                | workspace-write | `read`                         | exit 0, no file changed; Formal AI answers in prose             |
| repeated occurrences          | workspace-write | `read`, `perl -pi …` (refused) | exit 77; no shell fallback, the file is unchanged               |
| Unicode and CRLF              | workspace-write | `read`, `edit`, `sha256sum`    | exit 0; only the word changes                                   |
| symlinked path (inside)       | workspace-write | `read`, `edit`, `sha256sum`    | exit 0; the file the link points to changes                     |
| symlink leaving the workspace | workspace-write | `read` (refused)               | exit 77; nothing outside is read                                |
| foreign path (`../`)          | workspace-write | none                           | `obligation_gap` (`no_artifact_in_clause`), incomplete, exit 65 |

Stale reads, failed receipts, concurrent changes and an `edit` whose
`old_string` is missing or repeated cannot be produced by Formal AI on demand.
The unit tests drive them with scripted tool calls in both languages.

The mismatched-OLD case ends 0 with `no file changed`. Formal AI states the
mismatch in prose instead of calling `edit` or answering with a gap record,
so start has no failure to keep. This is a limit of Formal AI, and start does
not reinterpret its prose.
