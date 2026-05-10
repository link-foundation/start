# Online Research

## `link-foundation/box`

Repository: https://github.com/link-foundation/box

The box repository describes itself as a Docker image containing popular
language runtimes and tools for software development environments. Relevant
images for start-command documentation:

- `ghcr.io/link-foundation/box-js:latest`: JavaScript/Bun-focused image.
- `ghcr.io/link-foundation/box:latest`: full multi-runtime image.
- `ghcr.io/link-foundation/box-dind:latest`: Docker-in-Docker variant.

The box README recommends caution for Docker-in-Docker images because they need
elevated runtime configuration. The start-command examples therefore use
ordinary box images and document the DIND caveat instead of implying that
privileged runtime flags are currently available through start-command.

## Docker

Docker run reference: https://docs.docker.com/engine/containers/run/

Docker bind mounts reference:
https://docs.docker.com/engine/storage/bind-mounts/

Relevant facts for the examples and docs:

- `docker run` creates and starts a container from an image.
- `--rm` removes the container automatically after it exits.
- Bind mounts are the standard Docker mechanism for making a host working tree
  visible inside a container when an isolated development command needs files.

## Terminal Isolation Backends

GNU Screen logging reference:
https://www.gnu.org/software/screen/manual/html_node/Log.html

tmux getting started documentation:
https://github.com/tmux/tmux/wiki/Getting-Started

Relevant facts:

- Screen and tmux are terminal multiplexers appropriate for attached and
  detached command execution.
- Their session model is different from Docker's container model, so docs should
  describe process isolation by backend rather than implying every backend has
  identical lifecycle semantics.

## Bun

Bun test documentation: https://bun.sh/docs/cli/test

Relevant facts:

- The JavaScript implementation is Bun-first.
- Package-level development examples should prefer `bun test` over `npm test`
  unless specifically demonstrating arbitrary wrapped commands.

## Sysbox

Sysbox repository: https://github.com/nestybox/sysbox

Box references Sysbox for safer Docker-in-Docker setups. Since start-command
does not currently expose Docker runtime configuration for Sysbox or privileged
DIND use, the docs avoid using DIND in runnable examples.
