# Root-cause analysis

## 1. The recovery surface stopped at inspection

The CLI already tracked everything needed to recover a session. `--status`
reads the record, `--list` enumerates records, `--upload-log` publishes the log,
`--stop` and `--terminate` end a session. Every one of those verbs either reads
state or destroys it. None of them re-enters a session.

That asymmetry was invisible while sessions succeeded. It only became a defect
for long-running detached work, where the container's _filesystem_ — the
checkout, the caches, the intermediate artifacts — is worth more than the
command that produced it. Once the command died, the CLI could describe the
asset in detail and do nothing with it.

## 2. The printed guidance was wrong for the case that printed it

The retained-container message was:

```
Inspect: docker exec -it <name> sh (if running) or docker start -ai <name>
```

Both halves fail for a crashed detached session. `docker exec` requires a
running container, and the parenthetical "(if running)" concedes it does not
apply. `docker start -ai` does work on a stopped container, but it restarts the
original entrypoint: for a multi-hour task, it discards the very state the
retention policy preserved.

The guidance was not incorrect about Docker. It was correct about Docker and
useless about the situation, because there was no better answer to point at.
Adding the verbs is what makes better guidance possible, which is why the
message change and the implementation are the same fix.

## 3. Restarting the supervisor orphaned in-flight work

A detached docker execution is completed by a watcher process — it follows the
container logs, inspects the exit code, and appends the log footer. That watcher
is a child of the launching process. When the supervisor host restarted, every
watcher died with it. The containers kept running, but nothing streamed their
output into the session logs any more and nothing would ever write a footer, so
the records stayed `executing` forever.

A restarted supervisor could enumerate those records with `--list`, but had no
primitive to reconnect them. In the reported incident this is exactly the
six-hour gap between the 14:07 crash and the 20:14 inspection: the work was
recoverable the whole time and nothing surfaced it.

This also explains why `--resume-all` must not restart commands. Two distinct
states were conflated as "running": a container that is genuinely still working
and merely lost its watcher, and a container that already finished while nobody
was listening. Restarting the first would duplicate work; restarting the second
would discard results. The repair is to re-establish observation
(`reattached`) or finalize from existing evidence (`reconciled`), and to leave
the decision to actually continue work as an explicit, per-session `--resume`.

## 4. `exitCode 139` and `oomKilled false` were each correct and jointly misleading

`exitCode 139` is `128 + 11`, i.e. SIGSEGV. `oomKilled` mirrors Docker's
`State.OOMKilled`, which reflects the kernel/cgroup OOM killer — and that killer
genuinely did not fire (`oom_kill=0`, 9.1 GB of 11.7 GB free). Neither field is
wrong.

The run nevertheless died of memory exhaustion. V8 enforces its own heap limit
well below the cgroup limit; when it is reached, the process aborts _itself_:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

A self-abort never involves the kernel OOM killer, so the correct value of
`oomKilled` for a V8 heap-limit death is `false`. Presented next to a segfault
exit code, that reads as "not a memory problem" — the exact opposite of the
truth. Issues #148 and #151 had already established that `State.OOMKilled` is an
observation and never a verdict; this incident shows that an observation with no
accompanying explanation is read as a verdict anyway.

The evidence was already in hand: the wrapper reads the tail of the log to find
the exit-code footer. The same tail contains the fatal marker. Nothing new had
to be captured, only reported — which is why `exitReason` is a hint that leaves
`status`, `exitCode` and `oomKilled` untouched rather than a correction that
overrides them.

## Root-cause chain

Detached isolation preserved the container by design → the CLI offered only
inspect-and-destroy verbs → a crashed session's filesystem became unreachable →
the fallback guidance pointed at Docker commands that either cannot run or
restart from zero → meanwhile the supervisor restart killed every completion
watcher → records stuck in `executing` with no primitive to reconnect them →
and the one signal consumers did have, `exitCode 139` beside `oomKilled false`,
pointed away from the actual cause.
