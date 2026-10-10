use start_command::log_sanitizer::{sanitize_log_to_temp_with_env, StreamingSanitizer, BLOCK_SIZE};
use std::fs;

fn credentials() -> Vec<String> {
    use base64::Engine;
    let mut secrets: Vec<_> = "pousr"
        .chars()
        .map(|kind| format!("gh{kind}_{}", "a".repeat(36)))
        .collect();
    secrets.extend([
        format!("github_{}{}", "pat_", "b".repeat(82)),
        format!("sk-{}", "c".repeat(48)),
        format!("sk-{}{}", "proj-", "d".repeat(90)),
        format!("sk-{}{}", "ant-api03-", "e".repeat(90)),
        format!("AK{}{}", "IA", "F".repeat(16)),
        format!("AS{}{}", "IA", "G".repeat(16)),
        format!("ey{}", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"),
        "Authorization: Bearer arbitrary-credential".into(),
        "Proxy-Authorization: Basic encoded-credential".into(),
        "https://user:password@example.test/repo.git".into(),
        "AWS_SECRET_ACCESS_KEY=arbitrary-aws-secret".into(),
        "custom-secret-value".into(),
        format!(
            "{}.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(" \n{\"alg\":\"HS256\"}"),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("{\"sub\":\"x\"}")
        ),
    ]);
    secrets
}

#[test]
fn redacts_required_credentials_across_chunk_boundaries() {
    let secrets = credentials();
    for size in [1, 7, 31, 256, 1024, BLOCK_SIZE] {
        let input = format!(
            "ordinary utf8: café 😀\n{}{}\n{}finished\n",
            " ".repeat(size.saturating_sub(43)),
            secrets.join("\n"),
            "padding\n".repeat(400)
        );
        let mut sanitizer =
            StreamingSanitizer::new([("START_TEST_SECRET".into(), "custom-secret-value".into())])
                .unwrap();
        let mut output = Vec::new();
        for block in input.as_bytes().chunks(size) {
            output.extend(sanitizer.push(block, false));
        }
        output.extend(sanitizer.push(&[], true));
        let output = String::from_utf8(output).unwrap();
        for secret in &secrets {
            assert!(!output.contains(secret));
        }
        for value in [
            "arbitrary-credential",
            "encoded-credential",
            "password",
            "arbitrary-aws-secret",
        ] {
            assert!(!output.contains(value));
        }
        assert!(output.starts_with("ordinary utf8: café 😀\n"));
        assert!(output.ends_with("\nfinished\n"));
    }
}

#[test]
fn bounds_memory_and_redacts_long_token_and_header_suffixes() {
    for prefix in [
        format!("gh{}", "p_"),
        "Authorization: Bearer ".into(),
        "a".repeat(512),
    ] {
        let mut sanitizer = StreamingSanitizer::new([]).unwrap();
        let mut output = sanitizer.push(prefix.as_bytes(), false);
        let block = [b'a'; 16384];
        for _ in 0..128 {
            output.extend(sanitizer.push(&block, false));
            assert!(sanitizer.pending_bytes() <= BLOCK_SIZE);
        }
        output.extend(sanitizer.push(b"\nordinary\n", true));
        assert_eq!(output, b"[REDACTED]\nordinary\n");
    }
}

#[test]
fn overlapping_token_preserves_broader_header_continuation() {
    let mut sanitizer = StreamingSanitizer::new([]).unwrap();
    let input = format!(
        "Authorization: Bearer gh{}{} trailing-private-value\nordinary\n",
        "p_",
        "a".repeat(BLOCK_SIZE * 2)
    );
    let mut output = Vec::new();
    for block in input.as_bytes().chunks(BLOCK_SIZE) {
        output.extend(sanitizer.push(block, false));
    }
    output.extend(sanitizer.push(&[], true));
    assert_eq!(output, b"[REDACTED]\nordinary\n");
}

#[test]
fn quoted_aws_assignment_values_are_redacted() {
    let mut sanitizer = StreamingSanitizer::new([]).unwrap();
    let output = String::from_utf8(sanitizer.push(
        b"AWS_SECRET_ACCESS_KEY=\"quoted-aws-secret\"\nAWS_SESSION_TOKEN='quoted-session-value'\n",
        true,
    ))
    .unwrap();
    assert!(!output.contains("quoted-aws-secret"));
    assert!(!output.contains("quoted-session-value"));
}

#[test]
fn redacts_multiline_and_short_environment_values_and_preserves_invalid_utf8() {
    let mut sanitizer = StreamingSanitizer::new([
        ("GH_TOKEN".into(), "abc\nxyz".into()),
        ("TEST_PASSWORD".into(), "!".into()),
    ])
    .unwrap();
    let output = sanitizer.push(b"safe \xff abc\nxyz !", true);
    assert_eq!(output, b"safe \xff [REDACTED] [REDACTED]");
}

#[test]
fn overlapping_environment_values_are_fully_redacted_without_hiding_domains() {
    let mut sanitizer = StreamingSanitizer::new([
        ("GH_TOKEN".into(), "abcde".into()),
        ("TEST_PASSWORD".into(), "cdefg".into()),
        ("GITHUB_PAT".into(), "opaque-known-pat".into()),
    ])
    .unwrap();
    assert_eq!(
        sanitizer.push(b"abcdefg opaque-known-pat example.test.invalid", true),
        b"[REDACTED] [REDACTED] example.test.invalid"
    );
    let mut short = StreamingSanitizer::new([("GH_TOKEN".into(), "a".into())]).unwrap();
    assert_eq!(short.push(&[b'a'; BLOCK_SIZE], true), b"[REDACTED]");
}

#[test]
fn private_copy_does_not_modify_source_and_is_removed_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.log");
    let input = format!("gh{}{}", "p_", "x".repeat(36));
    fs::write(&source, &input).unwrap();
    let path;
    {
        let copy = sanitize_log_to_temp_with_env(&source, [], false).unwrap();
        path = copy.path.clone();
        assert_ne!(path, source);
        assert_eq!(fs::read(&path).unwrap(), b"[REDACTED]");
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
    }
    assert!(!path.exists());
}

