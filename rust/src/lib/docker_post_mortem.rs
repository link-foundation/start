//! Container post-mortem facts (issues #170, #171).
//!
//! When a detached container dies the only thing `start` used to write into the
//! log was `Reason: exitCode=137 oomKilled=false` — the two facts that, together,
//! say the least. `137` is `128 + 9`, i.e. SIGKILL, and `oomKilled=false` rules
//! out the cgroup OOM killer, so the container was killed from the outside
//! (`docker kill`, a `docker stop` escalation, systemd, the CI runner). None of
//! that was said out loud, and the three fields that would have shown *when* it
//! happened — `State.StartedAt`, `State.FinishedAt`, `State.Error` — were never
//! read at all, even though the watcher was already one `docker inspect` away
//! from them.
//!
//! This module owns those facts in one place:
//! - `describe_exit_code()` (re-exported from `exit_reason`) decodes `128 + n`
//!   once, for the watcher (completion time, written into the log) and for
//!   `--status` (query time, in memory), so the two can never disagree;
//! - the `build_*_snippet()` helpers generate the POSIX shell the detached
//!   watcher runs, including the signal table, so the shell and the runtime
//!   share a single source of truth;
//! - `format_container_post_mortem()` renders the same block for callers that
//!   already hold the facts in memory (the attached docker path).

use chrono::{DateTime, Utc};

use crate::exit_reason::{describe_exit_code, SIGNAL_NAMES, UNKNOWN_EXIT_CODE};
use crate::isolation::isolation_log::shell_quote;

/// Docker's zero value for a timestamp that was never set. `State.FinishedAt`
/// carries it for every container that has not finished, and `State.StartedAt`
/// for every container that never started. It must never reach a record as an
/// `endTime`: a year-1 timestamp is worse than an honest `null`.
pub const DOCKER_ZERO_TIME: &str = "0001-01-01T00:00:00Z";

/// Placeholder written instead of a fact that could not be observed.
pub const UNKNOWN: &str = UNKNOWN_EXIT_CODE;

/// Placeholder for `State.Error` when docker reported no error at all.
pub const NO_ERROR: &str = "(none)";

/// Header line of the post-mortem block appended to a kept container's log.
pub const POST_MORTEM_HEADER: &str = "=== Container post-mortem ===";

/// `docker inspect -f` template collecting every post-mortem fact at once.
pub const DOCKER_STATE_INSPECT_FORMAT: &str =
    "{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}} {{.State.FinishedAt}}";

/// Shell variables the completion watcher fills in and the snippets consume.
pub mod shell_vars {
    pub const EXIT: &str = "__start_command_exit";
    pub const OOM: &str = "__start_command_oom";
    pub const STARTED: &str = "__start_command_started";
    pub const FINISHED: &str = "__start_command_finished";
    pub const ERROR: &str = "__start_command_error";
    pub const ERROR_TEXT: &str = "__start_command_error_text";
    pub const SIGNAL: &str = "__start_command_signal";
    pub const EXIT_TEXT: &str = "__start_command_exit_text";
    pub const LIFETIME: &str = "__start_command_lifetime";
}

/// Facts read out of a container's `State` after it stopped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContainerPostMortem {
    pub container_name: String,
    pub exit_code: Option<i32>,
    pub oom_killed: Option<bool>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

/// Normalize a timestamp reported by `docker inspect`.
///
/// Returns `None` for docker's zero time, for the `<no value>` a missing field
/// renders as, and for anything that does not parse — an honest absence beats a
/// year-1 timestamp travelling onward as a finish time.
pub fn normalize_docker_timestamp(value: Option<&str>) -> Option<String> {
    let text = value.unwrap_or("").trim();
    if text.is_empty()
        || text == DOCKER_ZERO_TIME
        || text == UNKNOWN
        || text == "<no value>"
        || text == NO_ERROR
    {
        return None;
    }
    parse_timestamp(text)?;
    Some(text.to_string())
}

fn parse_timestamp(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .map(|value| value.with_timezone(&Utc))
        .ok()
}

/// Format the time a container was alive, e.g. `5.798s`.
pub fn format_lifetime(started_at: Option<&str>, finished_at: Option<&str>) -> Option<String> {
    let start = parse_timestamp(&normalize_docker_timestamp(started_at)?)?;
    let end = parse_timestamp(&normalize_docker_timestamp(finished_at)?)?;
    let ms = end.signed_duration_since(start).num_milliseconds();
    if ms < 0 {
        return None;
    }
    Some(format!("{}.{:03}s", ms / 1000, ms % 1000))
}

