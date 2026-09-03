//! Regression tests for issue #164:
//! "Command argv is flattened with join(' '), so quoted arguments are re-parsed
//!  by the inner shell (`$ node -e \"console.log('hi')\"` fails)"
//!
//! Root cause: parse_args() returned `command_args.join(" ")`, so every argument
//! boundary and every quote the user typed was destroyed before the command
//! reached `sh -c`. `node -e "console.log('hi')"` became a syntax error and
//! `echo "a  b"` was re-split into two words.
//!
//! Fix: parse_args() rebuilds the command with build_command_string(): a single
//! argument is a shell script the user quoted as a whole and stays verbatim,
//! while multiple arguments are each shell-quoted.
//!
//! Reference: https://github.com/link-foundation/start/issues/164

use start_command::args_parser::parse_args;
use start_command::{
    build_command_string, build_command_string_with, build_display_command,
    build_shell_with_args_cmd_args, command_name, is_interactive_shell_command,
    is_shell_invocation_with_args, quote_shell_arg, quote_shell_arg_with, split_shell_words,
    split_shell_words_with, ShellQuotingStyle,
};
use std::process::Command;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_string()).collect()
}

fn parse_command(args: &[&str]) -> String {
    parse_args(&strings(args))
        .expect("parse_args failed")
        .command
}

/// Run the built binary the way a shell would: one process argument per argv element.
fn run_cli(args: &[&str]) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_start"))
        .args(args)
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .output()
        .expect("failed to run start");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
    )
}

/// The command output sits between the start block and the finish block.
fn command_output(stdout: &str) -> String {
    // PowerShell prefixes its output with a UTF-8 BOM and ends its lines with a
    // carriage return on Windows, and the finish block is preceded by one more
    // blank line there, so trailing blank lines are trimmed (issue #164).
    let cleaned = stdout.replace('\u{feff}', "").replace('\r', "");
    let lines: Vec<&str> = cleaned.split('\n').collect();
    let start = lines.iter().position(|l| l.starts_with("$ ")).unwrap_or(0);
    let finish = lines
        .iter()
        .position(|l| *l == "✓" || *l == "✗")
        .unwrap_or(lines.len());
    lines[(start + 2).min(finish)..finish.saturating_sub(1)]
        .join("\n")
        .trim_end_matches('\n')
        .to_string()
}

fn displayed_command(stdout: &str) -> String {
    stdout
        .split('\n')
        .find(|l| l.starts_with("$ "))
        .map(|l| l[2..].to_string())
        .unwrap_or_default()
}

mod parse_args_keeps_argv_boundaries {
    use super::*;

    #[test]
    fn quotes_argument_with_shell_metacharacters() {
        // PowerShell (the host shell on Windows) escapes a quote by doubling it.
        let expected = if cfg!(windows) {
            "node -e 'console.log(''hi'')'"
        } else {
            "node -e 'console.log('\\''hi'\\'')'"
        };
        assert_eq!(
            parse_command(&["node", "-e", "console.log('hi')"]),
            expected
        );
    }

    #[test]
    fn quotes_argument_with_repeated_spaces() {
        assert_eq!(parse_command(&["echo", "a  b"]), "echo 'a  b'");
    }

    #[test]
    fn keeps_single_argument_verbatim() {
        assert_eq!(parse_command(&["ls | wc -l"]), "ls | wc -l");
    }

    #[test]
    fn leaves_ordinary_arguments_unquoted() {
        // `%` is an alias for ForEach-Object in PowerShell, so it has to be
        // quoted there while a POSIX shell leaves it alone.
        let expected = if cfg!(windows) {
            "git log -1 '--pretty=%s'"
        } else {
            "git log -1 --pretty=%s"
        };
        assert_eq!(
            parse_command(&["git", "log", "-1", "--pretty=%s"]),
            expected
        );
    }

    #[test]
    fn keeps_boundaries_after_separator() {
        assert_eq!(
            parse_command(&[
                "--isolated",
                "docker",
                "--",
                "git",
                "commit",
                "-m",
                "msg with spaces"
            ]),
            "git commit -m 'msg with spaces'"
        );
    }

    #[test]
    fn returns_empty_command_without_a_command() {
        assert_eq!(parse_command(&["--list"]), "");
    }
}

mod build_command_string_tests {
    use super::*;

    #[test]
    fn returns_empty_string_for_empty_argv() {
        assert_eq!(build_command_string(&[]), "");
    }

    #[test]
    fn escapes_embedded_single_quotes_for_posix_shell() {
        assert_eq!(
            quote_shell_arg_with("it's", ShellQuotingStyle::Posix),
            "'it'\\''s'"
        );
    }

    #[test]
    fn escapes_embedded_single_quotes_for_powershell_by_doubling() {
        assert_eq!(
            quote_shell_arg_with("it's", ShellQuotingStyle::PowerShell),
            "'it''s'"
        );
    }

    #[test]
    fn quotes_characters_only_powershell_treats_specially() {
        assert_eq!(quote_shell_arg_with("a,b", ShellQuotingStyle::Posix), "a,b");
        assert_eq!(
            quote_shell_arg_with("a,b", ShellQuotingStyle::PowerShell),
            "'a,b'"
        );
    }

    #[test]
    fn uses_host_shell_dialect_by_default() {
        assert_eq!(
            quote_shell_arg("it's"),
            quote_shell_arg_with("it's", ShellQuotingStyle::host())
        );
    }

