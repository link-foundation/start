//! Tests for output_blocks module
//!
//! Tests for nicely rendered command output blocks and formatting utilities.

use start_command::{
    create_finish_block, create_start_block, escape_for_links_notation, format_duration,
    get_box_style, FinishBlockOptions, StartBlockOptions,
};

#[test]
fn test_create_start_block() {
    let block = create_start_block(&StartBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:00",
        command: "echo hello",
        style: Some("rounded"),
        width: Some(50),
    });

    assert!(block.contains("╭"));
    assert!(block.contains("╰"));
    assert!(block.contains("Session ID: test-uuid"));
    assert!(block.contains("Starting at 2025-01-01 00:00:00: echo hello"));
}

#[test]
fn test_create_finish_block() {
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: Some(17.0),
        style: Some("rounded"),
        width: Some(60),
    });

    assert!(block.contains("╭"));
    assert!(block.contains("╰"));
    assert!(block.contains("Finished at 2025-01-01 00:00:01 in 0.017 seconds"));
    assert!(block.contains("Exit code: 0"));
    assert!(block.contains("Session ID: test-uuid"));
}

#[test]
fn test_create_finish_block_without_duration() {
    let block = create_finish_block(&FinishBlockOptions {
        session_id: "test-uuid",
        timestamp: "2025-01-01 00:00:01",
        exit_code: 0,
        log_path: "/tmp/test.log",
        duration_ms: None,
        style: Some("rounded"),
        width: Some(50),
    });

    assert!(block.contains("Finished at 2025-01-01 00:00:01"));
    assert!(!block.contains("seconds"));
}

#[test]
fn test_format_duration() {
    assert_eq!(format_duration(0.5), "0.001");
    assert_eq!(format_duration(17.0), "0.017");
    assert_eq!(format_duration(500.0), "0.500");
    assert_eq!(format_duration(1000.0), "1.000");
    assert_eq!(format_duration(5678.0), "5.678");
    assert_eq!(format_duration(12345.0), "12.35");
    assert_eq!(format_duration(123456.0), "123.5");
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

#[test]
fn test_box_styles() {
    let rounded = get_box_style(Some("rounded"));
    assert_eq!(rounded.top_left, "╭");

    let heavy = get_box_style(Some("heavy"));
    assert_eq!(heavy.top_left, "┏");

    let double = get_box_style(Some("double"));
    assert_eq!(double.top_left, "╔");

    let ascii = get_box_style(Some("ascii"));
    assert_eq!(ascii.top_left, "+");
}