#[test]
fn fails_closed_on_invalid_source_and_excessive_environment_values() {
    assert!(
        sanitize_log_to_temp_with_env(std::path::Path::new("/does-not-exist"), [], false).is_err()
    );
    let dir = tempfile::tempdir().unwrap();
    assert!(sanitize_log_to_temp_with_env(dir.path(), [], false).is_err());
    assert!(StreamingSanitizer::new([("GH_TOKEN".into(), "a".repeat(BLOCK_SIZE + 1))]).is_err());
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
    let source = dir.path().join("source.log");
    let input = format!("gh{}{}", "p_", "x".repeat(36));
    fs::write(&source, &input).unwrap();
    let uploader = dir.path().join("gh-upload-log");
    fs::write(&uploader, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_ARGS\"\ncat \"$1\" > \"$CAPTURE_LOG\"\nls -ld \"$1\" | cut -c1-10 > \"$CAPTURE_MODE\"\necho https://gist.github.com/test/id\n").unwrap();
    fs::set_permissions(&uploader, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        dir.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    for kind in ["manual", "automatic", "optout", "invalid"] {
        let _ = fs::remove_file(dir.path().join("args"));
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "upload_child", "--nocapture"])
            .env("PATH", &path)
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
            assert!(!dir.path().join("args").exists());
            continue;
        }
        let args = fs::read_to_string(dir.path().join("args")).unwrap();
        let args: Vec<_> = args.lines().collect();
        assert_eq!(args[1], "--private");
        assert_eq!(
            fs::read_to_string(dir.path().join("uploaded")).unwrap(),
            if kind == "optout" {
                &input
            } else {
                "[REDACTED]"
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
    let mut file = fs::File::create(&source).unwrap();
    for _ in 0..1760 {
        file.write_all(&block).unwrap();
    }
    drop(file);
    let start = std::time::Instant::now();
    let copy = sanitize_log_to_temp_with_env(&source, [], false).unwrap();
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
        "sourceBytes={} sanitizedBytes={} secretLeaked=false elapsedMs={} addressSpaceLimitMiB=256",
        fs::metadata(source).unwrap().len(),
        fs::metadata(&copy.path).unwrap().len(),
        start.elapsed().as_millis()
    );
}
