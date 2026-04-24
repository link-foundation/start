/// Print usage information
pub fn print_usage() {
    println!(
        r#"Usage: start [options] [--] <command> [args...]
       start <command> [args...]
       start --status <uuid> [--output-format <format>]
       start --list [--output-format <format>]

Options:
  --isolated, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --session-id <uuid>   Session UUID for tracking (auto-generated if not provided)
  --session-name <uuid> Alias for --session-id
  --image <image>       Docker image (optional, defaults to OS-matched image)
  --endpoint <endpoint> SSH endpoint (required for ssh isolation, e.g., user@host)
  --isolated-user, -u [name]  Create isolated user with same permissions
  --keep-user           Keep isolated user after command completes
  --keep-alive, -k      Keep isolation environment alive after command exits
  --auto-remove-docker-container  Auto-remove docker container after exit
  --shell <shell>       Shell to use in isolation environments: auto, bash, zsh, sh (default: auto)
  --use-command-stream  Use command-stream library for execution (experimental)
  --status <id>         Show status of execution by UUID or session name (--output-format: links-notation|json|text)
  --list                List all tracked executions (--output-format: links-notation|json|text)
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
  start --isolated ssh --endpoint user@remote.server -- ls -la
  start --isolated-user -- npm test
  start -u myuser -- npm start
  start -i screen --isolated-user -- npm test
  start --status a1b2c3d4-e5f6-7890-abcd-ef1234567890
  start --status a1b2c3d4 --output-format json
  start --list
  start --list --output-format json
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
