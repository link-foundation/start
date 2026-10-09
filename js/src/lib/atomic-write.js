/** Keep the previous database intact when a write fails, including ENOSPC. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    const handle = fs.openSync(temporary, 'r+');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}

module.exports = { atomicWrite };
