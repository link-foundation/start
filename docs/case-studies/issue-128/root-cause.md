# Root Cause

`--upload-log` was not part of the wrapper option model in either implementation.
The argument parser therefore treated it as an unknown option. In the no-separator
syntax, unknown options are interpreted as the beginning of the command to run.

That made this invocation:

```bash
$ --upload-log 41e2617a-0741-41f2-a56e-c9e9cbbe8068
```

behave like a shell command roughly equivalent to:

```bash
/bin/sh -c "--upload-log 41e2617a-0741-41f2-a56e-c9e9cbbe8068"
```

The shell then rejected the leading `--upload-log` token as an invalid shell
option, producing the reported `Illegal option --` failure.

The existing execution tracking store already persisted the required `logPath`,
and `--status` already exposed that path. The missing piece was a dedicated query
action that resolves the record and invokes the uploader directly.
