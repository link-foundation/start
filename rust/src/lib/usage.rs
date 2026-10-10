/// Print usage information
pub fn print_usage() {
    println!(
        r#"Usage: start [options] [--] <command> [args...]
       start <command> [args...]
       start --status <uuid> [--output-format <format>]
       start --list [--running] [--output-format <format>]
       start --upload-log <uuid-or-session-name>
       start --stop <uuid-or-session-name>
       start --terminate <uuid-or-session-name>
       start --attach <uuid-or-session-name> [--read-only]
       start --resume <uuid-or-session-name> [-- <command>]
       start --resume-all [--output-format <format>]

Options:
  --help, -h           Show this usage and exit successfully
  --isolated, --isolation, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --session-id <uuid>   Session UUID for tracking (auto-generated if not provided)
  --session-name <uuid> Alias for --session-id
  --image <image>       Docker image (optional, defaults to OS-matched image)
  --volume, -v <spec>   Docker bind mount/volume host:container[:mode] (repeatable, docker only)
  --mount <spec>        Docker --mount spec (repeatable, docker only)
  --env, -e <KEY=VALUE> Environment variable for docker container (repeatable, docker only)
  --label <KEY=VALUE>   Container attribution (repeatable, docker only; start-command.* reserved)
  --privileged          Run docker container in privileged mode (docker only)
  --network <name>      Connect to a named network (repeatable, docker only)
  --network-alias <alias> Add alias to the first network (repeatable, docker only)
  --on-kill-resume <N>  Resume a killed (exit 137 / OOM) detached docker session up to N times
  --recovery-command <cmd>  Command to run in the same container on such a resume
  --on-kill-resume-delay <min[-max]>  Wait a random number of seconds before each such resume (default 0)
  --memory <size|N%|MIN%-MAX%>  Docker RAM cap; percentages use daemon capacity
  --memory-swap <spec>  Combined memory+swap cap (defaults to memory, no extra swap)
  --cpus <n|N%|MIN%-MAX%>  Docker CPU cap; ranges draw once per creation
  --on-kill-resume-memory <spec>  New memory cap before a qualifying OOM recovery
  --cpu-penalty        Enable delayed Docker CPU penalty (default off)
  --cpu-penalty-cpus <n>  Penalty cap (default 2 CPUs)
  --cpu-penalty-trigger <p%>  Busy threshold (default 95% of usable CPUs)
  --cpu-penalty-trigger-window <d>  Fully covered busy window (default 15m)
  --cpu-penalty-release <p%>  Quiet threshold (default 65% of penalty cap)
  --cpu-penalty-release-window <d>  Minimum quiet/capped window (default 15m)
                        Durations accept ms, s, m, h; --status reports penalty state
  --endpoint <endpoint> SSH endpoint (required for ssh isolation, e.g., user@host)
  --isolated-user, -u [name]  Create isolated user with same permissions
  --keep-user           Keep isolated user after command completes
  --keep-alive, -k      Keep isolation environment alive after command exits
  --auto-remove-docker-container  Always remove docker container after exit (compatibility alias)
  --always-cleanup-container  Always remove docker container after exit
  --keep-container     Keep docker container filesystem after exit
  --keep-container-on-fail  Remove successful docker containers, keep failed or OOM-killed ones
  --shell <shell>       Shell to use in isolation environments: auto, bash, zsh, sh (default: auto)
  --use-command-stream  Use command-stream library for execution (experimental)
  --status <id>         Show status of execution by UUID or session name (--output-format: links-notation|json|text)
  --list                List all tracked executions (--output-format: links-notation|json|text)
  --running             With --list, only report executions that are still running
  --upload-log <id>     Upload a sanitized copy of the stored log privately
  --no-sanitize        With --upload-log, explicitly upload without secret redaction
  --stop <id>           Ask a detached isolated execution to stop gracefully
  --terminate <id>      Terminate a detached isolated execution immediately
  --attach <id>         Attach to a running detached isolated execution
  --read-only           With --attach, follow output without sending input
  --resume <id>         Restart a stopped detached execution in the same environment
                        (append -- <command> to run a different command there)
  --remove-original    With legacy snapshot resume, remove the stopped original after launch
  --resume-all          Re-attach or reconcile every execution still marked running
  --cleanup             Clean up stale "executing" records (crashed/killed processes)
  --cleanup-dry-run     Show stale records that would be cleaned up (without cleaning)
  --version, -v         Show version information

Examples:
  start echo "Hello World"
  start bun test
  start --isolated tmux -- bun start
  start -i screen -d bun start
  start --isolated docker -- echo 'hi'  # uses OS-matched default image
  start --isolated docker --image oven/bun:latest -- bun install
  start -i docker -v ~/.config/gh:/root/.config/gh -e TOKEN=abc -- gh repo list
  start -i docker --image konard/hive-mind-dind:latest --privileged -- solve ...
  start --isolated ssh --endpoint user@remote.server -- ls -la
  start --isolated-user -- npm test
  start -u myuser -- npm start
  start -i screen --isolated-user -- npm test
  start --status a1b2c3d4-e5f6-7890-abcd-ef1234567890
  start --status a1b2c3d4 --output-format json
  start --list
  start --list --output-format json
  start --list --running
  start --upload-log my-screen-session
  start --stop my-screen-session
  start --terminate my-screen-session
  start --attach my-docker-session
  start --attach my-docker-session --read-only
  start --resume my-docker-session
  start --resume my-docker-session -- bash
  start --resume-all
  start -i docker -d --on-kill-resume 3 --recovery-command 'solve --resume' -- solve
  start -i docker -d --on-kill-resume 3 --on-kill-resume-delay 30-90 -- cargo test
  start --cleanup-dry-run
  start --cleanup

Features:
  - Logs all output to temporary directory
  - Displays timestamps and exit codes
  - Auto-reports failures for NPM packages (when gh is available)
  - Natural language command aliases (via substitutions.lino)
  - Process isolation via screen, tmux, or docker"#
    );
}
