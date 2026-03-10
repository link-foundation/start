# Timeline of Events - Issue #84

## Phase 1: Original Bug Report (2026-03-06 10:50)

### Session Observed

```
konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox:1.3.14 -- bash
│ session   c1ce8622-6865-47ba-a667-c8dfbf84febe
│ start     2026-03-06 10:50:44.989
│
│ isolation docker
│ mode      attached
│ image     konard/sandbox:1.3.14
│ container docker-1772794244989-ylm9o5
│
$ bash

To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.

bash: /home/sandbox/.bashrc: line 167: syntax error: unexpected end of file
To run a command as administrator (user "root"), use "sudo <command>".
See "man sudo_root" for details.

bash: /home/sandbox/.bashrc: line 167: syntax error: unexpected end of file
sandbox@188b1b53e465:~$
```

### Step-by-Step Reconstruction

**Step 1**: User invokes the CLI
```
$ --isolated docker --image konard/sandbox:1.3.14 -- bash
```

**Step 2**: CLI parses arguments
- `wrapperOptions.isolated` = `"docker"`
- `wrapperOptions.image` = `"konard/sandbox:1.3.14"`
- `parsedCommand` = `"bash"`
- `wrapperOptions.shell` = `"auto"` (default)

**Step 3**: Shell detection runs (`detectShellInEnvironment`)

`detectShellInEnvironment('docker', options, 'auto')`:
1. Runs: `docker run --rm konard/sandbox:1.3.14 sh -c "command -v bash"`
2. Gets back `/usr/bin/bash`
3. Returns `"bash"` as `shellToUse`

**Step 4**: Interactive flag is computed
`getShellInteractiveFlag("bash")` returns `"-i"`.

**Step 5**: Docker command is constructed (attached mode)
```javascript
const shellCmdArgs = ["bash", "-i"];
dockerArgs.push(options.image, ...shellCmdArgs, '-c', command);
// => docker run -it --rm --name container konard/sandbox:1.3.14 bash -i -c bash
```

**Step 6**: `bash -i -c bash` executes inside the container
- Outer bash starts with `-i` (interactive) and runs `-c bash`
- Outer bash sources `/home/sandbox/.bashrc` (because `-i` was passed) → syntax error at line 167
- Outer bash starts inner `bash` process (the `-c bash` argument)
- Inner bash also sources `.bashrc` (because stdin is a TTY via `-it`) → same error again
- User lands in nested bash shell (double shell, two error messages)

**Key observation**: The command should be:
```
docker run -it --rm --name <name> <image> bash
```
But instead produces:
```
docker run -it --rm --name <name> <image> bash -i -c bash
```

---

## Phase 2: Fix Released (2026-03-06 / v0.24.1 PR #85)

**Fix applied**: `isInteractiveShellCommand()` added to `isolation.js`.

When user runs `$ --isolated docker -- bash`:
- `isInteractiveShellCommand('bash')` returns `true`
- Command is passed directly: `docker run -it --rm --name <name> <image> bash`
- No more shell-inside-shell wrapping

However, the fix inadvertently removed the explicit `-i` flag that the inner bash had previously
received. Before the fix, `bash -i -c bash` gave the inner bash an implicit TTY setup from the
outer interactive bash. After the fix, `bash` relies entirely on Docker's TTY bridge through
Node.js `spawn()` to set up interactive mode.

---

## Phase 3: Post-Fix Regression Reported (2026-03-08 19:25, v0.24.1)

### Session Observed (v0.24.1)

```
konard@MacBook-Pro-Konstantin ~ % bun install -g start-command
installed start-command@0.24.1

konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox:latest -- bash
│ session   021416fd-4fc2-4c47-bdc6-e37f4500e3cc
│ start     2026-03-08 19:25:39.407
│ image     konard/sandbox:latest
│ container docker-1772997939407-fmdn4u
│
✗
│ finish    2026-03-08 19:25:39.719
│ duration  0.412s
│ exit      1
│ log       /var/folders/.../start-command-docker-1772997939407-alkhiu.log
│ session   021416fd-4fc2-4c47-bdc6-e37f4500e3cc
```

**Failure analysis**: Exit 1 in 0.412s. No docker pull shown → image was locally cached.
With v0.24.1, command is `docker run -it ... konard/sandbox:latest bash` (no `-i` flag).

