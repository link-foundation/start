//! Query/control option parsing for the start-command wrapper.
//!
//! These options address an execution that already exists instead of starting
//! a new one: `--status`, `--list [--running]`, `--upload-log`, `--stop`,
//! `--terminate`, `--attach [--read-only]`, `--resume [-- <command>]`,
//! `--resume-all` and `--cleanup`. They are parsed here so `args_parser` stays
//! focused on the options that shape a new execution (issue #162).

use crate::args_parser::{WrapperOptions, VALID_OUTPUT_FORMATS};

/// Setter applied to the parsed options when an identifier option matches.
type IdentifierSetter = fn(&mut WrapperOptions, String);

/// Setter applied to the parsed options when a flag option matches.
type FlagSetter = fn(&mut WrapperOptions);

/// Options that take a UUID or session name argument.
const IDENTIFIER_OPTIONS: [(&str, IdentifierSetter); 6] = [
    ("--status", |o, v| o.status = Some(v)),
    ("--upload-log", |o, v| o.upload_log = Some(v)),
    ("--stop", |o, v| o.stop = Some(v)),
    ("--terminate", |o, v| o.terminate = Some(v)),
    ("--attach", |o, v| o.attach = Some(v)),
    ("--resume", |o, v| o.resume = Some(v)),
];

/// Options that are plain flags.
const FLAG_OPTIONS: [(&str, FlagSetter); 6] = [
    ("--list", |o| o.list = true),
    ("--running", |o| o.running = true),
    ("--read-only", |o| o.read_only = true),
    ("--resume-all", |o| o.resume_all = true),
    ("--cleanup", |o| o.cleanup = true),
    ("--cleanup-dry-run", |o| {
        o.cleanup = true;
        o.cleanup_dry_run = true;
    }),
];

/// Query modes that may be combined with `--output-format`.
const OUTPUT_FORMAT_MODES: [&str; 4] = ["--status", "--list", "--resume", "--resume-all"];

/// Parse one query/control option.
///
/// Returns the number of arguments consumed, or `Ok(0)` when `args[index]` is
/// not a query/control option.
pub fn parse_query_option(
    args: &[String],
    index: usize,
    options: &mut WrapperOptions,
) -> Result<usize, String> {
    let arg = &args[index];

    for (name, apply) in FLAG_OPTIONS {
        if arg == name {
            apply(options);
            return Ok(1);
        }
    }

    for (name, apply) in IDENTIFIER_OPTIONS {
        if arg == name {
            if index + 1 < args.len() && !args[index + 1].starts_with('-') {
                apply(options, args[index + 1].clone());
                return Ok(2);
            }
            return Err(format!(
                "Option {} requires a UUID or session name argument",
                arg
            ));
        }

        let prefix = format!("{}=", name);
        if let Some(value) = arg.strip_prefix(&prefix) {
            if value.is_empty() {
                return Err(format!(
                    "Option {} requires a UUID or session name argument",
                    name
                ));
            }
            apply(options, value.to_string());
            return Ok(1);
        }
    }

    if arg == "--output-format" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.output_format = Some(args[index + 1].to_lowercase());
            return Ok(2);
        }
        return Err(format!("Option {} requires a format argument", arg));
    }

    if arg.starts_with("--output-format=") {
        options.output_format = Some(arg.split('=').nth(1).unwrap_or("").to_lowercase());
        return Ok(1);
    }

    Ok(0)
}

/// List the query/control modes selected by these options.
pub fn active_query_modes(options: &WrapperOptions) -> Vec<&'static str> {
    let mut modes = Vec::new();
    if options.status.is_some() {
        modes.push("--status");
    }
    if options.list {
        modes.push("--list");
    }
    if options.upload_log.is_some() {
        modes.push("--upload-log");
    }
    if options.stop.is_some() {
        modes.push("--stop");
    }
    if options.terminate.is_some() {
        modes.push("--terminate");
    }
    if options.attach.is_some() {
        modes.push("--attach");
    }
    if options.resume.is_some() {
        modes.push("--resume");
    }
    if options.resume_all {
        modes.push("--resume-all");
    }
    if options.cleanup {
        modes.push("--cleanup");
    }
    modes
}

/// True when any query/control mode is active.
pub fn has_query_mode(options: &WrapperOptions) -> bool {
    !active_query_modes(options).is_empty()
}

/// Validate query/control option combinations.
pub fn validate_query_options(options: &WrapperOptions) -> Result<(), String> {
    if let Some(ref format) = options.output_format {
        if !VALID_OUTPUT_FORMATS.contains(&format.as_str()) {
            return Err(format!(
                "Invalid output format: \"{}\". Valid options are: {}",
                format,
                VALID_OUTPUT_FORMATS.join(", ")
            ));
        }
    }

    let modes = active_query_modes(options);

    if modes.len() > 1 {
        return Err(
            "Cannot combine --status, --list, --upload-log, --stop, --terminate, --attach, --resume, --resume-all, or --cleanup in the same invocation"
                .to_string(),
        );
    }

    if options.output_format.is_some()
        && !modes.iter().any(|mode| OUTPUT_FORMAT_MODES.contains(mode))
    {
        return Err(
            "--output-format option is only valid with --status, --list, --resume, or --resume-all"
                .to_string(),
        );
    }

    if options.running && !options.list {
        return Err("--running option is only valid with --list".to_string());
    }

    if options.read_only && options.attach.is_none() {
        return Err("--read-only option is only valid with --attach".to_string());
    }

    Ok(())
}
