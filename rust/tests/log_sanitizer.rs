use sha2::{Digest, Sha256};
use start_command::log_sanitizer::{
    find_sanitizer, parse_version, sanitize_log_to_temp_with_env, sanitize_text_with_env,
    BLOCK_SIZE, MINIMUM_VERSION, OVERRIDE, PACKAGE,
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
    // Since 0.12.2, placeholders and their scheme remain unchanged.
    (
        "Authorization: Bearer <token>",
        "Authorization: Bearer <token>",
    ),
];

#[test]
fn masks_only_the_authorization_scheme_and_token() {
    let Some(env) = test_env(&[]) else { return };
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
    // sensitive-data-sanitizer 0.12.1 does this itself (#45), without the
    // pre-pass start used to run (#253).
    assert_eq!(
        String::from_utf8(sanitize_file(input.as_bytes(), env.clone())).unwrap(),
        expected
    );
    assert_eq!(sanitize_text_with_env(&input, env).unwrap(), expected);
}

#[test]
fn masks_long_authorization_tokens_across_stream_blocks() {
    let Some(env) = test_env(&[]) else { return };
    let input = format!(
        "Authorization: Bearer {} tail\nordinary\n",
        "a".repeat(200_000)
    );
    let expected = "Authorization: [REDACTED] tail\nordinary\n";
    assert_eq!(sanitize_file(input.as_bytes(), env), expected.as_bytes());
}

#[test]
fn preserves_authorization_placeholders_and_control_bytes_when_sanitizing_twice() {
    let Some(env) = test_env(&[]) else { return };
    let input = [
        "Authorization: Bearer [REDACTED] already",
        "Authorization: Bearer {{token}} x",
        "Authorization: Bearer <token> x",
        "Authorization: Bearer $GITHUB_TOKEN x",
        "Authorization: Bearer abc\0 tail",
        "Authorization: Bearer abc\x1b[0m tail",
        r#"{"header":"Authorization: Bearer ab[c]d","next":"keep"}"#,
    ]
    .join("\n");
    let expected = [
        "Authorization: Bearer [REDACTED] already",
        // Arbitrary bracketed credentials are removed in full (#50).
        "Authorization: [REDACTED] x",
        "Authorization: Bearer <token> x",
        "Authorization: Bearer $GITHUB_TOKEN x",
        "Authorization: [REDACTED]\0 tail",
        "Authorization: [REDACTED]\x1b[0m tail",
        r#"{"header":"Authorization: [REDACTED]","next":"keep"}"#,
    ]
    .join("\n");
    let output = sanitize_file(input.as_bytes(), env.clone());
    assert_eq!(output, expected.as_bytes());
    assert_eq!(sanitize_file(&output, env), output);
}

#[test]
fn sanitizes_dense_credentials_without_losing_surrounding_bytes() {
    let Some(env) = test_env(&[("NODE_OPTIONS", "--max-old-space-size=384")]) else {
        return;
    };
    // Same finite log as the JS regression: about 256 KiB, 5700 secrets.
    let mut input = String::new();
    for index in 0..5700 {
        // sha2 0.11 returns a byte array without the old LowerHex implementation.
        let token: String = Sha256::digest(index.to_string().as_bytes())
            .iter()
            .map(|byte| format!("{:02x}", byte))
            .collect();
        input.push_str(&format!("ghp_{} keep\n", &token[..36]));
    }
    let output = sanitize_file(input.as_bytes(), env);
    let expected = "[REDACTED] keep\n".repeat(5700);
    // Keep failures value-free and avoid printing an entire credential log.
    assert_eq!(Sha256::digest(&output), Sha256::digest(expected.as_bytes()));
}

