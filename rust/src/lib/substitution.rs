//! Substitution Engine for start-command
//!
//! Parses .lino files and matches natural language commands to shell commands.
//! Uses Links Notation style patterns with variables like $packageName, $version

use regex::Regex;
use std::env;
use std::fs;
use std::path::Path;

/// A substitution rule parsed from a .lino file
#[derive(Debug, Clone)]
pub struct Rule {
    /// The original pattern string
    pub pattern: String,
    /// The replacement template
    pub replacement: String,
    /// Compiled regex for matching
    pub regex: Regex,
    /// Variable names in order of appearance
    pub variables: Vec<String>,
}

/// Result of matching and substituting a command
#[derive(Debug)]
pub struct SubstitutionResult {
    /// Whether a match was found
    pub matched: bool,
    /// Original input
    pub original: String,
    /// Final command (substituted or original)
    pub command: String,
    /// The rule that matched (if any)
    pub rule: Option<Rule>,
}

/// Parse a .lino substitutions file
pub fn parse_lino_file(file_path: &Path) -> Vec<Rule> {
    match fs::read_to_string(file_path) {
        Ok(content) => parse_lino_content(&content),
        Err(_) => Vec::new(),
    }
}

/// Parse .lino content string
pub fn parse_lino_content(content: &str) -> Vec<Rule> {
    let mut rules = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            i += 1;
            continue;
        }

        // Look for opening parenthesis of doublet link
        if line == "(" {
            i += 1;

            // Find the pattern line (first non-empty, non-comment line)
            let mut pattern: Option<&str> = None;
            while i < lines.len() {
                let pattern_line = lines[i].trim();
                if !pattern_line.is_empty() && !pattern_line.starts_with('#') && pattern_line != ")"
                {
                    pattern = Some(pattern_line);
                    i += 1;
                    break;
                }
                i += 1;
            }

            // Find the replacement line (second non-empty, non-comment line)
            let mut replacement: Option<&str> = None;
            while i < lines.len() {
                let replacement_line = lines[i].trim();
                if !replacement_line.is_empty()
                    && !replacement_line.starts_with('#')
                    && replacement_line != ")"
                {
                    replacement = Some(replacement_line);
                    i += 1;
                    break;
                }
                i += 1;
            }

            // Find closing parenthesis
            while i < lines.len() {
                let close_line = lines[i].trim();
                if close_line == ")" {
                    break;
                }
                i += 1;
            }

            // Create rule if both pattern and replacement found
            if let (Some(p), Some(r)) = (pattern, replacement) {
                if let Some(rule) = create_rule(p, r) {
                    rules.push(rule);
                }
            }
        }

        i += 1;
    }

    rules
}

/// Create a rule object from pattern and replacement strings
pub fn create_rule(pattern: &str, replacement: &str) -> Option<Rule> {
    // Extract variables from pattern (words starting with $)
    let var_regex = Regex::new(r"\$(\w+)").ok()?;
    let mut variables: Vec<String> = Vec::new();

    for cap in var_regex.captures_iter(pattern) {
        if let Some(var_name) = cap.get(1) {
            variables.push(var_name.as_str().to_string());
        }
    }

    // Convert pattern to regex
    let mut temp_pattern = pattern.to_string();
    let mut placeholders: Vec<(String, String)> = Vec::new();

    for (i, var_name) in variables.iter().enumerate() {
        let placeholder = format!("__VAR_{}__", i);
        placeholders.push((placeholder.clone(), var_name.clone()));
        // Replace first occurrence of this variable
        temp_pattern = temp_pattern.replacen(&format!("${}", var_name), &placeholder, 1);
    }

    // Escape special regex characters in the remaining text
    let mut regex_str = regex::escape(&temp_pattern);

    // Replace placeholders with named capture groups
    for (placeholder, var_name) in &placeholders {
        regex_str = regex_str.replace(placeholder, &format!("(?P<{}>.+?)", var_name));
    }

    // Make the regex match the entire string with optional whitespace
    regex_str = format!(r"^\s*{}\s*$", regex_str);

    // Compile regex (case insensitive)
    match Regex::new(&format!("(?i){}", regex_str)) {
        Ok(regex) => Some(Rule {
            pattern: pattern.to_string(),
            replacement: replacement.to_string(),
            regex,
            variables,
        }),
        Err(e) => {
            if is_debug() {
                eprintln!("Invalid pattern: {} - {}", pattern, e);
            }
            None
        }
    }
}

