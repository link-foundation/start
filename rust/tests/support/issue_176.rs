//! Fixtures shared by the issue #176 regression tests.
#![allow(dead_code)]

use serde_json::{json, Value};
use start_command::{
    CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions, SessionProbe, SessionState,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

/// HostConfig of the container from the issue after `docker update`.
pub fn updated_host_config() -> Value {
    json!({
        "Memory": 268435456_i64,
        "MemorySwap": 268435456_i64,
        "NanoCpus": 500000000_i64,
        "CpuQuota": 0,
        "CpuPeriod": 0,
        "CpuShares": 0,
        "CpusetCpus": "",
        "PidsLimit": 64,
        "ShmSize": 67108864_i64,
        "Ulimits": null,
    })
}

pub const ISSUE_LIMITS: [&str; 4] = [
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=0.5",
    "--pids-limit=64",
];

pub fn issue_limits() -> Vec<String> {
    ISSUE_LIMITS.iter().map(|flag| flag.to_string()).collect()
}

pub fn ok(stdout: &str) -> CommandRunOutput {
    CommandRunOutput {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
        status: Some(0),
        error: None,
    }
}

/// Fake runner that answers `docker inspect` and records every call.
#[derive(Default)]
pub struct FakeRunner {
    pub host_config: Value,
    pub container_status: String,
    pub failures: HashMap<String, String>,
    pub calls: RefCell<Vec<Vec<String>>>,
}

impl FakeRunner {
    pub fn new(host_config: Value) -> Self {
        FakeRunner {
            host_config,
            container_status: "exited".to_string(),
            ..FakeRunner::default()
        }
    }

    pub fn failing(mut self, verb: &str, stderr: &str) -> Self {
        self.failures.insert(verb.to_string(), stderr.to_string());
        self
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().clone()
    }

    pub fn verbs(&self) -> Vec<String> {
        self.calls().iter().map(|call| call[1].clone()).collect()
    }

    pub fn call(&self, verb: &str) -> Option<Vec<String>> {
        self.calls().into_iter().find(|call| call[1] == verb)
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        let mut call = vec![command.to_string()];
        call.extend(args.iter().cloned());
        self.calls.borrow_mut().push(call);
        let verb = args.first().map(String::as_str).unwrap_or("");
        if let Some(stderr) = self.failures.get(verb) {
            return CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: stderr.clone(),
                status: Some(1),
                error: None,
            };
        }
        if args.iter().any(|arg| arg == "--size") {
            return ok("1024\n");
        }
        if verb == "info" {
            return ok("{\"DockerRootDir\":\"/docker\"}");
        }
        if command == "df" {
            return ok("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mock 999999999 0 999999999 0% /docker");
        }
        if verb == "inspect" && args.iter().any(|arg| arg == "{{json .HostConfig}}") {
            return ok(&format!("{}\n", self.host_config));
        }
        if verb == "inspect" && args.iter().any(|arg| arg == "{{.State.Status}}") {
            return ok(&format!("{}\n", self.container_status));
        }
        ok("cid\n")
    }
}

pub fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

pub fn docker_record(
    status: ExecutionStatus,
    log_path: Option<&Path>,
    extra: Value,
) -> ExecutionRecord {
    let mut options: HashMap<String, Value> = HashMap::new();
    options.insert("isolated".to_string(), json!("docker"));
    options.insert("isolationMode".to_string(), json!("detached"));
    options.insert("sessionName".to_string(), json!("box"));
    options.insert("image".to_string(), json!("ubuntu:24.04"));
    if let Some(extra) = extra.as_object() {
        for (key, value) in extra {
            if value.is_null() {
                options.remove(key);
            } else {
                options.insert(key.clone(), value.clone());
            }
        }
    }
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "npm test".to_string(),
        status: Some(status),
        log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        options: Some(options),
        ..Default::default()
    })
}

pub fn stopped_probe() -> SessionProbe {
    SessionProbe {
        backend: Some("docker".to_string()),
        session_name: Some("box".to_string()),
        state: SessionState::Stopped,
        alive: false,
        container_status: Some("exited".to_string()),
    }
}

pub fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}
