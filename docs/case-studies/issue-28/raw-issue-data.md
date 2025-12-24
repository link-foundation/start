# Issue #28 Raw Data

## Issue Title

Can we somehow overcome the need of `'` quotes with `|` and `"` in a sequence?

## Issue State

OPEN

## Issue Labels

bug, documentation, enhancement, question

## Issue Author

konard

## Issue Content

The issue shows two terminal sessions demonstrating different behaviors:

### Session 1: Without quoting the entire command

```bash
konard@MacBook-Pro-Konstantin ~ % $ echo "hi" | agent
```

**Result:** The `echo "hi"` command ran directly in the shell, and only its OUTPUT was piped to `agent`. The agent then processed the log file that was created by the `$` command (start-command), not the original command input.

The agent received the OUTPUT of `$ echo "hi"` which was captured in a log file, and then read that log file.

### Session 2: With quoting the entire command

```bash
konard@MacBook-Pro-Konstantin ~ % $ 'echo "hi" | agent'
```

**Result:** The entire string `echo "hi" | agent` was passed TO the `$` command (start-command). The start-command then executed this complete pipeline, which resulted in the `echo "hi"` output being piped to `agent` correctly.

## Terminal Logs

### Session 1 Output (problematic behavior)

```json
{
  "type": "status",
  "mode": "stdin-stream",
  "message": "Agent CLI in continuous listening mode. Accepts JSON and plain text input.",
  "hint": "Press CTRL+C to exit. Use --help for options.",
  "acceptedFormats": ["JSON object with \"message\" field", "Plain text"],
  "options": {
    "interactive": true,
    "autoMergeQueuedMessages": true,
    "alwaysAcceptStdin": true,
    "compactJson": false
  }
}
```

The agent then read a log file:

```
=== Start Command Log ===
Timestamp: 2025-12-24 15:07:08.894
Command: echo hi
Shell: /bin/zsh
Platform: darwin
Bun Version: 1.2.20
Working Directory: /Users/konard
==================================================

hi

==================================================
Finished: 2025-12-24 15:07:08.906
Exit Code: 0
```

And responded:

> "It looks like you executed the command `echo hi`, which successfully output \"hi\" with exit code 0..."

### Session 2 Output (desired behavior)

The agent received "hi" directly as input and responded:

> "Hello! How can I help you today?"

## User Request

> Please download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder, and use it to do deep case study analysis (also make sure to search online for additional facts and data), in which we will reconstruct timeline/sequence of events, find root causes of the problem, and propose possible solutions.
