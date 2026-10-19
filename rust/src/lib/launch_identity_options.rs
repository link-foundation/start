//! Launch options about the identity of a new execution:
//!
//! - `--append-attempt`: run as the next attempt of the tracked execution
//!   named by `--session-id` instead of being refused (issue #229)
//! - `--continues <id>`: record that this execution continues an earlier one,
//!   which `--status` and `--upload-log` follow (issue #231)
//!
//! Both only apply when a command is launched, not to the query modes.
use crate::args_parser::WrapperOptions;
use crate::args_parser_queries::active_query_modes;

const CONTINUES_ERROR: &str = "Option --continues requires a UUID or session name argument";

/// Parse one launch identity option; `Ok(0)` when `args[index]` is not one.
pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> Result<usize, String> {
    let arg = args[index].as_str();
    if arg == "--append-attempt" {
        options.append_attempt = true;
        return Ok(1);
    }
    if arg == "--continues" {
        return match args.get(index + 1).filter(|next| !next.starts_with('-')) {
            Some(next) => {
                options.continues = Some(next.clone());
                Ok(2)
            }
            None => Err(CONTINUES_ERROR.into()),
        };
    }
    if let Some(value) = arg.strip_prefix("--continues=") {
        if value.is_empty() {
            return Err(CONTINUES_ERROR.into());
        }
        options.continues = Some(value.to_string());
        return Ok(1);
    }
    Ok(0)
}

/// Validate the launch identity options.
pub fn validate(options: &WrapperOptions) -> Result<(), String> {
    let mut used = Vec::new();
    if options.append_attempt {
        used.push("--append-attempt");
    }
    if options.continues.is_some() {
        used.push("--continues");
    }
    let Some(first) = used.first() else {
        return Ok(());
    };
    if !active_query_modes(options).is_empty() {
        return Err(format!(
            "{} option is only valid when launching a command",
            first
        ));
    }
    if options.append_attempt && options.session_id.is_none() {
        return Err("--append-attempt option requires --session-id <uuid>".into());
    }
    Ok(())
}
