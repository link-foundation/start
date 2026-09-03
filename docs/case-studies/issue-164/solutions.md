# Solutions and verification

## Selected solution

### Rebuild the command so re-tokenising it yields the original argv

The parser now produces a string that survives one round of shell tokenisation:

```js
function buildCommandString(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '';
  return argv.length === 1 ? argv[0] : argv.map(quoteShellArg).join(' ');
}
```

The single-versus-multiple distinction is the whole disambiguation, and it
matches how the tool is already documented:

- **One argument** — the user quoted an entire shell script
  (`$ 'ls | wc -l'`). It is passed through verbatim, exactly as before, so every
  pipeline, redirection and `&&` in that form keeps working.
- **Several arguments** — the outer shell already split them, so each element is
  one argument. Quoting each element makes the inner shell reproduce that split.

`quoteShellArg` leaves POSIX-safe words (`[A-Za-z0-9_@%+=:,./^-]+`) untouched
and wraps anything else in single quotes, escaping embedded single quotes as
`'\''`. Minimal quoting matters beyond aesthetics: the natural-language
substitution engine matches rules against the command string, so quoting words
that do not need it would stop `start install lodash npm package` from matching
`install $packageName npm package`.

The Rust side mirrors the helper exactly (`is_safe_arg`, `quote_shell_arg`,
`build_command_string` in `rust/src/lib/isolation_shell.rs`), keeping the two
implementations behaviourally identical.

### Fix it once, in the parser

Both implementations changed one expression:

```js
command: buildCommandString(commandArgs),   // was commandArgs.join(' ')
```

```rust
command: crate::isolation::build_command_string(&command_args), // was join(" ")
```

Everything downstream consumes `command`, so direct execution, Docker, screen,
tmux, SSH and the command-stream path are all repaired by that one change. No
consumer had to learn about a second field.

### Make the shell-detection helpers quote-aware

`isInteractiveShellCommand` (#84) and `isShellInvocationWithArgs` /
`buildShellWithArgsCmdArgs` (#91) split the command on whitespace, which is the
assumption that caused this defect. They now tokenise with `splitShellWords`, a
quote- and backslash-aware splitter that returns `null` on unbalanced quotes so
callers can fall back to treating the input as an opaque script. This keeps
#91's guarantee — a `<shell> -c <script>` invocation is never wrapped in another
shell — correct for scripts that contain quoted spaces.

### Make the displayed command honest

`buildDisplayCommand` now re-derives the `$ …` line from tokens rather than from
raw text, preferring double quotes so the trace reads the way a user would type
it: `$ node -e "console.log('hi')"`, `$ echo "a  b"`. When the command is a
single verbatim script (`buildCommandString(words) !== command`), it is printed
as-is instead of being re-quoted, so pipelines still display literally.
`getCommandName` uses the same tokeniser, so the command name recorded for a
quoted invocation is the program, not a fragment of an argument.

## Alternatives considered

### Consume `rawCommand` everywhere and pass argv without a shell

Rejected. The shell is not incidental here: single-argument scripts, the
substitution engine, the log header, `--status` output and every isolation
backend are defined in terms of a command *string*. Threading an argv array
through Docker, screen, tmux and SSH would have been a far larger change with
more places to get the quoting wrong, and it would have broken the documented
`$ 'ls | wc -l'` form outright.

### Retire `buildShellWithArgsCmdArgs`, as the issue suggested

Rejected, though the reasoning in the issue is sound. Correct quoting means the
inner shell would now receive `bash -c 'echo hello world'` faithfully, so the
helper is no longer needed to *repair* anything. It is still needed to *avoid*
the double wrapping #84 and #91 are about: without it, `start bash -c "…"` runs
`bash -c "bash -c '…'"`. Keeping it — but rebuilt on the tokeniser — preserves
both earlier guarantees and all of their tests.

### Quote every argument unconditionally

Rejected. It is simpler, but it breaks the substitution engine, which matches
natural-language rules against the command string, and it makes every log line
and status record noisier than what the user typed.

### Gate the change behind `--no-quote-args`

Rejected as the default-preserving option the issue offered. The lossy behaviour
is a defect, not a feature, and an opt-out flag would keep two tokenisation
models alive in both implementations forever. The escape hatch already exists
and is documented: pass the whole script as one argument.

### Accept the trade-off explicitly

`$ echo a '&&' echo b` now prints `a && echo b` instead of running two commands.
That form only ever worked because of the flattening defect. The documented way
to run a shell script is a single quoted argument, `$ 'echo a && echo b'`, which
is unchanged. `docs/USAGE.md#argument-boundaries` states this in the
documentation rather than leaving users to discover it, and the changesets
declare a `minor` bump on both packages for the behaviour change.

## Automated verification

`js/test/regression-164.js` and `rust/tests/regression_164.rs` (28 cases each)
cover the same ground in both implementations:

- `parseArgs` / `parse_args` keep boundaries for `echo "a  b"`, `node -e …`,
  `git commit -m "msg with spaces"`, and leave a single-argument script verbatim.
- `quoteShellArg` leaves safe words alone and escapes embedded single quotes.
- `splitShellWords` round-trips quoted input and reports unbalanced quotes.
- The shell-detection helpers still classify `bash -c "echo hello world"`
  correctly now that the script contains quoted spaces.
- End-to-end runs of the real CLI reproduce each failure from the issue:
  `node -e "console.log('hi')"` prints `hi`, `echo "a  b"` prints two spaces,
  `bash -c 'echo hello world'` prints the words, `bash -c 'echo $((1+1))'`
  prints `2`, and `'echo one | tr a-z A-Z'` still runs as a pipeline.
- The `$ …` line shows the user's quoting rather than the flattened string.

`js/test/args-parser-attach-resume.js` asserted the old flattened value for a
resume command; its expectation is updated to `echo 'hello world'` with a
reference to this issue. `docs/examples/tested-examples.json` is updated for the
same reason, so `scripts/check-doc-examples.mjs` verifies the new parse result.

The full local gate set is retained in `data/`: both full suites, lint, format,
Clippy, file size, both doc-example checks and test parity.
