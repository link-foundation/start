#!/usr/bin/env python3
"""
Create a GitHub release from CHANGELOG.md content.

Usage:
    python scripts/create_github_release.py --version VERSION --repository REPO

Example:
    python scripts/create_github_release.py --version 1.2.3 --repository owner/repo

Environment variables:
    GH_TOKEN or GITHUB_TOKEN: GitHub token for authentication
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def run_command(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """Run a command and handle errors."""
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)

    if result.stdout:
        print(result.stdout)
    if result.stderr and result.returncode != 0:
        print(result.stderr, file=sys.stderr)

    if check and result.returncode != 0:
        print(
            f"Error: Command failed with exit code {result.returncode}",
            file=sys.stderr,
        )
        sys.exit(result.returncode)

    return result


def extract_changelog_entry(changelog_path: Path, version: str) -> str:
    """Extract the changelog entry for a specific version."""
    if not changelog_path.exists():
        print(f"Warning: {changelog_path} not found", file=sys.stderr)
        return f"Release {version}"

    content = changelog_path.read_text()

    # Look for version section (e.g., "## 1.2.3" or "## 1.2.3 - 2024-01-15")
    version_pattern = rf"^## {re.escape(version)}(\s|$)"
    match = re.search(version_pattern, content, re.MULTILINE)

    if not match:
        print(
            f"Warning: Version {version} not found in {changelog_path}",
            file=sys.stderr,
        )
        return f"Release {version}"

    # Extract content until next version section or end of file
    start = match.end()
    next_version = re.search(r"^## \d+\.\d+\.\d+", content[start:], re.MULTILINE)

    if next_version:
        entry = content[start : start + next_version.start()].strip()
    else:
        entry = content[start:].strip()

    return entry if entry else f"Release {version}"


def create_release(
    version: str, repository: str, release_notes: str, prerelease: bool = False
) -> None:
    """Create a GitHub release using gh CLI."""
    tag = f"v{version}"

    print(f"\nCreating GitHub release for {tag}...")
    print(f"Repository: {repository}")
    print(f"Prerelease: {prerelease}")
    print(f"\nRelease notes:\n{release_notes}\n")

    cmd = [
        "gh",
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--title",
        tag,
        "--notes",
        release_notes,
    ]

    if prerelease:
        cmd.append("--prerelease")

    run_command(cmd)
    print(f"\n✅ GitHub release {tag} created successfully!")


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Create GitHub release from CHANGELOG.md",
    )
    parser.add_argument(
        "--version",
        "-v",
        required=True,
        help="Version to release (e.g., 1.2.3)",
    )
    parser.add_argument(
        "--repository",
        "-r",
        required=True,
        help="GitHub repository (owner/repo)",
    )
    parser.add_argument(
        "--prerelease",
        action="store_true",
        help="Mark as prerelease",
    )

    args = parser.parse_args()

    # Check for GitHub token
    if not os.environ.get("GH_TOKEN") and not os.environ.get("GITHUB_TOKEN"):
        print(
            "Error: GH_TOKEN or GITHUB_TOKEN environment variable required",
            file=sys.stderr,
        )
        return 1

    # Check if gh CLI is available
    result = run_command(["gh", "--version"], check=False)
    if result.returncode != 0:
        print(
            "Error: gh CLI not found. Install from https://cli.github.com/",
            file=sys.stderr,
        )
        return 1

    # Determine project root
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    changelog_path = project_root / "CHANGELOG.md"

    try:
        # Extract changelog entry
        release_notes = extract_changelog_entry(changelog_path, args.version)

        # Create release
        create_release(args.version, args.repository, release_notes, args.prerelease)

        return 0

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
