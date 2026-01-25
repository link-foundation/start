/**
 * Sequence Parser for Isolation Stacking
 *
 * Parses space-separated sequences with underscore placeholders for
 * distributing options across isolation levels.
 *
 * Based on Links Notation conventions (https://github.com/link-foundation/links-notation)
 */

/**
 * Parse a space-separated sequence with underscore placeholders
 * @param {string} value - Space-separated values (e.g., "screen ssh docker")
 * @returns {(string|null)[]} Array of values, with null for underscore placeholders
 */
function parseSequence(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  // Split by whitespace
  const parts = trimmed.split(/\s+/);

  // Convert underscores to null (placeholder)
  return parts.map((v) => (v === '_' ? null : v));
}

/**
 * Format a sequence array back to a string
 * @param {(string|null)[]} sequence - Array of values with nulls for placeholders
 * @returns {string} Space-separated string with underscores for nulls
 */
function formatSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return '';
  }

  return sequence.map((v) => (v === null ? '_' : v)).join(' ');
}

/**
 * Shift sequence by removing first element
 * @param {(string|null)[]} sequence - Parsed sequence
 * @returns {(string|null)[]} New sequence without first element
 */
function shiftSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return [];
  }
  return sequence.slice(1);
}

/**
 * Check if a string represents a multi-value sequence (contains spaces)
 * @param {string} value - Value to check
 * @returns {boolean} True if contains spaces (multi-value)
 */
function isSequence(value) {
  return typeof value === 'string' && value.includes(' ');
}

/**
 * Distribute a single option value across all isolation levels
 * If the value is a sequence, validate length matches stack depth
 * If the value is a single value, replicate it for all levels
 *
 * @param {string} optionValue - Space-separated or single value
 * @param {number} stackDepth - Number of isolation levels
 * @param {string} optionName - Name of option for error messages
 * @returns {(string|null)[]} Array of values for each level
 * @throws {Error} If sequence length doesn't match stack depth
 */
function distributeOption(optionValue, stackDepth, optionName) {
  if (!optionValue) {
    return Array(stackDepth).fill(null);
  }

  const parsed = parseSequence(optionValue);

  // Single value: replicate for all levels
  if (parsed.length === 1 && stackDepth > 1) {
    return Array(stackDepth).fill(parsed[0]);
  }

  // Sequence: validate length matches
  if (parsed.length !== stackDepth) {
    throw new Error(
      `${optionName} has ${parsed.length} value(s) but isolation stack has ${stackDepth} level(s). ` +
        `Use underscores (_) as placeholders for levels that don't need this option.`
    );
  }

  return parsed;
}

/**
 * Get the value at a specific level from a distributed option
 * @param {(string|null)[]} distributedOption - Distributed option array
 * @param {number} level - Zero-based level index
 * @returns {string|null} Value at that level or null
 */
function getValueAtLevel(distributedOption, level) {
  if (
    !Array.isArray(distributedOption) ||
    level < 0 ||
    level >= distributedOption.length
  ) {
    return null;
  }
  return distributedOption[level];
}

/**
 * Validate that required options are provided for specific isolation types
 * @param {(string|null)[]} isolationStack - Stack of isolation backends
 * @param {object} options - Object containing distributed options
 * @param {(string|null)[]} options.endpoints - Distributed endpoints for SSH
 * @param {(string|null)[]} options.images - Distributed images for Docker
 * @throws {Error} If required options are missing
 */
function validateStackOptions(isolationStack, options) {
  const errors = [];

  isolationStack.forEach((backend, i) => {
    if (backend === 'ssh') {
      if (!options.endpoints || !options.endpoints[i]) {
        errors.push(
          `Level ${i + 1} is SSH but no endpoint specified. ` +
            `Use --endpoint with a value at position ${i + 1}.`
        );
      }
    }
    // Docker doesn't require image - has default
    // Screen and tmux don't require special options
  });

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Build remaining options for next isolation level
 * @param {object} options - Current level options
 * @returns {object} Options for next level
 */
function buildNextLevelOptions(options) {
  const next = { ...options };

  // Shift isolation stack
  if (next.isolatedStack && next.isolatedStack.length > 1) {
    next.isolatedStack = shiftSequence(next.isolatedStack);
    next.isolated = next.isolatedStack[0];
  } else {
    next.isolatedStack = [];
    next.isolated = null;
  }

  // Shift distributed options
  if (next.imageStack && next.imageStack.length > 1) {
    next.imageStack = shiftSequence(next.imageStack);
    next.image = next.imageStack[0];
  } else if (next.imageStack) {
    next.imageStack = [];
  }

  if (next.endpointStack && next.endpointStack.length > 1) {
    next.endpointStack = shiftSequence(next.endpointStack);
    next.endpoint = next.endpointStack[0];
  } else if (next.endpointStack) {
    next.endpointStack = [];
  }

  if (next.sessionStack && next.sessionStack.length > 1) {
    next.sessionStack = shiftSequence(next.sessionStack);
    next.session = next.sessionStack[0];
  } else if (next.sessionStack) {
    next.sessionStack = [];
  }

  return next;
}

/**
 * Format isolation chain for display
 * @param {(string|null)[]} stack - Isolation stack
 * @param {object} options - Options with distributed values
 * @returns {string} Formatted chain (e.g., "screen → ssh@host → docker:ubuntu")
 */
function formatIsolationChain(stack, options = {}) {
  if (!Array.isArray(stack) || stack.length === 0) {
    return '';
  }

  return stack
    .map((backend, i) => {
      if (!backend) {
        return '_';
      }

      if (backend === 'ssh' && options.endpointStack?.[i]) {
        return `ssh@${options.endpointStack[i]}`;
      }

      if (backend === 'docker' && options.imageStack?.[i]) {
        // Extract short image name
        const image = options.imageStack[i];
        const shortName = image.split(':')[0].split('/').pop();
        return `docker:${shortName}`;
      }

      return backend;
    })
    .join(' → ');
}

module.exports = {
  parseSequence,
  formatSequence,
  shiftSequence,
  isSequence,
  distributeOption,
  getValueAtLevel,
  validateStackOptions,
  buildNextLevelOptions,
  formatIsolationChain,
};
