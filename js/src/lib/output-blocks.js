/**
 * Output formatting utilities for nicely rendered command blocks
 *
 * Provides "status spine" format: a width-independent, lossless output format
 * that works in TTY, tmux, SSH, CI, and logs.
 *
 * Core concepts:
 * - `│` prefix → tool metadata
 * - `$` → executed command
 * - No prefix → program output (stdout/stderr)
 * - Result marker (`✓` / `✗`) appears after output
 */

// Metadata spine character
const SPINE = '│';

// Result markers
const SUCCESS_MARKER = '✓';
const FAILURE_MARKER = '✗';

/**
 * Create a metadata line with spine prefix
 * @param {string} label - Label (e.g., 'session', 'start', 'exit')
 * @param {string} value - Value for the label
 * @returns {string} Formatted line with spine prefix
 */
function createSpineLine(label, value) {
  // Pad label to 10 characters for alignment
  const paddedLabel = label.padEnd(10);
  return `${SPINE} ${paddedLabel}${value}`;
}

/**
 * Create an empty spine line (just the spine character)
 * @returns {string} Empty spine line
 */
function createEmptySpineLine() {
  return SPINE;
}

/**
 * Create a command line with $ prefix
 * @param {string} command - The command being executed
 * @returns {string} Formatted command line
 */
function createCommandLine(command) {
  return `$ ${command}`;
}

/**
 * Get the result marker based on exit code
 * @param {number} exitCode - Exit code (0 = success)
 * @returns {string} Result marker (✓ or ✗)
 */
function getResultMarker(exitCode) {
  return exitCode === 0 ? SUCCESS_MARKER : FAILURE_MARKER;
}

/**
 * Parse isolation metadata from extraLines
 * Extracts key-value pairs from lines like "[Isolation] Environment: docker, Mode: attached"
 * @param {string[]} extraLines - Extra lines containing isolation info
 * @returns {object} Parsed isolation metadata
 */
function parseIsolationMetadata(extraLines) {
  const metadata = {
    isolation: null,
    mode: null,
    image: null,
    container: null,
    screen: null,
    session: null,
    endpoint: null,
    user: null,
  };

  for (const line of extraLines) {
    // Parse [Isolation] Environment: docker, Mode: attached
    const envModeMatch = line.match(
      /\[Isolation\] Environment: (\w+), Mode: (\w+)/
    );
    if (envModeMatch) {
      metadata.isolation = envModeMatch[1];
      metadata.mode = envModeMatch[2];
      continue;
    }

    // Parse [Isolation] Session: name
    const sessionMatch = line.match(/\[Isolation\] Session: (.+)/);
    if (sessionMatch) {
      metadata.session = sessionMatch[1];
      continue;
    }

    // Parse [Isolation] Image: name
    const imageMatch = line.match(/\[Isolation\] Image: (.+)/);
    if (imageMatch) {
      metadata.image = imageMatch[1];
      continue;
    }

    // Parse [Isolation] Endpoint: user@host
    const endpointMatch = line.match(/\[Isolation\] Endpoint: (.+)/);
    if (endpointMatch) {
      metadata.endpoint = endpointMatch[1];
      continue;
    }

    // Parse [Isolation] User: name (isolated)
    const userMatch = line.match(/\[Isolation\] User: (\w+)/);
    if (userMatch) {
      metadata.user = userMatch[1];
      continue;
    }
  }

  return metadata;
}

/**
 * Generate isolation metadata lines for spine format
 * @param {object} metadata - Parsed isolation metadata
 * @param {string} [containerOrScreenName] - Container or screen session name
 * @returns {string[]} Array of spine-formatted isolation lines
 */
