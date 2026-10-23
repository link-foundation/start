use start_command::log_sanitizer::{
    find_sanitizer, sanitize_log_to_temp_with_env, sanitize_text_with_env, AuthorizationHeaderMask,
    BLOCK_SIZE, OVERRIDE,
};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The library CLI: the override or PATH, else the copy installed for the
/// JavaScript package. CI installs it globally, so it must be found there.
fn sanitizer() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../js/node_modules/.bin");
            let local = bin.join(if cfg!(windows) {
                "sensitive-data-sanitizer.cmd"
            } else {
                "sensitive-data-sanitizer"
            });
            let found = find_sanitizer().or_else(|| local.is_file().then_some(local));
            if found.is_none() {
                assert!(
                    std::env::var_os("CI").is_none(),
                    "sensitive-data-sanitizer is required in CI"
                );
                eprintln!("skipped: install @link-foundation/sensitive-data-sanitizer");
            }
            found
        })
        .clone()
}

/// Only what the runtime needs, so the host's own credential-named variables
/// and gh login cannot change the expected output.
fn test_env(extra: &[(&str, &str)]) -> Option<Vec<(String, String)>> {
    static GH_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
    let gh_config = GH_CONFIG_DIR.get_or_init(|| tempfile::tempdir().unwrap().keep());
    // Windows reports PATH as `Path`, and its names are case-insensitive.
    let same = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(name, _)| {
            [
                "PATH",
                "PATHEXT",
                "COMSPEC",
                "SYSTEMROOT",
                "TEMP",
                "TMP",
                "TMPDIR",
                "HOME",
                "USERPROFILE",
            ]
            .iter()
            .any(|kept| same(name, kept))
        })
        .collect();
    env.push((OVERRIDE.into(), sanitizer()?.to_string_lossy().into_owned()));
    env.push(("GH_CONFIG_DIR".into(), gh_config.display().to_string()));
    for (name, value) in extra {
        env.retain(|(existing, _)| !same(existing, name));
        env.push((name.to_string(), value.to_string()));
    }
    Some(env)
}

fn sanitize_file(content: &[u8], env: Vec<(String, String)>) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.log");
    fs::write(&source, content).unwrap();
    let copy = sanitize_log_to_temp_with_env(&source, env, false).unwrap();
    fs::read(&copy.path).unwrap()
}

fn mask(input: &[u8], size: usize) -> Vec<u8> {
    let mut authorization = AuthorizationHeaderMask::new();
    let mut output = Vec::new();
    for block in input.chunks(size) {
        output.extend(authorization.push(block, false));
        assert!(authorization.pending_bytes() <= size + 160);
    }
    output.extend(authorization.push(&[], true));
    output
}

// The three lines from issue #249, which the old rules truncated.
const ISSUE_249_LINES: &[&str] = &[
    "Command: gate='/tmp/hive-mind-disk-baseline-0ce9e170-e6d3-494d-91e1-0d820245d34b'",
    "🧠 Formal AI: endpoint http://172.18.0.2:8080/api/openai/v1",
    r#"{"bodyPreview":"{\"messages\":[{\"content\":\"use: curl -L -H \\\"Authorization: token $(gh auth token)\\\" -o <filename> <url>\\n...the rest of a 100 KB prompt...\"}]}"}"#,
    "proxy http://myproxy:3128 and http://127.0.0.1:34271/session",
    "Authorization: [REDACTED] stays as it is",
    "account konard@example.com https://github.com/konard",
];

const AUTHORIZATION_CASES: &[(&str, &str)] = &[
    (
        "curl -H 'Authorization: Basic dXNlcjpwYXNz' -o out.txt url",
        "curl -H 'Authorization: [REDACTED]' -o out.txt url",
    ),
    (
        "Authorization: Bearer abc rest of line",
        "Authorization: [REDACTED] rest of line",
    ),
    (
        "Authorization: token abc, other: keep",
        "Authorization: [REDACTED], other: keep",
    ),
    (
        r#"{"h":"Authorization: Bearer abc\" tail","next":"keep"}"#,
        r#"{"h":"Authorization: [REDACTED]\" tail","next":"keep"}"#,
    ),
    (
        "Authorization: token $(gh auth token) and ${GITHUB_TOKEN}",
        "Authorization: token $(gh auth token) and ${GITHUB_TOKEN}",
    ),
    (
        "Authorization: Bearer <token>",
        "Authorization: Bearer <token>",
    ),
];

