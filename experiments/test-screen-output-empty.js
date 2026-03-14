// Simulate what happens if screen session exits BEFORE first poll check
// i.e. test the race condition where the session is gone before we even start polling
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const sessionName = `screen-test-race-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const logFile = os.tmpdir() + `/screen-output-${sessionName}.log`;
const shell = '/bin/bash';
const shellArg = '-c';
const command = 'echo test-version-output';

// Modern screen path (>= 4.5.1)
const screenArgs = ['-dmS', sessionName, '-L', '-Logfile', logFile, shell, shellArg, command];

console.log(`Testing native log capture: screen ${screenArgs.join(' ')}`);

const result = spawnSync('screen', screenArgs, { stdio: 'inherit' });
if (result.error) {
  console.error('Error:', result.error);
  process.exit(1);
}

// Immediately (no delay) check if session is gone 
try {
  const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (!sessions.includes(sessionName)) {
    console.log('Session already gone immediately after start!');
    // Read the log file immediately
    try {
      const output = fs.readFileSync(logFile, 'utf8');
      console.log(`Immediate read: "${output.trim()}"`);
    } catch(e) {
      console.log(`Log file not yet available: ${e.message}`);
    }
  } else {
    console.log('Session still running...');
  }
} catch {
  console.log('screen -ls failed (no sessions)');
  try {
    const output = fs.readFileSync(logFile, 'utf8');
    console.log(`Immediate read after -ls failure: "${output.trim()}"`);
  } catch(e) {
    console.log(`Log file not yet available: ${e.message}`);
  }
}

// After 200ms
setTimeout(() => {
  try {
    const output = fs.readFileSync(logFile, 'utf8');
    console.log(`After 200ms: "${output.trim()}"`);
  } catch(e) {
    console.log(`After 200ms - log not found: ${e.message}`);
  }
  try { fs.unlinkSync(logFile); } catch {}
}, 200);
