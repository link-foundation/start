/**
 * Docker utilities for the start-command CLI
 *
 * Provides Docker-related helper functions like detecting the default
 * Docker image based on the host operating system.
 */

const fs = require('fs');

/**
 * Get the default Docker image based on the host operating system
 * Returns an image that matches the current OS as closely as possible:
 * - macOS: Uses alpine (since macOS cannot run in Docker)
 * - Ubuntu/Debian: Uses ubuntu:latest
 * - Arch Linux: Uses archlinux:latest
 * - Other Linux: Uses the detected distro or alpine as fallback
 * - Windows: Uses alpine (Windows containers have limited support)
 * @returns {string} Docker image name
 */
function getDefaultDockerImage() {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS cannot run in Docker containers, use alpine as lightweight alternative
    return 'alpine:latest';
  }

  if (platform === 'win32') {
    // Windows containers have limited support, use alpine for Linux containers
    return 'alpine:latest';
  }

  if (platform === 'linux') {
    // Try to detect the Linux distribution
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');

      // Check for Ubuntu
      if (
        osRelease.includes('ID=ubuntu') ||
        osRelease.includes('ID_LIKE=ubuntu') ||
        osRelease.includes('ID_LIKE=debian ubuntu')
      ) {
        return 'ubuntu:latest';
      }

      // Check for Debian
      if (
        osRelease.includes('ID=debian') ||
        osRelease.includes('ID_LIKE=debian')
      ) {
        return 'debian:latest';
      }

      // Check for Arch Linux
      if (osRelease.includes('ID=arch') || osRelease.includes('ID_LIKE=arch')) {
        return 'archlinux:latest';
      }

      // Check for Fedora
      if (osRelease.includes('ID=fedora')) {
        return 'fedora:latest';
      }

      // Check for CentOS/RHEL
      if (
        osRelease.includes('ID=centos') ||
        osRelease.includes('ID=rhel') ||
        osRelease.includes('ID_LIKE=rhel')
      ) {
        return 'centos:latest';
      }

      // Check for Alpine
      if (osRelease.includes('ID=alpine')) {
        return 'alpine:latest';
      }
    } catch {
      // Cannot read /etc/os-release, fall through to default
    }
  }

  // Default fallback: use alpine as a lightweight, universal option
  return 'alpine:latest';
}

module.exports = {
  getDefaultDockerImage,
};
