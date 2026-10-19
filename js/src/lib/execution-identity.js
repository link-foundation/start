/**
 * Names an execution answers to (issue #231).
 *
 * An execution is found by its UUID, its backend session name, the session
 * names it used before a resume (`options.sessionNameHistory`, #162), its
 * display name (`options.name`, set by `--rename`) and its aliases
 * (`options.aliases`, added by `--alias` and `--rename`). Aliases are kept
 * apart from `sessionNameHistory` because that list names real backend
 * sessions: `--cleanup` removes those containers and `--resume` derives the
 * root session from it.
 */

function hasName(record, identifier) {
  const options = record.options || {};
  return (
    options.name === identifier ||
    (Array.isArray(options.aliases) && options.aliases.includes(identifier))
  );
}

/**
 * Resolve an identifier among stored records: UUID, then current session
 * name, then earlier session names, then display name and aliases.
 * @param {object[]} records - Stored records
 * @param {string} identifier - Any name of the execution
 * @returns {object|null} The record, or null
 */
function findRecord(records, identifier) {
  if (identifier === null || identifier === undefined || identifier === '') {
    return null;
  }
  return (
    records.find((r) => r.uuid === identifier) ||
    records.find((r) => r.options && r.options.sessionName === identifier) ||
    records.find(
      (r) =>
        r.options &&
        Array.isArray(r.options.sessionNameHistory) &&
        r.options.sessionNameHistory.includes(identifier)
    ) ||
    records.find((r) => hasName(r, identifier)) ||
    null
  );
}

/**
 * Every name the record answers to, UUID first, without duplicates.
 * @param {object} record - Execution record
 * @returns {string[]} Names
 */
function executionAliases(record) {
  const options = record.options || {};
  const names = [
    record.uuid,
    ...(options.sessionNameHistory || []),
    options.sessionName,
    ...(options.aliases || []),
    options.name,
  ].filter((name) => typeof name === 'string' && name);
  return [...new Set(names)];
}

/** True once the record has a caller-given name (`--alias`/`--rename`). */
function hasUserNames(record) {
  const options = record.options || {};
  return Boolean(options.name) || (options.aliases || []).length > 0;
}

/**
 * Run `mutate(records)` under the store's database lock and persist the
 * records it returns as changed.
 * @param {object} store - ExecutionStore
 * @param {Function} mutate - (records) => changed record, or null for none
 * @returns {*} What `mutate` returned
 */
function withStoreLock(store, mutate) {
  const { LockManager } = require('./execution-store');
  const lock = new LockManager(store.lockFilePath);
  if (!lock.acquire()) {
    throw new Error('Failed to acquire lock for database write');
  }
  try {
    const records = store.readLinoRecords();
    const changed = mutate(records);
    if (changed) {
      store.writeLinoRecords(records);
      if (store.useLinks) {
        store.writeLinksRecord(changed);
      }
    }
    return changed;
  } finally {
    lock.release();
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('The new name must not be empty');
  }
  if (name.startsWith('-')) {
    throw new Error(`Invalid name "${name}": names cannot start with "-"`);
  }
}

/**
 * Add a name to an execution (`$ --alias <id> <name>`) or rename it
 * (`$ --rename <id> <name>`, which keeps the previous display name as an
 * alias). The backend session/container keeps its name; only lookup and the
 * displayed name change.
 * @param {object} store - ExecutionStore
 * @param {string} identifier - Any current name of the execution
 * @param {string} name - Name to add
 * @param {object} [options] - {rename: boolean}
 * @returns {{success: boolean, output?: string, error?: string}}
 */
function nameExecution(store, identifier, name, options = {}) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }
  try {
    validateName(name);
    let unchanged = false;
    const record = withStoreLock(store, (records) => {
      const target = findRecord(records, identifier);
      if (!target) {
        throw new Error(
          `No execution found with UUID or session name: ${identifier}`
        );
      }
      const owner = findRecord(records, name);
      if (owner && owner.uuid !== target.uuid) {
        throw new Error(
          `Name "${name}" already refers to execution ${owner.uuid}`
        );
      }
      const opts = (target.options = target.options || {});
      const aliases = [...(opts.aliases || [])];
      if (options.rename) {
        const previous = opts.name || opts.sessionName || target.uuid;
        if (previous === name) {
          unchanged = true;
          return null;
        }
        // A session name or UUID still resolves on its own; an earlier
        // display name has to become an alias to keep resolving.
        if (opts.name) {
          aliases.push(previous);
        }
        opts.name = name;
      } else if (owner) {
        unchanged = true;
        return null;
      } else {
        aliases.push(name);
      }
      opts.aliases = [...new Set(aliases)].filter((a) => a !== opts.name);
      if (opts.aliases.length === 0) {
        delete opts.aliases;
      }
      return target;
    });
    const current = record || store.get(identifier);
    const action = options.rename ? 'Renamed' : 'Aliased';
    return {
      success: true,
      output: `${unchanged ? 'Unchanged' : action} execution ${current.uuid}\naliases: [${executionAliases(current).join(', ')}]`,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  executionAliases,
  findRecord,
  hasUserNames,
  nameExecution,
  withStoreLock,
};
