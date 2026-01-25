# Research Findings for Issue #77

## Related Tools and Approaches

### 1. Nested tmux Sessions

**Source:** [Tmux in Practice: Local and Nested Remote Sessions](https://www.freecodecamp.org/news/tmux-in-practice-local-and-nested-remote-tmux-sessions-4f7ba5db8795/)

**Key Findings:**
- Nested tmux sessions are a valid and practical use case
- Visual distinction can be achieved by positioning status lines differently (top vs bottom)
- Remote sessions can be detected via `SSH_CLIENT` environment variable
- Prefix key conflicts can be resolved with conditional configuration

**Relevance:** Confirms that nested terminal multiplexer sessions are a recognized pattern with established best practices.

### 2. intmux - Multi-Host SSH/Docker in tmux

**Source:** [GitHub - dsummersl/intmux](https://github.com/dsummersl/intmux)

**Key Findings:**
- Connects to multiple SSH/Docker hosts within a tmux session
- Creates panes for each matching host
- Supports `synchronize-panes` for parallel operations
- Can work inside or outside existing tmux sessions

**Relevance:** Shows existing tooling for multi-host management through terminal multiplexers.

### 3. tmux with Docker

**Source:** [Docker Docs - Multiplexers](https://dockerdocs.org/multiplexers/)

**Key Findings:**
- tmux inside Docker requires proper TTY allocation
- `docker attach` vs `docker exec` matters for multiplexer behavior
- Multiple terminals within containers via tmux

**Relevance:** Confirms Docker + tmux combinations work but require attention to TTY handling.

### 4. Mosh + tmux/screen

**Source:** [Terminal Multiplexers - Ubuntu Server](https://documentation.ubuntu.com/server/reference/other-tools/terminal-multiplexers/)

**Key Findings:**
- Mosh complements SSH + multiplexers for unreliable connections
- Handles connection loss, IP changes, sleep/wake cycles
- Often used in combination: local tmux → ssh/mosh → remote tmux

**Relevance:** Real-world pattern of stacking connection layers for reliability.

## Links Notation

### Overview

**Source:** [link-foundation/links-notation](https://github.com/link-foundation/links-notation)

**Key Concepts:**
- Based on references and links
- Space-separated values form sequences
- Parentheses group related items
- Natural text parsing - "most text in the world already may be parsed as links notation"

### Parsing Sequence Syntax

For our use case, the simplest form is sufficient:

```
"screen ssh tmux ssh docker"
```

This parses as a sequence of 5 references/values.

### Underscore Convention

The underscore (`_`) as placeholder is **not native to Links Notation** but is a common convention in programming:
- Go uses `_` for ignored return values
- Many languages use `_` for unused parameters
- Shell uses `_` as last argument placeholder

**Decision:** Adopt `_` as our "default/skip" placeholder for consistency with programming conventions.

## lino-objects-codec

**Source:** Project dependency `lino-objects-codec@0.1.1`

The project already uses this codec for serialization. It depends on `links-notation@^0.11.0`.

**Potential Use:**
```javascript
const { Parser } = require('links-notation');
const parser = new Parser();
const sequence = parser.parse("screen ssh tmux ssh docker");
```

However, for simple space-separated parsing, direct string splitting may be more appropriate.

## CLI Argument Conventions

### POSIX Standards

**Source:** [GNU Argument Syntax](https://www.gnu.org/software/libc/manual/html_node/Argument-Syntax.html)

- Options beginning with `-` are flags
- `--` terminates option parsing
- Multiple short options can combine (`-abc` = `-a -b -c`)

### Google Style Guide

**Source:** [Google Developer Documentation - Command Line Syntax](https://developers.google.com/style/code-syntax)

- Square brackets `[]` for optional arguments
- Curly braces `{}` for mutually exclusive choices
- Ellipsis `...` for repeated arguments

### Recommendation

Our syntax aligns well with conventions:
- Quoted strings for sequences: `--isolated "screen ssh docker"`
- Underscores for placeholders: `--image "_ _ ubuntu:22.04"`
- Standard `--` separator for command

## Best Practices for Nested Isolation

### Security Considerations

1. **Privilege escalation:** Each layer may have different permissions
2. **Network isolation:** Docker may have isolated networks
3. **SSH key forwarding:** May need agent forwarding through layers

### Performance Considerations

1. **Latency stacking:** Each SSH hop adds latency
2. **Resource overhead:** Each container/multiplexer uses resources
3. **Connection timeout handling:** Longer chains need higher timeouts

### Recommended Limits

- Maximum nesting depth: 5-7 levels (practical limit)
- Timeout scaling: Multiply base timeout by level count
- Connection verification: Health check at each level before proceeding

## Existing Similar Implementations

### 1. SSH ProxyJump (-J)

```bash
ssh -J jump1,jump2 target
```

Native SSH supports connection chaining. Our approach is more general (mixing different isolation types).

### 2. Docker-in-Docker (DinD)

Docker can run inside Docker with proper configuration. Shows that nested containerization is possible but requires special handling.

### 3. Kubernetes Pod Exec

Kubernetes allows exec into pods which may themselves run containers. Multi-level container access is a recognized pattern.

## Conclusion

The proposed isolation stacking feature:
1. Aligns with established patterns (nested tmux, SSH jump hosts)
2. Has clear precedents in existing tools (intmux, DinD)
3. Can be implemented with reasonable complexity
4. Should include appropriate guardrails (depth limits, timeouts)
