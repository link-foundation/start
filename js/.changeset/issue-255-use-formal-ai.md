---
'start-command': minor
---

Add the experimental `--use-formal-ai` mode: `$ --use-formal-ai -- <request>` sends a natural-language request to a local Formal AI runtime and runs the tool calls it chooses (#255).

- **Opt-in only:** without the flag nothing changes. The request after `--` is never read by a shell or the alias table. Without a qualified runtime (Formal AI 0.355.27 or newer, from `START_FORMAL_AI_ROOT` or an explicit `START_FORMAL_AI_URL`), start exits 69 and runs nothing. There is no fallback to aliases, a shell or an LLM.
- **Tools:** a small read-only set of programs, run without a shell. It includes `ls`, `cat`, `head`, `tail`, `wc`, `find`, `grep`, `sort`, `diff`, `stat`, `tree`, `du` and read-only `git` (see docs/formal-ai.md). Changes (`mkdir`, `touch`, `rmdir`, `rm`, `cp`, `mv`) need `START_FORMAL_AI_EFFECTS=workspace-write`; a change may only name targets observed before it and is verified by readback. Shell syntax, other programs and paths outside the working directory are refused (exit 77).
- **Bounds:** steps, retries, total time, per-tool time, output bytes and request length (`START_FORMAL_AI_*`). Exhausted budgets exit 124 and unsupported requests exit 65. A cancelled run ends with the signal status.
- **Evidence:** the log records the runtime identity, every response, tool decision, exit status and file-system effect. The log stays local: this mode never uploads logs or creates issues. Tool output appears in the evidence only as a short preview, and the environment is not recorded.
- **Dependencies:** `lino-objects-codec` 0.9.4 and `eslint` 10.14.0; CI runs on Node.js 26.
