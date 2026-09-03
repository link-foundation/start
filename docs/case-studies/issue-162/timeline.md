# Timeline

All timestamps are UTC. Incident times are quoted from issue #162; repository
times come from the GitHub metadata retained in `data/`.

1. **Incident, day 0** — A detached Docker-isolated command starts under
   execution `0ea1c630-cfdf-477e-8528-29d175a7fe64`, container/session name
   `dd1acfbe-3c01-4ffa-8c78-f825457f5813`.
2. **Incident, ~28 hours later, 14:07** — The launched Node process aborts with
   `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
memory`. The wrapper records `exitCode 139` and `oomKilled false`. Both
   values are accurate: the cgroup OOM killer never fired (`oom_kill=0`, 9.1 GB
   of 11.7 GB still free), so the kernel-level flag is correctly false.
3. **Incident, 14:07–20:14** — Nothing acts on the failure. The supervisor that
   launched the session had itself restarted, and no primitive existed to
   enumerate and reconnect in-flight work, so six hours pass silently.
4. **Incident, 20:14** — An operator inspects the record. The container is still
   present with a 27 GB writable layer holding the complete working tree. The
   only guidance printed was `docker exec -it <name> sh (if running) or docker
start -ai <name>`. `docker exec` fails because the container is stopped, and
   `docker start -ai` would re-run the original entrypoint from scratch,
   discarding a day of work.
5. **2026-09-02 20:24:09** — Issue #162 is filed, requesting `--attach`,
   `--resume [-- <command>]`, `--resume-all`, `--list --running`, and an
   `exitReason` hint for logs that show memory exhaustion.
6. **2026-09-02 20:24:20** — A comment names the downstream consumer,
   link-assistant/hive-mind#2189: a Telegram bot that recovers a tool session id
   from a killed run but has no way to re-enter the preserved container.
7. **2026-09-03 06:36:58** — Draft PR #163 opens from branch
   `issue-162-9b675d4abc32`, based on `013a4c8` (`rust-v0.19.2`), which already
   contains the published 0.32.1 JavaScript and 0.19.2 Rust releases.
8. **PR #163, JavaScript** — Option parsing, the attach/resume/resume-all
   implementations, session probing, exit-reason detection, the retained-container
   guidance change, and the `regression-162` end-to-end suite land first, so the
   reference behaviour exists before the port.
9. **PR #163, Rust** — The same surface is ported module by module: query option
   parsing, session probing and attach planning, resume and resume-all with
   hermetic `ResumeHooks` injection, then the CLI wiring through a new
   `query_commands` dispatcher, plus the 14-case `regression_162` suite.
10. **PR #163, documentation** — The shared README, `docs/USAGE.md` and both
    per-implementation READMEs gain the new verbs; the npm changeset and the
    Rust changelog fragment declare a minor bump for each package.
11. **PR #163, verification** — The full local gate set runs green and is
    retained in `data/`: 838 JavaScript cases, 245 Rust library cases plus every
    integration binary, lint, format, Clippy, file-size, both doc-example
    checks, test parity at 106.0%, and changeset validation.

Two derived facts are worth keeping. First, the six-hour silence in step 3 is
the direct motivation for `--resume-all`: the work was recoverable the entire
time and nothing surfaced it. Second, the container in step 4 was retained by
design, so the container filesystem — not the command — is the asset worth
resuming, which is why `--resume <id> -- <command>` is the primary form rather
than a convenience.
