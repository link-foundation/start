/**
 * Failure handler for start-command
 *
 * Handles command failures - detects repository, uploads logs, creates issues
 */

const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { getTimestamp } = require('./isolation');

/**
 * Handle command failure - detect repository, upload log, create issue
 * @param {object} config - Configuration object
 * @param {string} cmdName - Command name
 * @param {string} fullCommand - Full command that was executed
 * @param {number} exitCode - Exit code of the command
 * @param {string} logPath - Path to the log file
 */
function handleFailure(config, cmdName, fullCommand, exitCode, logPath) {
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
 * @param {string} cmdName - Name of the command
 * @returns {object|null} Repository info or null
 */
function detectRepository(cmdName) {
  const isWindows = process.platform === 'win32';

  try {
    // Find command location
    const whichCmd = isWindows ? 'where' : 'which';
    let cmdPath;

    try {
      cmdPath = execFileSync(whichCmd, [cmdName], {
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
      npmGlobalPath = execFileSync('npm', ['root', '-g'], {
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

    // Try the repository URL, then the bugs URL, from the npm registry.
    // execFileSync, not execSync: packageName comes from a path or from the
    // failing command's own name, and a shell would run anything it carries
    // (CodeQL js/shell-command-injection-from-environment).
    for (const field of ['repository.url', 'bugs.url']) {
      let url;
      try {
        url = execFileSync('npm', ['view', packageName, field], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
      } catch {
        // npm view failed: package might not exist or have no such field.
        continue;
      }

      // parseGitUrl anchors on the github.com host itself, so no separate
      // (and substring-only) host check is needed here.
      const parsed = parseGitUrl(url);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a git URL to extract owner, repo, and normalized URL
 * @param {string} url - Git URL to parse
 * @returns {object|null} Parsed URL info or null
 */
function parseGitUrl(url) {
  if (!url) {
    return null;
  }

  // Handle various git URL formats
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
 * @returns {boolean} True if authenticated
 */
function isGhAuthenticated() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh-upload-log is available
 * @returns {boolean} True if available
 */
function isGhUploadLogAvailable() {
  const isWindows = process.platform === 'win32';
  try {
    const whichCmd = isWindows ? 'where' : 'which';
    execFileSync(whichCmd, ['gh-upload-log'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload log file using gh-upload-log
 * @param {string} logPath - Path to the log file
 * @returns {string|null} URL of the uploaded log or null
 */
function uploadLog(logPath) {
  try {
    const result = execFileSync('gh-upload-log', [logPath, '--public'], {
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
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {boolean} True if we can create issues
 */
function canCreateIssue(owner, repo) {
  try {
    // Check if the repository exists and we have access
    execFileSync('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an issue in the repository
 * @param {object} repoInfo - Repository info
 * @param {string} fullCommand - Full command that failed
 * @param {number} exitCode - Exit code
 * @param {string|null} logUrl - URL to the log or null
 * @returns {string|null} Issue URL or null
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

    // execFileSync passes the title and body as argv entries, so no quoting is
    // involved: the failing command they quote reached the shell verbatim
    // before, and its newlines survived only as the two characters "\n"
    // (CodeQL js/incomplete-sanitization, issue #168).
    const result = execFileSync(
      'gh',
      [
        'issue',
        'create',
        '--repo',
        `${repoInfo.owner}/${repoInfo.repo}`,
        '--title',
        title,
        '--body',
        body,
      ],
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

module.exports = {
  handleFailure,
  detectRepository,
  parseGitUrl,
  isGhAuthenticated,
  isGhUploadLogAvailable,
  uploadLog,
  canCreateIssue,
  createIssue,
};
