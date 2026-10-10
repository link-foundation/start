//! Apply a durable resume plan without holding the database lock over Docker.
use super::*;

/// Resume a tracked execution by UUID or session name.
pub fn resume_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
) -> ExecutionResumeResult {
    resume_execution_with(
        store,
        identifier,
        command,
        output_format,
        &SystemCommandRunner,
        &SystemResumeHooks,
    )
}

/// Resume with an injectable command runner and hooks, so tests never touch
/// docker.
pub fn resume_execution_with<R: CommandRunner, H: ResumeHooks>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
    runner: &R,
    hooks: &H,
) -> ExecutionResumeResult {
    resume_execution_with_resources(
        store,
        identifier,
        command,
        output_format,
        runner,
        hooks,
        &json!({}),
    )
}

pub fn resume_execution_with_options(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
    options: &crate::args_parser::WrapperOptions,
) -> ExecutionResumeResult {
    let mut overrides = crate::docker_resource_options::specs(options);
    overrides["removeOriginal"] = json!(options.remove_original);
    overrides["labels"] = json!(options.labels);
    resume_execution_with_resources(
        store,
        identifier,
        command,
        output_format,
        &SystemCommandRunner,
        &SystemResumeHooks,
        &overrides,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn resume_execution_with_resources<R: CommandRunner, H: ResumeHooks>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
    runner: &R,
    hooks: &H,
    overrides: &Value,
) -> ExecutionResumeResult {
    let Some(store) = store else {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some("Execution tracking is disabled.".to_string()),
        };
    };

    let Some(mut record) = store.get(identifier) else {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some(format!(
                "No execution found with UUID or session name: {}",
                identifier
            )),
        };
    };

    if crate::launch_owner::has_active_launch(&record) {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some("An execution launch is already reserved.".into()),
        };
    }
    let previous = record.clone();
    let probe = probe_session(&record, runner);
    let resources = crate::resume_resources::prepare(&record, &probe, overrides, runner);
    let (limits, resolved, old_memory) = match resources {
        Ok(result) => result,
        Err(error) => {
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(error),
            }
        }
    };
    let mut planning_record = record.clone();
    if let Some(labels) = overrides
        .get("labels")
        .and_then(Value::as_array)
        .filter(|labels| !labels.is_empty())
    {
        let mut merged = record_strings(&record, "labels");
        for label in labels.iter().filter_map(Value::as_str) {
            let key = label.split('=').next().unwrap_or(label);
            if let Some(index) = merged
                .iter()
                .position(|existing| existing.split('=').next() == Some(key))
            {
                merged[index] = label.to_string();
            } else {
                merged.push(label.to_string());
            }
        }
        planning_record
            .options
            .insert("labels".into(), json!(merged));
    }
    if planning_record.options.get("labels") != record.options.get("labels") {
        if record_option(&record, "isolated") != Some("docker") {
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some("Docker labels require a Docker execution when resuming.".into()),
            };
        }
        planning_record
            .options
            .insert("forceSnapshot".into(), json!(true));
    }
    if let Some(limits) = &limits {
        planning_record
            .options
            .insert("resourceLimits".into(), json!(limits));
    }
    let mut plan =
        match build_resume_plan_with_limits(&planning_record, command, &probe, limits.clone()) {
            Ok(plan) => plan,
            Err(error) => {
                return ExecutionResumeResult {
                    success: false,
                    output: None,
                    error: Some(error),
                }
            }
        };
    if let Some(limits) = limits {
        plan.resource_limits = limits.clone();
        let changed = ["memory", "memorySwap", "cpus"]
            .iter()
            .any(|k| overrides.get(k).and_then(Value::as_str).is_some())
            || record.options.contains_key("cpuPenaltyConfig");
        if plan.mode == ResumeMode::DockerStart && changed {
            let mut args = vec!["update".into()];
            args.extend(limits.into_iter().filter(|s| {
                [
                    "--memory=",
                    "--memory-swap=",
                    "--cpus=",
                    "--cpu-quota=",
                    "--cpu-period=",
                ]
                .iter()
                .any(|f| s.starts_with(f))
            }));
            args.push(plan.session_name.clone());
            plan.steps.insert(
                0,
                ResumeStep {
                    command: docker_command().to_string_lossy().into(),
                    args,
                    description: "Apply resume limits before start".into(),
                },
            );
        }
    }
    let mut container_id: Option<String> = None;
    let mut attempt = crate::execution_attempt::create_attempt(
        &record,
        plan.mode.as_str(),
        active_session_name(&plan),
    );
    let mut lifecycle_record = record.clone();
    lifecycle_record.attempt = Some(attempt.clone());
    crate::execution_attempt::append_lifecycle(&lifecycle_record, "resume-started", json!({}));
    apply_resume_to_record(&mut record, &plan, None);
    if let Some(labels) = planning_record.options.get("labels") {
        record.options.insert("labels".into(), labels.clone());
    }
    record.attempt = Some(attempt.clone());
    if let Some(resolved) = resolved {
        record.options.insert("resolvedLimits".into(), resolved);
    }
    let mut requested = record
        .options
        .get("resourceLimitSpecs")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    for k in ["memory", "memorySwap", "cpus"] {
        if let Some(value) = overrides.get(k).filter(|v| v.is_string()) {
            requested[k] = value.clone();
        }
    }
    record
        .options
        .insert("resourceLimitSpecs".into(), requested);
    if record.options.contains_key("cpuPenaltyConfig")
        && overrides.get("cpus").and_then(Value::as_str).is_some()
    {
        record
            .options
            .insert("baseResourceLimits".into(), json!(&plan.resource_limits));
    }
    crate::launch_owner::mark_launch(&mut record);
    if let Err(error) = store.reserve_launch(&record, &previous) {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some(format!("Launch reservation failed: {}", error)),
        };
    }

    if let Some(spec) = overrides.get("memory").and_then(Value::as_str) {
        let new = record
            .options
            .get("resolvedLimits")
            .and_then(|v| v.get("memory"))
            .cloned()
            .unwrap_or(Value::Null);
        if !record.log_path.is_empty() {
            append_log_file(
                &PathBuf::from(&record.log_path),
                &format!(
                    "Resume memory limit: {} -> {} ({})\n",
                    old_memory, new, spec
                ),
            );
        }
    }

    if plan.mode == ResumeMode::Relaunch {
        let launch_options = plan.launch_options.clone().unwrap_or_default();
        let launch_result = hooks.relaunch(&plan.backend, &plan.command, &launch_options);
        if !launch_result.success {
            let _ = store.save(&previous);
            crate::execution_attempt::append_lifecycle(
                &lifecycle_record,
                "launch-failed",
                json!({ "error": launch_result.message }),
            );
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(format!(
                    "Failed to relaunch {} session \"{}\": {}",
                    plan.backend, plan.session_name, launch_result.message
                )),
            };
        }
        container_id = launch_result.container_id;
    } else {
        let mut snapshot_created = false;
        let mut derived_created = false;
        let handoff = plan.mode == ResumeMode::DockerStart
            && command.is_some()
            && record_flag(&previous, "commandHandoff");
        let launch_result = (|| -> Result<(), String> {
            let _snapshot_lock = if plan.mode == ResumeMode::DockerSnapshot {
                Some(crate::docker_snapshot_safety::acquire_snapshot_lock()?)
            } else {
                None
            };
            if plan.mode == ResumeMode::DockerSnapshot {
                let message =
                    crate::docker_snapshot_safety::preflight_snapshot(&plan.session_name, runner)?;
                plan.message.push_str(&format!("\n{}", message));
                if !record.log_path.is_empty() {
                    append_log_file(&PathBuf::from(&record.log_path), &format!("{}\n", message));
                }
            }
            if handoff {
                let copied = crate::docker_command_handoff::write_command_handoff(
                    &plan.session_name,
                    &plan.command,
                    record_option(&previous, "shell").unwrap_or("auto"),
                    record_flag(&previous, "keepAlive"),
                    runner,
                )?;
                if !copied.success {
                    return Err(if copied.stderr.trim().is_empty() {
                        copied.error.unwrap_or_else(|| {
                            "Could not copy replacement command into the stopped container".into()
                        })
                    } else {
                        copied.stderr.trim().into()
                    });
                }
            }
            for step in &plan.steps {
                let result = runner.run(&step.command, &step.args);
                if !result.success {
                    let detail = if !result.stderr.trim().is_empty() {
                        result.stderr.trim().to_string()
                    } else {
                        result.error.clone().unwrap_or_else(|| {
                            format!(
                                "exit code {}",
                                result
                                    .status
                                    .map(|code| code.to_string())
                                    .unwrap_or_else(|| "unknown".to_string())
                            )
                        })
                    };
                    return Err(detail);
                }
                if step.args[0] == "commit" {
                    snapshot_created = true;
                }
                if step.args[0] == "create" {
                    derived_created = true;
                }
                let stdout = result.stdout.trim().to_string();
                if !stdout.is_empty() && matches!(step.args[0].as_str(), "run" | "create") {
                    container_id = Some(stdout);
                }
            }
            if plan.mode == ResumeMode::DockerSnapshot
                && overrides.get("removeOriginal").and_then(Value::as_bool) == Some(true)
            {
                let running = runner.run(
                    &docker_command().to_string_lossy(),
                    &[
                        "inspect".into(),
                        "-f".into(),
                        "{{.State.Running}}".into(),
                        active_session_name(&plan).into(),
                    ],
                );
                let note = if running.success && running.stdout.trim() == "true" {
                    let removed = runner.run(
                        &docker_command().to_string_lossy(),
                        &["rm".into(), plan.session_name.clone()],
                    );
                    if removed.success {
                        format!("Stopped original container removed: {}", plan.session_name)
                    } else {
                        format!("Original container retained: {}", removed.stderr.trim())
                    }
                } else {
                    "Original container retained: the snapshot container is not running.".into()
                };
                plan.message.push_str(&format!("\n{}", note));
                if !record.log_path.is_empty() {
                    append_log_file(&PathBuf::from(&record.log_path), &format!("{}\n", note));
                }
            }
            Ok(())
        })();
        if let Err(detail) = launch_result {
            if derived_created {
                runner.run(
                    &docker_command().to_string_lossy(),
                    &["rm".into(), active_session_name(&plan).into()],
                );
            }
            if snapshot_created {
                runner.run(
                    &docker_command().to_string_lossy(),
                    &["rmi".into(), plan.snapshot_image.clone().unwrap()],
                );
            }
            if handoff {
                let _ = crate::docker_command_handoff::write_command_handoff(
                    &plan.session_name,
                    &previous.command,
                    record_option(&previous, "shell").unwrap_or("auto"),
                    record_flag(&previous, "keepAlive"),
                    runner,
                );
            }
            let _ = store.save(&previous);
            crate::execution_attempt::append_lifecycle(
                &lifecycle_record,
                "launch-failed",
                json!({ "error": detail }),
            );
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(format!(
                    "Failed to resume {} session \"{}\": {}",
                    plan.backend, plan.session_name, detail
                )),
            };
        }

        if let Some(line) = build_resource_limits_status_line(&plan.resource_limits) {
            if !record.log_path.is_empty() {
                append_log_file(&PathBuf::from(&record.log_path), &format!("{}\n", line));
            }
        }
    }

    let previous_session_name = plan
        .new_session_name
        .as_ref()
        .map(|_| plan.session_name.clone());
    if let Some(id) = container_id.as_deref() {
        record.options.insert("containerId".into(), json!(id));
    }
    record.options.insert("launchPending".into(), json!(false));
    attempt.launch_accepted_at = Some(Utc::now().to_rfc3339());
    record
        .options
        .insert("resumedAt".into(), json!(attempt.started_at));
    record.attempt = Some(attempt.clone());
    if let Err(error) = store.save(&record) {
        if plan.backend == "docker" {
            let _ = hooks.attach_watcher(active_session_name(&plan), &record);
        }
        let stopped = plan.backend == "docker"
            && runner
                .run(
                    &docker_command().to_string_lossy(),
                    &["stop".into(), active_session_name(&plan).into()],
                )
                .success;
        if stopped {
            record.status = ExecutionStatus::Executed;
            record.exit_code = Some(-1);
            record.end_time = Some(Utc::now().to_rfc3339());
            record.options.insert("launchPending".into(), json!(false));
            let _ = store.save(&record);
        }
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some(
                json!({"code": "LAUNCH_PERSISTENCE_FAILED", "uuid": record.uuid,
                "containerName": active_session_name(&plan), "running": !stopped,
                "error": error})
                .to_string(),
            ),
        };
    }
    crate::execution_attempt::append_lifecycle(&record, "launch-accepted", json!({}));
    if plan.backend == "docker" {
        let attachment = hooks.attach_watcher(active_session_name(&plan), &record);
        let fields = match &attachment {
            Ok(()) => json!({"watcherAttachedAt": Utc::now().to_rfc3339()}),
            Err(error) => json!({"watcherError": error}),
        };
        match store.patch_attempt(&record.uuid, attempt.number, fields) {
            Ok(Some(current)) => crate::execution_attempt::append_lifecycle(
                &current,
                if attachment.is_ok() {
                    "watcher-attached"
                } else {
                    "watcher-attachment-failed"
                },
                json!({"error": attachment.as_ref().err()}),
            ),
            Ok(None) => {}
            Err(error) => {
                return ExecutionResumeResult {
                    success: false,
                    output: None,
                    error: Some(error),
                }
            }
        }
        if let Err(error) = attachment {
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(format!(
                    "Launch accepted, but completion watcher attachment failed: {}",
                    error
                )),
            };
        }
    }

    let session_name = record_option(&record, "sessionName")
        .unwrap_or(&plan.session_name)
        .to_string();

    ExecutionResumeResult {
        success: true,
        output: Some(format_resume_result(
            &ResumeResultFields {
                identifier,
                uuid: &record.uuid,
                mode: plan.mode,
                backend: &plan.backend,
                session_name: &session_name,
                previous_session_name: previous_session_name.as_deref(),
                snapshot_image: plan.snapshot_image.as_deref(),
                resource_limits: &plan.resource_limits,
                command: &plan.command,
                message: &plan.message,
            },
            output_format,
        )),
        error: None,
    }
}

#[cfg(test)]
#[path = "execution_resume_cases.rs"]
mod tests;
