//! Parse and validate the opt-in init process for docker isolation
//! (issue #244):
//!
//! ```text
//! --init      run `docker run --init`, so Docker's bundled tini is PID 1
//!             and reaps orphaned processes
//! --no-init   keep the command as PID 1, overriding the environment default
//! ```
//!
//! Without either flag, `START_COMMAND_DOCKER_INIT=1` turns it on for every
//! docker launch on the host. The default stays off: a command that is its
//! own supervisor keeps today's behaviour, and recovery works the same for
//! containers started with or without it.

use crate::args_parser::WrapperOptions;

/// Environment variable holding the host-wide default.
pub const DOCKER_INIT_ENV: &str = "START_COMMAND_DOCKER_INIT";

/// Whether an environment value asks for an init process (1, true, yes, on).
pub fn docker_init_from_env_value(value: Option<&str>) -> bool {
    let value = value.unwrap_or("").trim().to_lowercase();
    matches!(value.as_str(), "1" | "true" | "yes" | "on")
}

/// Parse `--init` / `--no-init`. Returns the number of arguments consumed.
pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> usize {
    match args[index].as_str() {
        "--init" => {
            options.init = Some(true);
            1
        }
        "--no-init" => {
            options.init = Some(false);
            1
        }
        _ => 0,
    }
}

/// Resolve `options.init` from the environment. See [`validate_with_env`].
pub fn validate(options: &mut WrapperOptions) -> Result<(), String> {
    validate_with_env(options, &|name| std::env::var(name).ok())
}

/// Resolve `options.init` to `Some(bool)`: the flag if one was given (`None`
/// means none), otherwise the environment default for docker launches.
/// Idempotent, because validation may run again on options it already
/// resolved: `--no-init` (or a resolved `false`) without docker is the default
/// anyway and is accepted.
pub fn validate_with_env(
    options: &mut WrapperOptions,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let is_docker = options.isolated.as_deref() == Some("docker");
    if options.init == Some(true) && !is_docker {
        return Err("--init option is only valid with --isolated docker".to_string());
    }
    if options.init.is_none() {
        options.init =
            Some(is_docker && docker_init_from_env_value(env(DOCKER_INIT_ENV).as_deref()));
    }
    Ok(())
}
