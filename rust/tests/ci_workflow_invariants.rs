//! Structural invariants for every GitHub Actions workflow (issue #158).
//!
//! These guard the CI/CD properties that silently regressed before: a job with
//! no timeout, a workflow-level `concurrency` block that cancels a started
//! release, a bare `always()` that keeps work running after cancellation, a
//! missing aggregate status job that lets a red run look green, and coverage
//! gates that swallow their own failures.
//!
//! This mirrors `js/test/ci-workflow-invariants.js`.

use std::fs;
use std::path::{Path, PathBuf};

/// Jobs that push commits, tags, releases or packages. They must share one
/// repository-wide concurrency group so two writers never run at once.
const WRITER_JOBS: [&str; 5] = [
    "release",
    "instant-release",
    "changeset-pr",
    "auto-release",
    "manual-release",
];
const MAIN_WRITER_GROUP: &str = "main-writer-${{ github.repository }}-main";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn workflow_dir() -> PathBuf {
    repo_root().join(".github").join("workflows")
}

fn list_workflows() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(workflow_dir())
        .unwrap()
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().to_string_lossy().to_string();
            (name.ends_with(".yml") || name.ends_with(".yaml")).then_some(name)
        })
        .collect();
    names.sort();
    names
}

fn read_workflow(name: &str) -> String {
    fs::read_to_string(workflow_dir().join(name))
        .unwrap()
        .replace("\r\n", "\n")
}

struct Job {
    name: String,
    body: String,
}

/// Split a workflow into job blocks using indentation.
fn parse_jobs(workflow: &str) -> Vec<Job> {
    let lines: Vec<&str> = workflow.split('\n').collect();
    let jobs_index = lines
        .iter()
        .position(|line| *line == "jobs:")
        .expect("workflow has no jobs: block");

    let is_job_header = |line: &str| -> Option<String> {
        let rest = line.strip_prefix("  ")?;
        if rest.starts_with(' ') {
            return None;
        }
        let key = rest.strip_suffix(':')?;
        (!key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .then(|| key.to_string())
    };

    let mut jobs = Vec::new();
    for index in (jobs_index + 1)..lines.len() {
        let Some(name) = is_job_header(lines[index]) else {
            continue;
        };
        let mut body = Vec::new();
        for line in lines.iter().skip(index + 1) {
            let starts_top_level = line.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
            if is_job_header(line).is_some() || starts_top_level {
                break;
            }
            body.push(*line);
        }
        jobs.push(Job {
            name,
            body: body.join("\n"),
        });
    }
    jobs
}

/// Value of a key inside a job body at the given indentation depth.
fn job_key_at(body: &str, key: &str, indent: usize) -> Option<String> {
    let prefix = format!("{}{key}:", " ".repeat(indent));
    body.lines()
        .find(|line| line.starts_with(&prefix) && !line[..indent].contains(|c: char| c != ' '))
        .map(|line| line[prefix.len()..].trim().to_string())
}

fn job_key(body: &str, key: &str) -> Option<String> {
    job_key_at(body, key, 4)
}

/// Value of a key inside the job's `concurrency:` block.
fn concurrency_key(body: &str, key: &str) -> Option<String> {
    job_key_at(body, key, 6)
}

/// The `needs:` of a job, written either inline (`needs: [a, b]`) or as a
/// block sequence of `- a` items.
fn parse_needs(body: &str) -> Option<Vec<String>> {
    let inline = job_key(body, "needs")?;
    if !inline.is_empty() {
        return Some(
            inline
                .split([',', '[', ']'])
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect(),
        );
    }
    let mut items = Vec::new();
    let mut seen_needs = false;
    for line in body.lines() {
        if line.starts_with("    needs:") {
            seen_needs = true;
            continue;
        }
        if !seen_needs {
            continue;
        }
        match line.strip_prefix("      - ") {
            Some(item) => items.push(item.trim().to_string()),
            None => break,
        }
    }
    Some(items)
}

#[test]
fn finds_every_workflow_file() {
    let workflows = list_workflows();
    assert!(workflows.len() >= 4, "only found {}", workflows.join(", "));
    for expected in ["js.yml", "rust.yml", "security.yml", "links.yml"] {
        assert!(
            workflows.iter().any(|name| name == expected),
            "missing {expected}"
        );
    }
}

#[test]
fn declares_a_least_privilege_default_permission_set() {
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        assert!(
            workflow.contains("\npermissions:\n  contents: read\n")
                || workflow.starts_with("permissions:\n  contents: read\n"),
            "{name} must default to read-only contents permission"
        );
    }
}