    #[test]
    fn quotes_empty_argument() {
        assert_eq!(build_command_string(&strings(&["echo", ""])), "echo ''");
    }

    #[test]
    fn round_trips_through_split_shell_words_in_both_dialects() {
        let argv = strings(&["node", "-e", "console.log('a  b')", "x$y", ""]);
        for style in [ShellQuotingStyle::Posix, ShellQuotingStyle::PowerShell] {
            assert_eq!(
                split_shell_words_with(&build_command_string_with(&argv, style), style),
                Some(argv.clone())
            );
        }
    }
}

mod split_shell_words_tests {
    use super::*;

    #[test]
    fn splits_on_unquoted_whitespace() {
        assert_eq!(
            split_shell_words("echo a b"),
            Some(strings(&["echo", "a", "b"]))
        );
    }

    #[test]
    fn keeps_double_quoted_words_together() {
        assert_eq!(
            split_shell_words("echo \"a  b\""),
            Some(strings(&["echo", "a  b"]))
        );
    }

    #[test]
    fn keeps_single_quoted_words_together() {
        assert_eq!(
            split_shell_words("echo 'a  b'"),
            Some(strings(&["echo", "a  b"]))
        );
    }

    #[test]
    fn honours_backslash_escapes_in_posix_shell() {
        assert_eq!(
            split_shell_words_with("echo a\\ b", ShellQuotingStyle::Posix),
            Some(strings(&["echo", "a b"]))
        );
    }

    #[test]
    fn keeps_backslashes_literal_for_powershell() {
        assert_eq!(
            split_shell_words_with("echo C:\\tmp", ShellQuotingStyle::PowerShell),
            Some(strings(&["echo", "C:\\tmp"]))
        );
    }

    #[test]
    fn reads_doubled_quote_inside_powershell_string_as_one_quote() {
        assert_eq!(
            split_shell_words_with("echo 'it''s'", ShellQuotingStyle::PowerShell),
            Some(strings(&["echo", "it's"]))
        );
    }

    #[test]
    fn returns_none_for_unbalanced_quotes() {
        assert_eq!(split_shell_words("echo \"a"), None);
    }
}

mod shell_detection_with_quoted_commands {
    use super::*;

    #[test]
    fn still_detects_bare_shell_invocation() {
        assert!(is_interactive_shell_command("bash"));
        assert!(!is_interactive_shell_command("bash -c 'echo hi'"));
    }

    #[test]
    fn detects_shell_invocation_with_quoted_script() {
        assert!(is_shell_invocation_with_args("bash -c 'echo hi'"));
    }

    #[test]
    fn passes_quoted_script_as_single_argv_element() {
        assert_eq!(
            build_shell_with_args_cmd_args("bash -i -c 'nvm --version'"),
            strings(&["bash", "-i", "-c", "nvm --version"])
        );
    }

    #[test]
    fn reads_command_name_from_first_shell_word() {
        assert_eq!(command_name("'my command' --flag"), "my command");
    }
}

mod display_command_tests {
    use super::*;

    #[test]
    fn re_quotes_argument_quoted_by_the_parser() {
        assert_eq!(
            build_display_command(&parse_command(&["echo", "a  b"])),
            "echo \"a  b\""
        );
    }

    #[test]
    fn re_quotes_argument_with_shell_metacharacters() {
        assert_eq!(
            build_display_command(&parse_command(&["node", "-e", "console.log('hi')"])),
            "node -e \"console.log('hi')\""
        );
    }

    #[test]
    fn shows_single_argument_script_verbatim() {
        assert_eq!(build_display_command("ls | wc -l"), "ls | wc -l");
    }
}

mod cli_end_to_end {
    use super::*;

    #[test]
    fn runs_node_e_with_quoted_script() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node not installed, skipping");
            return;
        }
        let (code, stdout) = run_cli(&["node", "-e", "console.log('hi')"]);
        assert_eq!(code, 0, "stdout: {}", stdout);
        assert_eq!(command_output(&stdout), "hi");
    }

    #[test]
    fn preserves_repeated_spaces_in_quoted_argument() {
        let (code, stdout) = run_cli(&["echo", "a  b"]);
        assert_eq!(code, 0);
        assert_eq!(command_output(&stdout), "a  b");
    }

    #[test]
    fn keeps_bash_c_scripts_intact_on_direct_path() {
        let (code, stdout) = run_cli(&["bash", "-c", "echo hello world"]);
        assert_eq!(code, 0);
        assert_eq!(command_output(&stdout), "hello world");
    }

    #[test]
    fn keeps_arithmetic_expansion_in_bash_c() {
        let (code, stdout) = run_cli(&["bash", "-c", "echo $((1+1))"]);
        assert_eq!(code, 0);
        assert_eq!(command_output(&stdout), "2");
    }

    #[test]
    fn still_runs_single_quoted_argument_as_shell_script() {
        let (code, stdout) = run_cli(&["echo one | tr a-z A-Z"]);
        assert_eq!(code, 0);
        assert_eq!(command_output(&stdout), "ONE");
    }

    #[test]
    fn displays_command_with_user_typed_quoting() {
        let (_code, stdout) = run_cli(&["echo", "a  b"]);
        assert_eq!(displayed_command(&stdout), "echo \"a  b\"");
    }
}