fn optional_bool_text(value: Option<bool>) -> String {
    match value {
        Some(value) => value.to_string(),
        None => UNKNOWN.to_string(),
    }
}

/// Render the post-mortem block for facts already held in memory.
pub fn format_container_post_mortem(facts: &ContainerPostMortem) -> String {
    let started = normalize_docker_timestamp(facts.started_at.as_deref());
    let finished = normalize_docker_timestamp(facts.finished_at.as_deref());
    let lifetime = format_lifetime(facts.started_at.as_deref(), facts.finished_at.as_deref());
    let error = facts.error.as_deref().unwrap_or("").trim().to_string();
    let container = if facts.container_name.is_empty() {
        UNKNOWN
    } else {
        &facts.container_name
    };
    format!(
        "{}\nContainer:  {}\nExit Code:  {}\nOOMKilled:  {}\nStartedAt:  {}\nFinishedAt: {}\nLifetime:   {}\nError:      {}\n",
        POST_MORTEM_HEADER,
        container,
        describe_exit_code(facts.exit_code).text,
        optional_bool_text(facts.oom_killed),
        started.as_deref().unwrap_or(UNKNOWN),
        finished.as_deref().unwrap_or(UNKNOWN),
        lifetime.as_deref().unwrap_or(UNKNOWN),
        if error.is_empty() { NO_ERROR } else { &error },
    )
}

/// Render the single line written when a container is removed, so a successful
/// run keeps its log terse while still carrying the same facts (issue #171.3).
pub fn format_container_removal_note(facts: &ContainerPostMortem) -> String {
    let described = describe_exit_code(facts.exit_code);
    let signal = described
        .signal
        .as_deref()
        .map(|name| format!(", {}", name))
        .unwrap_or_default();
    let lifetime = format_lifetime(facts.started_at.as_deref(), facts.finished_at.as_deref())
        .unwrap_or_else(|| UNKNOWN.to_string());
    let container = if facts.container_name.is_empty() {
        UNKNOWN
    } else {
        &facts.container_name
    };
    format!(
        "Container removed: {} (exit {}{}, lifetime {}, oomKilled={})\n",
        container,
        described
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| UNKNOWN.to_string()),
        signal,
        lifetime,
        optional_bool_text(facts.oom_killed),
    )
}

/// Shell fragment reading the container's terminal state.
///
/// The four whitespace-free fields are split with `set --` rather than the
/// `${var%% *}` / `${var##* }` pair the two-field version used: those only ever
/// reach the first and the last field. `State.Error` is read separately because
/// it is free-form text that can contain spaces.
pub fn build_docker_state_snippet(container_name: &str) -> String {
    let quoted_name = shell_quote(container_name);
    [
        format!(
            "__start_command_state=$(docker inspect -f '{}' {} 2>/dev/null || printf '%s' '-1 false {} {}')",
            DOCKER_STATE_INSPECT_FORMAT, quoted_name, UNKNOWN, UNKNOWN
        ),
        "set -- $__start_command_state".to_string(),
        format!("{}=${{1:--1}}", shell_vars::EXIT),
        format!("{}=${{2:-false}}", shell_vars::OOM),
        format!("{}=${{3:-{}}}", shell_vars::STARTED, UNKNOWN),
        format!("{}=${{4:-{}}}", shell_vars::FINISHED, UNKNOWN),
        format!(
            "{}=$(docker inspect -f '{{{{.State.Error}}}}' {} 2>/dev/null)",
            shell_vars::ERROR,
            quoted_name
        ),
        format!(
            "case \"${}\" in {}|'') {}={};; esac",
            shell_vars::STARTED,
            DOCKER_ZERO_TIME,
            shell_vars::STARTED,
            UNKNOWN
        ),
        format!(
            "case \"${}\" in {}|'') {}={};; esac",
            shell_vars::FINISHED,
            DOCKER_ZERO_TIME,
            shell_vars::FINISHED,
            UNKNOWN
        ),
        build_signal_decode_snippet(),
        build_lifetime_snippet(),
    ]
    .join("; ")
}

/// Shell fragment decoding `128 + n` into a signal name.
///
/// The `case` arms are generated from the very table `describe_exit_code()`
/// uses, so the log the watcher writes and the `exitReason` `--status` computes
/// can never name different signals for the same code (issue #171.4).
pub fn build_signal_decode_snippet() -> String {
    let arms: Vec<String> = SIGNAL_NAMES
        .iter()
        .map(|(signal, name)| format!("{}) {}={};;", 128 + signal, shell_vars::SIGNAL, name))
        .collect();
    [
        format!("{}=''", shell_vars::SIGNAL),
        format!("case \"${}\" in {} esac", shell_vars::EXIT, arms.join(" ")),
        format!("{}=\"${}\"", shell_vars::EXIT_TEXT, shell_vars::EXIT),
        format!(
            "if [ -n \"${}\" ]; then {}=\"${} (${} - 128+$(({} - 128)))\"; fi",
            shell_vars::SIGNAL,
            shell_vars::EXIT_TEXT,
            shell_vars::EXIT,
            shell_vars::SIGNAL,
            shell_vars::EXIT
        ),
    ]
    .join("; ")
}

