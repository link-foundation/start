//! Regression tests for issue #171: the "Container kept for investigation" log
//! omits the post-mortem facts docker already has.
//!
//!   171.1 the watcher's single `docker inspect` must also collect
//!         `StartedAt`, `FinishedAt` and `Error`;
//!   171.2 a post-mortem block must be appended whenever the container is kept;
//!   171.3 the removal path must state the same facts in one line;
//!   171.4 signal decoding (`128+n` -> name) lives in one shared helper used by
//!         both the watcher (completion time) and the status formatter.

// The shell-snippet builders are only referenced by the `#[cfg(unix)]` module
// below; importing them here would be an unused import (and `-D warnings`, a
// build failure) on Windows.
use start_command::{
    describe_exit_code, format_container_post_mortem, format_container_removal_note,
    format_lifetime, normalize_docker_timestamp, ContainerPostMortem, DOCKER_STATE_INSPECT_FORMAT,
};

const STARTED_AT: &str = "2026-09-15T22:21:40.942007645Z";
const FINISHED_AT: &str = "2026-09-15T22:21:46.740817278Z";

// ---------------------------------------------------------------------------
// 171.4: one shared exit-code describer
// ---------------------------------------------------------------------------

#[test]
fn decodes_128_plus_n_into_the_signal_name() {
    let described = describe_exit_code(Some(137));
    assert_eq!(described.code, Some(137));
    assert_eq!(described.signal.as_deref(), Some("SIGKILL"));
    assert_eq!(described.text, "137 (SIGKILL - 128+9)");
    assert_eq!(
        describe_exit_code(Some(143)).signal.as_deref(),
        Some("SIGTERM")
    );
    assert_eq!(
        describe_exit_code(Some(139)).signal.as_deref(),
        Some("SIGSEGV")
    );
}

#[test]
fn leaves_ordinary_exit_codes_alone() {
    let zero = describe_exit_code(Some(0));
    assert_eq!(zero.text, "0");
    assert!(zero.signal.is_none());
    assert_eq!(describe_exit_code(Some(1)).text, "1");
    assert_eq!(describe_exit_code(Some(-1)).text, "-1");
}

#[test]
fn reports_unknown_for_a_missing_code() {
    assert_eq!(describe_exit_code(None).text, "unknown");
    assert!(describe_exit_code(None).signal.is_none());
    assert!(describe_exit_code(None).code.is_none());
}

// ---------------------------------------------------------------------------
// docker timestamp and lifetime helpers
// ---------------------------------------------------------------------------

#[test]
fn rejects_the_docker_zero_time_sentinel() {
    assert!(normalize_docker_timestamp(Some("0001-01-01T00:00:00Z")).is_none());
    assert!(normalize_docker_timestamp(Some("")).is_none());
    assert!(normalize_docker_timestamp(Some("unknown")).is_none());
    assert!(normalize_docker_timestamp(Some("<no value>")).is_none());
    assert!(normalize_docker_timestamp(None).is_none());
    assert_eq!(
        normalize_docker_timestamp(Some(FINISHED_AT)).as_deref(),
        Some(FINISHED_AT)
    );
}

#[test]
fn computes_the_container_lifetime() {
    assert_eq!(
        format_lifetime(Some(STARTED_AT), Some(FINISHED_AT)).as_deref(),
        Some("5.798s")
    );
    assert!(format_lifetime(Some("unknown"), Some("unknown")).is_none());
    assert!(format_lifetime(
        Some("2026-09-15T22:21:46.000Z"),
        Some("0001-01-01T00:00:00Z")
    )
    .is_none());
}

// ---------------------------------------------------------------------------
// 171.2: the kept-container log carries the post-mortem
// ---------------------------------------------------------------------------

#[test]
fn formats_the_post_mortem_block_in_the_documented_shape() {
    let block = format_container_post_mortem(&ContainerPostMortem {
        container_name: "demo".to_string(),
        exit_code: Some(137),
        oom_killed: Some(false),
        started_at: Some(STARTED_AT.to_string()),
        finished_at: Some(FINISHED_AT.to_string()),
        error: Some(String::new()),
    });

    assert!(block.contains("=== Container post-mortem ==="));
    assert!(block.contains("Exit Code:  137 (SIGKILL - 128+9)"));
    assert!(block.contains("OOMKilled:  false"));
    assert!(block.contains(&format!("StartedAt:  {}", STARTED_AT)));
    assert!(block.contains(&format!("FinishedAt: {}", FINISHED_AT)));
    assert!(block.contains("Lifetime:   5.798s"));
    assert!(block.contains("Error:      (none)"));
}

