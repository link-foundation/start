---
'start-command': minor
---

feat: Use OS-matched default Docker image when --image is not specified

When using `$ --isolated docker -- command`, instead of requiring the `--image` option,
the system now automatically selects an appropriate default Docker image based on the
host operating system:

- macOS/Windows: `alpine:latest` (lightweight, portable)
- Ubuntu: `ubuntu:latest`
- Debian: `debian:latest`
- Arch Linux: `archlinux:latest`
- Fedora: `fedora:latest`
- CentOS/RHEL: `centos:latest`
- Other Linux/Fallback: `alpine:latest`

This allows users to use Docker isolation with a simple command like:
`$ --isolated docker -- echo 'hi'`

Fixes #62
