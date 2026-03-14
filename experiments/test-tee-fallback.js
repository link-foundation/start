// Test to simulate the tee fallback path (older screen < 4.5.1)
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionName = `screen-test-tee-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
const logFile = path.join(os.tmpdir(), `screen-output-${sessionName}.log`);
const shell = '/bin/bash';
const shellArg = '-c';
const command = 'echo test-version-output';

// Tee fallback (older screen path)
const effectiveCommand = `(${command}) 2>&1 | tee "${logFile}"`;
const screenArgs = ['-dmS', sessionName, shell, shellArg, effectiveCommand];

console.log(`Testing tee fallback: screen ${screenArgs.join(' ')}`);
console.log(`Logfile: ${logFile}`);

const result = spawnSync('screen', screenArgs, { stdio: 'inherit' });
if (result.error) {
  console.error('Error spawning screen:', result.error);
  process.exit(1);
}

// Poll for session completion
const checkInterval = 100;
let waited = 0;
const maxWait = 5000;

function checkCompletion() {
  try {
    const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (!sessions.includes(sessionName)) {
      let output = '';
      try {
        output = fs.readFileSync(logFile, 'utf8');
        console.log(`\nOutput captured: "${output.trim()}"`);
        if (!output.trim()) {
          console.log('WARNING: No output captured!');
        }
      } catch (e) {
        console.log(`\nLog file not found or empty: ${e.message}`);
      }
      try { fs.unlinkSync(logFile); } catch {}
      return;
    }
    waited += checkInterval;
    if (waited >= maxWait) {
      console.log('Timeout waiting for session');
      return;
    }
    setTimeout(checkCompletion, checkInterval);
  } catch {
    let output = '';
    try {
      output = fs.readFileSync(logFile, 'utf8');
      console.log(`\nOutput captured (screen -ls failed): "${output.trim()}"`);
    } catch (e) {
      console.log(`\nLog file not found: ${e.message}`);
    }
    try { fs.unlinkSync(logFile); } catch {}
  }
}

setTimeout(checkCompletion, checkInterval);