#[test]
fn renders_unknown_facts_instead_of_empty_fields() {
    let block = format_container_post_mortem(&ContainerPostMortem {
        container_name: "demo".to_string(),
        exit_code: None,
        oom_killed: None,
        started_at: Some("0001-01-01T00:00:00Z".to_string()),
        finished_at: Some(String::new()),
        error: Some("OCI runtime create failed".to_string()),
    });

    assert!(block.contains("Exit Code:  unknown"));
    assert!(block.contains("StartedAt:  unknown"));
    assert!(block.contains("Lifetime:   unknown"));
    assert!(block.contains("Error:      OCI runtime create failed"));
    assert!(!block.contains("0001-01-01"));
}

// ---------------------------------------------------------------------------
// 171.3: the removal path states the same facts
// ---------------------------------------------------------------------------

#[test]
fn formats_the_removal_note_as_a_single_line() {
    assert_eq!(
        format_container_removal_note(&ContainerPostMortem {
            container_name: "demo".to_string(),
            exit_code: Some(137),
            oom_killed: Some(false),
            started_at: Some(STARTED_AT.to_string()),
            finished_at: Some(FINISHED_AT.to_string()),
            error: None,
        }),
        "Container removed: demo (exit 137, SIGKILL, lifetime 5.798s, oomKilled=false)\n"
    );
}

// ---------------------------------------------------------------------------
// 171.1: the watcher collects the full state in one inspect
// ---------------------------------------------------------------------------

#[test]
fn asks_docker_for_exit_code_oom_flag_and_both_timestamps() {
    assert!(DOCKER_STATE_INSPECT_FORMAT.contains("{{.State.ExitCode}}"));
    assert!(DOCKER_STATE_INSPECT_FORMAT.contains("{{.State.OOMKilled}}"));
    assert!(DOCKER_STATE_INSPECT_FORMAT.contains("{{.State.StartedAt}}"));
    assert!(DOCKER_STATE_INSPECT_FORMAT.contains("{{.State.FinishedAt}}"));
}

