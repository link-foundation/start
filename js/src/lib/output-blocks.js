/**
 * Output formatting utilities for nicely rendered command blocks
 *
 * Provides various styles for start/finish blocks to distinguish
 * command output from the $ wrapper output.
 *
 * Available styles:
 * 1. 'rounded' (default): Rounded unicode box borders (╭─╮ ╰─╯)
 * 2. 'heavy': Heavy unicode box borders (┏━┓ ┗━┛)
 * 3. 'double': Double line box borders (╔═╗ ╚═╝)
 * 4. 'simple': Simple dash lines (────────)
 * 5. 'ascii': Pure ASCII compatible (-------- +------+)
 */

// Box drawing characters for different styles
const BOX_STYLES = {
  rounded: {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
  },
  heavy: {
    topLeft: '┏',
    topRight: '┓',
    bottomLeft: '┗',
    bottomRight: '┛',
    horizontal: '━',
    vertical: '┃',
  },
  double: {
    topLeft: '╔',
    topRight: '╗',
    bottomLeft: '╚',
    bottomRight: '╝',
    horizontal: '═',
    vertical: '║',
  },
  simple: {
    topLeft: '',
    topRight: '',
    bottomLeft: '',
    bottomRight: '',
    horizontal: '─',
    vertical: '',
  },
  ascii: {
    topLeft: '+',
    topRight: '+',
    bottomLeft: '+',
    bottomRight: '+',
    horizontal: '-',
    vertical: '|',
  },
};

// Default style (can be overridden via environment variable)
const DEFAULT_STYLE = process.env.START_OUTPUT_STYLE || 'rounded';

// Default block width
const DEFAULT_WIDTH = 60;

/**
 * Get the box style configuration
 * @param {string} [styleName] - Style name (rounded, heavy, double, simple, ascii)
 * @returns {object} Box style configuration
 */
function getBoxStyle(styleName = DEFAULT_STYLE) {
  return BOX_STYLES[styleName] || BOX_STYLES.rounded;
}

/**
 * Create a horizontal line
 * @param {number} width - Line width
 * @param {object} style - Box style
 * @returns {string} Horizontal line
 */
function createHorizontalLine(width, style) {
  return style.horizontal.repeat(width);
}

/**
 * Pad or truncate text to fit a specific width
 * @param {string} text - Text to pad
 * @param {number} width - Target width
 * @returns {string} Padded text
 */
function padText(text, width) {
  if (text.length >= width) {
    return text.substring(0, width);
  }
  return text + ' '.repeat(width - text.length);
}

/**
 * Create a bordered line with text
 * @param {string} text - Text content
 * @param {number} width - Total width (including borders)
 * @param {object} style - Box style
 * @returns {string} Bordered line
 */
function createBorderedLine(text, width, style) {
  if (style.vertical) {
    const innerWidth = width - 4; // 2 for borders, 2 for padding
    const paddedText = padText(text, innerWidth);
    return `${style.vertical} ${paddedText} ${style.vertical}`;
  }
  return text;
}

/**
 * Create the top border of a box
 * @param {number} width - Box width
 * @param {object} style - Box style
 * @returns {string} Top border
 */
function createTopBorder(width, style) {
  if (style.topLeft) {
    const lineWidth = width - 2; // Subtract corners
    return `${style.topLeft}${createHorizontalLine(lineWidth, style)}${style.topRight}`;
  }
  return createHorizontalLine(width, style);
}

/**
 * Create the bottom border of a box
 * @param {number} width - Box width
 * @param {object} style - Box style
 * @returns {string} Bottom border
 */
function createBottomBorder(width, style) {
  if (style.bottomLeft) {
    const lineWidth = width - 2; // Subtract corners
    return `${style.bottomLeft}${createHorizontalLine(lineWidth, style)}${style.bottomRight}`;
  }
  return createHorizontalLine(width, style);
}

/**
 * Create a start block for command execution
 * @param {object} options - Options for the block
 * @param {string} options.sessionId - Session UUID
 * @param {string} options.timestamp - Timestamp string
 * @param {string} options.command - Command being executed
 * @param {string} [options.style] - Box style name
 * @param {number} [options.width] - Box width
 * @returns {string} Formatted start block
 */
function createStartBlock(options) {
  const {
    sessionId,
    timestamp,
    command,
    style: styleName = DEFAULT_STYLE,
    width = DEFAULT_WIDTH,
  } = options;

  const style = getBoxStyle(styleName);
  const lines = [];

  lines.push(createTopBorder(width, style));
  lines.push(createBorderedLine(`Session ID: ${sessionId}`, width, style));
  lines.push(
    createBorderedLine(`[${timestamp}] Starting: ${command}`, width, style)
  );
  lines.push(createBottomBorder(width, style));

  return lines.join('\n');
}

/**
 * Create a finish block for command execution
 * @param {object} options - Options for the block
 * @param {string} options.sessionId - Session UUID
 * @param {string} options.timestamp - Timestamp string
 * @param {number} options.exitCode - Exit code
 * @param {string} options.logPath - Path to log file
 * @param {string} [options.style] - Box style name
 * @param {number} [options.width] - Box width
 * @returns {string} Formatted finish block
 */
function createFinishBlock(options) {
  const {
    sessionId,
    timestamp,
    exitCode,
    logPath,
    style: styleName = DEFAULT_STYLE,
    width = DEFAULT_WIDTH,
  } = options;

  const style = getBoxStyle(styleName);
  const lines = [];

  lines.push(createTopBorder(width, style));
  lines.push(createBorderedLine(`[${timestamp}] Finished`, width, style));
  lines.push(createBorderedLine(`Exit code: ${exitCode}`, width, style));
  lines.push(createBorderedLine(`Log: ${logPath}`, width, style));
  lines.push(createBorderedLine(`Session ID: ${sessionId}`, width, style));
  lines.push(createBottomBorder(width, style));

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
  BOX_STYLES,
  DEFAULT_STYLE,
  DEFAULT_WIDTH,
  getBoxStyle,
  createHorizontalLine,
  createBorderedLine,
  createTopBorder,
  createBottomBorder,
  createStartBlock,
  createFinishBlock,
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
};
