---
'start-command': minor
---

feat: Improve output block uniformity and add OS-based Docker image detection

- Move isolation info lines into start block instead of printing them separately
- Move exit/result messages into finish block instead of printing them separately
- Add getDefaultDockerImage() to detect host OS and select matching Docker image
- Default Docker images: ubuntu, debian, archlinux, fedora, centos based on host OS
