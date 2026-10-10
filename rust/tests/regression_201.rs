use start_command::parse_args;
use std::process::Command;

#[test]
fn wrapper_help_prints_usage_and_preserves_command_help() {
    let cli = env!("CARGO_BIN_EXE_start");
    let usage = Command::new(cli).output().unwrap();
    for flag in ["--help", "-h"] {
        let result = Command::new(cli).arg(flag).output().unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, usage.stdout);
        assert!(result.stderr.is_empty());
        assert!(
            parse_args(&[flag.to_string()])
                .unwrap()
                .wrapper_options
                .help
        );
        let command = parse_args(&["--".into(), "grep".into(), flag.into()]).unwrap();
        assert!(!command.wrapper_options.help);
        assert_eq!(command.raw_command, vec!["grep", flag]);
    }
}