#[test]
fn gives_every_job_a_timeout() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            assert!(
                job_key(&job.body, "timeout-minutes").is_some(),
                "{name}: job \"{}\" has no timeout-minutes",
                job.name
            );
        }
    }
}

#[test]
fn never_puts_concurrency_at_workflow_level() {
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        assert!(
            !workflow.lines().any(|line| line == "concurrency:"),
            "{name}: workflow-level concurrency would also cancel started writers"
        );
    }
}

#[test]
fn gives_every_job_its_own_concurrency_group() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            if job.name == "pipeline-status" {
                continue;
            }
            assert!(
                concurrency_key(&job.body, "group").is_some(),
                "{name}: job \"{}\" has no concurrency group",
                job.name
            );
        }
    }
}

#[test]
fn writers_share_the_main_writer_group_and_are_not_cancellable() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            if !WRITER_JOBS.contains(&job.name.as_str()) {
                continue;
            }
            let Some(group) = concurrency_key(&job.body, "group") else {
                panic!("{name}: writer \"{}\" has no concurrency group", job.name);
            };
            assert_eq!(
                group, MAIN_WRITER_GROUP,
                "{name}: writer \"{}\" must use the shared main-writer group",
                job.name
            );
            assert_eq!(
                concurrency_key(&job.body, "cancel-in-progress").as_deref(),
                Some("false"),
                "{name}: writer \"{}\" must not be cancellable",
                job.name
            );
        }
    }
}

#[test]
fn read_only_checks_are_cancellable() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            if WRITER_JOBS.contains(&job.name.as_str()) {
                continue;
            }
            let Some(group) = concurrency_key(&job.body, "group") else {
                continue;
            };
            assert!(
                group.starts_with("check-"),
                "{name}: check \"{}\" must use a check-* group, got {group}",
                job.name
            );
            assert_eq!(
                concurrency_key(&job.body, "cancel-in-progress").as_deref(),
                Some("true"),
                "{name}: superseded check \"{}\" should be cancelled",
                job.name
            );
        }
    }
}

#[test]
fn uses_not_cancelled_rather_than_always_outside_the_status_job() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            if job.name == "pipeline-status" {
                continue;
            }
            assert!(
                !job.body.contains("always()"),
                "{name}: job \"{}\" uses always(); use !cancelled() so cancellation propagates",
                job.name
            );
        }
    }
}

#[test]
fn aggregates_every_job_into_a_pipeline_status_gate() {
    for name in list_workflows() {
        let jobs = parse_jobs(&read_workflow(&name));
        let status = jobs
            .iter()
            .find(|job| job.name == "pipeline-status")
            .unwrap_or_else(|| panic!("{name}: no pipeline-status job"));
        assert!(
            status.body.contains("if: always()"),
            "{name}: pipeline-status must run even when jobs are cancelled"
        );
        let needs = parse_needs(&status.body)
            .unwrap_or_else(|| panic!("{name}: pipeline-status has no needs"));
        for job in &jobs {
            if job.name == "pipeline-status" {
                continue;
            }
            assert!(
                needs.contains(&job.name),
                "{name}: pipeline-status does not depend on \"{}\"",
                job.name
            );
        }
    }
}

#[test]
fn configures_git_before_checkout_so_no_init_hints_are_printed() {
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        assert!(workflow.contains("GIT_CONFIG_COUNT: '1'"), "{name}");
        assert!(
            workflow.contains("GIT_CONFIG_KEY_0: init.defaultBranch"),
            "{name}"
        );
        assert!(workflow.contains("GIT_CONFIG_VALUE_0: main"), "{name}");
    }
}

#[test]
fn never_swallows_a_failing_command_in_a_quality_gate() {
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        for (index, line) in workflow.lines().enumerate() {
            // `|| true` on a `grep` that is allowed to find nothing is fine; the
            // regression was `... | tee coverage.txt || true`, which hid failing
            // tests from the coverage job.
            let hides_a_gate = ["tee ", "bun run", "cargo ", "npm run"]
                .iter()
                .any(|needle| line.contains(needle));
            assert!(
                !(line.contains("|| true") && hides_a_gate && !line.trim_start().starts_with('#')),
                "{name}:{} uses \"|| true\", which hides failures: {}",
                index + 1,
                line.trim()
            );
        }
    }
}

