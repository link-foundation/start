/**
 * Status formatter module for execution records
 *
 * Provides formatting functions for execution status output in various formats:
 * - Links Notation (links-notation): Structured link doublet format
 * - JSON: Standard JSON output
 * - Text: Human-readable text format
 */

const {
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('./output-blocks');

/**
 * Format execution record as Links Notation (indented style)
 * Uses nested Links notation for object values (like options) instead of JSON
 *
 * @param {Object} record - The execution record with toObject() method
 * @returns {string} Links Notation formatted string in indented style
 *
 * Output format:
 * <uuid>
 *   <key> "<value>"
 *   options
 *     <nested_key> <nested_value>
 *   ...
 */
function formatRecordAsLinksNotation(record) {
  const obj = record.toObject();
  const lines = [record.uuid];

  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      if (key === 'options' && typeof value === 'object') {
        // Format options as nested Links notation
        const optionEntries = Object.entries(value).filter(
          ([, v]) => v !== null && v !== undefined
        );
        if (optionEntries.length > 0) {
          lines.push('  options');
          for (const [optKey, optValue] of optionEntries) {
            const formattedOptValue = escapeForLinksNotation(optValue);
            lines.push(`    ${optKey} ${formattedOptValue}`);
          }
        }
      } else if (typeof value === 'object') {
        // For other objects, still format as nested Links notation
        lines.push(`  ${key}`);
        const nested = formatAsNestedLinksNotation(value, 2, 2);
        lines.push(nested);
      } else {
        const formattedValue = escapeForLinksNotation(value);
        lines.push(`  ${key} ${formattedValue}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format execution record as human-readable text
 * @param {Object} record - The execution record with toObject() method
 * @returns {string} Human-readable text
 */
function formatRecordAsText(record) {
  const obj = record.toObject();
  const lines = [
    `Execution Status`,
    `${'='.repeat(50)}`,
    `UUID:              ${obj.uuid}`,
    `Status:            ${obj.status}`,
    `Command:           ${obj.command}`,
    `Exit Code:         ${obj.exitCode !== null ? obj.exitCode : 'N/A'}`,
    `PID:               ${obj.pid !== null ? obj.pid : 'N/A'}`,
    `Working Directory: ${obj.workingDirectory}`,
    `Shell:             ${obj.shell}`,
    `Platform:          ${obj.platform}`,
    `Start Time:        ${obj.startTime}`,
    `End Time:          ${obj.endTime || 'N/A'}`,
    `Log Path:          ${obj.logPath}`,
  ];

  // Format options as nested list instead of JSON
  const optionEntries = Object.entries(obj.options || {}).filter(
    ([, v]) => v !== null && v !== undefined
  );
  if (optionEntries.length > 0) {
    lines.push(`Options:`);
    for (const [key, value] of optionEntries) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format execution record based on format type
 * @param {Object} record - The execution record
 * @param {string} format - Output format (links-notation, json, text)
 * @returns {string} Formatted output string
 */
function formatRecord(record, format) {
  switch (format) {
    case 'links-notation':
      return formatRecordAsLinksNotation(record);
    case 'json':
      return JSON.stringify(record.toObject(), null, 2);
    case 'text':
      return formatRecordAsText(record);
    default:
      throw new Error(`Unknown output format: ${format}`);
  }
}

/**
 * Handle status query and output the result
 * @param {Object} store - ExecutionStore instance
 * @param {string} uuid - UUID of the execution to query
 * @param {string|null} outputFormat - Output format (links-notation, json, text)
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function queryStatus(store, uuid, outputFormat) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }
  const record = store.get(uuid);
  if (!record) {
    return { success: false, error: `No execution found with UUID: ${uuid}` };
  }
  try {
    return {
      success: true,
      output: formatRecord(record, outputFormat || 'links-notation'),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  formatRecordAsLinksNotation,
  formatRecordAsText,
  formatRecord,
  queryStatus,
};
