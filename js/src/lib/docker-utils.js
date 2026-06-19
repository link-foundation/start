/**
 * Docker utilities for the start-command CLI
 *
 * Provides Docker-related helper functions like detecting the default
 * Docker image based on the host operating system, checking if images
 * exist locally, and pulling images with virtual command visualization.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
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
 * Run `docker pull <image>` while teeing its output to the session log file.
 *
 * When a logPath is given (and tee is available, i.e. non-Windows), the pull
 * output is streamed to BOTH the console and the log file in real time so the
 * image-preparation phase is captured in the single session log (issue #138).
 * docker's own exit code is recovered via a sentinel status file because the
 * exit status of a `cmd | tee` pipeline reflects tee, not docker.
 *
 * Without a logPath (or on Windows), it falls back to the previous behavior:
 * inherited stdio for real-time console output, with no log capture.
 *
 * @param {string} image - Docker image to pull
 * @param {string|null} logPath - Session log file to append pull output to
 * @returns {{status: number, error?: Error}} Spawn result (status = docker exit code)
 */
function runDockerPull(image, logPath) {
  const { shellQuote } = require('./isolation-log-utils');

  // Without a log target (or on Windows where tee is unreliable), keep the
  // original inherited-stdio behavior for fancy real-time console output.
  if (!logPath || process.platform === 'win32') {
    return spawnSync('docker', ['pull', image], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }

  // Tee docker pull output to both the console and the log file. docker writes
  // to a pipe here, so it emits plain progress lines (ideal for a log). The
  // sentinel file captures docker's real exit code (the pipeline's own exit
  // status would be tee's).
  const statusFile = path.join(
    os.tmpdir(),
    `start-docker-pull-${process.pid}-${Date.now()}.status`
  );
  try {
    const pipeline =
      `{ docker pull ${shellQuote(image)} 2>&1; echo $? > ${shellQuote(statusFile)}; } ` +
      `| tee -a ${shellQuote(logPath)}`;
    const result = spawnSync('sh', ['-c', pipeline], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (result.error) {
      return result;
    }
    let status = result.status;
    try {
      const recorded = fs.readFileSync(statusFile, 'utf8').trim();
      if (recorded !== '') {
        status = parseInt(recorded, 10);
      }
    } catch {
      // Sentinel missing (e.g. sh/tee failed before docker ran); keep pipeline status.
    }
    return { ...result, status };
  } finally {
    try {
      fs.unlinkSync(statusFile);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Pull a Docker image with output streaming
 * Displays the pull operation as a virtual command in the timeline.
 *
 * When a logPath is provided, the image-preparation phase (the `docker pull`)
 * is also recorded in the session log so the single log file is a gap-free
 * record of everything that ran (issue #138): a `Preparing image …` marker with
 * a timestamp is written before the pull, the pull output is teed into the log,
 * and an `Image ready (<duration>)` marker is written afterwards.
 *
 * @param {string} image - Docker image to pull
 * @param {string|null} logPath - Optional session log file to append output to
 * @returns {{success: boolean, output: string}} Pull result
 */
function dockerPullImage(image, logPath = null) {
  const {
    createVirtualCommandBlock,
    createVirtualCommandResult,
    createTimelineSeparator,
  } = require('./output-blocks');
  const { appendLogFile, getTimestamp } = require('./isolation-log-utils');

  // Print the virtual command line followed by empty line for visual separation
  console.log(createVirtualCommandBlock(`docker pull ${image}`));
  console.log();

  // Record the start of the image-preparation phase in the session log so
  // operators tailing the log see progress instead of a header-only file.
  const prepStartMs = Date.now();
  if (logPath) {
    appendLogFile(
      logPath,
      `$ docker pull ${image}\nPreparing image ${image}… (${getTimestamp()})\n`
    );
  }

  let output = '';
  let success;

  try {
    const result = runDockerPull(image, logPath);
    if (result.error) {
      throw result.error;
    }

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
    if (logPath) {
      appendLogFile(logPath, `Failed to run docker pull: ${err.message}\n`);
    }
  }

  // Record the end of the image-preparation phase with elapsed duration so the
  // prep time is visible even when full progress is unavailable (issue #138).
  if (logPath) {
    const durationSec = ((Date.now() - prepStartMs) / 1000).toFixed(1);
    appendLogFile(
      logPath,
      success
        ? `Image ready (${durationSec}s)\n`
        : `Image preparation failed (${durationSec}s)\n`
    );
  }

  // Print empty line before result marker for visual separation (issue #73)
  // This ensures output is visually separated from the result marker
  console.log();
  console.log(createVirtualCommandResult(success));
  console.log(createTimelineSeparator());

  return { success, output };
}

/**
 * Check if the Docker CLI is installed (command exists, regardless of daemon state)
 * @returns {boolean} True if the docker command is found on PATH
 */
function isDockerInstalled() {
  try {
    const isWindows = process.platform === 'win32';
    const checkCmd = isWindows ? 'where' : 'which';
    execSync(`${checkCmd} docker`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
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
  isDockerInstalled,
  isDockerAvailable,
  canRunLinuxDockerImages,
};
