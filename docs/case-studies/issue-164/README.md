# Case Study — Issue #164: the shell got a string where argv was meant

- Issue: https://github.com/link-foundation/start/issues/164
- Pull request: https://github.com/link-foundation/start/pull/166
- Related prior work: #84 (avoid `bash` inside `bash`), #91 (`bash -i -c "nvm --version"`)

## Result

`parseArgs` rebuilt the command as `commandArgs.join(' ')`, so the argv the
outer shell had already split was flattened back into one string and re-split by
the inner `bash -c`. Everything the user quoted was lost:

| Command                             | Before                                   | After  |
| ----------------------------------- | ---------------------------------------- | ------ |
| `$ node -e "console.log('hi')"`     | `bash: syntax error near ... ('` exit `2` | `hi`   |
| `$ echo "a  b"`                     | `a b` (one space)                        | `a  b` |
| `$ bash -c "echo hello world"`      | empty line, exit `0`                     | `hello world` |
| `$ bash -c "echo $((1+1))"`         | empty line, exit `0`                     | `2`    |

The faithful argv was already returned three lines away as `rawCommand` and was
never read by anything. The fix makes the rebuild lossless instead of adding a
second source of truth: one argument is still a verbatim shell script, several
arguments are shell-quoted element by element, so the inner shell reproduces
exactly the argv the user typed.

The same one-line defect existed in both implementations
(`js/src/lib/args-parser.js`, `rust/src/lib/args_parser.rs`) and is fixed in
both, so every downstream consumer — direct execution, Docker, screen, tmux,
SSH and the command-stream path — inherits the repair from one place.

## Documents

| File              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `requirements.md` | Complete requirement inventory and disposition.                      |
| `timeline.md`     | Event sequence from the earlier partial fixes to this repair.        |
| `root-cause.md`   | Why the flattening survived #91, and what it broke on each path.     |
| `solutions.md`    | Alternatives considered, the selected design, and the verification.  |
| `data/`           | Issue, PR, diff, and local verification evidence.                    |

## Evidence highlights

- `data/issue-164.json` records the report verbatim, including the four
  reproductions and the `grep -rn "rawCommand" src/` output showing the correct
  value was computed and discarded.
- `data/repro-before.log` and `data/repro-after.log` are the same harness
  (`experiments/issue-164-repro.mjs`) run against the unmodified tree and the
  fixed tree.
- `data/js-focused-test.log` and `data/rust-focused-test.log` record the two new
  regression suites (28 cases each), which drive the real CLI end to end for the
  reported failures and for the single-argument script form that must keep
  working.
- `data/local-js-full.log` and `data/local-rust-full.log` record the full local
  suites; `data/local-test-parity.log` shows the Rust-to-JavaScript case ratio
  against the required 90% minimum.
- `data/branch-diffstat.txt` shows the change is small and central: the parser
  fix is one expression per implementation, the rest is the shared quoting and
  tokenising helper, the display path, tests and documentation.

No upstream defect was filed. `bash -c` behaves exactly as specified; the defect
was this project's decision to hand it a string it had itself un-quoted.