/// Sort rules so more specific patterns (more variables, longer patterns) match first
pub fn sort_rules_by_specificity(rules: &mut [Rule]) {
    rules.sort_by(|a, b| {
        // More variables = more specific, should come first
        match b.variables.len().cmp(&a.variables.len()) {
            std::cmp::Ordering::Equal => {
                // Longer patterns = more specific
                b.pattern.len().cmp(&a.pattern.len())
            }
            other => other,
        }
    });
}

/// Match input against rules and return the substituted command
pub fn match_and_substitute(input: &str, rules: &[Rule]) -> SubstitutionResult {
    let trimmed_input = input.trim();

    // Sort rules by specificity
    let mut sorted_rules = rules.to_vec();
    sort_rules_by_specificity(&mut sorted_rules);

    for rule in &sorted_rules {
        if let Some(captures) = rule.regex.captures(trimmed_input) {
            // Build the substituted command
            let mut command = rule.replacement.clone();

            // Replace variables with captured values
            for var_name in &rule.variables {
                if let Some(value) = captures.name(var_name) {
                    command = command.replace(&format!("${}", var_name), value.as_str());
                }
            }

            return SubstitutionResult {
                matched: true,
                original: input.to_string(),
                command,
                rule: Some(rule.clone()),
            };
        }
    }

    // No match found - return original input
    SubstitutionResult {
        matched: false,
        original: input.to_string(),
        command: input.to_string(),
        rule: None,
    }
}

/// Load default substitutions from the package's substitutions.lino file
pub fn load_default_substitutions() -> Vec<Rule> {
    // Look for substitutions.lino relative to the executable or in standard locations
    let possible_paths = [
        // Same directory as executable
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("substitutions.lino"))),
        // In src/lib relative to current dir (for development)
        Some(std::path::PathBuf::from("src/lib/substitutions.lino")),
        // In the Rust source directory
        Some(std::path::PathBuf::from("rust/src/lib/substitutions.lino")),
        // In js source directory (shared)
        Some(std::path::PathBuf::from("js/src/lib/substitutions.lino")),
    ];

    for path_opt in &possible_paths {
        if let Some(path) = path_opt {
            if path.exists() {
                let rules = parse_lino_file(path);
                if !rules.is_empty() {
                    return rules;
                }
            }
        }
    }

    Vec::new()
}

/// Load user substitutions from custom path or home directory
pub fn load_user_substitutions(custom_path: Option<&str>) -> Vec<Rule> {
    // If custom path provided, use it
    if let Some(path) = custom_path {
        let path = Path::new(path);
        if path.exists() {
            return parse_lino_file(path);
        }
    }

    // Look in home directory for .start-command/substitutions.lino
    if let Some(home_dir) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let user_lino_path = Path::new(&home_dir)
            .join(".start-command")
            .join("substitutions.lino");
        if user_lino_path.exists() {
            return parse_lino_file(&user_lino_path);
        }
    }

    Vec::new()
}

/// Options for processing a command
#[derive(Debug, Default)]
pub struct ProcessOptions {
    /// Custom path to .lino file
    pub custom_lino_path: Option<String>,
    /// Enable verbose output
    pub verbose: bool,
}