// ---------------------------------------------------------------------------
// The generated watcher shell really writes those facts
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod shell {
    use super::*;
    use start_command::{
        build_docker_post_mortem_snippet, build_docker_removal_note_snippet,
        build_docker_state_snippet,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    fn write_fake_docker(bin_dir: &Path, state_line: &str, error_line: &str) {
        std::fs::create_dir_all(bin_dir).unwrap();
        let script = format!(
            "#!/bin/sh\n[ \"$1\" = \"inspect\" ] || exit 1\ncase \"$3\" in\n  *State.Error*) printf '%s\\n' '{}' ;;\n  *) printf '%s\\n' '{}' ;;\nesac\n",
            error_line, state_line
        );
        let docker_path = bin_dir.join("docker");
        std::fs::write(&docker_path, script).unwrap();
        let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&docker_path, permissions).unwrap();
    }

    fn write_failing_docker(bin_dir: &Path) {
        std::fs::create_dir_all(bin_dir).unwrap();
        let docker_path = bin_dir.join("docker");
        std::fs::write(&docker_path, "#!/bin/sh\nexit 1\n").unwrap();
        let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&docker_path, permissions).unwrap();
    }

    /// A `date` shaped like BSD's: it rejects GNU's `-d` and `%N` and only
    /// parses through `-j -f`. macOS CI runs the real thing; this stub makes the
    /// fallback branch reachable on Linux, where it would otherwise never run.
    fn write_bsd_date(bin_dir: &Path) {
        std::fs::create_dir_all(bin_dir).unwrap();
        let date_path = bin_dir.join("date");
        std::fs::write(
            &date_path,
            "#!/bin/sh\nif [ \"$1\" = \"-u\" ] && [ \"$2\" = \"-j\" ] && [ \"$3\" = \"-f\" ]; then\n  exec /bin/date -u -d \"$(echo \"$5\" | tr 'T' ' ')\" \"$6\"\nfi\nexit 1\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&date_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&date_path, permissions).unwrap();
    }

    fn run_snippet(bin_dir: &Path, snippet: &str) -> std::process::Output {
        let path = std::env::var("PATH").unwrap_or_default();
        Command::new("/bin/sh")
            .arg("-c")
            .arg(snippet)
            .env("PATH", format!("{}:{}", bin_dir.display(), path))
            .output()
            .expect("sh")
    }

    #[test]
    fn appends_the_post_mortem_block_for_a_kept_container() {
        let temp = TempDir::new().unwrap();
        let bin_dir = temp.path().join("bin");
        write_fake_docker(
            &bin_dir,
            &format!("137 false {} {}", STARTED_AT, FINISHED_AT),
            "",
        );
        let log_path = temp.path().join("run.log");
        let quoted = format!("'{}'", log_path.display());
        let snippet = format!(
            "{}; {}",
            build_docker_state_snippet("demo"),
            build_docker_post_mortem_snippet("demo", &quoted)
        );

        let output = run_snippet(&bin_dir, &snippet);
        assert!(output.status.success());
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(log.contains("=== Container post-mortem ==="));
        assert!(log.contains("Exit Code:  137 (SIGKILL - 128+9)"));
        assert!(log.contains("OOMKilled:  false"));
        assert!(log.contains(&format!("StartedAt:  {}", STARTED_AT)));
        assert!(log.contains(&format!("FinishedAt: {}", FINISHED_AT)));
        assert!(log.contains("Lifetime:   5.798s"));
        assert!(log.contains("Error:      (none)"));
    }

    #[test]
    fn appends_a_one_line_note_for_a_removed_container() {
        let temp = TempDir::new().unwrap();
        let bin_dir = temp.path().join("bin");
        write_fake_docker(
            &bin_dir,
            "0 false 2026-09-15T22:21:40.000000000Z 2026-09-15T22:21:41.500000000Z",
            "",
        );
        let log_path = temp.path().join("run.log");
        let quoted = format!("'{}'", log_path.display());
        let snippet = format!(
            "{}; {}",
            build_docker_state_snippet("demo"),
            build_docker_removal_note_snippet("demo", &quoted)
        );

        let output = run_snippet(&bin_dir, &snippet);
        assert!(output.status.success());
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(
            log.contains("Container removed: demo (exit 0, lifetime 1.500s, oomKilled=false)"),
            "log was: {}",
            log
        );
    }

    #[test]
    fn keeps_the_lifetime_exact_on_a_host_whose_date_is_bsd() {
        let temp = TempDir::new().unwrap();
        let bin_dir = temp.path().join("bin");
        write_fake_docker(
            &bin_dir,
            &format!("137 false {} {}", STARTED_AT, FINISHED_AT),
            "",
        );
        write_bsd_date(&bin_dir);
        let log_path = temp.path().join("run.log");
        let quoted = format!("'{}'", log_path.display());
        let snippet = format!(
            "{}; {}",
            build_docker_state_snippet("demo"),
            build_docker_post_mortem_snippet("demo", &quoted)
        );

        run_snippet(&bin_dir, &snippet);
        let log = std::fs::read_to_string(&log_path).unwrap();
        // Truncating both timestamps to whole seconds would report 6.000s here.
        assert!(log.contains("Lifetime:   5.798s"), "log was: {}", log);
    }

    #[test]
    fn keeps_sub_second_lifetimes_exact_on_a_bsd_date_host() {
        let temp = TempDir::new().unwrap();
        let bin_dir = temp.path().join("bin");
        write_fake_docker(
            &bin_dir,
            "0 false 2026-09-15T22:21:40.000000000Z 2026-09-15T22:21:41.500000000Z",
            "",
        );
        write_bsd_date(&bin_dir);
        let log_path = temp.path().join("run.log");
        let quoted = format!("'{}'", log_path.display());
        let snippet = format!(
            "{}; {}",
            build_docker_state_snippet("demo"),
            build_docker_removal_note_snippet("demo", &quoted)
        );

        run_snippet(&bin_dir, &snippet);
        let log = std::fs::read_to_string(&log_path).unwrap();
        // Truncating would collapse this to 1.000s.
        assert!(
            log.contains("Container removed: demo (exit 0, lifetime 1.500s, oomKilled=false)"),
            "log was: {}",
            log
        );
    }

    #[test]
    fn survives_an_inspect_failure_without_writing_garbage() {
        let temp = TempDir::new().unwrap();
        let bin_dir = temp.path().join("bin");
        write_failing_docker(&bin_dir);
        let log_path = temp.path().join("run.log");
        let quoted = format!("'{}'", log_path.display());
        let snippet = format!(
            "{}; {}",
            build_docker_state_snippet("demo"),
            build_docker_post_mortem_snippet("demo", &quoted)
        );

        let output = run_snippet(&bin_dir, &snippet);
        assert!(output.status.success());
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(log.contains("Exit Code:  -1"));
        assert!(log.contains("StartedAt:  unknown"));
        assert!(log.contains("Lifetime:   unknown"));
        assert!(!log.contains("0001-01-01"));
    }
}
