# Piping with start-command (`$`)

This document explains how to use pipes with the `$` command effectively.

## Table of Contents

- [Quick Summary](#quick-summary)
- [The Preferred Way: Pipe TO `$`](#the-preferred-way-pipe-to-)
- [Alternative: Quoting](#alternative-quoting)
- [Why This Matters](#why-this-matters)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

## Quick Summary

When piping data to a command wrapped with `$`, **put `$` on the receiving command**:

```bash
# Preferred - pipe TO the $-wrapped command
echo "hi" | $ agent

# Alternative - quote the entire pipeline (more verbose)
$ 'echo "hi" | agent'
```

Both approaches work, but piping TO `$` is simpler and requires fewer quotes.

## The Preferred Way: Pipe TO `$`

The cleanest way to use pipes with `$` is to place `$` on the command that **receives** the piped input:

```bash
# Data flows: echo "hi" -> agent (wrapped with $)
echo "hi" | $ agent
```

This works because:

1. The shell creates a pipeline: `echo "hi"` piped to `$ agent`
2. `$ agent` receives "hi" on stdin
3. The `$` command wraps `agent`, which processes the input

### Real-World Examples

```bash
# Pipe text to an AI agent
echo "Explain this code" | $ agent

# Pipe file contents to a processor
cat file.txt | $ processor

# Pipe command output to an analyzer
ls -la | $ analyzer

# Chain multiple commands, wrap the final one
cat data.json | jq '.items[]' | $ handler
```

### When to Use This Approach

Use `command | $ target` when:

- You want to pipe data INTO a command that `$` wraps
- You want the `$` logging and monitoring for the receiving command
- You prefer minimal quoting

## Alternative: Quoting

You can also wrap the entire pipeline in quotes:

```bash
# Single quotes preserve the pipe literally
$ 'echo "hi" | agent'

# The $ command receives the whole pipeline as one argument
$ 'cat file.txt | grep pattern | wc -l'
```

### When to Use Quoting

Use quotes when:

- You want `$` to wrap the ENTIRE pipeline (logging all commands)
- You need the pipeline to run as a single tracked unit
- You want a single log file for the whole operation

### Quote Types

| Quote Type | Behavior           | Example                |
| ---------- | ------------------ | ---------------------- |
| `'single'` | Everything literal | `$ 'echo $HOME \| wc'` |
| `"double"` | Variables expand   | `$ "echo $HOME \| wc"` |

## Why This Matters

### Shell Parsing Order

When you type a command, the shell parses it **before** any program runs:

```
Without quotes or positioning:
    $ echo "hi" | agent
    └───┬────┘   └──┬──┘
        │           │
   Command 1    Command 2
   ($ echo "hi")   (agent)

   Result: agent receives $ output, not "hi"
```

The pipe `|` is a shell operator, so the shell splits the command at that point.

### Solution Comparison

```
Preferred - Pipe TO $:
    echo "hi" | $ agent
    └───┬────┘   └──┬──┘
        │           │
   Command 1    Command 2
   (echo "hi")    ($ agent)

   Result: $ agent receives "hi" - correct!

Alternative - Quoting:
    $ 'echo "hi" | agent'
    └─────────┬──────────┘
              │
        Single command
        (pipeline runs inside $)

   Result: agent receives "hi" - correct!
```

## Examples

### Basic Piping

```bash
# Pipe text to a command
echo "hello world" | $ processor

# Pipe file contents
cat config.json | $ validator

# Pipe command output
git diff | $ reviewer
```

### Multiple Pipes

```bash
# $ wraps only the final command
cat file.txt | grep "error" | $ reporter

# $ wraps the entire pipeline (quoted)
$ 'cat file.txt | grep "error" | wc -l'
```

### With Variables

```bash
# Variable expands before piping (shell handles it)
echo "$HOME" | $ agent

# Variable preserved literally (single quotes)
$ 'echo $HOME | wc -c'
```

### Complex Commands

```bash
# Process JSON and pipe to handler
curl -s https://api.example.com/data | jq '.items' | $ handler

# Pipe to a command with arguments
echo "analyze this" | $ agent --verbose --format json
```

## Troubleshooting

### Problem: Output goes to wrong place

**Symptom:** Running `$ cmd1 | cmd2` and cmd2 receives unexpected output.

**Cause:** Shell parses `|` before `$` runs, so cmd2 gets `$` output.

**Solutions:**

1. Pipe TO $: `cmd1 | $ cmd2`
2. Quote: `$ 'cmd1 | cmd2'`

### Problem: Command not receiving stdin

**Symptom:** `echo "data" | $ cmd` but cmd doesn't see the data.

**Check:** Does `cmd` read from stdin? Not all commands do.

**Test:** Try `echo "data" | cmd` without `$` first.

### Problem: Quotes inside quotes

**Symptom:** `$ 'echo "hello 'world'"'` causes errors.

**Solutions:**

```bash
# Use double quotes with escaping
$ "echo \"hello 'world'\""

# Or mix quote styles
echo "hello 'world'" | $ processor
```

### Problem: Variables not expanding

**Symptom:** `$ 'echo $HOME'` prints literal "$HOME".

**Cause:** Single quotes prevent expansion.

**Solutions:**

```bash
# Use double quotes (escape the pipe)
$ "echo $HOME | wc -c"

# Or pipe TO $ (variable expands in source command)
echo "$HOME" | $ wc -c
```

## Summary

| Approach  | Syntax             | Best For                    |
| --------- | ------------------ | --------------------------- |
| Pipe TO $ | `cmd1 \| $ cmd2`   | Simple piping, less quoting |
| Quoted    | `$ 'cmd1 \| cmd2'` | Logging entire pipeline     |

The preferred approach is **piping TO `$`** - it's simpler and avoids quote complexity.

## See Also

- [USAGE.md](USAGE.md) - General usage guide
- [Case Study: Issue #28](case-studies/issue-28/README.md) - Detailed analysis
