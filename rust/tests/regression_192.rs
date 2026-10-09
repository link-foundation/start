use start_command::cgroup_memory::{
    build_cgroup_memory_log_snippet, build_cgroup_sampler_start_snippet,
};
#[test]
fn remote_samples_and_explicit_unavailable_diagnostics() {
    assert!(build_cgroup_sampler_start_snippet("remote-task").contains("docker exec"));
    assert!(build_cgroup_memory_log_snippet("'/tmp/log'").contains("unavailable"));
}

#[test]
#[cfg(unix)]
fn real_shell_remote_missing_shell_outage_and_shared_namespace() {
    use start_command::cgroup_memory::build_cgroup_sampler_stop_snippet;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("sampler.sh");
    std::fs::write(
        &script,
        format!(
            "{}; sleep 1.2; {}; {}; cat \"$TMPDIR/memory.log\"",
            build_cgroup_sampler_start_snippet("remote-task"),
            build_cgroup_sampler_stop_snippet(),
            build_cgroup_memory_log_snippet("\"$TMPDIR/memory.log\"")
        ),
    )
    .unwrap();
    for mode in ["remote", "no-shell", "outage", "shared"] {
        let result = std::process::Command::new("/bin/sh")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../experiments/issue-195-memory-sampler.sh"
            ))
            .args([mode, script.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(result.status.success());
        let log = String::from_utf8(result.stdout).unwrap();
        if mode == "remote" || mode == "outage" {
            assert!(
                log.contains("memory.max=67108864 memory.peak=33554432 oom=1 oom_kill=3"),
                "{}",
                log
            );
        } else {
            assert!(log.contains("Memory:     unavailable"));
            assert!(log.contains("memory.limit=67108864 (HostConfig)"));
            assert!(log.contains(if mode == "no-shell" {
                "sh: not found"
            } else {
                "namespace=host"
            }));
        }
    }
}
