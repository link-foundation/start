//! Parse and validate the launch-time recovery options (issue #176):
//!
//! ```text
//! --on-kill-resume <N>        resume up to N times when the main process is
//!                             killed (exit 137 / OOMKilled)
//! --recovery-command <cmd>    command to run in the same container on resume
//!                             (without it, the original command is re-run)
//! ```

use crate::args_parser::WrapperOptions;

fn parse_on_kill_resume_value(value: &str) -> Result<u32, String> {
    let text = value.trim();
    match text.parse::<u32>() {
        Ok(count) if count >= 1 && text.chars().all(|c| c.is_ascii_digit()) => Ok(count),
        _ => Err(format!(
            "Invalid --on-kill-resume value: \"{}\". Expected a positive integer.",
            value
        )),
    }
}

/// Parse one recovery option.
///
/// Returns the number of arguments consumed, or `Ok(0)` when `args[index]` is
/// not a recovery option.
pub fn parse_docker_recovery_option(
    args: &[String],
    index: usize,
    options: &mut WrapperOptions,
) -> Result<usize, String> {
    let arg = args[index].as_str();
    if arg == "--on-kill-resume" || arg == "--recovery-command" {
        let Some(value) = args.get(index + 1).filter(|value| !value.starts_with('-')) else {
            let kind = if arg == "--on-kill-resume" {
                "count"
            } else {
                "command"
            };
            return Err(format!("Option {} requires a {} argument", arg, kind));
        };
        if arg == "--on-kill-resume" {
            options.on_kill_resume = Some(parse_on_kill_resume_value(value)?);
        } else {
            options.recovery_command = Some(value.clone());
        }
        return Ok(2);
    }
    if let Some(value) = arg.strip_prefix("--on-kill-resume=") {
        options.on_kill_resume = Some(parse_on_kill_resume_value(value)?);
        return Ok(1);
    }
    if let Some(value) = arg.strip_prefix("--recovery-command=") {
        options.recovery_command = Some(value.to_string());
        return Ok(1);
    }
    Ok(0)
}

/// Recovery is driven by the detached docker completion watcher, so it needs a
/// detached docker session. A recovery command on its own implies one attempt.
pub fn validate_docker_recovery_options(options: &mut WrapperOptions) -> Result<(), String> {
    if let Some(command) = options.recovery_command.as_deref() {
        if command.trim().is_empty() {
            return Err("--recovery-command requires a non-empty command".to_string());
        }
        options.on_kill_resume.get_or_insert(1);
    }
    if options.on_kill_resume.is_none() {
        return Ok(());
    }
    let flag = if options.recovery_command.is_some() {
        "--recovery-command"
    } else {
        "--on-kill-resume"
    };
    if options.isolated.as_deref() != Some("docker") {
        return Err(format!(
            "{} option is only valid with --isolated docker as the only isolation level",
            flag
        ));
    }
    if !options.detached {
        return Err(format!("{} option requires --detached", flag));
    }
    Ok(())
}
