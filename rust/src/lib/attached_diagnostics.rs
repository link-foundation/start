//! Attached runs use the same sampler and penalty monitor as detached watchers.
use crate::cgroup_memory::{self, CgroupMemory};
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use crate::isolation::isolation_log::{append_log_file, shell_quote};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

#[derive(Debug, Clone)]
pub struct DiagnosticFacts {
    pub memory: Option<CgroupMemory>,
    pub evidence: serde_json::Value,
}

pub struct AttachedDiagnostics {
    worker: Option<Child>,
    file: PathBuf,
}

impl AttachedDiagnostics {
    pub fn start(name: &str, options: &crate::isolation::IsolationOptions) -> Self {
        let file = std::env::temp_dir().join(format!("start-attached-{}", uuid::Uuid::new_v4()));
        let script = format!(
            "{}; {}; read __start_stop; {}; {}; printf '%s' \"$__start_command_cgroup\" > {}; printf '%s' \"$__start_command_memory_unavailable\" > {}",
            cgroup_memory::build_cgroup_sampler_start_snippet(name),
            {
                let cpu = crate::cpu_penalty_monitor::start_snippet_with_options(name, options);
                if cpu.is_empty() {
                    ":".into()
                } else {
                    cpu
                }
            },
            cgroup_memory::build_cgroup_sampler_stop_snippet(),
            crate::cpu_penalty_monitor::stop_snippet(),
            shell_quote(&file.to_string_lossy()),
            shell_quote(&format!("{}.reason", file.to_string_lossy()))
        );
        let worker = {
            Command::new("sh")
                .args(["-c", &script])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()
        };
        Self { worker, file }
    }

    pub fn finish(mut self, name: &str, log: Option<&PathBuf>) -> DiagnosticFacts {
        let started = self.worker.is_some();
        if let Some(mut worker) = self.worker.take() {
            drop(worker.stdin.take());
            let _ = worker.wait();
        }
        let sample = std::fs::read_to_string(&self.file).unwrap_or_default();
        let reason_file = PathBuf::from(format!("{}.reason", self.file.to_string_lossy()));
        let unavailable = std::fs::read_to_string(&reason_file)
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if started {
                    "sampler unavailable or stopped before a reading".into()
                } else {
                    "sampler could not start (sh unavailable)".into()
                }
            });
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_file(reason_file);
        let facts = crate::docker_cleanup::read_docker_container_state(name);
        let evidence = facts
            .as_ref()
            .map(|facts| {
                crate::exit_evidence::collect(
                    name,
                    &sample,
                    facts.finished_at.as_deref().unwrap_or(""),
                    &facts.exit_code.unwrap_or(-1).to_string(),
                    if facts.oom_killed == Some(true) {
                        "true"
                    } else {
                        "false"
                    },
                    &SystemCommandRunner,
                )
            })
            .unwrap_or_else(|| {
                "Exit evidence: unavailable (container could not be inspected)".into()
            });
        let limit = SystemCommandRunner.run(
            &crate::docker_cleanup::docker_command().to_string_lossy(),
            &[
                "inspect".into(),
                "-f".into(),
                "{{.HostConfig.Memory}}".into(),
                name.into(),
            ],
        );
        let memory_line =
            cgroup_memory::format_cgroup_memory_log_line(&sample).unwrap_or_else(|| {
                format!(
                    "Memory:     unavailable ({}) memory.limit={} (HostConfig)",
                    unavailable,
                    if limit.success {
                        limit.stdout.trim()
                    } else {
                        "unknown"
                    }
                )
            });
        if let Some(log) = log {
            append_log_file(log, &format!("{}\n{}\n", memory_line, evidence));
        }
        let (main, daemon) = crate::exit_evidence::from_log(Some(&evidence));
        DiagnosticFacts {
            memory: cgroup_memory::parse_cgroup_memory_sample(&sample),
            evidence: serde_json::json!({"mainOom": main, "daemonRestart": daemon}),
        }
    }
}
