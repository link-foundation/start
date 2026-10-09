use start_command::parse_args;

#[test]
fn invalid_resource_inputs_are_rejected_before_launch() {
    for value in ["100%-90%", "101%", "0%", "0g", "3watts"] {
        let args = [
            "--isolated",
            "docker",
            "--image",
            "alpine",
            "--memory",
            value,
            "--",
            "true",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        assert!(parse_args(&args).is_err(), "{}", value);
    }
}

use serde_json::json;
use start_command::execution_control::{CommandRunOutput, CommandRunner};
struct Daemon;
impl CommandRunner for Daemon {
    fn run(&self, _: &str, args: &[String]) -> CommandRunOutput {
        assert_eq!(args[0], "info");
        CommandRunOutput {
            success: true,
            stdout: json!({"MemTotal":10737418240_u64,"NCPU":8}).to_string(),
            ..Default::default()
        }
    }
}
#[test]
fn launch_limits_resolve_daemon_percentages_and_default_swap() {
    let args = [
        "--isolated",
        "docker",
        "--memory",
        "70%-80%",
        "--cpus=50%",
        "--",
        "true",
    ]
    .map(String::from);
    let parsed = parse_args(&args).unwrap();
    assert_eq!(parsed.wrapper_options.memory.as_deref(), Some("70%-80%"));
    let (flags, values) = start_command::docker_resource_options::resolve(
        &start_command::docker_resource_options::specs(&parsed.wrapper_options),
        &[],
        &Daemon,
        || 0.5,
    )
    .unwrap();
    assert!(flags.contains(&"--memory=8053063680".into()));
    assert!(flags.contains(&"--cpus=4".into()));
    assert_eq!(values["memory"], values["memorySwap"]);
}