function generateIsolationLines(metadata, containerOrScreenName = null) {
  const lines = [];

  if (metadata.isolation) {
    lines.push(createSpineLine('isolation', metadata.isolation));
  }

  if (metadata.mode) {
    lines.push(createSpineLine('mode', metadata.mode));
  }

  if (metadata.image) {
    lines.push(createSpineLine('image', metadata.image));
  }

  // Use provided container/screen name or fall back to metadata.session
  if (metadata.isolation === 'docker') {
    const containerName = containerOrScreenName || metadata.session;
    if (containerName) {
      lines.push(createSpineLine('container', containerName));
    }
  } else if (metadata.isolation === 'screen') {
    const screenName = containerOrScreenName || metadata.session;
    if (screenName) {
      lines.push(createSpineLine('screen', screenName));
    }
  } else if (metadata.isolation === 'tmux') {
    const tmuxName = containerOrScreenName || metadata.session;
    if (tmuxName) {
      lines.push(createSpineLine('tmux', tmuxName));
    }
  } else if (metadata.isolation === 'ssh') {
    if (metadata.endpoint) {
      lines.push(createSpineLine('endpoint', metadata.endpoint));
    }
  }

  if (metadata.user) {
    lines.push(createSpineLine('user', metadata.user));
  }

  return lines;
}

/**
 * Create a start block for command execution using status spine format
 * @param {object} options - Options for the block
 * @param {string} options.sessionId - Session UUID
 * @param {string} options.timestamp - Timestamp string
 * @param {string} options.command - Command being executed
 * @param {string[]} [options.extraLines] - Additional lines with isolation info
 * @param {string} [options.style] - Ignored (kept for backward compatibility)
 * @param {number} [options.width] - Ignored (kept for backward compatibility)
 * @returns {string} Formatted start block in spine format
 */
function createStartBlock(options) {
  const { sessionId, timestamp, command, extraLines = [] } = options;

  const lines = [];

  // Header: session and start time
  lines.push(createSpineLine('session', sessionId));
  lines.push(createSpineLine('start', timestamp));

  // Parse and add isolation metadata if present
  const metadata = parseIsolationMetadata(extraLines);

  if (metadata.isolation) {
    lines.push(createEmptySpineLine());
    lines.push(...generateIsolationLines(metadata));
  }

  // Empty spine line before command
  lines.push(createEmptySpineLine());

  // Command line
  lines.push(createCommandLine(command));

  return lines.join('\n');
}

/**
 * Format duration in seconds with appropriate precision
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration string (e.g., "0.273s")
 */
function formatDuration(durationMs) {
  const seconds = durationMs / 1000;
  if (seconds < 0.001) {
    return '0.001s';
  } else if (seconds < 10) {
    // For durations under 10 seconds, show 3 decimal places
    return `${seconds.toFixed(3)}s`;
  } else if (seconds < 100) {
    return `${seconds.toFixed(2)}s`;
  } else {
    return `${seconds.toFixed(1)}s`;
  }
}

/**
 * Create a finish block for command execution using status spine format
 *
 * Bottom block ordering rules:
 * 1. Result marker (✓ or ✗)
 * 2. finish timestamp
 * 3. duration
 * 4. exit code
 * 5. (repeated isolation metadata, if any)
 * 6. empty spine line
 * 7. log path (always second-to-last)
 * 8. session ID (always last)
 *
 * @param {object} options - Options for the block
 * @param {string} options.sessionId - Session UUID
 * @param {string} options.timestamp - Timestamp string
 * @param {number} options.exitCode - Exit code
 * @param {string} options.logPath - Path to log file
 * @param {number} [options.durationMs] - Duration in milliseconds
 * @param {string} [options.resultMessage] - Result message (ignored in new format)
 * @param {string[]} [options.extraLines] - Isolation info for repetition in footer
 * @param {string} [options.style] - Ignored (kept for backward compatibility)
 * @param {number} [options.width] - Ignored (kept for backward compatibility)
 * @returns {string} Formatted finish block in spine format
 */
