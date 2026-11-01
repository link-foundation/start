//! The task loop of the experimental `--use-formal-ai` mode (issue #255).
//! Mirrors js/src/lib/formal-ai.js.
//!
//! The natural-language request goes to Formal AI verbatim. Formal AI decides
//! what to observe and which tool calls to make; start checks every call
//! against the effect policy, runs approved calls, reports each receipt back
//! and keeps evidence of what actually happened. The run ends when Formal AI
//! gives its final answer, says it did not understand, or a bound, refusal,
//! protocol error or cancellation stops it, and the exit status says which.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::formal_ai_client::{CompletionClient, ToolCall};
use crate::formal_ai_policy::{
    self as policy, Bounds, EffectDiff, PolicyContext, EXIT_BUDGET, EXIT_PROTOCOL, EXIT_REFUSED,
    EXIT_UNAVAILABLE, EXIT_UNSUPPORTED,
};
use crate::formal_ai_tool::{format_tool_result, run_tool, ToolOptions};

const PREVIEW_CHARS: usize = 2000;

/// Exit status of a cancellation by signal name (128 + signal number).
pub fn signal_exit(name: &str) -> i32 {
    match name {
        "SIGHUP" => 129,
        "SIGTERM" => 143,
        _ => 130,
    }
}

fn preview(text: &str) -> String {
    let count = text.chars().count();
    if count > PREVIEW_CHARS {
        format!(
            "{}… [{} more chars]",
            text.chars().take(PREVIEW_CHARS).collect::<String>(),
            count - PREVIEW_CHARS
        )
    } else {
        text.to_string()
    }
}

/// Observed working-directory changes, in words.
pub fn describe_effects(effects: &EffectDiff) -> String {
    let parts: Vec<String> = [
        ("added", &effects.added),
        ("removed", &effects.removed),
        ("changed", &effects.changed),
    ]
    .iter()
    .filter(|(_, names)| !names.is_empty())
    .map(|(key, names)| {
        let more = if names.len() > 10 {
            format!(" and {} more", names.len() - 10)
        } else {
            String::new()
        };
        let shown: Vec<&str> = names.iter().take(10).map(String::as_str).collect();
        format!("{} {}{}", key, shown.join(", "), more)
    })
    .collect();
    let text = if parts.is_empty() {
        "no file changed".to_string()
    } else {
        parts.join("; ")
    };
    if effects.complete {
        text
    } else {
        format!("{} (fingerprint incomplete)", text)
    }
}

/// What one task run needs besides the Formal AI client.
pub struct TaskOptions<'a> {
    /// Natural-language request, never executed.
    pub request: &'a str,
    pub cwd: &'a Path,
    /// START_* variables added to the tools' environment.
    pub env: &'a [(String, String)],
    pub bounds: &'a Bounds,
    pub deadline: Instant,
    /// Mirror tool output to this process's stdout/stderr.
    pub mirror: bool,
    pub note: &'a dyn Fn(&str),
    /// Exit status of a received cancellation signal, if any.
    pub cancel: &'a dyn Fn() -> Option<i32>,
}

/// The final state of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub status: String,
    pub exit_code: i32,
    pub message: String,
    pub remaining: Vec<String>,
}

impl Outcome {
    pub fn new(
        status: &str,
        exit_code: i32,
        message: impl Into<String>,
        remaining: &[&str],
    ) -> Self {
        Self {
            status: status.to_string(),
            exit_code,
            message: message.into(),
            remaining: remaining.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "exitCode": self.exit_code,
            "message": self.message,
            "remainingObligations": self.remaining,
        })
    }
}

fn cancelled(code: i32) -> Outcome {
    let name = crate::exit_reason::signal_name_for_exit_code(Some(code))
        .unwrap_or_else(|| "SIGINT".to_string());
    Outcome::new(
        "cancelled",
        code,
        format!("cancelled by {}", name),
        &["the task was interrupted; later steps did not run"],
    )
}

fn steps_mut(evidence: &mut Value) -> &mut Vec<Value> {
    if !evidence["steps"].is_array() {
        evidence["steps"] = json!([]);
    }
    evidence["steps"].as_array_mut().expect("steps is an array")
}

/// Run one request to completion. Fills `evidence` (a JSON object) as it
/// goes, sets `evidence.outcome` and returns the outcome.
pub fn run_formal_ai_task(
    options: &TaskOptions<'_>,
    client: &mut dyn CompletionClient,
    evidence: &mut Value,
) -> Outcome {
    if !evidence.is_object() {
        *evidence = json!({});
    }
    evidence["request"] = json!(options.request);
    evidence["cwd"] = json!(options.cwd.to_string_lossy());
    evidence["effectsMode"] = json!(options.bounds.effects);
    evidence["bounds"] = options.bounds.to_json();
    evidence["steps"] = json!([]);
    evidence["effects"] = EffectDiff::default().to_json();
    evidence["outcome"] = Value::Null;
    let outcome = task_loop(options, client, evidence);
    evidence["outcome"] = outcome.to_json();
    outcome
}

