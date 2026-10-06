//! Stream Docker output without buffering entire lines; timestamp command output only.
use chrono::{DateTime, SecondsFormat, Utc};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};

use crate::execution_attempt::activity_path;

pub const INTERNAL_OUTPUT_FLAG: &str = "--internal-capture-detached-output";

pub struct OutputObserver {
    log: fs::File,
    activity: String,
    since: DateTime<Utc>,
    prefix: Vec<u8>,
    at_line_start: bool,
    latest: Option<DateTime<Utc>>,
}

impl OutputObserver {
    pub fn new(log_path: &str, number: u64, since: &str) -> std::io::Result<Self> {
        let since = DateTime::parse_from_rfc3339(since)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?
            .with_timezone(&Utc);
        Ok(Self {
            log: OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)?,
            activity: activity_path(log_path, number),
            since,
            prefix: Vec::with_capacity(80),
            at_line_start: true,
            latest: None,
        })
    }

    pub fn write(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        self.log.write_all(chunk)?;
        let previous = self.latest;
        for byte in chunk {
            if *byte == b'\n' {
                self.at_line_start = true;
                self.prefix.clear();
            } else if self.at_line_start {
                if *byte == b' ' {
                    if let Ok(text) = std::str::from_utf8(&self.prefix) {
                        if text.ends_with('Z') {
                            if let Ok(time) = DateTime::parse_from_rfc3339(text) {
                                let time = time.with_timezone(&Utc);
                                if time >= self.since && self.latest.is_none_or(|last| time > last)
                                {
                                    self.latest = Some(time);
                                }
                            }
                        }
                    }
                    self.at_line_start = false;
                } else if self.prefix.len() < 80 {
                    self.prefix.push(*byte);
                } else {
                    self.at_line_start = false;
                }
            }
        }
        if self.latest != previous {
            if let Some(time) = self.latest {
                let temporary = format!("{}.{}.tmp", self.activity, std::process::id());
                fs::write(
                    &temporary,
                    time.to_rfc3339_opts(SecondsFormat::AutoSi, true),
                )?;
                #[cfg(windows)]
                let _ = fs::remove_file(&self.activity);
                fs::rename(temporary, &self.activity)?;
            }
        }
        Ok(())
    }
}

pub fn run_internal_output(args: &[String]) {
    let [log_path, number, since] = args else {
        return;
    };
    let Ok(number) = number.parse() else {
        return;
    };
    let Ok(mut observer) = OutputObserver::new(log_path, number, since) else {
        return;
    };
    let mut input = std::io::stdin().lock();
    let mut buffer = [0u8; 8192];
    while let Ok(length) = input.read(&mut buffer) {
        if length == 0 || observer.write(&buffer[..length]).is_err() {
            break;
        }
    }
}
