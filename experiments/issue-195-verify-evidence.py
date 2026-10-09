#!/usr/bin/env python3
"""Verify complete archived incident evidence without exposing credentials."""
import gzip
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/case-studies/issue-195/data"
PATTERNS = [
    re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    re.compile(rb"sk-(?:ant-)?[A-Za-z0-9_-]{20,}"),
    re.compile(rb"\b\d{8,12}:[A-Za-z0-9_-]{30,}"),
    re.compile(rb"(?i)Bearer\s+[A-Za-z0-9_.-]{20,}"),
]

manifest = json.loads((DATA / "evidence-manifest.json").read_text())
for entry in manifest["logs"]:
    archive = DATA / entry["archive"]
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == entry["archiveSHA256"]
    digest = hashlib.sha256()
    lines = 0
    with gzip.open(archive, "rb") as stream:
        for line in stream:
            digest.update(line)
            lines += 1
            assert not any(pattern.search(line) for pattern in PATTERNS), archive.name
    assert lines == entry["lineCount"], archive.name
    assert digest.hexdigest() == entry["redactedSHA256"], archive.name
    print(f"Verified {archive.name}: {lines} lines, hashes and credential scan")

for case in ["issue-193", "issue-194", "issue-195"]:
    for path in (ROOT / "docs/case-studies" / case).rglob("*"):
        if path.is_file() and path.suffix in [".json", ".md", ".txt"]:
            assert not any(pattern.search(path.read_bytes()) for pattern in PATTERNS), path.name
print("Verified case-study text/JSON credential scan")
