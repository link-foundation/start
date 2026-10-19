/**
 * Test preload (bunfig.toml): give this test process its own Docker snapshot
 * lock. The default lock is host-wide, so a real `start --resume` or another
 * test process on the same host holding it made every snapshot-resume test
 * fail after the 1s default wait (issue #234). A path set by the caller wins,
 * so experiments can still point the tests at a shared lock.
 */
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

if (!process.env.START_SNAPSHOT_LOCK) {
  process.env.START_SNAPSHOT_LOCK = join(
    mkdtempSync(join(tmpdir(), 'start-test-snapshot-lock-')),
    'snapshot.lock'
  );
}
