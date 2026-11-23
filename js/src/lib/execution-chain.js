/**
 * Continuation chains (issue #231): a launch with `--continues <id>` stores
 * the UUID it continues, so a supervisor that relaunches fresh instead of
 * `--resume`-ing in place can still treat every execution of one task as a
 * whole. `--status` prints the chain and `--upload-log` uploads one stream with
 * every execution of it, oldest first.
 */
const fs = require('fs');
const { executionAliases, hasUserNames } = require('./execution-identity');

/**
 * UUIDs of the chain `record` belongs to, oldest first. Backward links come
 * from `continues`; forward, the most recently started record that continues
 * the current one is followed. Cycles stop the walk.
 * @param {object[]} records - Stored records
 * @param {object} record - Any member of the chain
 * @returns {object[]} Records of the chain, oldest first
 */
function buildChain(records, record) {
  const seen = new Set([record.uuid]);
  const chain = [record];
  for (let cur = record; cur.continues;) {
    const prev = records.find((r) => r.uuid === cur.continues);
    if (!prev || seen.has(prev.uuid)) {
      break;
    }
    seen.add(prev.uuid);
    chain.unshift(prev);
    cur = prev;
  }
  for (let cur = record; ;) {
    const next = records
      .filter((r) => r.continues === cur.uuid && !seen.has(r.uuid))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0];
    if (!next) {
      break;
    }
    seen.add(next.uuid);
    chain.push(next);
    cur = next;
  }
  return chain;
}

/**
 * Resolve `--continues <id>` for a new launch to the UUID it stores.
 * @param {object|null} store - ExecutionStore
 * @param {string} identifier - Any name of the earlier execution
 * @param {string} sessionId - UUID of the new launch
 * @returns {string} UUID of the continued execution
 * @throws {Error} When it cannot be resolved
 */
function resolveContinues(store, identifier, sessionId) {
  if (!store) {
    throw new Error('--continues requires execution tracking.');
  }
  const target = store.get(identifier);
  if (!target) {
    throw new Error(
      `No execution found with UUID or session name: ${identifier}`
    );
  }
  if (target.uuid === sessionId) {
    throw new Error(`Execution ${sessionId} cannot continue itself`);
  }
  return target.uuid;
}

/**
 * Wrap a status record so `toObject()` also reports the names it answers to
 * (`aliases`, once `--alias`/`--rename` gave it one) and its continuation
 * `chain`, right after `uuid`.
 * @param {object} record - Record-like object with toObject()
 * @param {object|null} store - ExecutionStore
 * @returns {object} The record, or a wrapper with the extra fields
 */
function attachIdentity(record, store) {
  const aliases = hasUserNames(record) ? executionAliases(record) : null;
  const chain =
    store &&
    (record.continues ||
      store.getAll().some((r) => r.continues === record.uuid))
      ? buildChain(store.getAll(), record).map((r) => r.uuid)
      : null;
  if (!aliases && !(chain && chain.length > 1)) {
    return record;
  }
  const wrapped = Object.create(Object.getPrototypeOf(record));
  Object.assign(wrapped, record);
  const source = record.toObject.bind(record);
  wrapped.toObject = function () {
    const ordered = {};
    for (const [key, value] of Object.entries(source())) {
      ordered[key] = value;
      if (key === 'uuid') {
        if (aliases) {
          ordered.aliases = aliases;
        }
        if (chain && chain.length > 1) {
          ordered.chain = chain;
        }
      }
    }
    return ordered;
  };
  return wrapped;
}

/**
 * Text-format lines for the identity fields of a status object.
 * @param {object} obj - Output of toObject()
 * @returns {string[]} Lines
 */
function identityTextLines(obj) {
  return [
    ...(obj.aliases ? [`Aliases:           ${obj.aliases.join(', ')}`] : []),
    ...(obj.continues ? [`Continues:         ${obj.continues}`] : []),
    ...(obj.chain ? [`Chain:             ${obj.chain.join(' -> ')}`] : []),
  ];
}

/** Stream the continuation logs, oldest first, with their lifecycle headers. */
async function* streamChainLog(chain) {
  for (const [index, record] of chain.entries()) {
    const header = {
      event: 'continuation',
      uuid: record.uuid,
      chainIndex: index + 1,
      chainLength: chain.length,
      continues: record.continues || null,
      command: record.command,
      startTime: record.startTime,
      logPath: record.logPath || null,
    };
    yield Buffer.from(
      `\n[Start Command Lifecycle] ${JSON.stringify(header)}\n`
    );
    try {
      if (!record.logPath) {
        yield Buffer.from(`Log file not found: ${record.logPath}\n`);
        continue;
      }
      if (!(await fs.promises.stat(record.logPath)).isFile()) {
        throw new Error('Expected a regular file');
      }
      yield* fs.createReadStream(record.logPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const { SanitizationError } = require('./log-sanitizer');
        throw new SanitizationError('ERR_SOURCE');
      }
      yield Buffer.from(`Log file not found: ${record.logPath}\n`);
    }
  }
}

module.exports = {
  attachIdentity,
  buildChain,
  identityTextLines,
  resolveContinues,
  streamChainLog,
};
