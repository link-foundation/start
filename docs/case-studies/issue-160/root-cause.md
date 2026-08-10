# Root-cause analysis

## 1. A connectivity assertion accidentally required application success

The intended claims were:

1. a container attached to an internal network can resolve/reach `formal-ai`;
2. attaching that network does not destroy the default bridge route.

The historical command added a third, unrelated claim: GitHub's anonymous REST
API must return a status that BusyBox `wget --spider` accepts. HTTP 403 is an
application-layer response. Receiving it proves the lower network layers worked,
but `wget` correctly exits nonzero and the shell's `&&` propagates that status.

The complete CI log shows the command at line 4654, the container status mismatch
at lines 4663–4677, and the named failing test at line 4680. The quiet `wget`
mode and missing `docker logs` assertion message hid the actual HTTP response in
CI; the reproduction captured `HTTP/1.1 403 rate limit exceeded`.

## 2. The endpoint has a deliberately small IP-scoped anonymous quota

GitHub documents 60 unauthenticated REST requests per hour and associates them
with the originating IP address. Standard hosted runners do not provide a
dedicated static public address; GitHub recommends larger or self-hosted runners
when static addressing is required. Consequently, unrelated use from the same
egress address can change the probe result without any repository change.

Authentication would raise the quota but would turn a network integration test
into a secret-dependent GitHub API test. It would reduce the frequency, not fix
the category error.

## 3. Two claims were collapsed into one opaque exit code

`ping ... && wget ...` returned only the final container code. The assertion
printed `'1' !== '0'`, so it could not distinguish alias resolution, bridge
routing, DNS, TLS, rate limiting, or remote availability. PR #159 fixed the
diagnostics by including container output and added off-by-default lifecycle
tracing.

PR #161 separates structural invariants conceptually while retaining one cheap
container command: two local pings prove the internal attachments, and `ip
route` proves the default route remains. The no-HTTP test fails before Docker is
needed if a public dependency is reintroduced.

## 4. The failure blocked only one language's release path

Both suites contained the same defect, but the Rust request succeeded during its
run while JavaScript failed. GitHub Actions skips jobs that depend on a failed
job, so JavaScript's build/release chain never ran. Rust published 0.19.0. This
is a classic flaky-test asymmetry: identical source can produce a green release
in one workflow and block another.

## 5. The first hermetic fix narrowed the original bridge assertion

PR #159 correctly removed all internet access, but it made the tested container's
primary network internal and attached a second internal network. That proved
repeatable attachment but no longer checked the bridge/default-route half of the
original scenario.

PR #161 closes that coverage gap without restoring an external request: the
container is created on `bridge`, attached to both internal networks, reaches
both local aliases, and verifies its route table still contains a default route.

## Root-cause chain

The feature added an external HTTP probe → the endpoint enforced an IP-scoped
quota → a valid 403 response became a nonzero `wget` status → `&&` became the
container exit status → an opaque assertion failed → the dependent JavaScript
release jobs were skipped → version 0.32.0 remained unavailable until PR #159
merged and the main workflow reran.
