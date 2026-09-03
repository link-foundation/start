# Timeline

All timestamps are UTC. Repository times come from the GitHub metadata retained
in `data/` and from the branch commit history.

1. **Earlier, #84** — `bash` inside `bash` is identified as a problem and
   `isInteractiveShellCommand` is added so an interactive shell invocation is not
   wrapped in another shell.
2. **Earlier, #91** — `bash -i -c "nvm --version"` is reported as running
   `bash -i -c nvm --version`. The repair, `isShellInvocationWithArgs` /
   `buildShellWithArgsCmdArgs`, is written explicitly to *reverse*
   `commandArgs.join(' ')` for that one command shape, and is wired only into
   the isolation code paths. The flattening itself is left in place, so the same
   defect survives everywhere else — and, on the direct path, for `bash -c` too.
3. **2026-09-03 08:22:07** — Issue #164 is filed against `start-command` 0.32.1
   with four reproductions: a loud failure (`node -e "console.log('hi')"`, exit
   `2`), a silent one (`echo "a  b"`), the same pair under Docker isolation, and
   the observation that `bash -c "echo hello world"` is still broken on the
   non-isolated path despite #91. The report also shows that the faithful argv is
   already returned as `rawCommand` and read by nothing.
4. **2026-09-03 08:43:51** — Branch `issue-164-f956a1709ae9` is created and draft
   PR #166 opens at 08:44:05.
5. **Reproduction** — `experiments/issue-164-repro.mjs` runs the six cases
   against the unmodified tree, confirming every reported failure and recording
   that `$ 'ls | wc -l'` works and must keep working (`data/repro-before.log`).
6. **2026-09-03 08:58:05** — The fix lands in one commit across both
   implementations: `buildCommandString` / `build_command_string` in the shared
   shell helpers, the one-expression change in each parser, quote-aware
   tokenising for the #84 and #91 helpers, an honest `$ …` display line, and the
   28-case regression suite in each language. The same harness now shows `hi`,
   `a  b`, `hello world`, `2`, and an unchanged pipeline (`data/repro-after.log`).
7. **Fallout fixed in the same commit** — Two existing expectations encoded the
   old flattened value: `js/test/args-parser-attach-resume.js` and the
   `docker-default-image` entry in `docs/examples/tested-examples.json`. Both are
   updated to the new, correct parse result rather than the fix being narrowed.
8. **2026-09-03 09:00:52** — `docs/USAGE.md` gains an `Argument Boundaries`
   section and `README.md` a pointer to it, stating the trade-off plainly: in the
   multi-argument form a quoted operator such as `$ echo a '&&' echo b` is now a
   literal word, and the documented way to run a shell script is a single quoted
   argument.
9. **2026-09-03 09:01:02** — `js/.changeset/issue-164.md` and
   `rust/changelog.d/164.md` declare a `minor` bump on both packages, because the
   repair is a deliberate, documented behaviour change and not only a bug fix.
10. **Verification** — The full local gate set runs green and is retained in
    `data/`: 866 JavaScript cases, every Rust test binary (29 green
    `test result: ok` lines), the two 28-case focused suites, lint, format, file
    size for both languages, Clippy, `cargo fmt`, both doc-example checks, test
    parity at 105.8%, and changeset validation over the PR diff range.

One derived fact is worth keeping. Step 2 is the reason this defect stayed open
for so long: repairing the symptom on one path made the remaining cases quieter,
not rarer. After #91, `bash -c "echo hello world"` on the direct path exited `0`
and printed an empty line instead of raising a syntax error, which is a strictly
worse failure mode for anyone scripting against it.
