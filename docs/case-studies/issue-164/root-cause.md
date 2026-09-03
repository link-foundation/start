# Root-cause analysis

## 1. The parser destroyed the split the outer shell had already done

`start` is invoked as an ordinary program, so the user's shell has already
tokenised the command line and handed `start` a faithful `argv`. The parser then
threw that structure away:

```js
// js/src/lib/args-parser.js, before the fix
commandArgs = args.slice(i);
return {
  wrapperOptions,
  command: commandArgs.join(' '), // argv boundaries and quoting destroyed here
  rawCommand: commandArgs,        // correct value, never consumed
};
```

`rust/src/lib/args_parser.rs` carried the identical `command_args.join(" ")`.

Every execution path — direct, Docker, screen, tmux, SSH — then passes that
string to `bash -c`, which tokenises it a second time. The second tokenisation
has no way to know which spaces came from the user's quoting and which came from
the join, so:

- `node -e "console.log('hi')"` became `node -e console.log('hi')`; the inner
  shell hit an unquoted `(` and aborted with a syntax error, exit `2`.
- `echo "a  b"` became `echo a  b`; the inner shell collapsed the run of spaces
  during word splitting and `echo` printed `a b`.

The first failure is loud, the second is silent — the same defect, differing
only in whether the re-parsed text happened to remain syntactically valid.

## 2. `rawCommand` was computed and then ignored

The faithful argv was returned by the same function, three lines below the
lossy one. Nothing in either implementation ever read it:

```
$ grep -rn "rawCommand" src/
src/lib/args-parser.js:166: * @returns {{wrapperOptions: object, command: string, rawCommand: string[]}}
src/lib/args-parser.js:245:    rawCommand: commandArgs,
```

So the information needed to do the right thing was never lost inside the
process; it was simply not the value the rest of the code consumed. That is why
the repair is a change of expression rather than a change of data flow.

## 3. #91 fixed one command shape, and only on the isolation paths

Issue #91 reported `bash -i -c "nvm --version"` running as
`bash -i -c nvm --version`. The repair, `isShellInvocationWithArgs` /
`buildShellWithArgsCmdArgs`, is documented as *"everything after `-c` is one
argument (reverses `commandArgs.join(' ')`)"* — an explicit un-flattening of the
damage done by the parser, applied to the single shape it recognises.

Two limits followed from repairing the symptom rather than the cause:

1. It only knows about `<shell> [-flags] -c <script>`. `node -e`, `python -c`,
   `git commit -m "msg with spaces"`, `grep "a b"`, `jq '.a|.b'` were all still
   flattened.
2. It is only reached from the isolation code paths. In the default,
   non-isolated mode the #91 behaviour was still fully present. Because the
   direct path builds `bash -c "<flattened string>"`, `bash -c "echo hello
world"` re-flattens to `bash -c echo hello world`, where `echo` is the script,
   `hello` is `$0` and `world` is `$1` — so it printed an empty line and exited
   `0`. The bug had degraded from a visible syntax error to a silent wrong
   answer.

The un-flattening helper also split on whitespace (`command.split(/\s+/)`),
which is the same assumption that caused the problem: it cannot see quoting
either, so a quoted argument containing a space was miscounted.

## 4. The display path shared the assumption

`buildDisplayCommand` and the `$ …` line in the start block were derived from
the same flattened string, so the terminal echoed a command that was not the one
the user typed and not the one that would run. Fixing only execution would have
left the display showing `$ echo a  b` for a command that now correctly prints
`a  b` — the trace would have kept lying about the boundaries, just in the
opposite direction. The display therefore had to become quote-aware in the same
change.

## Root-cause chain

1. `start` receives a correctly split `argv` from the user's shell.
2. `parseArgs` joins it with single spaces, discarding boundaries and quoting.
3. Every execution path hands the joined string to `bash -c`, which tokenises it
   a second time under different rules.
4. Arguments whose re-parse is invalid fail loudly (`node -e`); arguments whose
   re-parse is merely different fail silently (`echo "a  b"`,
   `bash -c "echo hello world"`).
5. #91 patched one shape of step 4 on one set of paths, which reduced the
   visibility of the defect without removing it.
6. The fix belongs at step 2: rebuild the string so that re-tokenising it yields
   the original argv.

## 5. A second root cause the fix exposed: the shell dialect

The first push turned both Windows CI jobs red while Linux and macOS stayed
green (`data/ci/windows-js-33737072005.log`,
`data/ci/windows-rust-33737071866.log`). The failure is not a flake and not a
narrow escaping slip; it is the same class of mistake as the original bug, one
level down.

`start` does not run commands with `sh -c` on Windows. Both implementations pick
`powershell.exe -Command <string>` there (`rust/src/bin/main.rs`, the shell
selection in `js/src/lib/isolation.js`). PowerShell does not accept the POSIX
way of escaping a quote — closing the string, escaping, reopening — so the
rebuilt line `node -e 'console.log('\''hi'\'')'` is a parser error:

```
At line:1 char:3
+ ''''echo' 'hi''''
+   ~~~~~~~~~~~~~~~~
Unexpected token ''''echo' 'hi'''' in expression or statement.
```

Building a command string is therefore only well defined *relative to a shell*.
The quoting function had silently assumed one shell for every platform, exactly
as the parser had silently assumed one word for every argument. The fix makes
the dialect an explicit parameter that defaults to the host shell, with a
narrower safe-character set for PowerShell (`,` builds an array, `@` splats and
`%` is an alias for `ForEach-Object`).

Two secondary facts came out of the same logs:

- PowerShell prefixes its output with a UTF-8 BOM, so
  `assertion failed: left: "\u{feff}ONE", right: "ONE"`. The BOM is real
  program output on that platform, not a defect in the fix; the assertions strip
  it.
- The pre-existing `echo-integration` tests passed a *shell command string* to
  `execSync`, which `cmd.exe` splits differently from a POSIX shell. Before the
  fix `join(' ')` reassembled whatever `cmd.exe` produced, so `'echo hi'` was
  echoed back as a literal string and the loose `includes('hi')` assertion
  passed by accident. Those tests now pass argv directly, which is what they
  meant to test all along.
