#!/usr/bin/env bun

const { spawn, execSync } = require('child_process');
const process = require('process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Import modules
const { processCommand } = require('../lib/substitution');
const {
  parseArgs,
  hasIsolation,
  getEffectiveMode,
} = require('../lib/args-parser');
const {
  runIsolated,
  getTimestamp,
  createLogHeader,
  createLogFooter,
  writeLogFile,
  createLogPath,
} = require('../lib/isolation');

// Configuration from environment variables
const config = {
  // Disable automatic issue creation (useful for testing)
  disableAutoIssue:
    process.env.START_DISABLE_AUTO_ISSUE === '1' ||
    process.env.START_DISABLE_AUTO_ISSUE === 'true',
  // Disable log upload
  disableLogUpload:
    process.env.START_DISABLE_LOG_UPLOAD === '1' ||
    process.env.START_DISABLE_LOG_UPLOAD === 'true',
  // Custom log directory (defaults to OS temp)
  logDir: process.env.START_LOG_DIR || null,
  // Verbose mode
  verbose:
    process.env.START_VERBOSE === '1' || process.env.START_VERBOSE === 'true',
  // Disable substitutions/aliases
  disableSubstitutions:
    process.env.START_DISABLE_SUBSTITUTIONS === '1' ||
    process.env.START_DISABLE_SUBSTITUTIONS === 'true',
  // Custom substitutions file path
  substitutionsPath: process.env.START_SUBSTITUTIONS_PATH || null,
};

// Get all arguments passed after the command
const args = process.argv.slice(2);

// Handle --version flag
// Support: $ --version, $ -v, $ --version --
// The trailing -- should be ignored for version check
const hasVersionFlag =
  args.length >= 1 && (args[0] === '--version' || args[0] === '-v');
const isVersionOnly =
  args.length === 1 || (args.length === 2 && args[1] === '--');

if (hasVersionFlag && isVersionOnly) {
  printVersion();
  process.exit(0);
}

if (args.length === 0) {
  printUsage();
  process.exit(0);
}

/**
 * Print version information
 */
function printVersion() {
  // Get package version
  const packageJson = require('../../package.json');
  const startCommandVersion = packageJson.version;

  console.log(`start-command version: ${startCommandVersion}`);
  console.log('');

  // Get runtime information (Bun or Node.js)
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
  const runtimeVersion =
    typeof Bun !== 'undefined' ? Bun.version : process.version;

  // Get OS information
  console.log(`OS: ${process.platform}`);

  // Get OS version (use sw_vers on macOS for user-friendly version)
  let osVersion = os.release();
  if (process.platform === 'darwin') {
    try {
      osVersion = execSync('sw_vers -productVersion', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      // Fallback to kernel version if sw_vers fails
      osVersion = os.release();
    }
  }

  console.log(`OS Version: ${osVersion}`);
  console.log(`${runtime} Version: ${runtimeVersion}`);
  console.log(`Architecture: ${process.arch}`);
  console.log('');

  // Check for installed isolation tools
  console.log('Isolation tools:');

  // Check screen
  const screenVersion = getToolVersion('screen', '--version');
  if (screenVersion) {
    console.log(`  screen: ${screenVersion}`);
  } else {
    console.log('  screen: not installed');
  }

  // Check tmux
  const tmuxVersion = getToolVersion('tmux', '-V');
  if (tmuxVersion) {
    console.log(`  tmux: ${tmuxVersion}`);
  } else {
    console.log('  tmux: not installed');
  }

  // Check docker
  const dockerVersion = getToolVersion('docker', '--version');
  if (dockerVersion) {
    console.log(`  docker: ${dockerVersion}`);
  } else {
    console.log('  docker: not installed');
  }
}

/**
 * Get version of an installed tool
 * @param {string} toolName - Name of the tool
 * @param {string} versionFlag - Flag to get version (e.g., '--version', '-V')
 * @returns {string|null} Version string or null if not installed
 */
function getToolVersion(toolName, versionFlag) {
  try {
    // Redirect stderr to stdout (2>&1) to capture version info from stderr
    // Some tools like screen output version to stderr instead of stdout
    const result = execSync(`${toolName} ${versionFlag} 2>&1`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    // Extract version number from output
    // Most tools output version in various formats, so we'll return the first line
    const firstLine = result.split('\n')[0];
    return firstLine;
  } catch {
    return null;
  }
}

/**
 * Print usage information
 */
function printUsage() {
  console.log('Usage: $ [options] [--] <command> [args...]');
  console.log('       $ <command> [args...]');
  console.log('');
  console.log('Options:');
  console.log(
    '  --isolated, -i <environment>      Run in isolated environment (screen, tmux, docker)'
  );
  console.log('  --attached, -a            Run in attached mode (foreground)');
  console.log('  --detached, -d            Run in detached mode (background)');
  console.log('  --session, -s <name>      Session name for isolation');
  console.log(
    '  --image <image>           Docker image (required for docker isolation)'
  );
  console.log('  --version, -v             Show version information');
  console.log('');
  console.log('Examples:');
  console.log('  $ echo "Hello World"');
  console.log('  $ bun test');
  console.log('  $ --isolated tmux -- bun start');
  console.log('  $ -i screen -d bun start');
  console.log('  $ --isolated docker --image oven/bun:latest -- bun install');
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

// Parse wrapper options and command
let parsedArgs;
try {
  parsedArgs = parseArgs(args);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

const { wrapperOptions, command: parsedCommand } = parsedArgs;

// Check if no command was provided
if (!parsedCommand || parsedCommand.trim() === '') {
  console.error('Error: No command provided');
  printUsage();
  process.exit(1);
}

// Process through substitution engine (unless disabled)
let command = parsedCommand;
let substitutionResult = null;

if (!config.disableSubstitutions) {
  substitutionResult = processCommand(parsedCommand, {
    customLinoPath: config.substitutionsPath,
    verbose: config.verbose,
  });

  if (substitutionResult.matched) {
    command = substitutionResult.command;
    if (config.verbose) {
      console.log(`[Substitution] "${parsedCommand}" -> "${command}"`);
      console.log('');
    }
  }
}

// Main execution
(async () => {
  // Check if running in isolation mode
  if (hasIsolation(wrapperOptions)) {
    await runWithIsolation(wrapperOptions, command);
  } else {
    await runDirect(command);
  }
})();

/**
 * Run command in isolation mode
 * @param {object} options - Wrapper options
 * @param {string} cmd - Command to execute
 */
async function runWithIsolation(options, cmd) {
  const environment = options.isolated;
  const mode = getEffectiveMode(options);
  const startTime = getTimestamp();

  // Create log file path
  const logFilePath = createLogPath(environment);

  // Get session name (will be generated by runIsolated if not provided)
  const sessionName =
    options.session ||
    `${environment}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Print start message (unified format)
  console.log(`[${startTime}] Starting: ${cmd}`);
  console.log('');

  // Log isolation info
  console.log(`[Isolation] Environment: ${environment}, Mode: ${mode}`);
  if (options.session) {
    console.log(`[Isolation] Session: ${options.session}`);
  }
  if (options.image) {
    console.log(`[Isolation] Image: ${options.image}`);
  }
  console.log('');

  // Create log content
  let logContent = createLogHeader({
    command: cmd,
    environment,
    mode,
    sessionName,
    image: options.image,
    startTime,
  });

  // Run in isolation
  const result = await runIsolated(environment, cmd, {
    session: options.session,
    image: options.image,
    detached: mode === 'detached',
  });

  // Get exit code
  const exitCode =
    result.exitCode !== undefined ? result.exitCode : result.success ? 0 : 1;
  const endTime = getTimestamp();

  // Add result to log content
  logContent += `${result.message}\n`;
  logContent += createLogFooter(endTime, exitCode);

  // Write log file
  writeLogFile(logFilePath, logContent);

  // Print result and footer (unified format)
  console.log('');
  console.log(result.message);
  console.log('');
  console.log(`[${endTime}] Finished`);
  console.log(`Exit code: ${exitCode}`);
  console.log(`Log saved: ${logFilePath}`);

  process.exit(exitCode);
}

/**
 * Run command directly (without isolation)
 * @param {string} cmd - Command to execute
 */
function runDirect(cmd) {
  // Get the command name (first word of the actual command to execute)
  const commandName = cmd.split(' ')[0];

  // Determine the shell based on the platform
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
  const shellArgs = isWindows ? ['-Command', cmd] : ['-c', cmd];

  // Setup logging
  const logDir = config.logDir || os.tmpdir();
  const logFilename = generateLogFilename();
  const logFilePath = path.join(logDir, logFilename);

  let logContent = '';
  const startTime = getTimestamp();

  // Get runtime information
  const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
  const runtimeVersion =
    typeof Bun !== 'undefined' ? Bun.version : process.version;

  // Log header
  logContent += `=== Start Command Log ===\n`;
  logContent += `Timestamp: ${startTime}\n`;
  if (substitutionResult && substitutionResult.matched) {
    logContent += `Original Input: ${parsedCommand}\n`;
    logContent += `Substituted Command: ${cmd}\n`;
    logContent += `Pattern Matched: ${substitutionResult.rule.pattern}\n`;
  } else {
    logContent += `Command: ${cmd}\n`;
  }
  logContent += `Shell: ${shell}\n`;
  logContent += `Platform: ${process.platform}\n`;
  logContent += `${runtime} Version: ${runtimeVersion}\n`;
  logContent += `Working Directory: ${process.cwd()}\n`;
  logContent += `${'='.repeat(50)}\n\n`;

  // Print start message to console
  if (substitutionResult && substitutionResult.matched) {
    console.log(`[${startTime}] Input: ${parsedCommand}`);
    console.log(`[${startTime}] Executing: ${cmd}`);
  } else {
    console.log(`[${startTime}] Starting: ${cmd}`);
  }
  console.log('');

  // Execute the command with captured output
  const child = spawn(shell, shellArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });

  // Capture stdout
  child.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
    logContent += text;
  });

  // Capture stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    process.stderr.write(text);
    logContent += text;
  });

  // Handle process exit
  child.on('exit', (code) => {
    const exitCode = code || 0;
    const endTime = getTimestamp();

    // Log footer
    logContent += `\n${'='.repeat(50)}\n`;
    logContent += `Finished: ${endTime}\n`;
    logContent += `Exit Code: ${exitCode}\n`;

    // Write log file
    try {
      fs.writeFileSync(logFilePath, logContent, 'utf8');
    } catch (err) {
      console.error(`\nWarning: Could not save log file: ${err.message}`);
    }

    // Print footer to console
    console.log('');
    console.log(`[${endTime}] Finished`);
    console.log(`Exit code: ${exitCode}`);
    console.log(`Log saved: ${logFilePath}`);

    // If command failed, try to auto-report
    if (exitCode !== 0) {
      handleFailure(commandName, cmd, exitCode, logFilePath, logContent);
    }

    process.exit(exitCode);
  });

  // Handle spawn errors
  child.on('error', (err) => {
    const endTime = getTimestamp();
    const errorMessage = `Error executing command: ${err.message}`;

    logContent += `\n${errorMessage}\n`;
    logContent += `\n${'='.repeat(50)}\n`;
    logContent += `Finished: ${endTime}\n`;
    logContent += `Exit Code: 1\n`;

    // Write log file
    try {
      fs.writeFileSync(logFilePath, logContent, 'utf8');
    } catch (writeErr) {
      console.error(`\nWarning: Could not save log file: ${writeErr.message}`);
    }

    console.error(`\n${errorMessage}`);
    console.log('');
    console.log(`[${endTime}] Finished`);
    console.log(`Exit code: 1`);
    console.log(`Log saved: ${logFilePath}`);

    handleFailure(commandName, cmd, 1, logFilePath, logContent);

    process.exit(1);
  });
}

/**
 * Generate unique log filename for direct execution
 * @returns {string} Log filename
 */
function generateLogFilename() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `start-command-${timestamp}-${random}.log`;
}

/**
 * Handle command failure - detect repository, upload log, create issue
 */
function handleFailure(cmdName, fullCommand, exitCode, logPath) {
  console.log('');

  // Check if auto-issue is disabled
  if (config.disableAutoIssue) {
    if (config.verbose) {
      console.log('Auto-issue creation disabled via START_DISABLE_AUTO_ISSUE');
    }
    return;
  }

  // Try to detect repository for the command
  const repoInfo = detectRepository(cmdName);

  if (!repoInfo) {
    console.log('Repository not detected - automatic issue creation skipped');
    return;
  }

  console.log(`Detected repository: ${repoInfo.url}`);

  // Check if gh CLI is available and authenticated
  if (!isGhAuthenticated()) {
    console.log(
      'GitHub CLI not authenticated - automatic issue creation skipped'
    );
    console.log('Run "gh auth login" to enable automatic issue creation');
    return;
  }

  // Try to upload log
  let logUrl = null;
  if (config.disableLogUpload) {
    if (config.verbose) {
      console.log('Log upload disabled via START_DISABLE_LOG_UPLOAD');
    }
  } else if (isGhUploadLogAvailable()) {
    logUrl = uploadLog(logPath);
    if (logUrl) {
      console.log(`Log uploaded: ${logUrl}`);
    }
  } else {
    console.log('gh-upload-log not installed - log upload skipped');
    console.log('Install with: bun install -g gh-upload-log');
  }

  // Check if we can create issues in this repository
  if (!canCreateIssue(repoInfo.owner, repoInfo.repo)) {
    console.log('Cannot create issue in repository - skipping issue creation');
    return;
  }

  // Create issue
  const issueUrl = createIssue(
    repoInfo,
    fullCommand,
    exitCode,
    logUrl,
    logPath
  );
  if (issueUrl) {
    console.log(`Issue created: ${issueUrl}`);
  }
}

/**
 * Detect repository URL for a command (currently supports NPM global packages)
 */
function detectRepository(cmdName) {
  const isWindows = process.platform === 'win32';

  try {
    // Find command location
    const whichCmd = isWindows ? 'where' : 'which';
    let cmdPath;

    try {
      cmdPath = execSync(`${whichCmd} ${cmdName}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }

    if (!cmdPath) {
      return null;
    }

    // Handle Windows where command that returns multiple lines
    if (isWindows && cmdPath.includes('\n')) {
      cmdPath = cmdPath.split('\n')[0].trim();
    }

    // Check if it's in npm global modules
    let npmGlobalPath;
    try {
      npmGlobalPath = execSync('npm root -g', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }

    // Get the npm bin directory (parent of node_modules)
    const npmBinPath = `${path.dirname(npmGlobalPath)}/bin`;

    // Check if the command is located in the npm bin directory or node_modules
    let packageName = null;
    let isNpmPackage = false;

    try {
      // Try to resolve the symlink to find the actual path
      const realPath = fs.realpathSync(cmdPath);

      // Check if the real path is within node_modules
      if (realPath.includes('node_modules')) {
        isNpmPackage = true;
        const npmPathMatch = realPath.match(/node_modules\/([^/]+)/);
        if (npmPathMatch) {
          packageName = npmPathMatch[1];
        }
      }

      // Also check if the command path itself is in npm's bin directory
      if (!isNpmPackage && cmdPath.includes(npmBinPath)) {
        isNpmPackage = true;
      }

      // Try to read the bin script to extract package info
      if (!packageName) {
        const binContent = fs.readFileSync(cmdPath, 'utf8');

        // Check if this is a Node.js script
        if (
          binContent.startsWith('#!/usr/bin/env node') ||
          binContent.includes('node_modules')
        ) {
          isNpmPackage = true;

          // Look for package path in the script
          const packagePathMatch = binContent.match(/node_modules\/([^/'"]+)/);
          if (packagePathMatch) {
            packageName = packagePathMatch[1];
          }
        }
      }
    } catch {
      // Could not read/resolve command - not an npm package
      return null;
    }

    // If we couldn't confirm this is an npm package, don't proceed
    if (!isNpmPackage) {
      return null;
    }

    // If we couldn't find the package name from the path, use the command name
    if (!packageName) {
      packageName = cmdName;
    }

    // Try to get repository URL from npm
    try {
      const npmInfo = execSync(
        `npm view ${packageName} repository.url 2>/dev/null`,
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      ).trim();

      if (npmInfo) {
        // Parse git URL to extract owner and repo
        const parsed = parseGitUrl(npmInfo);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // npm view failed, package might not exist or have no repository
    }

    // Try to get homepage or bugs URL as fallback
    try {
      const bugsUrl = execSync(`npm view ${packageName} bugs.url 2>/dev/null`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (bugsUrl && bugsUrl.includes('github.com')) {
        const parsed = parseGitUrl(bugsUrl);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // Fallback also failed
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a git URL to extract owner, repo, and normalized URL
 */
function parseGitUrl(url) {
  if (!url) {
    return null;
  }

  // Handle various git URL formats
  // git+https://github.com/owner/repo.git
  // git://github.com/owner/repo.git
  // https://github.com/owner/repo.git
  // https://github.com/owner/repo
  // git@github.com:owner/repo.git
  // https://github.com/owner/repo/issues

  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (match) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
    };
  }

  return null;
}

/**
 * Check if GitHub CLI is authenticated
 */
function isGhAuthenticated() {
  try {
    execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh-upload-log is available
 */
function isGhUploadLogAvailable() {
  const isWindows = process.platform === 'win32';
  try {
    const whichCmd = isWindows ? 'where' : 'which';
    execSync(`${whichCmd} gh-upload-log`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload log file using gh-upload-log
 */
function uploadLog(logPath) {
  try {
    const result = execSync(`gh-upload-log "${logPath}" --public`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Extract URL from output
    const urlMatch = result.match(/https:\/\/gist\.github\.com\/[^\s]+/);
    if (urlMatch) {
      return urlMatch[0];
    }

    // Try other URL patterns
    const repoUrlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
    if (repoUrlMatch) {
      return repoUrlMatch[0];
    }

    return null;
  } catch (err) {
    console.log(`Warning: Log upload failed - ${err.message}`);
    return null;
  }
}

/**
 * Check if we can create an issue in a repository
 */
function canCreateIssue(owner, repo) {
  try {
    // Check if the repository exists and we have access
    execSync(`gh repo view ${owner}/${repo} --json name`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an issue in the repository
 */
function createIssue(repoInfo, fullCommand, exitCode, logUrl) {
  try {
    const title = `Command failed with exit code ${exitCode}: ${fullCommand.substring(0, 50)}${fullCommand.length > 50 ? '...' : ''}`;

    // Get runtime information
    const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
    const runtimeVersion =
      typeof Bun !== 'undefined' ? Bun.version : process.version;

    let body = `## Command Execution Failure Report\n\n`;
    body += `**Command:** \`${fullCommand}\`\n\n`;
    body += `**Exit Code:** ${exitCode}\n\n`;
    body += `**Timestamp:** ${getTimestamp()}\n\n`;
    body += `### System Information\n\n`;
    body += `- **Platform:** ${process.platform}\n`;
    body += `- **OS Release:** ${os.release()}\n`;
    body += `- **${runtime} Version:** ${runtimeVersion}\n`;
    body += `- **Architecture:** ${process.arch}\n\n`;

    if (logUrl) {
      body += `### Log File\n\n`;
      body += `Full log available at: ${logUrl}\n\n`;
    }

    body += `---\n`;
    body += `*This issue was automatically created by [start-command](https://github.com/link-foundation/start)*\n`;

    const result = execSync(
      `gh issue create --repo ${repoInfo.owner}/${repoInfo.repo} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    // Extract issue URL from output
    const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      return urlMatch[0];
    }

    return null;
  } catch (err) {
    console.log(`Warning: Issue creation failed - ${err.message}`);
    return null;
  }
}
