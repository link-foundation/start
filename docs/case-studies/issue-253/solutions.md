# Solutions and plans

## R1, R2: Fail pull requests that use anything but the latest releases

| Option                                             | Covers                                                                         | Gate on pull requests                                                                        | Verdict                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Dependabot or Renovate update pull requests        | npm, cargo, actions (Renovate also runner labels)                              | No. They propose updates but cannot reject a pull request that adds or keeps an old version. | Useful on top of the gate, but not enough for R1                                                                |
| `npm-check-updates --errorLevel 2`                 | npm `package.json` only                                                        | Yes                                                                                          | Too narrow; also needs a second tool for crates                                                                 |
| `npm outdated` plus `cargo outdated --exit-code 1` | Installed npm packages and crates                                              | Yes                                                                                          | Compares installed versions, not range floors; extra cargo install; no actions, runners, runtimes or translator |
| `cargo update --dry-run`                           | `Cargo.lock`                                                                   | Yes                                                                                          | **Used** for the Rust lockfile, because it is built into cargo and runs inside `rust.yml`                       |
| **A repository script over every pinned version**  | npm, crates, actions, CI tools, PyPI, runtimes, runners, translator, lockfiles | Yes                                                                                          | **Chosen**: `scripts/check-dependency-freshness.mjs`                                                            |

Why the custom gate:

1. It covers every kind of pin in this repository from one inventory, and its report lists them all ([data/freshness-after.txt](data/freshness-after.txt)).
2. It checks the **floor** of each range. A caret range that already admits the newest release still fails until its floor names it. That is what keeps "obsolete versions with new features missing" out of `package.json` and `Cargo.toml`, the files users and downstream lockfiles resolve from.
3. Exceptions are explicit and expire. A version may stay behind only with a link to an open issue, and the check fails once that issue closes.
4. It needs only Node.js and the network, so it runs in the JavaScript stage. It keeps the rule that cargo runs only in `rust.yml`.

Plan, done in this pull request:

1. Write the checker and its fixture tests.
2. Upgrade everything it reports.
3. Run it strictly on pull requests and in report mode elsewhere, so a release published after a merge cannot block the release of `main`.
4. Add `cargo update --dry-run` to `rust.yml`.

Possible follow-up, not required by the issue: add Renovate or Dependabot so the upgrades the gate asks for arrive as pull requests automatically.

## R3: Upgrade every dependency now

Options:

- Bump only what is needed.
- Bump everything to its latest release and fix what breaks.

The issue asks for the latest everywhere, so every entry the gate reported was upgraded. Each break was fixed at its root cause instead of being pinned back:

- **clink 4.x rejected the store's queries.** The store was rewritten to record-scoped links and is tested against the real CLI.
- **command-stream 2.x returns snapshots.** They are converted with `outputText()`.
- **The lino-objects-codec 0.9 format changed.** Reading both formats is tested with fixtures, and the changelog notes that older start releases cannot read the new store.
- **.NET 10 is required by clink 4.0.2.** CI moved to the 10.0 SDK.

## R4, R5: Sanitizer features

Options:

- **(a) Keep start's own Authorization pre-pass and NUL workaround.** This duplicates the library and diverges from gh-upload-log and hive-mind.
- **(b) Use 0.12.1's fixes directly and require that release.**

Chosen: (b).

- The pre-pass is removed in JS and Rust, and `--allow-binary` is passed.
- The Rust installer upgrades a sanitizer older than 0.12.1 before any upload.
- Tests in both languages keep the required release in sync.
- The remaining library defects are reported upstream (#50, #51) with reproductions. They lose no secret, so they do not block the upgrade.

## R6: Dependencies we control

| Dependency         | Finding                                                                       | Action                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| link-cli (clink)   | A quoted number is read as an address; the store had silently written nothing | Store fixed in start; link-cli#130 filed                                                                                                   |
| command-stream     | `import { $ }` loads 281 modules                                              | command-stream#235 filed; start imports it lazily                                                                                          |
| lino-objects-codec | New readable format; reads the old one                                        | Upgraded; fixtures for both formats                                                                                                        |
| gh-upload-log      | Renamed package unpublished (#56); no upload-side sanitizing (#55)            | Already reported upstream; start sanitizes before uploading and keeps `gh-upload-log` 0.10.1. **Blocked** on the npm owner for the rename. |
| meta-language      | Translator pin behind `main`                                                  | Pin bumped; the gate now checks it                                                                                                         |

## R7 to R10: Case study

The data is collected in [data/](data) and [upstream/](upstream). The scripts that produced it are in [experiments/issue-253](../../../experiments/issue-253). The analysis is in the [README](README.md), the requirements in [requirements.md](requirements.md) and the external facts in [online-research.md](online-research.md).
