# Online Research - Issue #122

This case study used official documentation to validate the CI/CD fixes.

## Cargo path dependencies and publishable crates

Source: Cargo Book, "Specifying Dependencies"

- URL: https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
- Relevant section: "Multiple locations"

Finding:

Cargo supports a dependency that has both a local `path` and a registry
`version`. The local path is used during local builds, while publishing uses the
registry version. That explains why adding a version to
`lino-objects-codec = { path = "../lib/lino-objects-codec", version = "..." }`
changed the publish check from "no version specified" to registry resolution.

Decision:

Use the registry dependency directly:

```toml
lino-objects-codec = "0.2.0"
```

This makes local CI compile the same dependency API that crates.io users will
receive.

## Cargo publish

Sources:

- https://doc.rust-lang.org/cargo/reference/publishing.html
- https://doc.rust-lang.org/cargo/commands/cargo-publish.html

Findings:

- Publishing uploads a specific crate version to crates.io.
- Published versions are permanent and cannot be overwritten.
- `cargo publish` requires authentication through Cargo credentials or registry
  token configuration.

Decision:

Add an idempotent publish helper:

- check whether the exact crate version is already present,
- skip as success when already published,
- require `CARGO_REGISTRY_TOKEN` or `CARGO_TOKEN` only when a publish is needed,
- run `cargo publish --allow-dirty --manifest-path rust/Cargo.toml`.

## GitHub REST Releases API

Source: GitHub Docs, "REST API endpoints for releases"

- URL: https://docs.github.com/en/rest/releases/releases#create-a-release

Findings:

- Create Release requires `tag_name`.
- Successful creation returns HTTP 201.
- Validation failure returns HTTP 422.
- GitHub App installation tokens can call the endpoint when the repository
  token has `contents: write`.

Decision:

The release helper must check the `gh api` exit status. HTTP 422 for
`already_exists` is treated as an idempotent skip, while other non-zero exits
fail the workflow.

## GitHub Actions step outputs

Source: GitHub Docs, "Workflow commands for GitHub Actions"

- URL: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#setting-an-output-parameter

Finding:

Step outputs should be set by appending `name=value` lines to
`$GITHUB_OUTPUT`.

Decision:

`scripts/publish-to-crates.mjs` writes:

- `published`,
- `published_version`,
- `already_published`,
- `publish_result`.

The Rust workflow gates GitHub Release creation on the publish step's
`published` output.
