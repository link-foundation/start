/**
 * Substitution Engine for start-command
 * Parses .lino files and matches natural language commands to shell commands
 *
 * Uses Links Notation style patterns with variables like $packageName, $version
 */

const fs = require('fs');
const path = require('path');

// Debug mode from environment
const DEBUG = process.env.START_DEBUG === '1' || process.env.START_DEBUG === 'true';

/**
 * Parse a .lino substitutions file
 * @param {string} filePath - Path to the .lino file
 * @returns {Array<{pattern: string, replacement: string, regex: RegExp, variables: string[]}>}
 */
function parseLinoFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseLinoContent(content);
}

/**
 * Parse .lino content string
 * @param {string} content - Content of the .lino file
 * @returns {Array<{pattern: string, replacement: string, regex: RegExp, variables: string[]}>}
 */
function parseLinoContent(content) {
  const rules = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }

    // Look for opening parenthesis of doublet link
    if (line === '(') {
      i++;

      // Find the pattern line (first non-empty, non-comment line)
      let pattern = null;
      while (i < lines.length) {
        const patternLine = lines[i].trim();
        if (patternLine && !patternLine.startsWith('#') && patternLine !== ')') {
          pattern = patternLine;
          i++;
          break;
        }
        i++;
      }

      // Find the replacement line (second non-empty, non-comment line)
      let replacement = null;
      while (i < lines.length) {
        const replacementLine = lines[i].trim();
        if (replacementLine && !replacementLine.startsWith('#') && replacementLine !== ')') {
          replacement = replacementLine;
          i++;
          break;
        }
        i++;
      }

      // Find closing parenthesis
      while (i < lines.length) {
        const closeLine = lines[i].trim();
        if (closeLine === ')') {
          break;
        }
        i++;
      }

      // Create rule if both pattern and replacement found
      if (pattern && replacement) {
        const rule = createRule(pattern, replacement);
        if (rule) {
          rules.push(rule);
        }
      }
    }

    i++;
  }

  return rules;
}

/**
 * Create a rule object from pattern and replacement strings
 * @param {string} pattern - The matching pattern with variables
 * @param {string} replacement - The replacement pattern
 * @returns {{pattern: string, replacement: string, regex: RegExp, variables: string[]}|null}
 */
function createRule(pattern, replacement) {
  // Extract variables from pattern (words starting with $)
  const variables = [];
  const variablePattern = /\$(\w+)/g;
  let match;

  while ((match = variablePattern.exec(pattern)) !== null) {
    variables.push(match[1]);
  }

  // Convert pattern to regex
  // First, replace $variables with placeholders
  let tempPattern = pattern;
  const placeholders = [];

  for (let i = 0; i < variables.length; i++) {
    const varName = variables[i];
    const placeholder = `__VAR_${i}__`;
    placeholders.push({ placeholder, varName });
    // Replace first occurrence of this variable
    tempPattern = tempPattern.replace(`$${varName}`, placeholder);
  }

  // Escape special regex characters in the remaining text
  let regexStr = tempPattern.replace(/[.*+?^{}()|[\]\\]/g, '\\$&');

  // Replace placeholders with named capture groups
  // Use .+? for greedy-enough matching but not too greedy
  for (const { placeholder, varName } of placeholders) {
    regexStr = regexStr.replace(placeholder, `(?<${varName}>.+?)`);
  }

  // Make the regex match the entire string with optional whitespace
  regexStr = `^\\s*${regexStr}\\s*$`;

  try {
    const regex = new RegExp(regexStr, 'i'); // Case insensitive
    return { pattern, replacement, regex, variables };
  } catch (err) {
    if (DEBUG) {
      console.error(`Invalid pattern: ${pattern} - ${err.message}`);
    }
    return null;
  }
}

/**
 * Sort rules so more specific patterns (more variables, longer patterns) match first
 * @param {Array} rules - Array of rule objects
 * @returns {Array} Sorted rules
 */
