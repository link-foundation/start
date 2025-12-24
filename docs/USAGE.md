# start-command Usage Guide

This document provides detailed guidance on using the `$` command effectively, including important information about shell quoting and special characters.

## Table of Contents

- [Quick Start](#quick-start)
- [Shell Quoting and Piping](#shell-quoting-and-piping)
- [Command Examples](#command-examples)
- [Troubleshooting](#troubleshooting)

## Quick Start

The `$` command wraps any shell command with automatic logging and failure reporting:

```bash
$ echo "Hello World"
$ npm test
$ git status
```

## Shell Quoting and Piping

### Understanding the Issue

When using the `$` command with pipe operators (`|`) or other shell metacharacters, the shell parses these operators **before** passing arguments to `$`. This is standard POSIX shell behavior.

**Example of unexpected behavior:**

```bash
$ echo "hi" | grep "h"
```

What you might expect:
- `$` receives `echo "hi" | grep "h"` as a single command
- The pipeline executes inside `$`

What actually happens:
- Shell parses the command line first
- `$ echo "hi"` runs as one command
- Its output is piped to `grep "h"` (a separate command)
- `grep` receives the JSON/log output from `$`, not "hi"

### Shell Metacharacters

The following characters are interpreted by the shell before reaching `$`:

| Character | Name             | Purpose                              |
| --------- | ---------------- | ------------------------------------ |
| `\|`      | Pipe             | Connects stdout to stdin             |
| `&`       | Background       | Runs command in background           |
| `;`       | Semicolon        | Command separator                    |
| `&&`      | AND              | Run next command if previous succeeds|
| `\|\|`    | OR               | Run next command if previous fails   |
| `>`       | Redirect         | Redirect stdout to file              |
| `<`       | Input            | Read input from file                 |
| `$`       | Variable         | Variable expansion                   |
| `` ` ``   | Backtick         | Command substitution                 |
| `*?[]`    | Globs            | Filename expansion                   |

### Solution: Use Single Quotes

To pass a complete command including pipes and special characters to `$`, wrap the entire command in **single quotes**:

```bash
# Correct - the entire pipeline is passed to $
$ 'echo "hi" | grep "h"'

# Correct - command with background process
$ 'sleep 5 && echo "done"'

# Correct - command with output redirection
$ 'ls -la > files.txt'
```

### Quoting Rules Summary

| Quote Type      | Behavior                                      | Use When                                     |
| --------------- | --------------------------------------------- | -------------------------------------------- |
| `'single'`      | Everything is literal, no expansion           | Preserving pipes, special chars exactly      |
| `"double"`      | Variables expand, some escaping needed        | Need variable expansion inside               |
| `$'...'`        | ANSI-C quoting, escape sequences work         | Need escape sequences like `\n`, `\t`        |
| `` `...` ``     | Command substitution (old style)              | Capturing command output (prefer `$()`)      |

### Examples with Different Quote Styles

```bash
# Single quotes - everything literal
$ 'echo "hello" | wc -c'

# Double quotes - variables expand
$ "echo $HOME | wc -c"      # $HOME expands first!

# Double quotes with escaping
$ "echo \$HOME | wc -c"     # \$ keeps it literal

# No quotes - command split by pipes
$ echo "hello" | wc -c      # Piped incorrectly!
```

### Visual Diagram

```
Without quotes:
    $ echo "hi" | agent
    └───┬────┘   └──┬──┘
        │           │
   Command 1    Command 2
   (runs first)  (receives $ output)

With single quotes:
    $ 'echo "hi" | agent'
    └─────────┬──────────┘
              │
        Single command
        (pipeline runs inside $)
```

## Command Examples

### Simple Commands (No Quoting Needed)

```bash
$ ls -la
$ npm test
$ git status
$ echo "hello world"
```

### Commands with Pipes (Quoting Required)

```bash
$ 'cat file.txt | grep pattern'
$ 'ps aux | grep node'
$ 'npm list | head -20'
$ 'echo "hello" | tr "a-z" "A-Z"'
```

### Commands with Redirection (Quoting Required)

```bash
$ 'echo "data" > output.txt'
$ 'cat < input.txt'
$ 'npm test 2>&1 | tee test.log'
```

### Commands with Logical Operators (Quoting Required)

```bash
$ 'npm install && npm test'
$ 'command1 || command2'
$ 'test -f file && cat file'
```

### Commands with Background Processes (Quoting Required)

```bash
$ 'npm start &'
$ 'sleep 10 && echo "done" &'
```

### Commands with Variables

If you need variable expansion:

```bash
# Variable expands BEFORE $ sees it (usually what you want)
$ echo "$HOME"

# Variable is passed literally to $ (rare use case)
$ 'echo $HOME'
```

### Complex Commands

```bash
# Full pipeline with multiple stages
$ 'cat access.log | grep "404" | awk "{print \$1}" | sort | uniq -c | sort -rn | head -10'

# Command substitution inside
$ 'echo "Today is $(date)"'

# Multiple commands in sequence
$ 'cd /tmp && ls -la && pwd'
```

## Troubleshooting

### Problem: Pipe Output Goes to Wrong Place

**Symptom:** You run `$ command1 | command2` and command2 receives unexpected output.

**Solution:** Wrap in single quotes: `$ 'command1 | command2'`

### Problem: Variables Not Expanding

**Symptom:** `$ 'echo $HOME'` literally prints "$HOME"

**Solution:** Use double quotes if you need expansion: `$ "echo $HOME"` or `$ echo "$HOME"` (without wrapping `$` command)

### Problem: Special Characters Causing Errors

**Symptom:** Commands with `*`, `?`, `[`, `]` behave unexpectedly

**Solution:** Quote the command or escape the characters:
```bash
$ 'ls *.txt'           # Quotes prevent glob expansion by outer shell
$ ls \*.txt            # Escape prevents expansion
```

### Problem: Command with Internal Quotes

**Symptom:** `$ 'echo "hello 'world'"'` causes syntax errors

**Solution:** Use different quote styles or escape:
```bash
$ "echo \"hello 'world'\""     # Use double quotes with escaping
$ $'echo "hello \'world\'"'    # Use ANSI-C quoting
```

## Further Reading

- [Bash Reference Manual - Quoting](https://www.gnu.org/software/bash/manual/html_node/Quoting.html)
- [Bash Reference Manual - Pipelines](https://www.gnu.org/software/bash/manual/html_node/Pipelines.html)
- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [Case Study: Issue #28 - Shell Quoting Analysis](case-studies/issue-28/README.md)
