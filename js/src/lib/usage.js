/** Print usage information */
function printUsage() {
  console.log(`Usage: $ [options] [--] <command> | $ --status <uuid> [--output-format <fmt>] | $ --list [--output-format <fmt>]

Options:
  --isolated, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --session-id <uuid>   Session UUID for tracking (auto-generated if not provided)
  --session-name <uuid> Alias for --session-id
  --image <image>       Docker image (required for docker isolation)
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
  $ echo "Hello World"
  $ bun test
  $ --isolated tmux -- bun start
  $ -i screen -d bun start
  $ --isolated docker --image oven/bun:latest -- bun install
  $ --isolated ssh --endpoint user@remote.server -- ls -la
  $ --isolated-user -- npm test            # Create isolated user
  $ -u myuser -- npm start                 # Custom username
  $ -i screen --isolated-user -- npm test  # Combine with process isolation
  $ --isolated-user --keep-user -- npm start
  $ --list                                 # List stored execution records
  $ --list --output-format json            # List stored records as JSON
  $ --use-command-stream echo "Hello"      # Use command-stream library`);
  console.log('');
  console.log('Piping with $:');
  console.log('  echo "hi" | $ agent       # Preferred - pipe TO $ command');
  console.log(
    '  $ \'echo "hi" | agent\'   # Alternative - quote entire pipeline'
  );
  console.log('');
  console.log('Quoting for special characters:');
  console.log("  $ 'npm test && npm build' # Wrap for logical operators");
  console.log("  $ 'cat file > output.txt' # Wrap for redirections");
  console.log('');
  console.log('Features:');
  console.log('  - Logs all output to temporary directory');
  console.log('  - Displays timestamps and exit codes');
  console.log(
    '  - Auto-reports failures for NPM packages (when gh is available)'
  );
  console.log('  - Natural language command aliases (via substitutions.lino)');
  console.log('  - Process isolation via screen, tmux, or docker');
  console.log('');
  console.log('Alias examples:');
  console.log('  $ install lodash npm package           -> npm install lodash');
  console.log(
    '  $ install 4.17.21 version of lodash npm package -> npm install lodash@4.17.21'
  );
  console.log(
    '  $ clone https://github.com/user/repo repository -> git clone https://github.com/user/repo'
  );
}

module.exports = { printUsage };
