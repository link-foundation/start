# Wrapper help: issue #201

## Evidence and sequence

The [issue](https://github.com/link-foundation/start/issues/201) was opened at
2026-10-10 11:15:21 UTC. It reports failures on 0.35.4 and 0.36.0 when incident
automation tried to discover available options. Its full body and comments are
preserved under `data/`. The substitution documentation already recommended
`$ --help`, while both parsers treated the flag as unknown. The no-argument CLI
already had the correct usage renderer and successful exit.

Tests were written first: both flags had to match the no-argument output exactly.
The initial combined issue #201/#202 regression run had 20 failing tests and two
passing tests. The retained shell probe demonstrates the original rewrite, and
the passing regression log covers both help spellings. After the
parser and CLI changes the focused suite passed.

## Every requirement and possible solutions

| Requirement | Alternatives | Applied plan and evidence |
| --- | --- | --- |
| `--help` prints no-argument usage and exits zero | Duplicate help output; route to existing renderer | Both parsers set the help flag; both entry points use their existing no-argument usage renderer before execution |
| `-h` has identical behavior | Add only long spelling; alias the same flag | Both spellings share the same parser branch and both have executable regression tests |
| Help is a wrapper option only before `--` | Scan all argv for help; preserve parser separator | Existing command separation remains authoritative, so `$ -- grep --help` retains the command argument |
| Same behavior in Rust | JavaScript-only fix; native parity | Native parser and entry point match JavaScript, with binary-level tests |
| Download evidence, reconstruct sequence, analyze root cause and existing components | Treat as parser typo only; preserve reproducible evidence | Raw issue/comment snapshots, failing/passing logs and this case study record the mismatch and selected fix |
| Report independently reproduced upstream defects | Open speculative dependency reports; report demonstrated defects | The defect is local to the custom parsers; no dependency or upstream defect was reproduced |
| Apply across the whole codebase with tests | Patch only one entry point; cover both implementations | `regression-201.js`, `regression_201.rs` and shared CLI fixtures cover both flags and separator behavior |

## Component research

[Commander](https://github.com/tj/commander.js/blob/master/Readme.md) implements a
default help option, and [clap's Help action](https://docs.rs/clap/latest/clap/enum.ArgAction.html)
provides the same convention for Rust. Either could support a future parser
replacement. Adopting either here would broaden the change to command stacking,
query commands and the wrapper/command separator. Reusing the existing usage
function is sufficient and guarantees the requested byte-for-byte equality.

The failure has a deterministic root cause and executable coverage. Existing
verbose parsing and execution diagnostics suffice; additional logging would not
help explain this pre-execution failure.