fn task_loop(
    options: &TaskOptions<'_>,
    client: &mut dyn CompletionClient,
    evidence: &mut Value,
) -> Outcome {
    let bounds = options.bounds;
    let mut context = PolicyContext::new(options.cwd, &bounds.effects);
    let mut total = EffectDiff::default();
    let mut messages = vec![json!({ "role": "user", "content": options.request })];
    let mut last_exit: Option<i32> = None;
    let mut tool_calls: u64 = 0;
    let is_cancelled = || (options.cancel)().is_some();

    for turn in 1..=bounds.max_steps {
        if let Some(code) = (options.cancel)() {
            return cancelled(code);
        }
        if Instant::now() >= options.deadline {
            return Outcome::new(
                "budget-exhausted",
                EXIT_BUDGET,
                "time budget exhausted",
                &["the task did not finish within START_FORMAL_AI_TIMEOUT_MS"],
            );
        }
        let response = match client.complete(&messages, &is_cancelled) {
            Ok(response) => response,
            Err(error) => {
                if let Some(code) = (options.cancel)() {
                    return cancelled(code);
                }
                let status = match error.exit_code {
                    EXIT_BUDGET => "budget-exhausted",
                    EXIT_UNAVAILABLE => "unavailable",
                    _ => "protocol-error",
                };
                return Outcome::new(
                    status,
                    error.exit_code,
                    error.message,
                    &["Formal AI did not complete the task"],
                );
            }
        };
        steps_mut(evidence).push(json!({
            "kind": "response",
            "turn": turn,
            "finishReason": response.finish_reason,
            "handler": response.handler,
            "content": preview(&response.content),
            "toolCalls": response.tool_calls.iter().map(|c| c.command.clone()).collect::<Vec<_>>(),
        }));
        if response.tool_calls.is_empty() {
            if !response.content.is_empty() {
                (options.note)(&response.content);
            }
            if response.handler.as_deref() == Some("unknown") && tool_calls == 0 {
                return Outcome::new(
                    "unsupported",
                    EXIT_UNSUPPORTED,
                    "Formal AI did not understand the request; no tool ran",
                    &["rephrase the request or perform it manually"],
                );
            }
            let Some(last) = last_exit else {
                return Outcome::new("answered", 0, "Formal AI answered without tools", &[]);
            };
            // The status reports what the tools did, not what Formal AI
            // claims: a run of reads is never presented as a completed change.
            let status = if last == 0 {
                format!("finished after {} tool call(s)", tool_calls)
            } else {
                format!("finished; the last tool call exited with {}", last)
            };
            let remaining: &[&str] = if last == 0 {
                &[]
            } else {
                &["the last tool call failed"]
            };
            return Outcome::new(
                "completed",
                last,
                format!("{}; {}", status, describe_effects(&total)),
                remaining,
            );
        }
        let ids: Vec<String> = response
            .tool_calls
            .iter()
            .enumerate()
            .map(|(index, call)| {
                call.id
                    .clone()
                    .unwrap_or_else(|| format!("call_{}_{}", turn, index))
            })
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": response.content,
            "tool_calls": response.tool_calls.iter().zip(&ids).map(|(call, id)| json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json!({ "command": call.command }).to_string(),
                },
            })).collect::<Vec<_>>(),
        }));
        for (call, id) in response.tool_calls.iter().zip(&ids) {
            tool_calls += 1;
            if tool_calls > bounds.max_steps {
                return Outcome::new(
                    "budget-exhausted",
                    EXIT_BUDGET,
                    format!("tool call budget of {} exhausted", bounds.max_steps),
                    &["the task did not finish within START_FORMAL_AI_MAX_STEPS"],
                );
            }
            let result = run_call(options, call, &mut context, &mut total, evidence);
            if let Some(code) = (options.cancel)() {
                return cancelled(code);
            }
            let (exit_code, content) = match result {
                Ok(done) => done,
                Err(outcome) => return outcome,
            };
            last_exit = Some(exit_code);
            messages.push(json!({ "role": "tool", "tool_call_id": id, "content": content }));
        }
    }
    Outcome::new(
        "budget-exhausted",
        EXIT_BUDGET,
        format!("step budget of {} exhausted", bounds.max_steps),
        &["the task did not finish within START_FORMAL_AI_MAX_STEPS"],
    )
}

