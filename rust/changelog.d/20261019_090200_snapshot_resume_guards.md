---
bump: patch
---

Docker snapshot resumes can now be supervised: `--snapshot-wait <seconds>` (or `START_SNAPSHOT_LOCK_WAIT`) waits for the host snapshot lock and names its holder, `--snapshot-disk-wait <seconds>` (or `START_SNAPSHOT_DISK_WAIT`) re-checks free disk, and a busy lock or short disk now exits 75 (EX_TEMPFAIL) so callers can retry. `--remove-original-after <seconds>` removes the stopped original only when the replacement still runs after the delay, `--snapshot-size-hint <bytes>` skips the `docker inspect --size` walk, `--snapshot-prepare <command>` runs a command in the original before `docker commit`, the commit writes elapsed-time progress lines to the log, and `$ --cleanup <uuid-or-session-name>` removes one execution's containers and their `start-command.snapshot-image` images without forcing anything (#224).
