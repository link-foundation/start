---
'start-command': patch
---

Main pushes publish again (#240). Since #234 the Release job was skipped on every push to `main`: at job level the wildcard `needs.*.result` list also saw the deliberately skipped changeset check behind `test`/`coverage`. Release now compares each needed job by name, and the JavaScript Stage prints every term of the release condition and fails a main push whose release was skipped although all of its needs succeeded.

Attribute a Docker daemon restart without the host journal (#241). With a mounted `docker.sock` (Docker-outside-of-Docker) or a remote daemon, an exit-137 task is now reported as `killed (docker daemon restart)` when another container finished within the 15 s shutdown window with exit 137/143, or was started again after it, and was not OOM-killed. `exitEvidence.daemonRestartSource` records whether the host journal or the Docker API supported the attribution, and `--status` collects the evidence itself when the detached watcher died with the daemon before it could log any.

Sample Docker cgroup counters through one long-lived `docker exec -i` per run when the cgroup is only readable through the daemon (a mounted `docker.sock`). The host paces it with one tick per interval on stdin, so the container runs only shell builtins and the stream ends with the sampler; the per-round exec stays as a fallback. Docker is asked for `{{.State.Running}}` only after a round without a sample, and `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` disables sampling.

`$ --status` and `$ --list` cost far less with many records (#243). The store is decoded once per content within a process, and a JSON copy of the decoded records next to `executions.lino` (tagged with the store's SHA-256) lets the next process skip the decode entirely. One `docker inspect --type container` now answers every docker probe of a query instead of one or two processes per record, and records whose container is already marked removed are no longer probed. Output is unchanged; probes the batch cannot answer (an old or stubbed `docker`) run one by one as before.
