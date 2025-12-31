/**
 * Version and tool information utilities
 */

const os = require('os');
const { execSync, spawnSync } = require('child_process');

/**
 * Print version information
 * @param {boolean} verbose - Whether to show verbose debugging info
 */
function printVersion(verbose = false) {
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
      if (verbose) {
        console.log(`[verbose] macOS version from sw_vers: ${osVersion}`);
      }
    } catch {
      // Fallback to kernel version if sw_vers fails
      osVersion = os.release();
      if (verbose) {
        console.log(
          `[verbose] sw_vers failed, using kernel version: ${osVersion}`
        );
      }
    }
  }

  console.log(`OS Version: ${osVersion}`);
  console.log(`${runtime} Version: ${runtimeVersion}`);
  console.log(`Architecture: ${process.arch}`);
  console.log('');

  // Check for installed isolation tools
  console.log('Isolation tools:');

  if (verbose) {
    console.log('[verbose] Checking isolation tools...');
  }

  // Check screen (use -v flag for compatibility with older versions)
  const screenVersion = getToolVersion('screen', '-v', verbose);
  if (screenVersion) {
    console.log(`  screen: ${screenVersion}`);
  } else {
    console.log('  screen: not installed');
  }

  // Check tmux
  const tmuxVersion = getToolVersion('tmux', '-V', verbose);
  if (tmuxVersion) {
    console.log(`  tmux: ${tmuxVersion}`);
  } else {
    console.log('  tmux: not installed');
  }

  // Check docker
  const dockerVersion = getToolVersion('docker', '--version', verbose);
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
 * @param {boolean} verbose - Whether to log verbose information
 * @returns {string|null} Version string or null if not installed
 */
function getToolVersion(toolName, versionFlag, verbose = false) {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  // First, check if the tool exists in PATH
  try {
    execSync(`${whichCmd} ${toolName}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Tool not found in PATH
    if (verbose) {
      console.log(`[verbose] ${toolName}: not found in PATH`);
    }
    return null;
  }

  // Tool exists, try to get version using spawnSync
  // This captures output regardless of exit code (some tools like older screen
  // versions return non-zero exit code even when showing version successfully)
  const result = spawnSync(toolName, [versionFlag], {
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
  });

  // Combine stdout and stderr (some tools output version to stderr)
  const output = ((result.stdout || '') + (result.stderr || '')).trim();

  if (verbose) {
    console.log(
      `[verbose] ${toolName} ${versionFlag}: exit=${result.status}, output="${output.substring(0, 100)}"`
    );
  }

  if (!output) {
    return null;
  }

  // Return the first line of output
  const firstLine = output.split('\n')[0];
  return firstLine || null;
}

module.exports = {
  printVersion,
  getToolVersion,
};
