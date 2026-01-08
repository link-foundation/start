/**
 * Docker utilities for the start-command CLI
 *
 * Provides Docker-related helper functions like detecting the default
 * Docker image based on the host operating system, checking if images
 * exist locally, and pulling images with virtual command visualization.
 */

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

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

/**
 * Check if a Docker image exists locally
 * @param {string} image - Docker image name
 * @returns {boolean} True if image exists locally
 */
function dockerImageExists(image) {
  try {
    execSync(`docker image inspect ${image}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image with output streaming
 * Displays the pull operation as a virtual command in the timeline
 * @param {string} image - Docker image to pull
 * @returns {{success: boolean, output: string}} Pull result
 */
function dockerPullImage(image) {
  const {
    createVirtualCommandBlock,
    createVirtualCommandResult,
    createTimelineSeparator,
  } = require('./output-blocks');

  // Print the virtual command line followed by empty line for visual separation
  console.log(createVirtualCommandBlock(`docker pull ${image}`));
  console.log();

  let output = '';
  let success = false;

  try {
    // Run docker pull with inherited stdio for real-time output
    const result = spawnSync('docker', ['pull', image], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    success = result.status === 0;

    if (result.stdout) {
      output = result.stdout.toString();
    }
    if (result.stderr) {
      output += result.stderr.toString();
    }
  } catch (err) {
    console.error(`Failed to run docker pull: ${err.message}`);
    output = err.message;
    success = false;
  }

  // Print result marker and separator (no empty line needed - already printed after command)
  console.log(createVirtualCommandResult(success));
  console.log(createTimelineSeparator());

  return { success, output };
}

/**
 * Check if Docker is available (command exists and daemon is running)
 * @returns {boolean} True if Docker is available
 */
function isDockerAvailable() {
  try {
    execSync('docker info', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the Docker daemon can run Linux container images
 * On Windows with Docker Desktop in Windows containers mode,
 * Linux images like alpine:latest cannot be pulled or run.
 * @returns {boolean} True if Linux Docker images can be run
 */
function canRunLinuxDockerImages() {
  if (!isDockerAvailable()) {
    return false;
  }

  try {
    // On Windows, check if Docker is configured for Linux containers
    if (process.platform === 'win32') {
      try {
        const osType = execSync('docker info --format "{{.OSType}}"', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();

        // Docker must be using Linux containers to run Linux images
        return osType === 'linux';
      } catch {
        // If we can't determine the OS type, assume Linux images won't work on Windows
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getDefaultDockerImage,
  dockerImageExists,
  dockerPullImage,
  isDockerAvailable,
  canRunLinuxDockerImages,
};