/// Shell fragment computing how long the container was alive.
///
/// Best effort by design: `date -d` is GNU, `date -j -f` is BSD, and a host that
/// offers neither leaves the lifetime `unknown` rather than guessing. The two
/// timestamps get identical treatment, so even the BSD branch — which drops the
/// fractional part and the zone suffix — yields a correct difference.
pub fn build_lifetime_snippet() -> String {
    [
        concat!(
            "__start_command_epoch_ms() { ",
            "__start_command_ts=$(date -u -d \"$1\" +%s%3N 2>/dev/null); ",
            "case \"$__start_command_ts\" in ''|*[!0-9]*) ",
            "__start_command_ts=$(date -u -j -f '%Y-%m-%dT%H:%M:%S' \"${1%.*}\" +%s 2>/dev/null) && ",
            "__start_command_ts=\"${__start_command_ts}000\";; esac; ",
            "case \"$__start_command_ts\" in ''|*[!0-9]*) __start_command_ts='';; esac; ",
            "printf '%s' \"$__start_command_ts\"; }"
        )
        .to_string(),
        format!("{}={}", shell_vars::LIFETIME, UNKNOWN),
        format!(
            "__start_command_t0=$(__start_command_epoch_ms \"${}\")",
            shell_vars::STARTED
        ),
        format!(
            "__start_command_t1=$(__start_command_epoch_ms \"${}\")",
            shell_vars::FINISHED
        ),
        format!(
            concat!(
                "if [ -n \"$__start_command_t0\" ] && [ -n \"$__start_command_t1\" ] && ",
                "[ \"$__start_command_t1\" -ge \"$__start_command_t0\" ] 2>/dev/null; then ",
                "__start_command_ms=$((__start_command_t1 - __start_command_t0)); ",
                "{}=\"$((__start_command_ms / 1000)).$(printf '%03d' \"$((__start_command_ms % 1000))\")s\"; fi"
            ),
            shell_vars::LIFETIME
        ),
    ]
    .join("; ")
}

/// Shell fragment appending the post-mortem block for a kept container.
pub fn build_docker_post_mortem_snippet(container_name: &str, quoted_log_path: &str) -> String {
    format!(
        concat!(
            "{error_text}=\"${error}\"; ",
            "if [ -z \"${error_text}\" ]; then {error_text}='{none}'; fi; ",
            "printf '\\n{header}\\nContainer:  %s\\nExit Code:  %s\\n",
            "OOMKilled:  %s\\nStartedAt:  %s\\nFinishedAt: %s\\nLifetime:   %s\\nError:      %s\\n' ",
            "{name} \"${exit_text}\" \"${oom}\" \"${started}\" \"${finished}\" ",
            "\"${lifetime}\" \"${error_text}\" >> {log}"
        ),
        error_text = shell_vars::ERROR_TEXT,
        error = shell_vars::ERROR,
        none = NO_ERROR,
        header = POST_MORTEM_HEADER,
        name = shell_quote(container_name),
        exit_text = shell_vars::EXIT_TEXT,
        oom = shell_vars::OOM,
        started = shell_vars::STARTED,
        finished = shell_vars::FINISHED,
        lifetime = shell_vars::LIFETIME,
        log = quoted_log_path,
    )
}

/// Shell fragment appending the one-line note for a removed container.
pub fn build_docker_removal_note_snippet(container_name: &str, quoted_log_path: &str) -> String {
    format!(
        concat!(
            "__start_command_signal_note=''; ",
            "if [ -n \"${signal}\" ]; then __start_command_signal_note=\", ${signal}\"; fi; ",
            "printf '\\nContainer removed: %s (exit %s%s, lifetime %s, oomKilled=%s)\\n' ",
            "{name} \"${exit}\" \"$__start_command_signal_note\" \"${lifetime}\" \"${oom}\" >> {log}"
        ),
        signal = shell_vars::SIGNAL,
        name = shell_quote(container_name),
        exit = shell_vars::EXIT,
        lifetime = shell_vars::LIFETIME,
        oom = shell_vars::OOM,
        log = quoted_log_path,
    )
}
