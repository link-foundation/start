/** Attempt-scoped evidence for logical executions sharing a UUID and log. */
const fs = require('fs');
const { appendLogFile, readLogTail } = require('./isolation-log-utils');

const TERMINAL_FIELDS = [
  'endTimeSource',
  'observedAt',
  'staleDetectedAt',
  'containerStartedAt',
  'exitReason',
  'oomKilled',
  'memoryExhausted',
  'memoryExhaustedReason',
  'cgroupMemory',
];

function activityPath(record) {
  return `${record.logPath}.attempt-${record.attempt.number}.activity`;
}

function readAttemptActivity(record) {
  if (!record.attempt || !record.logPath) {
    return record;
  }
  let fd;
  try {
    fd = fs.openSync(activityPath(record), 'r');
    const buffer = Buffer.alloc(128);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const at = buffer.subarray(0, length).toString().trim();
    if (
      Number.isFinite(Date.parse(at)) &&
      Date.parse(at) >= Date.parse(record.attempt.startedAt)
    ) {
      record.attempt = { ...record.attempt, lastOutputAt: at };
    }
  } catch {
    // Quiet, missing, or unreadable output is not evidence of task progress.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  return record;
}

function createAttempt(record, plan) {
  let logOffset = null;
  if (record.logPath) {
    try {
      logOffset = fs.statSync(record.logPath).size;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logOffset = 0;
      }
    }
  }
  return {
    number:
      (record.attempt?.number ||
        (Number(record.options?.resumeCount) || 0) +
          (Number(record.options?.recoveryAttempts) || 0) +
          1) + 1,
    startedAt: new Date().toISOString(),
    logOffset,
    lastOutputAt: null,
    launchAcceptedAt: null,
    watcherAttachedAt: null,
    mode: plan.mode,
    previousSessionName: record.options?.sessionName || null,
    sessionName: plan.newSessionName || plan.sessionName,
  };
}

function archiveAttempt(record) {
  readAttemptActivity(record);
  const snapshot = {
    ...(record.attempt || {
      number:
        (Number(record.options?.resumeCount) || 0) +
        (Number(record.options?.recoveryAttempts) || 0) +
        1,
      startedAt: record.options?.resumedAt || record.startTime,
      logOffset: null,
    }),
    command: record.command,
    sessionName: record.options?.sessionName || null,
    containerId: record.options?.containerId || null,
    containerError: record.options?.containerError || null,
    status: record.status,
    exitCode: record.exitCode,
    endTime: record.endTime,
  };
  for (const field of TERMINAL_FIELDS) {
    if (record[field] !== undefined) {
      snapshot[field] = record[field];
    }
    record[field] = undefined;
  }
  record.attemptHistory = [...(record.attemptHistory || []), snapshot];
  delete record.options.containerError;
}

function appendLifecycle(record, event, details = {}) {
  if (!record.logPath || !record.attempt) {
    return;
  }
  appendLogFile(
    record.logPath,
    `\n[Start Command Lifecycle] ${JSON.stringify({
      event,
      at: new Date().toISOString(),
      uuid: record.uuid,
      attemptNumber: record.attempt.number,
      ...record.attempt,
      ...details,
    })}\n`
  );
}

function patchAttempt(store, record, fields) {
  if (typeof store.patchAttempt === 'function') {
    return store.patchAttempt(record.uuid, record.attempt.number, fields);
  }
  // Compatibility for consumers injecting a minimal in-memory store.
  const current = store.get(record.uuid) || record;
  if (current.attempt?.number !== record.attempt.number) {
    return null;
  }
  current.attempt = { ...current.attempt, ...fields };
  store.save(current);
  return current;
}

function readAttemptLogTail(record, bytes) {
  if (
    !record.logPath ||
    (record.attempt && record.attempt.logOffset === null)
  ) {
    return null;
  }
  return readLogTail(record.logPath, bytes, record.attempt?.logOffset || 0);
}

module.exports = {
  activityPath,
  appendLifecycle,
  archiveAttempt,
  createAttempt,
  patchAttempt,
  readAttemptActivity,
  readAttemptLogTail,
};
