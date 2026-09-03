# Root cause

## What was reported

A command inside `--isolated docker` died of memory exhaustion and `start`
reported it as an ordinary crash: `status executed`, `exitCode 139`, no memory
field of any kind, and a kept-container footer explicitly asserting
`oomKilled=false`.

## Why every consulted signal was correct and useless

`start` learns about memory pressure from the container. A runtime that aborts
on its *own* limit never reaches the container's:

| Signal                                | Reading for a V8 self-abort | Why                                                    |
| ------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `docker inspect .State.OOMKilled`     | `false`                     | The kernel OOM killer never fired.                     |
| cgroup `memory.events` `oom_kill`     | `0`                         | Same reason: the container limit was never reached.    |
| container memory limit                | never hit                   | V8 stops at `--max-old-space-size`, far below it.      |
| exit code                             | `139` / `134`               | SIGSEGV / SIGABRT — identical to an arbitrary crash.   |
| **the runtime's own stderr**          | **`FATAL ERROR: Reached heap limit …`** | The process announces the cause before dying. |

Only the last row carries the information, and only `start` is positioned to
read it before the container filesystem is cleaned up. This is not a defect in
Docker, the kernel or V8; each reports exactly what it observed. The defect is
that `start` consulted only the rows that cannot see this failure mode.

## Why #162's `exitReason` did not already cover it

Issue #162 added `exitReason`, which scans the same log tail for the same V8
marker. Three gaps kept it from answering the question:

1. **Window.** The scan reused `LOG_TAIL_BYTES = 16 KiB`, the width chosen for
   the anchored three-line footer. V8 prints a full native stack trace *after*
   the fatal marker, so a long trace pushes the marker out of that window. The
   incident's marker happened to sit 2 102 bytes from EOF; a deeper stack would
   not have.
2. **Shape.** `exitReason` is a category string
   (`memory-exhaustion (v8-heap-limit)`). A consumer keying off `oomKilled` has
   to know the taxonomy to map that back to "ran out of memory", and it never
   gets the line that proves it.
3. **Reach.** Nothing propagated any of it into the kept-container footer, which
   is the string downstream tooling actually greps, and the attached session's
   message said only "Container kept because the command failed."

So the observation existed in one output field and was contradicted in another,
in the same file, a few lines apart.

## The narrower question

Consumers of `oomKilled` are not asking for a taxonomy. They are asking: *did
this run die of memory exhaustion?* `memoryExhausted` answers exactly that, and
`memoryExhaustedReason` carries the log line that proves it — the same line a
human would point at. `exitReason` remains the category, unchanged.

## The discipline that constrains the fix

#148 and #151 settled that `State.OOMKilled` is an observation and never a
verdict. The same rule governs here, and it cuts both ways:

- The observation is attached only for an abnormal exit. A log that merely
  *quotes* `FATAL ERROR: Reached heap limit …` — an `rg` dump, a copied incident
  report, this very case study — cannot turn a successful run into a reported
  memory failure.
- The observation never rewrites `status`, `exitCode` or `oomKilled`.
  `oomKilled=false` stays `false`, because it is a true statement about the
  cgroup. What changes is that it is no longer the *only* thing said.
