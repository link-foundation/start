use start_command::isolation::{
    build_display_command, build_shell_with_args_cmd_args, is_interactive_shell_command,
    is_shell_invocation_with_args,
};

#[test]
fn compound_shell_commands_are_not_direct_invocations() {
    for op in [";", "&&", "||", "|", "&", ">", "<", "\n"] {
        let command = format!("sh -c 'exit 7'{} echo after $?", op);
        assert!(!is_shell_invocation_with_args(&command));
        assert_eq!(build_display_command(&command), command);
        assert!(!is_interactive_shell_command(&format!(
            "sh {} echo after",
            op
        )));
    }
}

#[test]
fn shell_script_and_positional_arguments_are_distinct() {
    assert_eq!(
        build_shell_with_args_cmd_args("sh -c 'echo $0 $1' a 'b c' ''"),
        vec!["sh", "-c", "echo $0 $1", "a", "b c", ""]
    );
    assert_eq!(
        build_shell_with_args_cmd_args("bash -i -c \"nvm --version\""),
        vec!["bash", "-i", "-c", "nvm --version"]
    );
    for command in [
        "sh -c",
        "sh file -c 'echo hi'",
        "sh -c \"echo $$\"",
        "sh -c echo *",
        "sh -c echo {a,b}",
        "sh -c 'echo hi'\u{00a0}arg",
        "sh -c echo \\\nhi",
    ] {
        assert!(!is_shell_invocation_with_args(command));
    }
}

#[test]
fn literal_shell_escapes_are_preserved() {
    assert_eq!(
        build_shell_with_args_cmd_args("sh -c \"printf \\q\""),
        vec!["sh", "-c", "printf \\q"]
    );
    assert_eq!(
        build_shell_with_args_cmd_args("sh -c \"echo \\$0\" a"),
        vec!["sh", "-c", "echo $0", "a"]
    );
    assert_eq!(
        build_shell_with_args_cmd_args("sh -c echo a\\;b"),
        vec!["sh", "-c", "echo", "a;b"]
    );
}

#[cfg(unix)]
#[test]
fn actual_shell_output_and_exit_status_are_preserved() {
    for (command, stdout, status) in [
        ("sh -c 'exit 7'; echo after $?", "after 7\n", 0),
        ("sh -c 'echo $0 $1' a b", "a b\n", 0),
        ("sh -c 'kill -9 $$'; exit $?", "", 137),
    ] {
        let args = if is_shell_invocation_with_args(command) {
            build_shell_with_args_cmd_args(command)
        } else {
            vec!["sh".to_string(), "-c".to_string(), command.to_string()]
        };
        let output = std::process::Command::new(&args[0])
            .args(&args[1..])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), stdout);
        assert_eq!(output.status.code(), Some(status));
    }
}
