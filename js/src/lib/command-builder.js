/**
 * Command Builder for Isolation Stacking
 *
 * Builds the command to execute at each isolation level,
 * including the recursive $ invocation for nested levels.
 */

const { formatSequence } = require('./sequence-parser');

/**
 * Build command for next isolation level
 * If more levels remain, builds a recursive $ command
 * If this is the last level, returns the actual command
 *
 * @param {object} options - Current wrapper options
 * @param {string} command - User command to execute
 * @returns {string} Command to execute at current level
 */
function buildNextLevelCommand(options, command) {
  // If no more isolation levels, execute actual command
  if (!options.isolatedStack || options.isolatedStack.length <= 1) {
    return command;
  }

  // Build recursive $ command for remaining levels
  const parts = ['$'];

  // Remaining isolation stack (skip first which is current level)
  const remainingStack = options.isolatedStack.slice(1);
  parts.push(`--isolated "${remainingStack.join(' ')}"`);

  // Shift option values and add if non-empty
  if (options.imageStack && options.imageStack.length > 1) {
    const remainingImages = options.imageStack.slice(1);
    const imageStr = formatSequence(remainingImages);
    if (imageStr && imageStr !== '_'.repeat(remainingImages.length)) {
      parts.push(`--image "${imageStr}"`);
    }
  }

  if (options.endpointStack && options.endpointStack.length > 1) {
    const remainingEndpoints = options.endpointStack.slice(1);
    const endpointStr = formatSequence(remainingEndpoints);
    if (endpointStr) {
      parts.push(`--endpoint "${endpointStr}"`);
    }
  }

  if (options.sessionStack && options.sessionStack.length > 1) {
    const remainingSessions = options.sessionStack.slice(1);
    const sessionStr = formatSequence(remainingSessions);
    if (sessionStr && sessionStr !== '_'.repeat(remainingSessions.length)) {
      parts.push(`--session "${sessionStr}"`);
    }
  }

  // Pass through global flags
  if (options.detached) {
    parts.push('--detached');
  }

  if (options.keepAlive) {
    parts.push('--keep-alive');
  }

  if (options.sessionId) {
    parts.push(`--session-id ${options.sessionId}`);
  }

  if (options.autoRemoveDockerContainer) {
    parts.push('--auto-remove-docker-container');
  }

  // Separator and command
  parts.push('--');
  parts.push(command);

  return parts.join(' ');
}

/**
 * Escape a command for safe execution in a shell context
 * @param {string} cmd - Command to escape
 * @returns {string} Escaped command
 */
function escapeForShell(cmd) {
  // For now, simple escaping - could be enhanced
  return cmd.replace(/'/g, "'\\''");
}

/**
 * Check if we're at the last isolation level
 * @param {object} options - Wrapper options
 * @returns {boolean} True if this is the last level
 */
function isLastLevel(options) {
  return !options.isolatedStack || options.isolatedStack.length <= 1;
}

/**
 * Get current isolation backend from options
 * @param {object} options - Wrapper options
 * @returns {string|null} Current backend or null
 */
function getCurrentBackend(options) {
  if (options.isolatedStack && options.isolatedStack.length > 0) {
    return options.isolatedStack[0];
  }
  return options.isolated;
}

/**
 * Get option value for current level
 * @param {(string|null)[]} stack - Option value stack
 * @returns {string|null} Value for current level
 */
function getCurrentValue(stack) {
  if (Array.isArray(stack) && stack.length > 0) {
    return stack[0];
  }
  return null;
}

module.exports = {
  buildNextLevelCommand,
  escapeForShell,
  isLastLevel,
  getCurrentBackend,
  getCurrentValue,
};
