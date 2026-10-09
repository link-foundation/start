//! Opt-in timestamp-weighted CPU hysteresis. Missing coverage cannot trigger.
use crate::args_parser::WrapperOptions;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub cpus: f64,
    pub trigger: f64,
    pub trigger_window_ms: i64,
    pub release: f64,
    pub release_window_ms: i64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            cpus: 2.0,
            trigger: 95.0,
            trigger_window_ms: 900000,
            release: 65.0,
            release_window_ms: 900000,
        }
    }
}
pub fn duration(value: &str) -> Result<i64, String> {
    let end = value
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(value.len());
    let amount = value[..end]
        .parse::<f64>()
        .map_err(|_| format!("Invalid CPU penalty duration: {}", value))?;
    let unit = match &value[end..] {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60000.0,
        "h" => 3600000.0,
        _ => return Err(format!("Invalid CPU penalty duration: {}", value)),
    };
    let ms = amount * unit;
    if !ms.is_finite() || ms <= 0.0 || ms > 9007199254740991.0 || ms.fract() != 0.0 {
        return Err(format!("Invalid CPU penalty duration: {}", value));
    }
    Ok(ms as i64)
}
pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> Result<usize, String> {
    let (flag, inline) = args[index]
        .split_once('=')
        .map(|(f, v)| (f, Some(v)))
        .unwrap_or((&args[index], None));
    if flag == "--cpu-penalty" {
        if inline.is_some() {
            return Err("--cpu-penalty does not take a value".into());
        }
        options.cpu_penalty = true;
        return Ok(1);
    }
    if ![
        "--cpu-penalty-cpus",
        "--cpu-penalty-trigger",
        "--cpu-penalty-trigger-window",
        "--cpu-penalty-release",
        "--cpu-penalty-release-window",
    ]
    .contains(&flag)
    {
        return Ok(0);
    }
    let value = inline
        .or_else(|| args.get(index + 1).map(String::as_str))
        .ok_or_else(|| format!("{} requires a value", flag))?;
    let config = options
        .cpu_penalty_config
        .get_or_insert_with(Config::default);
    if flag.ends_with("-window") {
        let ms = duration(value)?;
        if flag.contains("trigger") {
            config.trigger_window_ms = ms;
        } else {
            config.release_window_ms = ms;
        }
    } else {
        let n = value
            .trim_end_matches('%')
            .parse::<f64>()
            .map_err(|_| format!("Invalid {}: {}", flag, value))?;
        if !n.is_finite()
            || n <= 0.0
            || (flag != "--cpu-penalty-cpus" && n > 100.0)
            || (flag == "--cpu-penalty-cpus" && value.ends_with('%'))
        {
            return Err(format!("Invalid {}: {}", flag, value));
        }
        match flag {
            "--cpu-penalty-cpus" => config.cpus = n,
            "--cpu-penalty-trigger" => config.trigger = n,
            _ => config.release = n,
        }
    }
    Ok(if inline.is_some() { 1 } else { 2 })
}
pub fn validate(options: &mut WrapperOptions) -> Result<(), String> {
    if options.cpu_penalty || options.cpu_penalty_config.is_some() {
        if !options.cpu_penalty {
            return Err("CPU penalty settings require --cpu-penalty".into());
        }
        if options.isolated.as_deref() != Some("docker") {
            return Err("--cpu-penalty requires Docker isolation".into());
        }
        options
            .cpu_penalty_config
            .get_or_insert_with(Config::default);
    }
    Ok(())
}
#[derive(Debug, Clone)]
pub struct Sample {
    pub at: i64,
    pub cores: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub phase: String,
    pub since: i64,
    pub limit_cpus: Option<f64>,
    pub base_cpus: Option<f64>,
    pub penalty_count: u64,
    pub penalized_ms: u64,
    #[serde(skip)]
    pub samples: Vec<Sample>,
    #[serde(skip)]
    pub last_at: i64,
    #[serde(skip)]
    pub capacity: Option<f64>,
}
pub fn initial(base: Option<f64>, now: i64, saved: Option<State>) -> State {
    if let Some(mut s) = saved {
        s.base_cpus = base;
        s.samples.clear();
        s.capacity = None;
        s.last_at = now;
        if s.phase != "penalized" {
            s.phase = "observing".into();
            s.since = now;
            s.limit_cpus = base;
        }
        return s;
    }
    State {
        phase: "observing".into(),
        since: now,
        limit_cpus: base,
        base_cpus: base,
        penalty_count: 0,
        penalized_ms: 0,
        samples: vec![],
        last_at: now,
        capacity: None,
    }
}
pub fn average(samples: &[Sample], now: i64, window: i64) -> Option<f64> {
    let start = now - window;
    if samples.len() < 2 || samples[0].at > start || samples.last()?.at != now {
        return None;
    }
    let sum = samples
        .windows(2)
        .map(|pair| {
            let left = start.max(pair[0].at);
            let right = pair[1].at;
            (right - left).max(0) as f64 * pair[0].cores
        })
        .sum::<f64>();
    Some(sum / window as f64)
}
#[derive(Debug, Clone)]
pub struct Action {
    pub kind: &'static str,
    pub cpus: f64,
    pub average: Option<f64>,
    pub capacity: f64,
}
pub fn evaluate(
    state: &State,
    now: i64,
    cores: f64,
    daemon_cpus: f64,
    max_gap: i64,
    config: &Config,
) -> (State, Option<Action>) {
    let mut s = state.clone();
    if s.phase == "penalized" {
        s.penalized_ms += (now - s.last_at).max(0) as u64;
    }
    s.last_at = now;
    let capacity = s.base_cpus.unwrap_or(f64::INFINITY).min(daemon_cpus);
    if !cores.is_finite()
        || cores < 0.0
        || !daemon_cpus.is_finite()
        || capacity <= 0.0
        || s.samples
            .last()
            .is_some_and(|last| now <= last.at || now - last.at > max_gap)
        || s.capacity != Some(capacity)
    {
        s.samples.clear();
    }
    s.capacity = Some(capacity);
    if !cores.is_finite() || cores < 0.0 || !daemon_cpus.is_finite() || capacity <= 0.0 {
        return (s, None);
    }
    s.samples.push(Sample { at: now, cores });
    let window = if s.phase == "penalized" {
        config.release_window_ms
    } else {
        config.trigger_window_ms
    };
    while s.samples.len() > 2 && s.samples[1].at <= now - window {
        s.samples.remove(0);
    }
    let avg = average(&s.samples, now, window);
    let mut action = None;
    if s.phase == "observing"
        && config.cpus < capacity
        && avg.is_some_and(|a| a >= config.trigger / 100.0 * capacity)
    {
        action = Some(Action {
            kind: "apply",
            cpus: config.cpus,
            average: avg,
            capacity,
        });
        s.phase = "penalized".into();
        s.since = now;
        s.limit_cpus = Some(config.cpus);
        s.penalty_count += 1;
    } else if s.phase == "penalized"
        && (config.cpus >= capacity
            || (now - s.since >= config.release_window_ms
                && avg.is_some_and(|a| a < config.release / 100.0 * config.cpus)))
    {
        action = Some(Action {
            kind: "lift",
            cpus: capacity,
            average: avg,
            capacity,
        });
        s.phase = "observing".into();
        s.since = now;
        s.limit_cpus = Some(capacity);
    }
    if action.is_some() {
        s.samples.clear();
    }
    (s, action)
}
