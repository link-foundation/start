//! Tests for isolation module
//!
//! Tests for command isolation utilities and default Docker image detection.

use start_command::{docker_pull_image, get_default_docker_image, is_command_available};

#[test]
fn test_get_default_docker_image() {
    // The function should return a valid Docker image string
    let image = get_default_docker_image();

    // Should not be empty
    assert!(!image.is_empty());

    // Should contain :latest or a version tag
    assert!(image.contains(':'), "Image should have a tag");

    // Should be a valid image name (alphanumeric, dashes, underscores, slashes)
    let valid_chars =
        |c: char| c.is_alphanumeric() || c == '-' || c == '_' || c == '/' || c == ':' || c == '.';
    assert!(
        image.chars().all(valid_chars),
        "Image name should contain valid characters"
    );
}

#[test]
fn test_get_default_docker_image_returns_known_images() {
    let image = get_default_docker_image();

    // The function should return one of the known base images
    let known_images = [
        "alpine:latest",
        "ubuntu:latest",
        "debian:latest",
        "archlinux:latest",
        "fedora:latest",
        "centos:latest",
    ];

    assert!(
        known_images.contains(&image.as_str()),
        "Image '{}' should be one of the known base images: {:?}",
        image,
        known_images
    );
}

/// Regression test for issue #138: the image-preparation phase (docker pull)
/// must be recorded in the session log. An invalid reference fails fast without
/// any network access, so this exercises the marker + teed-output behavior even
/// in environments without registry access.
#[test]
fn test_docker_pull_image_records_prep_phase_in_log() {
    if !is_command_available("docker") {
        eprintln!("  Skipping: docker not installed");
        return;
    }

    let log_path = std::env::temp_dir().join(format!(
        "start-138-rust-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&log_path, "=== Start Command Log ===\n").unwrap();

    let (success, _output) = docker_pull_image("invalid..badname", Some(&log_path));
    let contents = std::fs::read_to_string(&log_path).unwrap();
    let _ = std::fs::remove_file(&log_path);

    assert!(!success, "pull of an invalid reference must fail");
    assert!(
        contents.contains("Preparing image invalid..badname"),
        "log must contain the \"Preparing image …\" start marker, got:\n{}",
        contents
    );
    assert!(
        contents.contains("Image preparation failed"),
        "log must contain the failure marker with elapsed duration, got:\n{}",
        contents
    );
}

/// Issue #138: without a log path, docker_pull_image must not panic and must
/// return the (success, output) contract unchanged (backward compatibility).
#[test]
fn test_docker_pull_image_without_log_path() {
    if !is_command_available("docker") {
        eprintln!("  Skipping: docker not installed");
        return;
    }

    let (success, output) = docker_pull_image("invalid..badname", None);
    assert!(!success);
    let _ = output; // output is a String; just ensure the call returns
}