function sortRulesBySpecificity(rules) {
  return [...rules].sort((a, b) => {
    // More variables = more specific, should come first
    if (b.variables.length !== a.variables.length) {
      return b.variables.length - a.variables.length;
    }
    // Longer patterns = more specific
    return b.pattern.length - a.pattern.length;
  });
}

/**
 * Match input against rules and return the substituted command
 * @param {string} input - The user input command
 * @param {Array} rules - Array of rule objects
 * @returns {{matched: boolean, original: string, command: string, rule: object|null}}
 */
function matchAndSubstitute(input, rules) {
  const trimmedInput = input.trim();

  // Sort rules by specificity (more specific patterns first)
  const sortedRules = sortRulesBySpecificity(rules);

  for (const rule of sortedRules) {
    const match = trimmedInput.match(rule.regex);

    if (match) {
      // Build the substituted command
      let command = rule.replacement;

      // Replace variables with captured values
      for (const varName of rule.variables) {
        const value = match.groups[varName];
        if (value !== undefined) {
          command = command.replace(new RegExp(`\\$${varName}`, 'g'), value);
        }
      }

      return {
        matched: true,
        original: input,
        command: command,
        rule: rule
      };
    }
  }

  // No match found - return original input
  return {
    matched: false,
    original: input,
    command: input,
    rule: null
  };
}

/**
 * Load default substitutions from the package's substitutions.lino file
 * @returns {Array} Array of rules
 */
function loadDefaultSubstitutions() {
  // Look for substitutions.lino in the package directory
  const packageDir = path.dirname(__dirname);
  const defaultLinoPath = path.join(packageDir, 'substitutions.lino');

  if (fs.existsSync(defaultLinoPath)) {
    try {
      return parseLinoFile(defaultLinoPath);
    } catch (err) {
      if (DEBUG) {
        console.error(`Failed to load default substitutions: ${err.message}`);
      }
      return [];
    }
  }

  return [];
}

/**
 * Load user substitutions from custom path or home directory
 * @param {string} customPath - Optional custom path to .lino file
 * @returns {Array} Array of rules
 */
function loadUserSubstitutions(customPath) {
  // If custom path provided, use it
  if (customPath && fs.existsSync(customPath)) {
    try {
      return parseLinoFile(customPath);
    } catch (err) {
      if (DEBUG) {
        console.error(`Failed to load user substitutions: ${err.message}`);
      }
      return [];
    }
  }

  // Look in home directory for .start-command/substitutions.lino
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const userLinoPath = path.join(homeDir, '.start-command', 'substitutions.lino');
    if (fs.existsSync(userLinoPath)) {
      try {
        return parseLinoFile(userLinoPath);
      } catch (err) {
        if (DEBUG) {
          console.error(`Failed to load user substitutions: ${err.message}`);
        }
      }
    }
  }

  return [];
}

/**
 * Process a command through the substitution engine
 * @param {string} input - The input command
 * @param {object} options - Options { customLinoPath, verbose }
 * @returns {{matched: boolean, original: string, command: string, rule: object|null}}
 */
function processCommand(input, options = {}) {
  const { customLinoPath, verbose } = options;

  // Load rules: user rules take precedence
  const userRules = loadUserSubstitutions(customLinoPath);
  const defaultRules = loadDefaultSubstitutions();

  // User rules first, then default rules
  const allRules = [...userRules, ...defaultRules];

  if (allRules.length === 0) {
    return {
      matched: false,
      original: input,
      command: input,
      rule: null
    };
  }

  const result = matchAndSubstitute(input, allRules);

  if (verbose && result.matched) {
    console.log(`Pattern matched: "${result.rule.pattern}"`);
    console.log(`Translated to: ${result.command}`);
  }

  return result;
}

module.exports = {
  parseLinoFile,
  parseLinoContent,
  createRule,
  matchAndSubstitute,
  loadDefaultSubstitutions,
  loadUserSubstitutions,
  processCommand
};
