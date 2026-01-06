//! Tests for isolation module
//!
//! Tests for command isolation utilities and default Docker image detection.

use start_command::get_default_docker_image;

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
