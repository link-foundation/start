# Solutions and verification

## Selected solution

The final integration topology is entirely local:

1. Create two user-defined `--internal` networks.
2. Start one Alpine sidecar with alias `formal-ai` on the first and another with
   alias `formal-db` on the second.
3. Create the subject container on Docker's default `bridge`.
4. Attach both internal networks before starting it.
5. Assert both aliases answer and `ip route` still contains a default route.
6. Include container logs in any nonzero-exit assertion.
7. Independently assert that the probe contains both aliases and the route check
   but contains no HTTP or HTTPS URL.

This tests repository-owned behavior only. It distinguishes Docker topology
from public internet health and remains valid when GitHub's quota is exhausted,
DNS is filtered, or an external service is unavailable.

## Alternatives considered

### Replace GitHub with `https://example.com`

Better than a metered API, but rejected as a gating dependency. IANA explicitly
describes the example-domain HTTP service as best effort and says applications
must not require it to operate. RFC 2606 reserves the name for examples; it does
not provide an uptime guarantee.

### Authenticate the GitHub request

Rejected. It adds token provisioning and still couples a Docker topology test to
GitHub API availability and quotas.

### Probe TCP 443 or accept every HTTP response

This would avoid the 403 semantic mismatch but still depends on public DNS,
routing, firewall policy, and remote service availability. It belongs in a
non-gating environment smoke test, not this regression suite.

### Run a local HTTP server on the bridge

Valid and fully hermetic. Testcontainers for Node.js and Rust both provide
network/host-port helpers for this pattern. It was not selected because the
route table directly tests the invariant at issue and avoids another server,
port, image, dependency, and cleanup path.

### Keep PR #159's two-internal-network probe unchanged

It prevents the rate-limit flake and proves multiple attachment, but does not
exercise the original bridge/default-route requirement. PR #161 retains its two
local sidecars and restores bridge coverage.

## Automated verification

| Check                                          | Expected result                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| JavaScript focused Docker test                 | Three pass: hermetic invariant, topology/route, missing-network cleanup. |
| Rust focused Docker test                       | Two pass: hermetic invariant and topology/route/cleanup.                 |
| JavaScript full suite, lint, format, file size | Pass.                                                                    |
| Rust full suite, formatting, Clippy            | Pass.                                                                    |
| Test-count parity and workflow invariants      | Pass.                                                                    |
| JavaScript changeset and Rust changelog gates  | Patch release fragments validate.                                        |
| Repository search for executable public probe  | Only the intentional historical reproducer/evidence may contain it.      |

Focused and full local results are retained in `data/`, and complete pre-fix and
fixed-main workflow logs provide independent before/after evidence in
`ci-logs/`. PR #161 records the final CI result for the branch.

## Operational follow-up

If end-to-end public internet egress itself must be monitored, add a separate,
clearly named smoke/canary job with retries, diagnostics, and non-release-blocking
semantics. Do not fold it back into the deterministic multi-network regression
test.
