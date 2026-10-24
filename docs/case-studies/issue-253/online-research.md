# Online research

Facts collected on 2026-10-24 to choose how to enforce "latest versions only" and to check the dependencies.

## Tools that detect or update outdated dependencies

| Tool                                                                                                                                                       | What it does                                              | Relevant facts                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Dependabot version updates](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories) | Opens pull requests that bump dependencies on a schedule  | Its ecosystems include `npm`, `bun`, `cargo`, `github-actions`, `nuget` and `dotnet-sdk`. Its documentation does not cover `runs-on` runner labels or `node-version` inputs. It proposes updates; it does not reject a pull request that adds an old version.                                                         |
| [Renovate](https://docs.renovatebot.com/)                                                                                                                  | Opens update pull requests; many managers and datasources | The [`github-runners` datasource](https://docs.renovatebot.com/modules/datasource/github-runners/) can update `runs-on` labels, but new runner images are added to it by hand. Ubuntu 26 arrived in 43.221.0 (2026-06-14). It needs the Renovate app or a self-hosted bot, and it does not gate pull requests either. |
| [npm-check-updates](https://github.com/raineorshine/npm-check-updates)                                                                                     | Compares `package.json` ranges with the latest releases   | `--errorLevel 2` "exits with error code 0 if no packages need updating (useful for continuous integration)". `--target latest/minor/patch`. It covers npm only.                                                                                                                                                       |
| [`npm outdated`](https://docs.npmjs.com/cli/commands/npm-outdated)                                                                                         | Lists installed packages behind `wanted` or `latest`      | Exits non-zero when something is outdated. It compares installed versions, not range floors, and covers npm only.                                                                                                                                                                                                     |
| [cargo-outdated](https://github.com/kbknapp/cargo-outdated)                                                                                                | Lists crates behind their latest release                  | `--exit-code NUM` and `-R/--root-deps-only`. It is an extra cargo install that resolves the whole workspace, and covers crates only.                                                                                                                                                                                  |
| [cargo-edit `cargo upgrade`](https://github.com/killercup/cargo-edit)                                                                                      | Rewrites `Cargo.toml` requirements to the latest releases | Updates manifests but does not check them.                                                                                                                                                                                                                                                                            |
| [`cargo update --dry-run`](https://doc.rust-lang.org/cargo/commands/cargo-update.html)                                                                     | Shows what `Cargo.lock` would change to                   | Built into cargo, so it needs nothing extra. It prints `Updating`/`Adding` lines when the lockfile is behind.                                                                                                                                                                                                         |

No single existing tool covers npm, crates, GitHub Actions, runner labels, runtime versions, PyPI tools and a git-pinned translator together. None of them fails a pull request whose range _floor_ is behind while its lockfile is current.

## Registries and indexes used by the gate

- npm: `https://registry.npmjs.org/<name>`, the `dist-tags.latest` field.
- crates.io: `https://crates.io/api/v1/crates/<name>`, the newest non-yanked stable release.
- PyPI: `https://pypi.org/pypi/<name>/json`, `info.version`.
- Node.js: `https://nodejs.org/dist/index.json`.
- .NET: `https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json`.
- GitHub releases and tags through the REST API, for actions, Bun, actionlint and `actions/runner-images`.

## Facts about the dependencies

- **sensitive-data-sanitizer**
  - 0.12.0 was published 2026-10-23 19:08 UTC.
  - #49 was merged 2026-10-24 01:41 UTC and 0.12.1 was published at 01:45 UTC. It fixed #45 (the Authorization header was masked to the end of the line) and #47 (`ERR_WORKER` at 60 s, `ERR_BINARY` on NUL bytes, `--allow-binary`). #46 (`AUTH`-named configuration values) is closed as well.
- **link-cli**
  - C# clink 4.0.2 was released 2026-10-15 and requires .NET 10. Rust 1.0.5 was released the same day.
  - Open issues: #128 (`--import` drops backslashes) and #129 (`--import` is not atomic). #112 (`--out` export) is closed.
- **gh-upload-log**
  - 0.10.1 was published 2026-10-08 and is the npm `latest`.
  - #56 (open): releases are blocked since the rename to `gh-upload-file`, because the npm publish returns E404.
  - #55 (open): the upload side does not sanitize.
- **command-stream**
  - 2.4.0 is the npm `latest`.
  - Closed issues #192 and #219 concern earlier import and startup cost. #235 is the new report about the eager `$` entry.
- **actionlint**
  - 1.7.12 is the latest release.
  - rhysd/actionlint#682 (open) asks it to recognise the `ubuntu-26.04` runner label.
