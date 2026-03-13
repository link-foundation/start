# Timeline: Issue #91

## Sequence of Events

### User Action
```
$ --isolated docker --image konard/sandbox -- bash -i -c "nvm --version"
```

### Step 1: Shell Argument Parsing (user's shell, macOS/zsh)
The user's shell strips the outer quotes and passes:
```
process.argv = ['start-command', '--isolated', 'docker', '--image', 'konard/sandbox',
                '--', 'bash', '-i', '-c', 'nvm --version']
```
`nvm --version` is a single argv element (4th command token).

### Step 2: args-parser.js parseArgs()
```js
commandArgs = ['bash', '-i', '-c', 'nvm --version']
command = commandArgs.join(' ')  // → 'bash -i -c nvm --version'  ← information lost here
rawCommand = commandArgs         // correct, but not passed forward
```

### Step 3: cli.js runIsolated() call
```js
runIsolated('docker', 'bash -i -c nvm --version', options)
```

### Step 4: isolation.js runInDocker() — isBareShell detection
```js
isInteractiveShellCommand('bash -i -c nvm --version')
// parts.includes('-c') → true → returns false
isBareShell = false  // ← wrong path taken
```

### Step 5 (BUG): isolation.js attached mode — double-wrapping
```js
// isBareShell is false, so:
attachedCmdArgs = [...shellCmdArgs, '-c', command]
// = ['/bin/bash', '-i', '-c', 'bash -i -c nvm --version']
dockerArgs = ['run', '-it', '--rm', ..., 'konard/sandbox',
              '/bin/bash', '-i', '-c', 'bash -i -c nvm --version']
```

### Step 6 (BUG): Docker execution
```
docker run -it --rm --name container konard/sandbox /bin/bash -i -c "bash -i -c nvm --version"
```
- Outer `/bin/bash -i` sources `.bashrc` → sudo advisory printed (1st time)
- Outer bash executes script: `bash -i -c nvm --version`
  - Inner `bash -i` sources `.bashrc` → sudo advisory printed (2nd time)  ← Bug 2
  - Inner bash runs: `nvm` with `$0=--version`
    → `nvm` prints full help (treating `--version` as `$0`) ← Bug 1

---

## Fixed Sequence (after PR #92)

### Step 4 (FIXED): isShellInvocationWithArgs detection
```js
isInteractiveShellCommand('bash -i -c nvm --version') → false  (unchanged)
isShellInvocationWithArgs('bash -i -c nvm --version') → true   (NEW)
```

### Step 5 (FIXED): buildShellWithArgsCmdArgs() used instead
```js
attachedCmdArgs = buildShellWithArgsCmdArgs('bash -i -c nvm --version')
// → ['bash', '-i', '-c', 'nvm --version']   (correct argv reconstruction)
dockerArgs = ['run', '-it', '--rm', ..., 'konard/sandbox',
              'bash', '-i', '-c', 'nvm --version']
```

### Step 6 (FIXED): Docker execution
```
docker run -it --rm --name container konard/sandbox bash -i -c "nvm --version"
```
- `bash -i` sources `.bashrc` → sudo advisory printed once
- bash runs script `nvm --version` → prints `0.40.3` ✓