/// Process a command through the substitution engine
pub fn process_command(input: &str, options: &ProcessOptions) -> SubstitutionResult {
    // Load rules: user rules take precedence
    let user_rules = load_user_substitutions(options.custom_lino_path.as_deref());
    let default_rules = load_default_substitutions();

    // User rules first, then default rules
    let mut all_rules = user_rules;
    all_rules.extend(default_rules);

    if all_rules.is_empty() {
        return SubstitutionResult {
            matched: false,
            original: input.to_string(),
            command: input.to_string(),
            rule: None,
        };
    }

    let result = match_and_substitute(input, &all_rules);

    if options.verbose && result.matched {
        if let Some(ref rule) = result.rule {
            println!("Pattern matched: \"{}\"", rule.pattern);
            println!("Translated to: {}", result.command);
        }
    }

    result
}

fn is_debug() -> bool {
    env::var("START_DEBUG").map_or(false, |v| v == "1" || v == "true")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_lino_content() {
        let content = r#"
# Test comment
(
  install $packageName npm package
  npm install $packageName
)

(
  clone $url
  git clone $url
)
"#;
        let rules = parse_lino_content(content);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "install $packageName npm package");
        assert_eq!(rules[0].replacement, "npm install $packageName");
        assert_eq!(rules[0].variables, vec!["packageName"]);
    }

    #[test]
    fn test_create_rule() {
        let rule = create_rule(
            "install $version version of $packageName npm package",
            "npm install $packageName@$version",
        )
        .unwrap();

        assert_eq!(rule.variables, vec!["version", "packageName"]);
    }

    #[test]
    fn test_match_and_substitute_basic() {
        let rules = vec![create_rule(
            "install $packageName npm package",
            "npm install $packageName",
        )
        .unwrap()];

        let result = match_and_substitute("install lodash npm package", &rules);
        assert!(result.matched);
        assert_eq!(result.command, "npm install lodash");
    }

    #[test]
    fn test_match_and_substitute_multiple_vars() {
        let rules = vec![create_rule(
            "install $version version of $packageName npm package",
            "npm install $packageName@$version",
        )
        .unwrap()];

        let result = match_and_substitute("install 4.17.21 version of lodash npm package", &rules);
        assert!(result.matched);
        assert_eq!(result.command, "npm install lodash@4.17.21");
    }

    #[test]
    fn test_match_and_substitute_no_match() {
        let rules = vec![create_rule(
            "install $packageName npm package",
            "npm install $packageName",
        )
        .unwrap()];

        let result = match_and_substitute("echo hello", &rules);
        assert!(!result.matched);
        assert_eq!(result.command, "echo hello");
    }

    #[test]
    fn test_case_insensitive_matching() {
        let rules = vec![create_rule("LIST FILES", "ls -la").unwrap()];

        let result = match_and_substitute("list files", &rules);
        assert!(result.matched);
        assert_eq!(result.command, "ls -la");
    }

    #[test]
    fn test_sort_rules_by_specificity() {
        let mut rules = vec![
            create_rule("install $pkg npm package", "npm i $pkg").unwrap(),
            create_rule(
                "install $ver version of $pkg npm package globally",
                "npm i -g $pkg@$ver",
            )
            .unwrap(),
            create_rule("install $pkg", "npm i $pkg").unwrap(),
        ];

        sort_rules_by_specificity(&mut rules);

        // Most specific (2 vars) should be first
        assert_eq!(rules[0].variables.len(), 2);
        // Then 1 var with longer pattern
        assert!(rules[1].pattern.len() > rules[2].pattern.len());
    }

    #[test]
    fn test_specificity_matching() {
        let rules = vec![
            create_rule("install $pkg npm package", "npm i $pkg").unwrap(),
            create_rule(
                "install $ver version of $pkg npm package globally",
                "npm i -g $pkg@$ver",
            )
            .unwrap(),
        ];

        // Should match the more specific rule
        let result = match_and_substitute(
            "install 1.0.0 version of express npm package globally",
            &rules,
        );
        assert!(result.matched);
        assert_eq!(result.command, "npm i -g express@1.0.0");
    }
}
