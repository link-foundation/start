# Timeline of Events - Issue #84

## Observed Session

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

## Step-by-Step Reconstruction

### Step 1: User invokes the CLI

```
$ --isolated docker --image konard/sandbox:1.3.14 -- bash
```

The user wants an interactive `bash` shell inside a Docker container.

### Step 2: CLI parses arguments

- `wrapperOptions.isolated` = `"docker"`
- `wrapperOptions.image` = `"konard/sandbox:1.3.14"`
- `parsedCommand` = `"bash"`
- `wrapperOptions.shell` = `"auto"` (default)

### Step 3: Shell detection runs (`detectShellInEnvironment`)

In `js/src/lib/isolation.js`, the `detectShellInEnvironment('docker', options, 'auto')` function:
1. Runs: `docker run --rm konard/sandbox:1.3.14 sh -c "command -v bash"` 
2. Gets back `/usr/bin/bash` or similar
3. Returns `"bash"` (or its full path) as `shellToUse`

### Step 4: Interactive flag is computed

`getShellInteractiveFlag("bash")` returns `"-i"`.

### Step 5: Docker command is constructed (attached mode)

```javascript
const shellCmdArgs = [shellToUse, '-i'];   // ["bash", "-i"]
dockerArgs.push(options.image, ...shellCmdArgs, '-c', command);
// => ["run", "-it", "--rm", "--name", "<name>", "konard/sandbox:1.3.14", "bash", "-i", "-c", "bash"]
```

This produces:

```
docker run -it --rm --name docker-1772794244989-ylm9o5 konard/sandbox:1.3.14 bash -i -c bash
```

### Step 6: `bash -i -c bash` executes inside the container

- Outer `bash` is the **container entrypoint shell** invoked with `-i` (interactive) and `-c bash`
- The `-c bash` argument means: **execute the string `bash` as a command**
- This starts a **second bash process** as a sub-shell of the first
- The outer bash sources `/home/sandbox/.bashrc` because `-i` was passed
- If `/home/sandbox/.bashrc` has a syntax error at line 167, it prints the error
- This happens **twice** (once when outer bash starts, once when it sources .bashrc for the subshell)

### Step 7: The user lands in an unexpected shell state

The user sees bash errors about `.bashrc` and ends up in `sandbox@188b1b53e465:~$` — inside a
nested bash sub-process rather than a clean interactive shell. The `.bashrc` issue is a symptom
of the double-bash wrapping.

## Key Observation

The command `$ --isolated docker -- bash` should produce:

```
docker run -it --rm --name <name> <image> bash
```

But instead produces:

```
docker run -it --rm --name <name> <image> bash -i -c bash
```

The `-i -c bash` is the shell wrapper that `start-command` adds unconditionally around the
user's command. When the user's command **is itself a shell**, this creates bash-inside-bash.

---

## Post-Fix Timeline (2026-03-08)

After v0.24.1 was released with the `isInteractiveShellCommand` fix, the user reported a new failure.

### Step 1: User installs v0.24.1 and runs the command

```
konard@MacBook-Pro-Konstantin ~ % bun install -g start-command
installed start-command@0.24.1

konard@MacBook-Pro-Konstantin ~ % $ --isolated docker --image konard/sandbox:latest -- bash
│ session   021416fd-4fc2-4c47-bdc6-e37f4500e3cc
│ start     2026-03-08 19:25:39.407
│
│ isolation docker
│ mode      attached
│ image     konard/sandbox:latest
│ container docker-1772997939407-fmdn4u
│

✗
│ finish    2026-03-08 19:25:39.719
│ duration  0.412s
│ exit      1
```

### Step 2: Fix produces the correct docker command

With v0.24.1, `start-command` now runs:

```
docker run -it --rm --name docker-xxx konard/sandbox:latest bash
```

### Step 3: Failure reason

The command fails with exit 1 in 0.3-0.4 seconds. Two possible causes:

**Cause A (most likely):** The `konard/sandbox:1.3.14` tag no longer exists on Docker Hub.
If the image is not locally cached, `dockerPullImage` runs and fails fast (connection error or
tag not found), returning exit 1.

**Cause B:** The container image's `/home/sandbox/.bashrc` has a syntax error that causes
bash to exit immediately (exit 1) rather than printing the error and continuing. This would
require a newer image with a more severe `.bashrc` bug.

### Step 4: Workaround

Pass `bash --norc` to skip startup file sourcing:

```
$ --isolated docker --image konard/sandbox:latest -- bash --norc
```

### Step 5: Upstream fix

The `.bashrc` bug was reported to the sandbox image maintainer as `konard/sandbox#1`.
Users should update their image: `docker pull konard/sandbox:latest`