#[test]
fn masks_only_the_authorization_scheme_and_token_at_every_block_size() {
    let input = AUTHORIZATION_CASES
        .iter()
        .map(|(line, _)| *line)
        .collect::<Vec<_>>()
        .join("\n");
    let expected = AUTHORIZATION_CASES
        .iter()
        .map(|(_, line)| *line)
        .collect::<Vec<_>>()
        .join("\n");
    for size in [1, 7, 31, 256, BLOCK_SIZE] {
        assert_eq!(
            String::from_utf8(mask(input.as_bytes(), size)).unwrap(),
            expected
        );
    }
    let Some(env) = test_env(&[]) else { return };
    // The library itself masks the scheme before a placeholder; nothing is lost.
    assert_eq!(
        String::from_utf8(sanitize_file(input.as_bytes(), env)).unwrap(),
        expected.replace("Bearer <token>", "[REDACTED] <token>")
    );
}

#[test]
fn masks_long_authorization_tokens_across_blocks_with_bounded_memory() {
    let input = format!(
        "Authorization: Bearer {} tail\nordinary\n",
        "a".repeat(200_000)
    );
    let expected = "Authorization: [REDACTED] tail\nordinary\n";
    assert_eq!(mask(input.as_bytes(), BLOCK_SIZE), expected.as_bytes());
    let Some(env) = test_env(&[]) else { return };
    assert_eq!(sanitize_file(input.as_bytes(), env), expected.as_bytes());
}

#[test]
fn keeps_every_line_from_issue_249_and_public_account_details() {
    let Some(env) = test_env(&[]) else { return };
    let input = format!("{}\n", ISSUE_249_LINES.join("\n"));
    assert_eq!(sanitize_file(input.as_bytes(), env), input.as_bytes());
}

