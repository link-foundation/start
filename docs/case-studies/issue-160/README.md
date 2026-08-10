# Case Study — Issue #160: a rate-limited integration probe blocked release

- Issue: https://github.com/link-foundation/start/issues/160
- Pull request: https://github.com/link-foundation/start/pull/161
- Failing JavaScript run: https://github.com/link-foundation/start/actions/runs/31380353470
- Same-revision Rust run: https://github.com/link-foundation/start/actions/runs/31380353804
- Fixed JavaScript run: https://github.com/link-foundation/start/actions/runs/31388354106
- Fixed Rust run: https://github.com/link-foundation/start/actions/runs/31388355823

## Result

The product's multi-network behavior was correct. Its integration test combined
two different claims in one shell command: reach a private Docker alias and get
a successful HTTP response from the unauthenticated GitHub API. The first claim
passed. The second intermittently returned HTTP 403 after the runner's source IP
exhausted GitHub's 60-request hourly unauthenticated quota. BusyBox `wget`
returned a nonzero status, so the container and test failed even though DNS,
routing, TCP, and TLS had all succeeded.

PR #159 removed the public request from both language suites before this issue's
prepared branch was created. It replaced the endpoint with two local sidecars,
added container-log diagnostics, and added opt-in Docker lifecycle tracing. Its
successful main workflow published the previously blocked JavaScript 0.32.0
release.

This PR preserves that hermetic design and closes one remaining coverage gap:
the probe now starts on Docker's default `bridge`, reaches sidecars on two
additional internal networks, and checks that a default route remains present.
It therefore retains all three assertions without depending on any public
service. A fast, daemon-independent invariant in each language rejects any
future HTTP URL in the probe.

## Documents

| File                 | Purpose                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `requirements.md`    | Complete requirement inventory and disposition.                                        |
| `timeline.md`        | Event and release sequence reconstructed from GitHub metadata.                         |
| `root-cause.md`      | Technical and process root causes, with raw-log line references.                       |
| `solutions.md`       | Alternatives considered, selected design, and verification plan.                       |
| `online-research.md` | Official documentation and existing components reviewed.                               |
| `ci-logs/`           | Complete pre-fix and post-fix JavaScript and Rust workflow logs.                       |
| `data/`              | Issue, PR, review, workflow, release, registry, source, diff, and local-test evidence. |

## Evidence highlights

- The failing log invokes the public probe at
  `ci-logs/js-31380353470.log:4654`, reports only `'1' !== '0'` at lines
  4663–4677, and names the failed integration test at line 4680.
- That job finishes with 714 passing tests and exactly one failure at lines
  5676–5683.
- The fixed main run uses only local aliases at
  `ci-logs/js-31388354106.log:4835`, passes the integration test at line 4840,
  and publishes `start-command@0.32.0` at line 8195.
- `data/npm-package.json` independently records `latest: 0.32.0` and its
  publication timestamp.
- `data/js-focused-test.log` and `data/rust-focused-test.log` record successful
  real-Docker verification of the final route-preserving probe.

No upstream defect was filed. GitHub's rate limit, GitHub-hosted runner address
model, IANA's best-effort example service, and BusyBox's nonzero response to an
HTTP error all behave as documented or expected. The defect was the test's
choice of an uncontrolled dependency.
