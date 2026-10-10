"""Inventory explicit JS/Rust feature evidence and manual translation blockers."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
groups = {
    "cli": (["bin/cli.js", "lib/command-stream.js", "lib/spawn-helpers.js", "lib/version.js", "lib/usage.js"], ["bin/main.rs", "lib/mod.rs", "lib/usage.rs", "lib/atty.rs", "lib/signal_handler.rs"], ["cli.js", "version.js", "regression-201.js", "regression-202.js"], ["integration.rs", "signal_handler.rs", "regression_201.rs", "regression_202.rs"]),
    "arguments": (["lib/args-parser.js", "lib/args-parser-queries.js"], ["lib/args_parser.rs", "lib/args_parser_queries.rs", "lib/args_parser_cases.rs"], ["args-parser.js", "args-parser-control.js"], ["args_parser.rs"]),
    "isolation": (["lib/isolation.js", "lib/command-builder.js", "lib/screen-isolation.js", "lib/shell-utils.js"], ["lib/isolation.rs", "lib/isolation_cases.rs", "lib/isolation_screen.rs", "lib/isolation_shell.rs"], ["isolation.js", "isolation-stacking.js"], ["isolation.rs", "isolation_unit.rs"]),
    "docker-options": (["lib/docker-utils.js", "lib/docker-runtime-args.js", "lib/docker-resource-options.js", "lib/docker-network-options.js", "lib/docker-labels.js"], ["lib/docker_resource_options.rs", "lib/isolation_metadata.rs", "lib/isolation_metadata_cases.rs", "lib/docker_labels.rs"], ["docker-runtime-options.js", "regression-199.js"], ["regression_193.rs", "regression_199.rs"]),
    "docker-cleanup": (["lib/docker-cleanup.js"], ["lib/docker_cleanup.rs", "lib/docker_cleanup_cases.rs"], ["docker-autoremove.js", "command-builder-docker-cleanup.js"], ["cleanup.rs"]),
    "docker-networks": (["lib/docker-network-lifecycle.js"], ["lib/docker_network_lifecycle.rs"], ["docker-network-lifecycle.js"], ["docker_network.rs"]),
    "docker-diagnostics": (["lib/docker-post-mortem.js", "lib/cgroup-memory.js", "lib/docker-resource-limits.js", "lib/resume-resources.js"], ["lib/docker_post_mortem.rs", "lib/cgroup_memory.rs", "lib/docker_resource_limits.rs", "lib/resume_resources.rs"], ["regression-182.js"], ["regression_182.rs"]),
    "execution-records": (["lib/execution-store.js", "lib/store-lock.js", "lib/atomic-write.js", "lib/launch-persistence.js"], ["lib/execution_store.rs", "lib/execution_store_cases.rs", "lib/store_lock.rs", "lib/atomic_write.rs", "lib/lino_value_json.rs"], ["execution-store.js"], ["execution_store.rs"]),
    "execution-attempts": (["lib/execution-attempt.js", "lib/launch-owner.js", "lib/detached-finalize.js", "lib/detached-output.js", "lib/attached-diagnostics.js"], ["lib/execution_attempt.rs", "lib/launch_owner.rs", "lib/detached_finalize.rs", "lib/detached_output.rs", "lib/attached_diagnostics.rs"], ["regression-194.js"], ["regression_194.rs"]),
    "execution-control": (["lib/execution-control.js", "lib/execution-attach.js", "lib/query-commands.js"], ["lib/execution_control.rs", "lib/execution_attach.rs", "lib/execution_attach_cases.rs", "lib/query_commands.rs"], ["execution-control.js", "execution-attach.js"], ["execution_control.rs"]),
    "execution-resume": (["lib/execution-resume.js", "lib/execution-resume-all.js", "lib/docker-snapshot-safety.js", "lib/docker-command-handoff.js"], ["lib/execution_resume.rs", "lib/execution_resume_cases.rs", "lib/execution_resume_flow.rs", "lib/execution_resume_all.rs", "lib/execution_resume_all_cases.rs", "lib/docker_snapshot_safety.rs", "lib/docker_command_handoff.rs"], ["execution-resume.js", "regression-193.js", "regression-198.js", "docker-command-handoff.js", "docker-snapshot-safety.js"], ["regression_176.rs"]),
    "execution-recovery": (["lib/execution-recovery.js", "lib/docker-recovery-options.js", "lib/recovery-delay.js"], ["lib/execution_recovery.rs", "lib/docker_recovery_options.rs", "lib/recovery_delay.rs"], ["regression-181.js"], ["regression_181.rs"]),
    "cpu-penalty": (["lib/cpu-penalty.js", "lib/cpu-penalty-monitor.js"], ["lib/cpu_penalty.rs", "lib/cpu_penalty_monitor.rs"], ["regression-189.js", "regression-190.js"], ["regression_189.rs"]),
    "status": (["lib/status-formatter.js", "lib/session-probe.js", "lib/isolation-log-utils.js", "lib/exit-reason.js", "lib/exit-evidence.js"], ["lib/status_formatter.rs", "lib/status_footer.rs", "lib/status_probe.rs", "lib/session_probe.rs", "lib/session_probe_cases.rs", "lib/isolation_log.rs", "lib/exit_reason.rs", "lib/exit_evidence.rs"], ["status-query.js", "session-probe.js", "exit-reason.js"], ["status_formatter.rs", "isolation_log.rs", "regression_201.rs"]),
    "output": (["lib/output-blocks.js"], ["lib/output_blocks.rs"], ["output-blocks.js"], ["output_blocks.rs"]),
    "sequences": (["lib/sequence-parser.js"], ["lib/sequence_parser.rs"], ["sequence-parser.js"], ["sequence_parser.rs"]),
    "substitution": (["lib/substitution.js"], ["lib/substitution.rs"], ["substitution.js"], ["integration.rs"]),
    "user-management": (["lib/user-manager.js"], ["lib/user_manager.rs", "lib/local_hostname.rs"], ["user-manager.js"], ["user_manager.rs"]),
    "failure-reporting": (["lib/failure-handler.js", "lib/log-uploader.js", "lib/log-sanitizer.js"], ["lib/failure_handler.rs", "lib/log_uploader.rs", "lib/log_sanitizer.rs"], ["failure-handler.js", "log-sanitizer.js"], ["failure_handler.rs", "log_sanitizer.rs"]),
}
# Every blocker below is anchored to an actual source construct, not a count proxy.
constructs = [
    ("CommonJS and native Node/Bun adapters", r"require\(|module\.exports", 222),
    ("async/await scheduling", r"\basync\b|\bawait\b", 223),
    ("optional/nullish fields", r"\?\.|\?\?", 204),
    ("dynamic object/JSON records", r"JSON\.|Object\.|return \{", 206),
    ("callbacks and closures", r"=>", 207),
    ("array/list operations", r"\.(map|filter|join|push|slice|some|includes)\(", 208),
    ("string operations", r"\.(replace|replaceAll|startsWith|trim|split)\(", 209),
    ("classes, Map/Set", r"\bclass\b|new (Map|Set)\(", 210),
    ("regular expressions", r"\.test\(|\.match\(", 211),
    ("try/catch, switch, destructuring", r"\btry\s*\{|\bcatch\b|\bswitch\s*\(", 212),
]
features = []
for name, (js, rust, js_tests, rust_tests) in groups.items():
    js = [f"js/src/{path}" for path in js if (root / "js/src" / path).exists()]
    rust = [f"rust/src/{path}" for path in rust if (root / "rust/src" / path).exists()]
    blockers = []
    for kind, pattern, number in constructs:
        for source in js:
            match = re.search(pattern, (root / source).read_text())
            if match:
                line = (root / source).read_text()[:match.start()].count("\n") + 1
                blockers.append({"construct": kind, "source": source, "line": line, "issue": f"https://github.com/link-foundation/meta-language/issues/{number}"})
                break
    manual = []
    for path in rust:
        text = (root / path).read_text()
        adapter = "Native filesystem/process adapter" if re.search(r"std::(fs|process)|Command::|thread::", text) else "Typed native representation and control flow"
        manual.append({"path": path, "reason": f"{adapter} for {name}; its JavaScript contract uses " + ", ".join(item["construct"] for item in blockers) + ". See the feature's anchored translationBlockers; carried code is not executable Rust.", "blockers": [item["issue"] for item in blockers]})
    features.append({"id": name, "javascript": {"implementation": js, "tests": [f"js/test/{path}" for path in js_tests]}, "rust": {"implementation": rust, "tests": [f"rust/tests/{path}" for path in rust_tests]}, "manualRust": manual, "translationBlockers": blockers})

features.append({"id": "parity-threshold", "javascript": {"implementation": ["scripts/parity-threshold.mjs"], "tests": ["js/test/shared-golden.js"]}, "rust": {"implementation": ["rust/src/lib/generated/parity_threshold.rs"], "tests": ["rust/tests/shared_golden.rs"]}, "manualRust": []})
shared = {"cli-parsing": "cli", "isolation-arguments": "isolation", "status-output": "status", "execution-record-format": "execution-records"}
for kind, feature in shared.items():
    entry = next(item for item in features if item["id"] == feature)
    entry["golden"] = {"fixture": "parity/fixtures/contracts.json", "section": kind, "javascriptTest": "js/test/shared-golden.js", "rustTest": "rust/tests/shared_golden.rs"}
manifest = {"schemaVersion": 1, "policy": "JavaScript first; feature changes require implementation or behavioral test evidence in both languages.", "features": features}
(root / "parity/features.json").write_text(json.dumps(manifest, indent=2) + "\n")
known = {path for feature in features for side in ["javascript", "rust"] for path in feature[side]["implementation"]}
for prefix, extension in [("js/src", "*.js"), ("rust/src", "*.rs")]:
    for path in (root / prefix).rglob(extension):
        if str(path.relative_to(root)) not in known:
            print("UNMAPPED", path.relative_to(root))