function createFinishBlock(options) {
  const {
    sessionId,
    timestamp,
    exitCode,
    logPath,
    durationMs,
    extraLines = [],
  } = options;

  const lines = [];

  // Result marker appears first in footer (after program output)
  lines.push(getResultMarker(exitCode));

  // Finish metadata
  lines.push(createSpineLine('finish', timestamp));

  if (durationMs !== undefined && durationMs !== null) {
    lines.push(createSpineLine('duration', formatDuration(durationMs)));
  }

  lines.push(createSpineLine('exit', String(exitCode)));

  // Repeat isolation metadata if present
  const metadata = parseIsolationMetadata(extraLines);
  if (metadata.isolation) {
    lines.push(createEmptySpineLine());
    lines.push(...generateIsolationLines(metadata));
  }

  // Empty spine line before final two entries
  lines.push(createEmptySpineLine());

  // Log and session are ALWAYS last (in that order)
  lines.push(createSpineLine('log', logPath));
  lines.push(createSpineLine('session', sessionId));

  return lines.join('\n');
}

/**
 * Escape a value for Links notation
 * Smart quoting: uses single or double quotes based on content
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeForLinksNotation(str) {
  if (str === null || str === undefined) {
    return 'null';
  }

  const value = String(str);

  // Check for characters that need quoting
  const hasColon = value.includes(':');
  const hasDoubleQuotes = value.includes('"');
  const hasSingleQuotes = value.includes("'");
  const hasParens = value.includes('(') || value.includes(')');
  const hasNewline = value.includes('\n');
  const hasSpace = value.includes(' ');

  const needsQuoting =
    hasColon ||
    hasDoubleQuotes ||
    hasSingleQuotes ||
    hasParens ||
    hasNewline ||
    hasSpace;

  if (!needsQuoting) {
    return value;
  }

  if (hasDoubleQuotes && !hasSingleQuotes) {
    // Has " but not ' → use single quotes
    return `'${value}'`;
  } else if (hasSingleQuotes && !hasDoubleQuotes) {
    // Has ' but not " → use double quotes
    return `"${value}"`;
  } else if (hasDoubleQuotes && hasSingleQuotes) {
    // Has both " and ' → choose wrapper with fewer escapes
    const doubleQuoteCount = (value.match(/"/g) || []).length;
    const singleQuoteCount = (value.match(/'/g) || []).length;

    if (singleQuoteCount <= doubleQuoteCount) {
      // Escape single quotes by doubling them
      const escaped = value.replace(/'/g, "''");
      return `'${escaped}'`;
    } else {
      // Escape double quotes by doubling them
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    }
  } else {
    // Has colon, parentheses, newlines, or spaces but no quotes
    return `"${value}"`;
  }
}

/**
 * Format an object as nested Links notation
 * @param {object} obj - Object to format
 * @param {number} [indent=2] - Indentation level (spaces)
 * @param {number} [depth=0] - Current depth
 * @returns {string} Links notation formatted string
 */
function formatAsNestedLinksNotation(obj, indent = 2, depth = 0) {
  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj !== 'object') {
    return escapeForLinksNotation(obj);
  }

  if (Array.isArray(obj)) {
    // Format arrays
    if (obj.length === 0) {
      return '()';
    }
    const indentStr = ' '.repeat(indent * (depth + 1));
    const items = obj.map((item) => {
      const formatted = formatAsNestedLinksNotation(item, indent, depth + 1);
      return `${indentStr}${formatted}`;
    });
    return `(\n${items.join('\n')}\n${' '.repeat(indent * depth)})`;
  }

  // Format objects
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return '()';
  }

  const indentStr = ' '.repeat(indent * (depth + 1));
  const lines = entries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => {
      if (typeof value === 'object') {
        const nested = formatAsNestedLinksNotation(value, indent, depth + 1);
        return `${indentStr}${key}\n${nested}`;
      }
      const formattedValue = escapeForLinksNotation(value);
      return `${indentStr}${key} ${formattedValue}`;
    });

  return lines.join('\n');
}

module.exports = {
  // Status spine format API
  SPINE,
  SUCCESS_MARKER,
  FAILURE_MARKER,
  createSpineLine,
  createEmptySpineLine,
  createCommandLine,
  getResultMarker,
  parseIsolationMetadata,
  generateIsolationLines,

  // Main block creation functions
  createStartBlock,
  createFinishBlock,
  formatDuration,

  // Links notation utilities
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
};
