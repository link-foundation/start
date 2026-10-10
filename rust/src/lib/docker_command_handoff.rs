//! Copy-free command handoff for newly launched detached Docker containers.
use crate::docker_cleanup::docker_command;
use crate::execution_control::{CommandRunOutput, CommandRunner};
use crate::isolation::isolation_log::shell_quote;
use std::fs;

pub fn command_handoff_path(session_name: &str) -> String {
    let safe: String = session_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("/.start-command-resume-{}", safe)
}

pub fn build_command_handoff_args(main_args: &[String], marker_path: &str) -> Vec<String> {
    let mut args = vec![
        "sh".into(),
        "-c".into(),
        "p=$1; shift; if [ -f \"$p\" ]; then exec sh \"$p\"; fi; exec \"$@\"".into(),
        "start-command-handoff".into(),
        marker_path.into(),
    ];
    args.extend_from_slice(main_args);
    args
}

pub fn build_command_handoff_script(command: &str, shell: &str, keep_alive: bool) -> String {
    use crate::isolation::isolation_shell::{
        docker_shell_args, is_interactive_shell_command, is_shell_invocation_with_args,
    };
    if !keep_alive
        && (is_interactive_shell_command(command) || is_shell_invocation_with_args(command))
    {
        return format!(
            "exec {}\n",
            docker_shell_args(command, "sh", false)
                .iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
    if shell == "auto" || shell.is_empty() {
        let effective = if keep_alive {
            format!("{}; exec \"$__START_COMMAND_HANDOFF_SHELL\"", command)
        } else {
            command.into()
        };
        return format!("__START_COMMAND_HANDOFF_SHELL=$(command -v bash || command -v zsh || command -v sh); export __START_COMMAND_HANDOFF_SHELL\ncase \"$__START_COMMAND_HANDOFF_SHELL\" in */bash|bash|*/zsh|zsh) exec \"$__START_COMMAND_HANDOFF_SHELL\" -i -c {};; *) exec \"$__START_COMMAND_HANDOFF_SHELL\" -c {};; esac\n", shell_quote(&effective), shell_quote(&effective));
    }
    let interactive = if matches!(shell.rsplit('/').next(), Some("bash" | "zsh")) {
        " -i"
    } else {
        ""
    };
    let effective = if keep_alive {
        format!("{}; exec {}", command, shell_quote(shell))
    } else {
        command.into()
    };
    format!(
        "exec {}{} -c {}\n",
        shell_quote(shell),
        interactive,
        shell_quote(&effective)
    )
}

pub fn write_command_handoff<R: CommandRunner + ?Sized>(
    name: &str,
    command: &str,
    shell: &str,
    keep_alive: bool,
    runner: &R,
) -> Result<CommandRunOutput, String> {
    let dir = std::env::temp_dir().join(format!("start-handoff-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("command");
    let result = (|| {
        fs::write(
            &file,
            build_command_handoff_script(command, shell, keep_alive),
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o644))
                .map_err(|e| e.to_string())?;
        }
        Ok(runner.run(
            &docker_command().to_string_lossy(),
            &[
                "cp".into(),
                file.to_string_lossy().into(),
                format!("{}:{}", name, command_handoff_path(name)),
            ],
        ))
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn selector_preserves_argv_and_replaces_only_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("command");
        let args = build_command_handoff_args(
            &["sh".into(), "-c".into(), "printf original".into()],
            &marker.to_string_lossy(),
        );
        let run = || {
            Command::new(&args[0])
                .args(&args[1..])
                .output()
                .unwrap()
                .stdout
        };
        assert_eq!(run(), b"original");
        fs::write(&marker, "exec sh -c 'printf replacement'\n").unwrap();
        assert_eq!(run(), b"replacement");
        assert_eq!(run(), b"replacement");
    }

    #[test]
    fn handoff_preserves_direct_shell_argv_and_compound_status() {
        for (command, expected) in [
            (
                "sh -c 'printf \"%s:%s\" \"$0\" \"$1\"' tag 'two words'",
                "tag:two words",
            ),
            ("sh -c 'exit 7'; printf 'after%s' \"$?\"", "after7"),
        ] {
            let result = Command::new("sh")
                .args(["-c", &build_command_handoff_script(command, "sh", false)])
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&result.stdout), expected);
        }
    }

    #[test]
    fn auto_handoff_chooses_an_installed_shell_inside_the_container() {
        let script = build_command_handoff_script("printf auto", "auto", false);
        assert!(script.contains("command -v bash || command -v zsh || command -v sh"));
        let result = Command::new("sh").args(["-c", &script]).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"auto");
    }
}
