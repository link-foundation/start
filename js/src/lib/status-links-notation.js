/**
 * Links-notation and text rendering of nested `--status` values.
 *
 * `--status` stores structured option values such as `launchOwner`,
 * `exitEvidence`, `resolvedLimits` and `resourceLimitSpecs`. They used to be
 * passed through `escapeForLinksNotation` (and a template string in the text
 * format), which printed `"[object Object]"` and lost the values (issue #226).
 * These helpers render nested objects and arrays the same way the Rust
 * formatter's `append_links_value` does, so both implementations print the
 * same layout.
 */

const { escapeForLinksNotation } = require('./output-blocks');

function isPresent(value) {
  return value !== null && value !== undefined;
}

/**
 * Append an array as a `(` … `)` block.
 * @param {string[]} lines - Output lines
 * @param {Array} values - Array to render
 * @param {number} indent - Indentation of the parentheses
 */
function appendLinksArray(lines, values, indent) {
  const prefix = ' '.repeat(indent);
  if (values.length === 0) {
    lines.push(`${prefix}()`);
    return;
  }
  lines.push(`${prefix}(`);
  for (const value of values) {
    if (Array.isArray(value)) {
      appendLinksArray(lines, value, indent + 2);
    } else if (isPresent(value) && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (isPresent(childValue)) {
          appendLinksValue(lines, childKey, childValue, indent + 2);
        }
      }
    } else {
      lines.push(`${' '.repeat(indent + 2)}${escapeForLinksNotation(value)}`);
    }
  }
  lines.push(`${prefix})`);
}

/**
 * Append `key value`, or `key` followed by its nested children.
 * Children of an object are indented by four more spaces, matching the
 * top-level `  key` / `      child` layout `--status` has always used.
 * @param {string[]} lines - Output lines
 * @param {string} key - Field name
 * @param {*} value - Field value
 * @param {number} indent - Indentation of the key
 */
function appendLinksValue(lines, key, value, indent) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    lines.push(`${prefix}${key}`);
    appendLinksArray(lines, value, indent + 2);
    return;
  }
  if (isPresent(value) && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return;
    }
    lines.push(`${prefix}${key}`);
    for (const [childKey, childValue] of entries) {
      if (isPresent(childValue)) {
        appendLinksValue(lines, childKey, childValue, indent + 4);
      }
    }
    return;
  }
  lines.push(`${prefix}${key} ${escapeForLinksNotation(value)}`);
}

/**
 * Render an option value for the text format: scalars as-is, structured
 * values as compact JSON (the Rust formatter uses `serde_json::to_string`).
 * @param {*} value - Option value
 * @returns {string} Rendered value
 */
function formatTextOptionValue(value) {
  if (isPresent(value) && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

module.exports = {
  appendLinksArray,
  appendLinksValue,
  formatTextOptionValue,
};
