# start-command Usage Guide

This document provides detailed guidance on using the `$` command effectively, including important information about shell quoting and special characters.

## Table of Contents

- [Quick Start](#quick-start)
- [Using Pipes](#using-pipes)
- [Shell Metacharacters](#shell-metacharacters)
- [Quoting Reference](#quoting-reference)
- [Command Examples](#command-examples)
- [Troubleshooting](#troubleshooting)

## Quick Start

The `$` command wraps any shell command with automatic logging and failure reporting:

```bash
$ echo "Hello World"
$ npm test
$ git status
```

## Using Pipes

When piping data to a command wrapped with `$`, there are two approaches. **The preferred way is to pipe TO the `$`-wrapped command**:

```bash
# Preferred - pipe TO the $-wrapped command
echo "hi" | $ agent

# Alternative - quote the entire pipeline
$ 'echo "hi" | agent'
```

The first approach is simpler and requires fewer quotes. For detailed information about piping, see **[PIPES.md](PIPES.md)**.

### Quick Examples

```bash
# Pipe text to an AI agent
echo "Explain this code" | $ agent

# Pipe file contents to a processor
cat file.txt | $ processor

# Chain commands, wrap the final one
git diff | $ reviewer
```

## Shell Metacharacters

The following characters are interpreted by the shell before reaching `$`:

| Character | Name       | Purpose                               |
| --------- | ---------- | ------------------------------------- |
| `\|`      | Pipe       | Connects stdout to stdin              |
| `&`       | Background | Runs command in background            |
| `;`       | Semicolon  | Command separator                     |
| `&&`      | AND        | Run next command if previous succeeds |
| `\|\|`    | OR         | Run next command if previous fails    |
| `>`       | Redirect   | Redirect stdout to file               |
| `<`       | Input      | Read input from file                  |
| `$`       | Variable   | Variable expansion                    |
| `` ` ``   | Backtick   | Command substitution                  |
| `*?[]`    | Globs      | Filename expansion                    |

## Quoting Reference

When you need to pass special characters literally to `$`, use quotes:

| Quote Type  | Behavior                               | Use When                                |
| ----------- | -------------------------------------- | --------------------------------------- |
| `'single'`  | Everything is literal, no expansion    | Preserving pipes, special chars exactly |
| `"double"`  | Variables expand, some escaping needed | Need variable expansion inside          |
| `$'...'`    | ANSI-C quoting, escape sequences work  | Need escape sequences like `\n`, `\t`   |
| `` `...` `` | Command substitution (old style)       | Capturing command output (prefer `$()`) |

### Examples with Different Quote Styles

```bash
# Single quotes - everything literal
$ 'echo "hello" | wc -c'

# Double quotes - variables expand
$ "echo $HOME | wc -c"      # $HOME expands first!

# Double quotes with escaping
$ "echo \$HOME | wc -c"     # \$ keeps it literal
```

## Command Examples

### Simple Commands (No Quoting Needed)

```bash
$ ls -la
$ npm test
$ git status
$ echo "hello world"
```

### Commands with Pipes

```bash
# Preferred: pipe TO the $-wrapped command
echo "hello" | $ grep "h"
cat file.txt | $ processor
git log | $ reviewer

# Alternative: quote the entire pipeline
$ 'cat file.txt | grep pattern'
$ 'ps aux | grep node'
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

```bash
# Variable expands BEFORE $ sees it (usually what you want)
$ echo "$HOME"

# Variable is passed literally to $ (rare use case)
$ 'echo $HOME'
```

## Troubleshooting

### Problem: Pipe Output Goes to Wrong Place

**Symptom:** Running `$ cmd1 | cmd2` and cmd2 receives unexpected output.

**Solutions:**

1. Pipe TO $: `cmd1 | $ cmd2` (preferred)
2. Quote: `$ 'cmd1 | cmd2'`

### Problem: Variables Not Expanding

**Symptom:** `$ 'echo $HOME'` literally prints "$HOME"

**Solution:** Use double quotes: `$ "echo $HOME"` or pipe: `echo "$HOME" | $ processor`

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

- [PIPES.md](PIPES.md) - Detailed guide on piping with `$`
- [Bash Reference Manual - Quoting](https://www.gnu.org/software/bash/manual/html_node/Quoting.html)
- [Bash Reference Manual - Pipelines](https://www.gnu.org/software/bash/manual/html_node/Pipelines.html)
- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- [Case Study: Issue #28 - Shell Quoting Analysis](case-studies/issue-28/README.md)
