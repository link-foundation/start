//! Grace period between the stop signal and SIGKILL for docker executions
//! (issue #265):
//!
//! ```text
//! start --stop <uuid> --stop-timeout <seconds>
//!     `docker stop -t <seconds> <container>` for this stop only
//! start --isolated docker --stop-timeout <seconds> -- <command>
//!     `docker run --stop-timeout <seconds>`, recorded with the execution, so
//!     a plain `docker stop` (and the daemon on shutdown) honors it too
//! ```
//!
//! `START_DOCKER_STOP_TIMEOUT=<seconds>` sets the default for both, so a
//! caller can configure it once. Without any of them Docker's own default
//! applies: SIGKILL 10 seconds after the stop signal.
//!
//! `--stop` resolves the grace period as: the `--stop-timeout` flag, then the
//! value recorded at launch (the container's own StopTimeout), then the
//! environment default, then Docker's 10 seconds.

use crate::args_parser::WrapperOptions;
use crate::execution_store::ExecutionRecord;
use serde_json::Value;

/// Environment variable holding the default grace period.
pub const DOCKER_STOP_TIMEOUT_ENV: &str = "START_DOCKER_STOP_TIMEOUT";
/// Docker's own grace period when none is given.
pub const DOCKER_DEFAULT_STOP_TIMEOUT: u64 = 10;

/// Environment lookup (`std::env::var` in production, a fake in tests).
pub type EnvLookup = dyn Fn(&str) -> Option<String>;

/// Parse a grace period in whole seconds.
pub fn parse_stop_timeout_value(value: &str, source: &str) -> Result<u64, String> {
    let text = value.trim();
    let invalid = || {
        format!(
            "Invalid {} value: \"{}\". Expected a non-negative whole number of seconds",
            source, value
        )
    };
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    // JavaScript's Number.MAX_SAFE_INTEGER, so both editions accept the same.
    match text.parse::<u64>() {
        Ok(seconds) if seconds <= 9_007_199_254_740_991 => Ok(seconds),
        _ => Err(invalid()),
    }
}

/// The environment default, or `None` when it is unset or empty.
pub fn stop_timeout_from_env(env: &EnvLookup) -> Result<Option<u64>, String> {
    match env(DOCKER_STOP_TIMEOUT_ENV) {
        Some(raw) if !raw.trim().is_empty() => {
            parse_stop_timeout_value(&raw, DOCKER_STOP_TIMEOUT_ENV).map(Some)
        }
        _ => Ok(None),
    }
}

/// Parse `--stop-timeout <seconds>` / `--stop-timeout=<seconds>`. Returns the
/// number of arguments consumed (0 if not recognized).
pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> Result<usize, String> {
    let arg = args[index].as_str();
    if arg == "--stop-timeout" {
        let Some(value) = args.get(index + 1).filter(|value| !value.starts_with('-')) else {
            return Err("Option --stop-timeout requires a number of seconds".to_string());
        };
        options.stop_timeout = Some(parse_stop_timeout_value(value, "--stop-timeout")?);
        return Ok(2);
    }
    if let Some(value) = arg.strip_prefix("--stop-timeout=") {
        options.stop_timeout = Some(parse_stop_timeout_value(value, "--stop-timeout")?);
        return Ok(1);
    }
    Ok(0)
}

/// Resolve `options.stop_timeout` from the environment. See
/// [`validate_with_env`].
pub fn validate(options: &mut WrapperOptions) -> Result<(), String> {
    validate_with_env(options, &|name| std::env::var(name).ok())
}

/// `--stop-timeout` belongs to `--stop` or to a docker launch. A docker launch
/// without it takes the environment default. Idempotent: validation may run
/// again on options it already resolved.
pub fn validate_with_env(options: &mut WrapperOptions, env: &EnvLookup) -> Result<(), String> {
    let is_docker = options.isolated.as_deref() == Some("docker");
    if options.stop_timeout.is_some() {
        if options.stop.is_none() && !is_docker {
            return Err(
                "--stop-timeout option is only valid with --stop or when isolation stack includes docker"
                    .to_string(),
            );
        }
        return Ok(());
    }
    options.stop_timeout = if is_docker {
        stop_timeout_from_env(env)?
    } else {
        None
    };
    Ok(())
}

/// The grace period `--stop` gives a docker execution: seconds, and whether
/// start chose them (so `docker stop -t` must pass them) rather than Docker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopTimeout {
    pub seconds: u64,
    pub explicit: bool,
}

/// Resolve the grace period: flag, recorded launch value, environment, Docker.
pub fn resolve_stop_timeout(
    record: &ExecutionRecord,
    requested: Option<u64>,
    env: &EnvLookup,
) -> Result<StopTimeout, String> {
    let explicit = |seconds| StopTimeout {
        seconds,
        explicit: true,
    };
    if let Some(seconds) = requested {
        return Ok(explicit(seconds));
    }
    match record.options.get("stopTimeout") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) => {
            return parse_stop_timeout_value(text, "recorded stopTimeout").map(explicit)
        }
        Some(other) => {
            return parse_stop_timeout_value(&other.to_string(), "recorded stopTimeout")
                .map(explicit)
        }
    }
    if let Some(seconds) = stop_timeout_from_env(env)? {
        return Ok(explicit(seconds));
    }
    Ok(StopTimeout {
        seconds: DOCKER_DEFAULT_STOP_TIMEOUT,
        explicit: false,
    })
}
