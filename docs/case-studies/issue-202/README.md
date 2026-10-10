# Shell command boundaries and exit codes: issue #202

## Evidence and sequence

The [issue](https://github.com/link-foundation/start/issues/202) was opened at
2026-10-10 11:25:19 UTC and reproduces against 0.35.4 and main commit `2f4273d`.
The full issue and comments are saved in `data/`, together with linked
[#91](https://github.com/link-foundation/start/issues/91) and
[#164](https://github.com/link-foundation/start/issues/164). Issue #91 established
direct execution for an explicitly quoted `bash -i -c "nvm --version"`; #164
established Docker exit-code propagation. The new incident showed that argument
reconstruction could invalidate that exit-code evidence before execution.

The old detector found `-c` anywhere after a shell name. Its builder joined every
following word into one script. Thus `sh -c 'exit 7'; echo after $?` became one
script exiting 7, and positional arguments became script text. Its display
function used the same rewrite even outside Docker. The JavaScript Docker paths
used the faulty builder, while native Docker execution unconditionally wrapped
commands and did not preserve the existing direct-shell behavior.

Reproducing tests were added before the fix. The combined issue #201/#202 suite
initially failed 20 of 22 tests. Focused tests passed after the fix, and a real
attached Alpine Docker execution printed `after 7` and returned zero.

## Every requirement and proposed solutions

| Requirement | Alternatives considered | Applied solution and verification |
| --- | --- | --- |
| Recognize direct `<shell> [flags] -c <script> [arg0 [args...]]` only | Full shell AST; string split; conservative literal-word scanner | Reuse the existing word lexer with a conservative operator/expansion check; flags must precede `-c` and a script must exist |
| Never absorb unquoted operators or redirections | Reject all such commands; delegate them to an outer shell | `;`, `&&`, `||`, pipes, background, redirections, subshell/group operators and newlines keep the complete original command line |
| Keep script and each positional argument separate | Join remaining words; retain literal argv | Builders preserve script, `$0`, `$1`, spaces and empty argument boundaries |
| Preserve quoting and expansion semantics | Expand variables in the wrapper; defer expansion | Single-quoted literals are safe to split; active substitutions, globbing and ambiguous syntax go to the selected outer shell |
| Compound command prints `after 7`, exits zero | Mock exit value; execute real shell | Automated tests execute the selected argv and verify output and status |
| `sh -c 'echo $0 $1' a b` prints `a b` | Rewrite into script; retain argv | Both language regression suites execute this exact form |
| Killed inner command returns 137 | Assume any signal-like text implies a kill; execute bounded process | A child shell kills only its own PID and the outer shell returns its actual status; tests verify 137 |
| Quoted `bash -i -c "nvm --version"` still executes directly | Always wrap; preserve validated direct invocation | Existing #91 fixtures now use correctly quoted scripts and new regressions preserve direct argv |
| Fix attached, detached, and display behavior across implementations | Patch one Docker mode; shared helpers everywhere | Both native Docker modes and both JavaScript modes use corrected classification; display preserves compound command text |
| Preserve case-study evidence, investigate components, and report demonstrated upstream defects | Speculative dependency report; inspect actual ownership | Raw linked issues, regression logs and this analysis identify a local rewriting defect, with no reproduced upstream shell defect |

The scanner deliberately delegates syntax that requires shell evaluation rather
than attempting to implement expansion. Escaped operator characters and literal
single-quoted contents retain their meaning. Backslash/newline continuation also
goes through the outer shell. A keep-alive suffix makes a command compound and
therefore cannot be folded into an inner `-c` script.

## Primary references and component comparison

The [Bash invocation manual](https://www.gnu.org/software/bash/manual/bash.html#Invoking-Bash)
specifies that the first argument after the command string becomes `$0` and the
rest become positional parameters. The
[POSIX shell specification](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/sh.html)
defines shell command-line evaluation and operators. These semantics require
preserving both command-string and argument boundaries.

[shell-quote](https://github.com/ljharb/shell-quote) offers JavaScript tokenizing
and quoting, including operator tokens. It would be useful for a JavaScript-only
solution, but its expansion behavior and lack of an equivalent native parser
would need additional parity work. The existing scanners are sufficient when
they conservatively send evaluation back to the actual shell. A complete shell
parser or AST library would add substantial syntax and dialect dependencies
without removing the need to invoke that shell.

## Reproduction and verification

`js/test/regression-202.js` and `rust/tests/regression_202.rs` cover the exact
reported forms, every requested operator, missing script, misplaced `-c`, empty
positional arguments, literal escaping, and direct #91 behavior. The retained
Docker experiment in `experiments/` exercises the actual Docker execution paths.
Only child processes are signaled; no host-memory or stack stress is needed.