#[test]
fn references_only_helper_scripts_that_exist() {
    let root = repo_root();
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        for token in workflow.split_whitespace() {
            let Some(path) = token.strip_prefix("scripts/") else {
                continue;
            };
            let path = path.trim_end_matches(|c: char| !(c.is_ascii_alphanumeric()));
            if path.is_empty() {
                continue;
            }
            let full = root.join("scripts").join(path);
            assert!(full.exists(), "{name} references missing scripts/{path}");
        }
    }
}

#[test]
fn parses_coverage_through_the_tested_helper_not_an_inline_grep() {
    let js = read_workflow("js.yml");
    assert!(
        !js.contains(r"grep -oP '\d+\.\d+(?=%)'"),
        "the inline coverage grep never matched Bun output (issue #158)"
    );
    assert!(js.contains("scripts/check-js-coverage.mjs"));
    assert!(
        !js.contains("Could not determine coverage, skipping check"),
        "an unparsable coverage report must fail, not skip"
    );
}

#[test]
fn coverage_step_enables_pipefail_so_tee_cannot_hide_failures() {
    let js = read_workflow("js.yml");
    assert!(
        js.contains("set -o pipefail"),
        "the coverage step pipes bun test into tee; without pipefail a failing \
         test run is reported as success (issue #158)"
    );
}

#[test]
fn rust_workflow_keeps_the_test_parity_gate() {
    let rust = read_workflow("rust.yml");
    assert!(
        rust.contains("scripts/check-test-parity.mjs"),
        "rust.yml must keep enforcing JS/Rust test parity"
    );
    let parity = parse_jobs(&rust)
        .into_iter()
        .find(|job| job.name == "test-parity")
        .expect("rust.yml has no test-parity job");
    assert!(job_key(&parity.body, "timeout-minutes").is_some());
}

#[test]
fn security_workflow_scans_code_dependencies_and_secrets() {
    let security = read_workflow("security.yml");
    assert!(
        security.contains("github/codeql-action"),
        "no CodeQL analysis"
    );
    assert!(
        security.contains("dependency-review-action"),
        "no dependency review"
    );
    assert!(security.contains("secretlint"), "no secret scanning");
    for language in ["javascript-typescript", "actions", "rust"] {
        assert!(
            security.contains(language),
            "CodeQL matrix does not cover {language}"
        );
    }
}

#[test]
fn link_workflow_checks_links_and_falls_back_to_the_web_archive() {
    let links = read_workflow("links.yml");
    assert!(
        links.contains("lycheeverse/lychee-action"),
        "no link checker"
    );
    assert!(
        links.contains("scripts/check-web-archive.mjs"),
        "no Wayback Machine fallback for dead links"
    );
    assert!(
        repo_root().join(".lycheeignore").exists(),
        "missing .lycheeignore"
    );
}

// --- issue #168: false negatives the pipeline could not see -----------------

/// Split a job body into individual `- ...` step blocks.
fn parse_steps(body: &str) -> Vec<String> {
    let mut steps: Vec<String> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    let mut indent = 0usize;
    for line in body.lines() {
        let line_indent = line.len() - line.trim_start().len();
        let starts_step = line.trim_start().starts_with("- ");
        if starts_step && (current.is_none() || line_indent == indent) {
            if let Some(step) = current.take() {
                steps.push(step.join("\n"));
            }
            indent = line_indent;
            current = Some(vec![line]);
            continue;
        }
        if let Some(step) = current.as_mut() {
            step.push(line);
        }
    }
    if let Some(step) = current {
        steps.push(step.join("\n"));
    }
    steps
}

/// True when line `index` of `workflow` sits inside a `run:` block.
fn in_run_block(lines: &[&str], index: usize) -> bool {
    let line = lines[index];
    let trimmed = line.trim_start();
    if trimmed.starts_with("run:") || trimmed.starts_with("- run:") {
        return true;
    }
    if trimmed.is_empty() {
        return false;
    }
    let indent = line.len() - trimmed.len();
    for previous in lines[..index].iter().rev() {
        let previous_trimmed = previous.trim_start();
        if previous_trimmed.is_empty() {
            continue;
        }
        let previous_indent = previous.len() - previous_trimmed.len();
        if previous_indent >= indent {
            continue;
        }
        return (previous_trimmed.starts_with("run:") || previous_trimmed.starts_with("- run:"))
            && (previous_trimmed.ends_with('|') || previous_trimmed.ends_with('>'));
    }
    false
}

