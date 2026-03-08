---
'start-command': patch
---

fix: hint users when a bare shell exits immediately due to startup file errors

When running `$ --isolated docker --image <image> -- bash` and the shell exits
with code 1 within 3 seconds, `start-command` now prints a helpful hint:

```
Hint: The shell exited immediately — its startup file (.bashrc/.zshrc) may have errors.
Try skipping startup files: bash --norc
```

This covers the post-fix regression from issue #84 where `konard/sandbox`
images with broken `.bashrc` files cause bash to exit immediately when run
directly. The hint also appears in the log file for later diagnosis.

The `bash --norc` (and `zsh --no-rcs`) workaround bypasses startup file
sourcing and is recognized as a bare shell invocation, so it is passed
directly to docker without any `-c` wrapping.