### Additional Failures (same session)

```
$ --isolated docker --image konard/sandbox -- bash   → exit 1, 0.299s
$ --isolated docker --image konard/sandbox:1.3.14 -- bash → exit 1, 0.298s
```

All three image references fail. All are locally cached from previous use.

---

## Phase 4: Confirmed Regression with v0.24.2 (2026-03-08 21:05)

### Session Observed (v0.24.2)

```
konard@MacBook-Pro-Konstantin ~ % bun install -g start-command
installed start-command@0.24.2

konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox:latest -- bash
│ session   06ad7a72-...
│ start     2026-03-08 21:05:02.796
│ image     konard/sandbox:latest
│
✗ exit 1, duration 0.443s

konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox:1.3.14 -- bash
✗ exit 1, duration 0.298s

konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox -- bash
✗ exit 1, duration 0.299s
```

User comment: "Previous fix didn't work. The image even does not get pulled, before it just worked."

### Root Cause (Corrected 2026-03-09)

**Important clarification**: `konard/sandbox:1.3.14` contains no `.bashrc` errors that cause bash
to fail. The image works correctly with `docker run -it konard/sandbox:1.3.14 bash` — bash starts
and the user gets a functional shell. The `.bashrc` syntax error shown in Phase 1 was already
present before our fix and only caused a warning, not an exit.

**Why "image does not get pulled"**:
- `dockerImageExists()` uses `docker image inspect` which returns immediately for cached images
- The images ARE locally cached from prior test runs
- Since `dockerImageExists()` returns true, `dockerPullImage()` is never called
- The user sees no pull output — confirming the image is cached (expected behavior)

**Why the command fails in 0.3-0.4 seconds**:
1. `dockerImageExists()` returns true (~10-50ms)
2. `docker run -it --rm ... bash` starts the container (~100-300ms)
3. Bash detects that it may not be running interactively (no explicit `-i` flag)
4. Without `-i`, bash reads stdin, gets EOF from the non-interactive startup path, and exits
5. Container exits with code 1 (total: ~0.3-0.4s)

**Why v0.24.0 appeared to work**:
- v0.24.0 command: `docker run -it ... bash -i -c bash`
- Outer bash with explicit `-i` starts in interactive mode, sources `.bashrc` with warning
- Outer bash then runs inner `bash` process which also starts interactively
- User gets a nested shell (double errors shown, but functional shell)

**Why v0.24.1+ fails**:
- v0.24.1+ command: `docker run -it ... bash` (no `-i` flag)
- Bash relies on TTY auto-detection through: macOS Docker Desktop VM → container process → bash
- On macOS with Docker Desktop (multiple hypervisor layers), this TTY propagation may be unreliable
- Without explicit `-i`, bash may not enter interactive mode → reads EOF from stdin → exits

---

## Phase 5: Corrected Fix (PR #87)

**Root cause**: The v0.24.1 fix removed the shell-inside-shell wrapping (correct) but also lost
the explicit `-i` flag that guaranteed bash started in interactive mode (regression).

**Fix applied**: Bare shell commands now receive `-i` explicitly in docker attached mode.

```
v0.24.0: docker run -it ... image /bin/bash -i -c bash  (WRONG: bash inside bash)
v0.24.1: docker run -it ... image bash                  (WRONG: missing -i)
Fixed:   docker run -it ... image bash -i               (CORRECT: direct + interactive)
```

The fix is implemented in `runInDocker()` attached mode in `js/src/lib/isolation.js`:

```javascript
// Bare shell: pass directly with -i (avoids bash-inside-bash; -i ensures interactive).
let attachedCmdArgs;
if (isBareShell) {
  const parts = command.trim().split(/\s+/);
  const bareFlag = getShellInteractiveFlag(parts[0]);
  attachedCmdArgs =
    bareFlag && !parts.includes(bareFlag)
      ? [parts[0], bareFlag, ...parts.slice(1)]
      : parts;
} else {
  attachedCmdArgs = [...shellCmdArgs, '-c', command];
}
```

Results:
- `bash` → `['bash', '-i']`
- `bash --norc` → `['bash', '-i', '--norc']`
- `bash -i` → `['bash', '-i']` (no duplication)
- `zsh` → `['zsh', '-i']`
- `sh` → `['sh']` (sh has no `-i` convention)