/// `${{ github.<context> }}` references that a fork pull request controls.
fn untrusted_interpolation(line: &str) -> bool {
    for start in line.match_indices("${{").map(|(index, _)| index) {
        let rest = line[start + 3..].trim_start();
        let Some(context) = rest.strip_prefix("github.") else {
            continue;
        };
        if context.starts_with("head_ref") || context.starts_with("base_ref") {
            return true;
        }
        if let Some(event) = context.strip_prefix("event.") {
            let name = event
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
                .next()
                .unwrap_or("");
            if ["title", "body", "name", "label", "ref"]
                .iter()
                .any(|field| name.ends_with(field))
            {
                return true;
            }
        }
    }
    false
}

#[test]
fn lints_and_audits_the_workflows_themselves() {
    let workflows = list_workflows();
    assert!(
        workflows.iter().any(|name| name == "workflows.yml"),
        "no workflows.yml: nothing ran actionlint or zizmor over .github/workflows"
    );
    let meta = read_workflow("workflows.yml");
    assert!(
        meta.contains("rhysd/actionlint"),
        "workflows.yml must run actionlint"
    );
    assert!(meta.contains("zizmor"), "workflows.yml must run zizmor");
    for config in ["zizmor.yml", "actionlint.yaml"] {
        assert!(
            repo_root().join(".github").join(config).exists(),
            "missing .github/{config}"
        );
    }
}

#[test]
fn never_interpolates_untrusted_context_into_a_run_block() {
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        let lines: Vec<&str> = workflow.split('\n').collect();
        for index in 0..lines.len() {
            let line = lines[index];
            if line.trim_start().starts_with('#') {
                continue;
            }
            assert!(
                !(in_run_block(&lines, index) && untrusted_interpolation(line)),
                "{name}:{}: interpolates untrusted context into run:; pass it through env: instead - {}",
                index + 1,
                line.trim()
            );
        }
    }
}

#[test]
fn does_not_persist_credentials_on_read_only_checkouts() {
    for name in list_workflows() {
        for job in parse_jobs(&read_workflow(&name)) {
            if WRITER_JOBS.contains(&job.name.as_str()) {
                continue;
            }
            for step in parse_steps(&job.body) {
                if !step.contains("uses: actions/checkout") {
                    continue;
                }
                assert!(
                    step.contains("persist-credentials: false"),
                    "{name}: read-only job \"{}\" checks out with the token left in .git/config",
                    job.name
                );
            }
        }
    }
}

#[test]
fn pins_third_party_actions_to_a_commit_hash() {
    // Trusted first-party namespaces may use a moving tag; anything else is a
    // mutable ref in a job that can hold write credentials.
    const TRUSTED: [&str; 7] = [
        "actions/",
        "github/",
        "docker/",
        "astral-sh/",
        "lycheeverse/",
        "zizmorcore/",
        "changesets/",
    ];
    for name in list_workflows() {
        let workflow = read_workflow(&name);
        for line in workflow.lines() {
            let trimmed = line.trim_start().trim_start_matches("- ");
            let Some(reference) = trimmed.strip_prefix("uses:") else {
                continue;
            };
            let reference = reference.split_whitespace().next().unwrap_or("");
            if reference.starts_with("docker://")
                || reference.starts_with("./")
                || TRUSTED.iter().any(|prefix| reference.starts_with(prefix))
            {
                continue;
            }
            let sha = reference.rsplit('@').next().unwrap_or("");
            assert!(
                sha.len() == 40
                    && sha
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
                "{name}: third-party action {reference} must be pinned to a commit hash"
            );
        }
    }
}

#[test]
fn audits_both_dependency_graphs_for_advisories() {
    let security = read_workflow("security.yml");
    let jobs: Vec<String> = parse_jobs(&security).into_iter().map(|j| j.name).collect();
    for job in ["cargo-audit", "npm-audit"] {
        assert!(
            jobs.iter().any(|name| name == job),
            "security.yml has no {job} job"
        );
    }
    assert!(
        security.contains("cargo audit"),
        "cargo-audit job must run cargo audit"
    );
    assert!(
        security.contains("npm audit"),
        "npm-audit job must run npm audit"
    );
}

#[test]
fn lints_the_repository_level_scripts_directory() {
    // js/eslint.config.mjs has js/ as its base path, so `eslint .` run from js/
    // silently skipped scripts/ - the release automation (issue #168).
    assert!(
        repo_root().join("eslint.config.mjs").exists(),
        "no repository-level eslint.config.mjs: scripts/ would go unlinted"
    );
    let js = read_workflow("js.yml");
    assert!(js.contains("lint:scripts"), "js.yml must lint scripts/");
    assert!(
        js.contains("format:check:scripts"),
        "js.yml must format-check scripts/"
    );
}