#[test]
fn redacts_credentials_and_credential_named_environment_values() {
    let Some(env) = test_env(&[("START_TEST_SECRET", "custom-secret-value")]) else {
        return;
    };
    let mut secrets: Vec<String> = "pousr"
        .chars()
        .map(|kind| format!("gh{kind}_{}", "a".repeat(36)))
        .collect();
    secrets.extend([
        format!("github_{}{}", "pat_", "b".repeat(82)),
        format!("sk-{}", "c".repeat(48)),
        format!("sk-{}{}", "proj-", "d".repeat(90)),
        format!("AK{}{}", "IA", "F".repeat(16)),
        format!("AS{}{}", "IA", "G".repeat(16)),
        format!("ey{}", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"),
    ]);
    let mut input = secrets.join("\n");
    input.push_str(concat!(
        "\nAuthorization: Bearer arbitrary-credential",
        "\nProxy-Authorization: Basic encoded-credential",
        "\nclone https://user:password@example.test/repo.git",
        "\nAWS_SECRET_ACCESS_KEY=arbitrary-aws-secret",
        "\nvalue custom-secret-value end",
        "\nordinary utf8: café 😀\n",
    ));
    let output = String::from_utf8(sanitize_file(input.as_bytes(), env)).unwrap();
    secrets.extend(
        [
            "arbitrary-credential",
            "encoded-credential",
            "password",
            "arbitrary-aws-secret",
            "custom-secret-value",
        ]
        .map(String::from),
    );
    for secret in &secrets {
        assert!(!output.contains(secret.as_str()), "leaked {}", &secret[..8]);
    }
    for kept in [
        "Authorization: [REDACTED]\n",
        "Proxy-Authorization: [REDACTED]\n",
        "clone https://[REDACTED]@example.test/repo.git\n",
        "value [REDACTED] end\n",
        "ordinary utf8: café 😀\n",
    ] {
        assert!(output.contains(kept), "missing {}", kept);
    }
}

#[test]
fn preserves_invalid_utf8_line_endings_and_empty_logs() {
    let Some(env) = test_env(&[]) else { return };
    let mut input = b"bad \xff\xfe\xc3 ".to_vec();
    input.extend(format!("gh{}{}\r\nnext\rend", "p_", "x".repeat(36)).bytes());
    assert_eq!(
        sanitize_file(&input, env.clone()),
        b"bad \xff\xfe\xc3 [REDACTED]\r\nnext\rend"
    );
    assert!(sanitize_file(b"", env).is_empty());
}

#[test]
fn sanitizes_issue_text_with_the_same_rules() {
    let Some(env) = test_env(&[]) else { return };
    let token = format!("gh{}{}", "p_", "a".repeat(36));
    assert_eq!(
        sanitize_text_with_env(
            &format!("echo {} 😀 'Authorization: token abc' -o x", token),
            env.clone()
        )
        .unwrap(),
        "echo [REDACTED] 😀 'Authorization: [REDACTED]' -o x"
    );
    assert_eq!(
        sanitize_text_with_env("echo \"quoted\" $(id) `hostname`", env).unwrap(),
        "echo \"quoted\" $(id) `hostname`"
    );
}

#[test]
fn private_copy_does_not_modify_source_and_is_removed_on_drop() {
    let Some(env) = test_env(&[]) else { return };
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.log");
    let input = format!("gh{}{}", "p_", "x".repeat(36));
    fs::write(&source, &input).unwrap();
    let copy = sanitize_log_to_temp_with_env(&source, env, false).unwrap();
    let path = copy.path.clone();
    assert_ne!(path, source);
    assert_eq!(fs::read_to_string(&path).unwrap(), "[REDACTED]");
    let entries: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["execution.log"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    assert_eq!(fs::read_to_string(&source).unwrap(), input);
    drop(copy);
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn fails_closed_with_value_free_codes() {
    let Some(env) = test_env(&[]) else { return };
    let dir = tempfile::tempdir().unwrap();
    let attempt = |source: &std::path::Path, env: Vec<(String, String)>| {
        sanitize_log_to_temp_with_env(source, env, false)
            .err()
            .expect("sanitization must fail")
    };
    let message = |code: &str| format!("Log sanitization failed ({}); upload blocked.", code);
    assert_eq!(
        attempt(&dir.path().join("missing"), env.clone()),
        message("ERR_SOURCE")
    );
    assert_eq!(attempt(dir.path(), env.clone()), message("ERR_SOURCE"));
    let source = dir.path().join("binary.log");
    fs::write(&source, b"secret\0binary").unwrap();
    // The library rejects NUL bytes rather than guessing at binary content.
    assert_eq!(attempt(&source, env.clone()), message("ERR_BINARY"));
    let missing = dir.path().join("missing-sanitizer");
    let unavailable = test_env(&[(OVERRIDE, missing.to_str().unwrap())]).unwrap();
    assert_eq!(
        attempt(&source, unavailable.clone()),
        message("ERR_UNAVAILABLE")
    );
    assert_eq!(
        sanitize_text_with_env("x", unavailable).err().unwrap(),
        "Text sanitization failed (ERR_UNAVAILABLE); publication blocked."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let failing = dir.path().join("failing-sanitizer");
        let failing_env = test_env(&[(OVERRIDE, failing.to_str().unwrap())]).unwrap();
        fs::write(
            &failing,
            "#!/bin/sh\necho \"secret-from-stderr (ERR_WORKER)\" >&2\nexit 2\n",
        )
        .unwrap();
        fs::set_permissions(&failing, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(attempt(&source, failing_env.clone()), message("ERR_WORKER"));
        // A sanitizer that succeeds without writing the output blocks too.
        fs::write(&failing, "#!/bin/sh\nexit 0\n").unwrap();
        assert_eq!(attempt(&source, failing_env), message("ERR_OUTPUT"));
    }
}

#[cfg(unix)]
#[test]
fn upload_child() {
    let Ok(kind) = std::env::var("SANITIZER_UPLOAD_KIND") else {
        return;
    };
    let source = std::env::var("SANITIZER_SOURCE_LOG").unwrap();
    match kind.as_str() {
        "automatic" => {
            assert!(start_command::failure_handler::upload_log(&source).is_some());
        }
        "invalid" => {
            assert!(start_command::failure_handler::upload_log(&source).is_none());
        }
        _ => {
            assert_eq!(
                start_command::failure_handler::upload_log_interactive_with_options(
                    &source,
                    kind == "optout",
                    false
                )
                .unwrap(),
                0
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn both_upload_paths_use_private_sanitized_copies_and_manual_optout_is_explicit() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let path = format!(
        "{}:{}",
        dir.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let Some(env) = test_env(&[("PATH", &path)]) else {
        return;
    };
    let source = dir.path().join("source.log");
    let line = "Command: gate='/tmp/hive-mind-disk-baseline-0ce9e170' http://172.18.0.2:8080/v1";
    let input = format!("{} gh{}{}", line, "p_", "x".repeat(36));
    fs::write(&source, &input).unwrap();
    let uploader = dir.path().join("gh-upload-log");
    fs::write(&uploader, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_ARGS\"\ncat \"$1\" > \"$CAPTURE_LOG\"\nls -ld \"$1\" | cut -c1-10 > \"$CAPTURE_MODE\"\necho https://gist.github.com/test/id\n").unwrap();
    fs::set_permissions(&uploader, fs::Permissions::from_mode(0o755)).unwrap();
    for kind in ["manual", "automatic", "optout", "invalid"] {
        let _ = fs::remove_file(dir.path().join("args"));
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "upload_child", "--nocapture"])
            .env_clear()
            .envs(env.iter().cloned())
            .env("SANITIZER_UPLOAD_KIND", kind)
            .env(
                "SANITIZER_SOURCE_LOG",
                if kind == "invalid" {
                    dir.path().join("missing")
                } else {
                    source.clone()
                },
            )
            .env("CAPTURE_ARGS", dir.path().join("args"))
            .env("CAPTURE_LOG", dir.path().join("uploaded"))
            .env("CAPTURE_MODE", dir.path().join("mode"))
            .env("GH_UPLOAD_PUBLIC", "true")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        if kind == "invalid" {
            assert!(String::from_utf8_lossy(&output.stdout)
                .contains("Warning: Log sanitization failed (ERR_SOURCE); upload blocked."));
            assert!(!dir.path().join("args").exists());
            continue;
        }
        let args = fs::read_to_string(dir.path().join("args")).unwrap();
        let args: Vec<_> = args.lines().collect();
        assert_eq!(args[1], "--private");
        assert_eq!(
            fs::read_to_string(dir.path().join("uploaded")).unwrap(),
            if kind == "optout" {
                input.clone()
            } else {
                format!("{} [REDACTED]", line)
            }
        );
        if kind != "optout" {
            assert_ne!(args[0], source.to_str().unwrap());
            assert!(!std::path::Path::new(args[0]).exists());
            assert_eq!(
                fs::read_to_string(dir.path().join("mode")).unwrap().trim(),
                "-rw-------"
            );
        }
    }
}

#[test]
#[ignore = "bounded 110MiB experiment; run with experiments/issue-200/large-log-rust.sh"]
fn large_log_experiment() {
    use std::io::{Read, Write};
    let env = test_env(&[]).expect("sensitive-data-sanitizer");
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("large.log");
    let token = format!("gh{}{}", "p_", "a".repeat(36));
    let sample = format!("ordinary output café 😀 {token}\n");
    let mut block = [b' '; BLOCK_SIZE];
    for offset in (0..BLOCK_SIZE).step_by(sample.len()) {
        if offset + sample.len() >= block.len() {
            break;
        }
        block[offset..offset + sample.len()].copy_from_slice(sample.as_bytes());
    }
    let blocks: usize = std::env::var("LARGE_LOG_BLOCKS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1760);
    let mut file = fs::File::create(&source).unwrap();
    for _ in 0..blocks {
        file.write_all(&block).unwrap();
    }
    drop(file);
    let start = std::time::Instant::now();
    let copy = sanitize_log_to_temp_with_env(&source, env, false).unwrap();
    let mut file = fs::File::open(&copy.path).unwrap();
    let mut previous = Vec::new();
    loop {
        let length = file.read(&mut block).unwrap();
        if length == 0 {
            break;
        }
        previous.extend_from_slice(&block[..length]);
        assert!(!previous
            .windows(token.len())
            .any(|value| value == token.as_bytes()));
        previous = previous[previous.len().saturating_sub(token.len())..].to_vec();
    }
    println!(
        "sourceBytes={} sanitizedBytes={} secretLeaked=false elapsedMs={}",
        fs::metadata(source).unwrap().len(),
        fs::metadata(&copy.path).unwrap().len(),
        start.elapsed().as_millis()
    );
}
