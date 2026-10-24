/**
 * Issue #253: the links database was never written. clink 4.x rejected every
 * query the store built (unbalanced parentheses, `\"` escapes, references to
 * links it would not create), and the failures were only logged. These tests
 * pin the query shape and, where clink is installed, run it for real.
 */
const { describe, it, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ExecutionStore,
  ExecutionRecord,
  isClinkInstalled,
  clinkReference,
} = require('../src/lib/execution-store');

const UUID = '4df9d19e-da50-4a7b-9e97-2c4f15b35a88';

function withStore(options, fn) {
  const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'start-253-clink-'));
  try {
    return fn(new ExecutionStore({ appFolder, ...options }));
  } finally {
    fs.rmSync(appFolder, { recursive: true, force: true });
  }
}

function countParens(text) {
  let depth = 0;
  let inQuote = false;
  for (const char of text) {
    if (char === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && char === '(') {
      depth++;
    } else if (!inQuote && char === ')') {
      depth--;
      if (depth < 0) {
        return depth;
      }
    }
  }
  return depth;
}

describe('clinkReference (#253)', () => {
  it('quotes text and doubles inner quotes', () => {
    expect(clinkReference('plain')).toBe('"plain"');
    expect(clinkReference(`say "hi"`)).toBe('"say ""hi"""');
    expect(clinkReference('back\\slash')).toBe('"back\\slash"');
  });
});

describe('ExecutionStore.buildClinkCreateQuery (#253)', () => {
  it('builds one balanced create group with record-scoped property links', () => {
    withStore({ useLinks: false }, (store) => {
      const record = new ExecutionRecord({
        uuid: UUID,
        command: `echo "a" (b)`,
        pid: 4242,
        exitCode: 0,
        options: { isolated: 'docker' },
      });
      const query = store.buildClinkCreateQuery(record);

      expect(countParens(query)).toBe(0);
      expect(query.startsWith(`() ((${UUID}: ExecutionRecord ${UUID}) `)).toBe(
        true
      );
      expect(query).toContain(
        `(${UUID}.command: ${UUID} "command=echo ""a"" (b)")`
      );
      // Numbers carry their key, so clink never reads them as link addresses
      expect(query).toContain(`(${UUID}.exitCode: ${UUID} "exitCode=0")`);
      expect(query).toContain(`(${UUID}.pid: ${UUID} "pid=4242")`);
      expect(query).toContain(
        `(${UUID}.options: ${UUID} "options={""isolated"":""docker""}")`
      );
      expect(query).not.toContain('\\"');
    });
  });
});

describe('ExecutionStore links database with clink (#253)', () => {
  const clink = isClinkInstalled();

  it.skipIf(!clink)(
    'saves, updates and deletes records that share values',
    () => {
      withStore({}, (store) => {
        expect(store.useLinks).toBe(true);
        const first = new ExecutionRecord({
          command: `echo 'it''s' "quoted" (x) \\ done`,
          pid: 4242,
          options: { isolated: 'docker' },
        });
        // Same status, pid and options: the property links must not collide
        const second = new ExecutionRecord({
          command: 'echo second',
          pid: 4242,
          options: { isolated: 'docker' },
        });

        expect(store.writeLinksRecord(first)).toBe(true);
        expect(store.writeLinksRecord(second)).toBe(true);

        store.save(first);
        store.save(second);
        let consistency = store.verifyConsistency();
        expect(consistency.errors).toEqual([]);
        expect(consistency.linksCount).toBe(2);

        first.complete(3);
        store.save(first);
        const links = store.execClink('((($id: $s $t)) (($id: $s $t)))', [
          '--changes',
        ]).output;
        expect(links).toContain(
          `${first.uuid}.status: ${first.uuid} status=executed`
        );
        expect(links).not.toContain(
          `${first.uuid}.status: ${first.uuid} status=executing`
        );
        expect(links).toContain(
          `${second.uuid}.status: ${second.uuid} status=executing`
        );
        expect(links).toContain(
          `${first.uuid}.exitCode: ${first.uuid} exitCode=3`
        );

        expect(store.delete(first.uuid)).toBe(true);
        consistency = store.verifyConsistency();
        expect(consistency.errors).toEqual([]);
        expect(consistency.linksCount).toBe(1);
        const remaining = store.execClink('((($id: $s $t)) (($id: $s $t)))', [
          '--changes',
        ]).output;
        expect(remaining).not.toContain(`${first.uuid}.`);
        expect(remaining).toContain(`${second.uuid}.command`);
      });
    },
    60000
  );
});
