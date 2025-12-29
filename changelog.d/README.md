# Changelog Fragments

This directory contains changelog fragments for the Rust implementation.

## How to Create a Changelog Fragment

When making changes to the Rust code, create a new `.md` file in this directory with your changelog entry.

### File Naming

Name your file using one of these patterns:
- `{pr-number}.md` - For changes associated with a PR
- `{descriptive-name}.md` - For other changes

### File Contents

The file should contain a brief description of your changes. The first line determines the release type:

- Lines starting with `BREAKING:` - Major version bump
- Lines starting with `feat:` or `feature:` - Minor version bump
- All other changes - Patch version bump

### Example

```markdown
feat: Add new command substitution feature

Added support for natural language command substitution using .lino files.
```

## How It Works

1. When you create a PR, add a changelog fragment
2. When the PR is merged to main, the release workflow will:
   - Collect all fragments
   - Determine the version bump type
   - Update CHANGELOG.md
   - Bump the version in Cargo.toml
   - Create a GitHub release
   - Delete the processed fragments

## Notes

- Fragment files are automatically deleted after being processed
- Multiple fragments can exist if multiple PRs are merged before a release
- The `README.md` file is preserved and not processed as a fragment
