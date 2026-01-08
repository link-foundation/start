//! Tests for output_blocks module
//!
//! Tests for the "status spine" format: width-independent, lossless output.

use start_command::{
    create_finish_block, create_start_block, escape_for_links_notation, format_duration,
    get_box_style, get_result_marker, parse_isolation_metadata, FinishBlockOptions,
    StartBlockOptions, FAILURE_MARKER, SPINE, SUCCESS_MARKER,
};

#[test]
fn test_spine_constants() {
    assert_eq!(SPINE, "│");
    assert_eq!(SUCCESS_MARKER, "✓");
    assert_eq!(FAILURE_MARKER, "✗");
}

#[test]
fn test_get_result_marker() {
    assert_eq!(get_result_marker(0), "✓");
    assert_eq!(get_result_marker(1), "✗");
    assert_eq!(get_result_marker(127), "✗");
}

#[test]
fn test_parse_isolation_metadata() {
    let extra_lines = vec![
        "[Isolation] Environment: docker, Mode: attached",
        "[Isolation] Session: docker-container-123",
        "[Isolation] Image: ubuntu:latest",
    ];
    let metadata = parse_isolation_metadata(&extra_lines);

    assert_eq!(metadata.isolation, Some("docker".to_string()));
    assert_eq!(metadata.mode, Some("attached".to_string()));
    assert_eq!(metadata.session, Some("docker-container-123".to_string()));
    assert_eq!(metadata.image, Some("ubuntu:latest".to_string()));
}

#[test]
fn test_create_start_block() {
    let block = create_start_block(&StartBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:00",
        command: "echo hello",
        extra_lines: None,
        style: Some("rounded"),
        width: Some(50),
    });

    assert!(block.contains("│ session   test-uuid"));
    assert!(block.contains("│ start     2025-01-01 00:00:00"));
    assert!(block.contains("$ echo hello"));
}

#[test]
fn test_create_start_block_with_isolation() {
    let extra = vec![
        "[Isolation] Environment: screen, Mode: attached",
        "[Isolation] Session: my-session",
    ];
    let block = create_start_block(&StartBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:00",
        command: "echo hello",
        extra_lines: Some(extra),
        style: Some("rounded"),
        width: Some(60),
    });

    assert!(block.contains("│ session   test-uuid"));
    assert!(block.contains("│ start     2025-01-01 00:00:00"));
    assert!(block.contains("│ isolation screen"));
    assert!(block.contains("│ mode      attached"));
    assert!(block.contains("│ screen    my-session"));
    assert!(block.contains("$ echo hello"));
}

#[test]
fn test_create_start_block_with_docker_isolation() {
    let extra = vec![
        "[Isolation] Environment: docker, Mode: attached",
        "[Isolation] Image: ubuntu",
        "[Isolation] Session: docker-container-123",
    ];
    let block = create_start_block(&StartBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:00",
        command: "echo hello",
        extra_lines: Some(extra),
        style: None,
        width: None,
    });

    assert!(block.contains("│ isolation docker"));
    assert!(block.contains("│ image     ubuntu"));
    assert!(block.contains("│ container docker-container-123"));
}

#[test]
fn test_create_finish_block() {
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: Some(17.0),
        result_message: None,
        extra_lines: None,
        style: Some("rounded"),
        width: Some(60),
    });

    assert!(block.contains("✓"));
    assert!(block.contains("│ finish    2025-01-01 00:00:01"));
    assert!(block.contains("│ duration  0.017s"));
    assert!(block.contains("│ exit      0"));
    assert!(block.contains("│ log       /tmp/test.log"));
    assert!(block.contains("│ session   test-uuid"));
}

#[test]
fn test_create_finish_block_failure() {
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 1,
        log_path: "/tmp/test.log",
        duration_ms: Some(100.0),
        result_message: None,
        extra_lines: None,
        style: None,
        width: None,
    });

    assert!(block.contains("✗"));
    assert!(block.contains("│ exit      1"));
}

#[test]
fn test_create_finish_block_with_isolation_repeated() {
    let extra = vec![
        "[Isolation] Environment: docker, Mode: attached",
        "[Isolation] Image: ubuntu",
        "[Isolation] Session: docker-container-123",
    ];
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: Some(17.0),
        result_message: None,
        extra_lines: Some(extra),
        style: None,
        width: None,
    });

    assert!(block.contains("│ isolation docker"));
    assert!(block.contains("│ mode      attached"));
    assert!(block.contains("│ image     ubuntu"));
    assert!(block.contains("│ container docker-container-123"));
}

#[test]
fn test_create_finish_block_without_duration() {
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: None,
        result_message: None,
        extra_lines: None,
        style: Some("rounded"),
        width: Some(50),
    });

    assert!(block.contains("│ finish    2025-01-01 00:00:01"));
    assert!(!block.contains("duration"));
}

#[test]
fn test_finish_block_log_session_last() {
    let extra = vec![
        "[Isolation] Environment: screen, Mode: attached",
        "[Isolation] Session: my-screen",
    ];
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: Some(17.0),
        result_message: None,
        extra_lines: Some(extra),
        style: None,
        width: None,
    });

    let lines: Vec<&str> = block.lines().collect();
    assert_eq!(lines[lines.len() - 1], "│ session   test-uuid");
    assert_eq!(lines[lines.len() - 2], "│ log       /tmp/test.log");
}

#[test]
fn test_format_duration() {
    assert_eq!(format_duration(0.5), "0.001s");
    assert_eq!(format_duration(17.0), "0.017s");
    assert_eq!(format_duration(500.0), "0.500s");
    assert_eq!(format_duration(1000.0), "1.000s");
    assert_eq!(format_duration(5678.0), "5.678s");
    assert_eq!(format_duration(12345.0), "12.35s");
    assert_eq!(format_duration(123456.0), "123.5s");
}

#[test]
fn test_escape_for_links_notation_no_quoting() {
    assert_eq!(escape_for_links_notation("simple"), "simple");
    assert_eq!(escape_for_links_notation("123"), "123");
}

#[test]
fn test_escape_for_links_notation_with_space() {
    assert_eq!(escape_for_links_notation("hello world"), "\"hello world\"");
}

#[test]
fn test_escape_for_links_notation_with_colon() {
    assert_eq!(escape_for_links_notation("key:value"), "\"key:value\"");
}

#[test]
fn test_escape_for_links_notation_with_double_quotes() {
    assert_eq!(
        escape_for_links_notation("say \"hello\""),
        "'say \"hello\"'"
    );
}

#[test]
fn test_escape_for_links_notation_with_single_quotes() {
    assert_eq!(escape_for_links_notation("it's cool"), "\"it's cool\"");
}

// Legacy tests for backward compatibility (BOX_STYLES)
#[test]
fn test_box_styles_legacy() {
    let rounded = get_box_style(Some("rounded"));
    assert_eq!(rounded.top_left, "╭");

    let heavy = get_box_style(Some("heavy"));
    assert_eq!(heavy.top_left, "┏");

    let double = get_box_style(Some("double"));
    assert_eq!(double.top_left, "╔");

    let ascii = get_box_style(Some("ascii"));
    assert_eq!(ascii.top_left, "+");
}
