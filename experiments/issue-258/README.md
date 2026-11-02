# Issue #258 experiments

These scripts talk to a real Formal AI runtime. Point `START_FORMAL_AI_ROOT` at
a [link-assistant/formal-ai](https://github.com/link-assistant/formal-ai)
checkout. The receipts in the tests were recorded with 0.355.29.

- `probe-tools.cjs` sends one edit request with different advertised tool
  sets (Bash only, Bash and read, the full read/edit/write set, and others),
  then prints the raw replies.

  This is how we found the cause of #258. With only `bash` offered, Formal AI
  answers with `workspace-edit-capability-gap/v1` (`EditToolUnavailable`,
  missing `read` and `edit`). With `read` and `edit` offered, it calls them.

  ```bash
  START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-258/probe-tools.cjs
  ```

- `capture-receipts.cjs` runs each #258 request through start's real task loop
  on a fresh copy of the fixture, under both effect modes and both tool
  contracts. It writes the responses, tool steps, outcomes and resulting file
  text to `js/test/fixtures/formal-ai/receipts-258.json`.

  The offline tests replay that file in JavaScript (`js/test/regression-258.js`)
  and in Rust (`rust/src/lib/formal_ai_gap_cases.rs`). The receipts contain no
  host paths, environment or credentials.

  ```bash
  START_FORMAL_AI_ROOT=/path/to/formal-ai node experiments/issue-258/capture-receipts.cjs
  ```

Findings with Formal AI 0.355.29:

| Request                                        | Effects / tools             | Outcome                                                                         |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| issue wording (`replace the before label ...`) | workspace-write, Bash only  | capability gap, exit 65 (start 0.41.0 reported `answered`, 0)                   |
| issue wording                                  | workspace-write, file tools | `read`, then an `edit` whose `old_string` is not in the file: exit 1, no change |
| literal `«const label = "before";»` wording    | workspace-write, file tools | `read`, `edit`, `sha256sum`: only the declaration changes, exit 0               |
| literal wording                                | read-only                   | capability gap (missing `edit`), exit 65, with the remedy                       |
| `show contents of snippet.mjs`                 | read-only                   | `read`, exit 0, no change                                                       |
| `What is 2 + 2?`                               | read-only, either contract  | answered, exit 0                                                                |

The looser wording failing is a limit of Formal AI's argument extraction, not
of start. start still reports it truthfully with the real status and no
change. See [`examples/formal-ai-edit-file.sh`](../../examples/formal-ai-edit-file.sh)
for an end-to-end demo.
