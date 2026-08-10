# Online research and component survey

Research was performed on 2026-08-10. Primary/official sources were preferred.

## Facts used in the diagnosis

- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)
  documents that unauthenticated requests are associated with the originating IP
  and limited to 60 requests per hour. This directly explains why a source-IP
  quota can change independently of the test code.
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  documents the broad Azure address ranges used by standard Ubuntu/Windows
  runners and recommends larger runners with static ranges or self-hosted
  runners when static addressing is needed. A normal runner should not be
  treated as having a dedicated stable egress identity.
- [GitHub Actions job dependencies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)
  documents that downstream jobs are skipped when a required job fails or is
  skipped. This explains why the failed test prevented the JS release job.
- [Docker bridge networking](https://docs.docker.com/engine/network/drivers/bridge/)
  documents that the default bridge supplies masqueraded external access and
  that user-defined bridges isolate unrelated networks.
- [`docker network create --internal`](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal)
  documents that an internal network allows members to communicate but does not
  configure an external default route. This supports testing the private aliases
  locally and checking the bridge route separately.
- [Bazel's hermeticity guidance](https://bazel.build/concepts/hermeticity)
  describes self-contained builds/tests that do not rely on services external
  to the build environment. The selected design follows that principle.

## Why `example.com` was not selected

- [RFC 2606](https://www.rfc-editor.org/info/rfc2606/) reserves `example.com`,
  `example.net`, and `example.org` for examples and documentation.
- [IANA's example-domain guidance](https://www.iana.org/help/example-domains)
  says the HTTP service is best effort and explicitly warns against designing
  applications that require it. Reservation avoids ownership surprises; it is
  not a service-level guarantee.

Therefore `example.com` is appropriate in prose and sample configuration, but
not as a required success dependency for a release gate.

## Existing components/libraries evaluated

- [Testcontainers for Node.js networking](https://node.testcontainers.org/features/networking/)
  supports temporary networks, aliases, bridge mode, and exposing host ports to
  containers.
- [Testcontainers for Rust networking](https://rust.testcontainers.org/features/networking/)
  supports temporary container/host connectivity and scoped port exposure.

Either library could host a local HTTP responder if payload-level traffic were
required. The repository already has small, symmetric Docker CLI helpers and
cleanup guards in both languages, so adding two new dependency stacks would be
disproportionate for a route-existence assertion.

BusyBox tools already present in `alpine:3.23` are sufficient: `ping` verifies
network-scoped aliases, and `ip route` verifies the retained default route.
`docker logs` supplies failure evidence. No new runtime or test dependency is
needed.
