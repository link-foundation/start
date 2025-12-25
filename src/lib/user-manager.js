/**
 * User Manager for start-command
 *
 * Provides utilities for creating isolated users with the same
 * group memberships as the current user. This enables true user
 * isolation while preserving access to sudo, docker, and other
 * privileged groups.
 */

const { execSync, spawnSync } = require('child_process');

// Debug mode from environment
const DEBUG =
  process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

/**
 * Get the current user's username
 * @returns {string} Current username
 */
function getCurrentUser() {
  try {
    return execSync('whoami', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

/**
 * Get the groups the current user belongs to
 * @returns {string[]} Array of group names
 */
function getCurrentUserGroups() {
  try {
    // Get groups for the current user
    const output = execSync('groups', { encoding: 'utf8' }).trim();
    // Output format: "user : group1 group2 group3" or "group1 group2 group3"
    const parts = output.split(':');
    const groupsPart = parts.length > 1 ? parts[1] : parts[0];
    return groupsPart.trim().split(/\s+/).filter(Boolean);
  } catch (err) {
    if (DEBUG) {
      console.log(`[DEBUG] Failed to get user groups: ${err.message}`);
    }
    return [];
  }
}

/**
 * Check if a user exists on the system
 * @param {string} username - Username to check
 * @returns {boolean} True if user exists
 */
function userExists(username) {
  try {
    execSync(`id ${username}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a group exists on the system
 * @param {string} groupname - Group name to check
 * @returns {boolean} True if group exists
 */
function groupExists(groupname) {
  try {
    execSync(`getent group ${groupname}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique username for isolation
 * @param {string} [prefix='start'] - Prefix for the username
 * @returns {string} Generated username
 */
function generateIsolatedUsername(prefix = 'start') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  // Keep username short (max 32 chars on most systems)
  // and valid (only alphanumeric, hyphen, underscore)
  return `${prefix}-${timestamp}${random}`.substring(0, 31);
}

/**
 * Create a new user with specified groups
 * Requires sudo access
 *
 * @param {string} username - Username to create
 * @param {string[]} groups - Groups to add user to
 * @param {object} options - Options
 * @param {boolean} options.noLogin - If true, create user with nologin shell
 * @param {string} options.homeDir - Home directory (default: /home/username)
 * @returns {{success: boolean, message: string, username: string}}
 */
function createUser(username, groups = [], options = {}) {
  if (process.platform === 'win32') {
    return {
      success: false,
      message: 'User creation is not supported on Windows',
      username,
    };
  }

  if (userExists(username)) {
    return {
      success: true,
      message: `User "${username}" already exists`,
      username,
      alreadyExists: true,
    };
  }

  try {
    // Build useradd command
    const useradd = ['sudo', '-n', 'useradd'];

    // Add home directory option
    if (options.homeDir) {
      useradd.push('-d', options.homeDir);
    }
    useradd.push('-m'); // Create home directory

    // Add shell option
    if (options.noLogin) {
      useradd.push('-s', '/usr/sbin/nologin');
    } else {
      useradd.push('-s', '/bin/bash');
    }

    // Filter groups to only existing ones
    const existingGroups = groups.filter(groupExists);
    if (existingGroups.length > 0) {
      // Add user to groups (comma-separated)
      useradd.push('-G', existingGroups.join(','));
    }

    // Add username
    useradd.push(username);

    if (DEBUG) {
      console.log(`[DEBUG] Creating user: ${useradd.join(' ')}`);
      console.log(`[DEBUG] Groups to add: ${existingGroups.join(', ')}`);
    }

    const result = spawnSync(useradd[0], useradd.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      const stderr = result.stderr || '';
      return {
        success: false,
        message: `Failed to create user: ${stderr.trim() || 'Unknown error'}`,
        username,
      };
    }

    return {
      success: true,
      message: `Created user "${username}" with groups: ${existingGroups.join(', ') || 'none'}`,
      username,
      groups: existingGroups,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to create user: ${err.message}`,
      username,
    };
  }
}

/**
 * Create an isolated user with the same groups as the current user
 * @param {string} [customUsername] - Optional custom username (auto-generated if not provided)
 * @param {object} options - Options
 * @param {string[]} options.includeGroups - Only include these groups (default: all)
 * @param {string[]} options.excludeGroups - Exclude these groups (default: none)
 * @param {boolean} options.noLogin - Create with nologin shell
 * @returns {{success: boolean, message: string, username: string, groups: string[]}}
 */
function createIsolatedUser(customUsername, options = {}) {
  const username = customUsername || generateIsolatedUsername();
  let groups = getCurrentUserGroups();

  // Filter groups if specified
  if (options.includeGroups && options.includeGroups.length > 0) {
    groups = groups.filter((g) => options.includeGroups.includes(g));
  }

  if (options.excludeGroups && options.excludeGroups.length > 0) {
    groups = groups.filter((g) => !options.excludeGroups.includes(g));
  }

  // Important groups for isolation to work properly
  const importantGroups = ['sudo', 'docker', 'wheel', 'admin'];
  const currentUserGroups = getCurrentUserGroups();
  const inheritedImportantGroups = importantGroups.filter((g) =>
    currentUserGroups.includes(g)
  );

  if (DEBUG) {
    console.log(`[DEBUG] Current user groups: ${currentUserGroups.join(', ')}`);
    console.log(`[DEBUG] Groups to inherit: ${groups.join(', ')}`);
    console.log(
      `[DEBUG] Important groups found: ${inheritedImportantGroups.join(', ')}`
    );
  }

  return createUser(username, groups, options);
}

/**
 * Delete a user and optionally their home directory
 * Requires sudo access
 *
 * @param {string} username - Username to delete
 * @param {object} options - Options
 * @param {boolean} options.removeHome - If true, remove home directory
 * @returns {{success: boolean, message: string}}
 */
function deleteUser(username, options = {}) {
  if (process.platform === 'win32') {
    return {
      success: false,
      message: 'User deletion is not supported on Windows',
    };
  }

  if (!userExists(username)) {
    return {
      success: true,
      message: `User "${username}" does not exist`,
    };
  }

  try {
    const userdel = ['sudo', '-n', 'userdel'];

    if (options.removeHome) {
      userdel.push('-r'); // Remove home directory
    }

    userdel.push(username);

    if (DEBUG) {
      console.log(`[DEBUG] Deleting user: ${userdel.join(' ')}`);
    }

    const result = spawnSync(userdel[0], userdel.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      const stderr = result.stderr || '';
      return {
        success: false,
        message: `Failed to delete user: ${stderr.trim() || 'Unknown error'}`,
      };
    }

    return {
      success: true,
      message: `Deleted user "${username}"`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to delete user: ${err.message}`,
    };
  }
}

/**
 * Setup sudoers entry for a user to run as another user without password
 * Requires sudo access
 *
 * @param {string} fromUser - User who will run sudo
 * @param {string} toUser - User to run commands as
 * @returns {{success: boolean, message: string}}
 */
function setupSudoersForUser(fromUser, toUser) {
  if (process.platform === 'win32') {
    return {
      success: false,
      message: 'Sudoers configuration is not supported on Windows',
    };
  }

  try {
    // Create a sudoers.d entry for this user pair
    const sudoersFile = `/etc/sudoers.d/start-${fromUser}-${toUser}`;
    const sudoersEntry = `${fromUser} ALL=(${toUser}) NOPASSWD: ALL\n`;

    // Use visudo -c to validate the entry before writing
    const checkResult = spawnSync(
      'sudo',
      ['-n', 'sh', '-c', `echo '${sudoersEntry}' | visudo -c -f -`],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );

    if (checkResult.status !== 0) {
      return {
        success: false,
        message: `Invalid sudoers entry: ${checkResult.stderr}`,
      };
    }

    // Write the sudoers file
    const writeResult = spawnSync(
      'sudo',
      [
        '-n',
        'sh',
        '-c',
        `echo '${sudoersEntry}' > ${sudoersFile} && chmod 0440 ${sudoersFile}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );

    if (writeResult.status !== 0) {
      return {
        success: false,
        message: `Failed to write sudoers file: ${writeResult.stderr}`,
      };
    }

    return {
      success: true,
      message: `Created sudoers entry: ${fromUser} can run as ${toUser}`,
      sudoersFile,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to setup sudoers: ${err.message}`,
    };
  }
}

/**
 * Get information about a user
 * @param {string} username - Username to query
 * @returns {{exists: boolean, uid?: number, gid?: number, groups?: string[], home?: string, shell?: string}}
 */
function getUserInfo(username) {
  if (!userExists(username)) {
    return { exists: false };
  }

  try {
    const idOutput = execSync(`id ${username}`, { encoding: 'utf8' }).trim();
    // Parse: uid=1000(user) gid=1000(group) groups=1000(group),27(sudo)
    const uidMatch = idOutput.match(/uid=(\d+)/);
    const gidMatch = idOutput.match(/gid=(\d+)/);

    const groupsOutput = execSync(`groups ${username}`, {
      encoding: 'utf8',
    }).trim();
    const groupsPart = groupsOutput.split(':').pop().trim();
    const groups = groupsPart.split(/\s+/).filter(Boolean);

    // Get home directory and shell from passwd
    let home, shell;
    try {
      const passwdEntry = execSync(`getent passwd ${username}`, {
        encoding: 'utf8',
      }).trim();
      const parts = passwdEntry.split(':');
      if (parts.length >= 7) {
        home = parts[5];
        shell = parts[6];
      }
    } catch {
      // Ignore if getent fails
    }

    return {
      exists: true,
      uid: uidMatch ? parseInt(uidMatch[1], 10) : undefined,
      gid: gidMatch ? parseInt(gidMatch[1], 10) : undefined,
      groups,
      home,
      shell,
    };
  } catch {
    return { exists: true }; // User exists but couldn't get details
  }
}

/**
 * Check if the current process has sudo access without password
 * @returns {boolean} True if sudo -n works
 */
function hasSudoAccess() {
  try {
    execSync('sudo -n true', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getCurrentUser,
  getCurrentUserGroups,
  userExists,
  groupExists,
  generateIsolatedUsername,
  createUser,
  createIsolatedUser,
  deleteUser,
  setupSudoersForUser,
  getUserInfo,
  hasSudoAccess,
};