#[test]
fn requires_the_sanitizer_release_the_javascript_package_bundles() {
    assert_eq!(parse_version("0.12.2\n"), Some((0, 12, 2)));
    assert_eq!(parse_version("1.2.3-beta.1"), Some((1, 2, 3)));
    assert_eq!(parse_version("unknown"), None);
    // An older CLI on PATH rejects --allow-binary (ERR_ARGUMENT), so the
    // installer, the version check and the JavaScript dependency agree.
    let (major, minor, patch) = MINIMUM_VERSION;
    let range = format!("^{}.{}.{}", major, minor, patch);
    assert_eq!(
        PACKAGE,
        format!("@link-foundation/sensitive-data-sanitizer@{}", range)
    );
    let manifest =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../js/package.json"))
            .unwrap();
    assert!(manifest.contains(&format!(
        "\"@link-foundation/sensitive-data-sanitizer\": \"{}\"",
        range
    )));
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
    for (index, secret) in secrets.iter().enumerate() {
        assert!(
            !output.contains(secret.as_str()),
            "leaked secret #{}",
            index
        );
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
fn preserves_invalid_utf8_nul_bytes_line_endings_and_empty_logs() {
    let Some(env) = test_env(&[]) else { return };
    let mut input = b"bad \xff\xfe\xc3 ".to_vec();
    input.extend(format!("gh{}{}\r\nnext\rend", "p_", "x".repeat(36)).bytes());
    assert_eq!(
        sanitize_file(&input, env.clone()),
        b"bad \xff\xfe\xc3 [REDACTED]\r\nnext\rend"
    );
    // --allow-binary: a NUL byte in a terminal transcript no longer blocks
    // the upload with ERR_BINARY (#253), and credentials next to it are masked.
    let input = format!("line\0one gh{}{}\0two\n", "p_", "x".repeat(36));
    assert_eq!(
        sanitize_file(input.as_bytes(), env.clone()),
        b"line\0one [REDACTED]\0two\n"
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
    let source = dir.path().join("source.log");
    fs::write(&source, b"ordinary log").unwrap();
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

#[cfg(unix)]
#[test]
fn manual_upload_replaces_a_sanitizer_older_than_the_minimum_version() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let Some(real) = sanitizer() else { return };
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, script: &str| {
        let file = dir.path().join(name);
        fs::write(&file, script).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    };
    // 0.12.0 rejects --allow-binary with ERR_ARGUMENT.
    write(
        "sensitive-data-sanitizer",
        "#!/bin/sh\n[ \"$1\" = --version ] && echo 0.12.0 && exit 0\necho 'Sanitization failed (ERR_ARGUMENT).' >&2\nexit 2\n",
    );
    // A fake bun "installs" the current release over the old one.
    write(
        "bun",
        "#!/bin/sh\n[ \"$1\" = --version ] && echo 1.0.0 && exit 0\nprintf '%s\\n' \"$@\" > \"$CAPTURE_INSTALL\"\nprintf '#!/bin/sh\\nexec \"%s\" \"$@\"\\n' \"$REAL_SANITIZER\" > \"$(dirname \"$0\")/sensitive-data-sanitizer\"\n",
    );
    write(
        "gh-upload-log",
        "#!/bin/sh\ncat \"$1\" > \"$CAPTURE_LOG\"\necho https://gist.github.com/test/id\n",
    );
    let path = format!(
        "{}:{}",
        dir.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut env = test_env(&[("PATH", &path)]).unwrap();
    env.retain(|(name, _)| name != OVERRIDE);
    let source = dir.path().join("source.log");
    fs::write(&source, format!("line\0gh{}{}\n", "p_", "x".repeat(36))).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "upload_child", "--nocapture"])
        .env_clear()
        .envs(env)
        .env("SANITIZER_UPLOAD_KIND", "manual")
        .env("SANITIZER_SOURCE_LOG", &source)
        .env("REAL_SANITIZER", real)
        .env("CAPTURE_INSTALL", dir.path().join("install"))
        .env("CAPTURE_LOG", dir.path().join("uploaded"))
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{}", stdout);
    assert!(stdout.contains(&format!(
        "sensitive-data-sanitizer is older than the required version; installing with: bun install -g {}",
        PACKAGE
    )));
    assert_eq!(
        fs::read_to_string(dir.path().join("install")).unwrap(),
        format!("install\n-g\n{}\n", PACKAGE)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("uploaded")).unwrap(),
        "line\0[REDACTED]\n"
    );
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