/// Check and run one call: Ok((exit code, tool message)) or the outcome that
/// ends the run.
fn run_call(
    options: &TaskOptions<'_>,
    call: &ToolCall,
    context: &mut PolicyContext,
    total: &mut EffectDiff,
    evidence: &mut Value,
) -> Result<(i32, String), Outcome> {
    let bounds = options.bounds;
    let note = options.note;
    let decision = policy::evaluate_command(&call.command, context);
    let mut step = json!({ "kind": "tool", "command": call.command, "argv": decision.tokens });
    if !decision.allowed {
        let reason = decision.reason.clone().unwrap_or_default();
        step["decision"] = json!("refused");
        step["reason"] = json!(reason);
        steps_mut(evidence).push(step);
        let message = format!("refused `{}`: {}", call.command, reason);
        note(&message);
        return Err(Outcome::new(
            "refused",
            EXIT_REFUSED,
            message,
            &["the refused call did not run; nothing after it ran either"],
        ));
    }
    step["decision"] = json!("allowed");
    step["effect"] = json!(decision.kind);
    note(&format!("$ {}", call.command));
    let before = policy::fingerprint(options.cwd, bounds.max_fingerprint_entries);
    let remaining = options.deadline.saturating_duration_since(Instant::now());
    let limit = Duration::from_millis(bounds.tool_timeout_ms)
        .min(remaining)
        .max(Duration::from_millis(1));
    let cancel = || (options.cancel)().is_some();
    let receipt = run_tool(&ToolOptions {
        argv: &decision.tokens,
        cwd: options.cwd,
        env: options.env,
        timeout: limit,
        max_output_bytes: bounds.max_output_bytes,
        mirror: options.mirror,
        cancel: &cancel,
    });
    let diff = policy::diff_fingerprints(
        &before,
        &policy::fingerprint(options.cwd, bounds.max_fingerprint_entries),
    );
    step["exitCode"] = json!(receipt.exit_code);
    step["signal"] = json!(receipt.signal);
    step["timedOut"] = json!(receipt.timed_out);
    step["durationMs"] = json!(receipt.duration_ms);
    step["truncated"] = json!(receipt.truncated);
    step["spawnError"] = json!(receipt.spawn_error);
    step["stdout"] = json!(preview(&receipt.stdout));
    step["stderr"] = json!(preview(&receipt.stderr));
    step["effects"] = diff.to_json();
    total.added.extend(diff.added.iter().cloned());
    total.removed.extend(diff.removed.iter().cloned());
    total.changed.extend(diff.changed.iter().cloned());
    total.complete = total.complete && diff.complete;
    evidence["effects"] = total.to_json();
    if receipt.truncated {
        note(&format!(
            "output truncated at START_FORMAL_AI_MAX_OUTPUT_BYTES={}",
            bounds.max_output_bytes
        ));
    }
    let cwd_text = options.cwd.to_string_lossy().to_string();
    let result = if receipt.timed_out {
        Err(Outcome::new(
            "budget-exhausted",
            EXIT_BUDGET,
            format!(
                "`{}` exceeded the tool time limit and was stopped",
                call.command
            ),
            &["the stopped call may have done part of its work"],
        ))
    } else if decision.kind == Some("read") {
        policy::record_observation(&decision, context);
        if diff.has_effects() {
            step["unexpectedEffects"] = json!(true);
            let names: Vec<&str> = diff
                .added
                .iter()
                .chain(&diff.removed)
                .chain(&diff.changed)
                .take(5)
                .map(String::as_str)
                .collect();
            note(&format!(
                "warning: the working directory changed during a read-only call ({})",
                names.join(", ")
            ));
        }
        Ok((
            receipt.exit_code,
            format_tool_result(&receipt, &call.command, &cwd_text),
        ))
    } else if receipt.exit_code == 0 {
        let verification = policy::verify_change(&decision.tokens, options.cwd);
        step["verification"] = verification.to_json();
        if verification.verified {
            for target in &decision.targets {
                context.observed.insert(target.clone());
            }
            Ok((0, format_tool_result(&receipt, &call.command, &cwd_text)))
        } else {
            Err(Outcome::new(
                "unverified",
                EXIT_PROTOCOL,
                format!("`{}` exited 0 but {}", call.command, verification.detail),
                &["the change could not be confirmed by readback"],
            ))
        }
    } else {
        Ok((
            receipt.exit_code,
            format_tool_result(&receipt, &call.command, &cwd_text),
        ))
    };
    steps_mut(evidence).push(step);
    result
}

#[cfg(test)]
#[path = "formal_ai_cases.rs"]
mod formal_ai_cases;
