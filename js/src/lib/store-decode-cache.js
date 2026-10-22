/**
 * Decoded execution store, shared within one process and between processes
 * (issue #243).
 *
 * Decoding `executions.lino` costs about 1-4 ms per record, and one
 * `--status` used to decode it up to three times (`get`, then `getAll` twice
 * for the execution chain). The file is still read on every call, so a write
 * by any process is seen at once, but it is decoded again only when its
 * content differs from the last decoded copy. The content itself is the key:
 * unlike an mtime, it cannot miss two same-size writes within one clock tick.
 *
 * A new process (every `$ --status` poll) still had to decode once. The
 * decoded records are therefore also kept as JSON next to the store, tagged
 * with the SHA-256 of the content they were decoded from; `JSON.parse` of
 * that copy is about 250 times faster than the lino decode. A copy whose
 * digest does not match the current content is ignored and replaced.
 */

const fs = require('fs');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { atomicWrite } = require('./atomic-write');

/** Format tag of the JSON copy; a different tag is ignored. */
const DECODED_COPY_FORMAT = 'start-command-decoded-store-js-1';

/** @type {Map<string, {content: string, data: *, decodes: number}>} */
const decodedStores = new Map();

function digestOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Records of the JSON copy at `copyPath`, when it was decoded from content
 * with this digest; otherwise undefined.
 */
function readDecodedCopy(copyPath, digest) {
  try {
    const copy = JSON.parse(fs.readFileSync(copyPath, 'utf8'));
    if (copy && copy.format === DECODED_COPY_FORMAT && copy.sha256 === digest) {
      return copy.records;
    }
  } catch {
    /* Missing or unreadable: decode instead. */
  }
  return undefined;
}

/**
 * Keep `data` as JSON for the next process, unless JSON cannot represent it
 * exactly. Best effort: a read-only folder only costs the next decode.
 */
function writeDecodedCopy(copyPath, digest, data) {
  try {
    const json = JSON.stringify({
      format: DECODED_COPY_FORMAT,
      sha256: digest,
      records: data,
    });
    if (!isDeepStrictEqual(JSON.parse(json).records, data)) {
      return;
    }
    atomicWrite(copyPath, json);
  } catch {
    /* Not kept; the next process decodes again. */
  }
}

/**
 * Decode `content` of the store at `filePath`, or reuse an earlier decode of
 * the same content. Every call returns its own deep copy, so callers may
 * mutate the records they get.
 * @param {string} filePath - Store file the content was read from
 * @param {string} content - Current file content
 * @param {function(string): *} decode - Decoder for a changed content
 * @param {{copyPath?: string}} [options] - JSON copy shared between processes
 * @returns {{data: *, reused: boolean, source: 'memory'|'copy'|'decode'}}
 */
function decodeStoreContent(filePath, content, decode, options = {}) {
  const cached = decodedStores.get(filePath);
  if (cached && cached.content === content) {
    return {
      data: structuredClone(cached.data),
      reused: true,
      source: 'memory',
    };
  }
  const decodes = cached ? cached.decodes : 0;
  const { copyPath } = options;
  const digest = copyPath ? digestOf(content) : null;
  const copied = copyPath ? readDecodedCopy(copyPath, digest) : undefined;
  if (copied !== undefined) {
    decodedStores.set(filePath, {
      content,
      data: structuredClone(copied),
      decodes,
    });
    return { data: copied, reused: true, source: 'copy' };
  }
  const data = decode(content);
  decodedStores.set(filePath, {
    content,
    data: structuredClone(data),
    decodes: decodes + 1,
  });
  if (copyPath) {
    writeDecodedCopy(copyPath, digest, data);
  }
  return { data, reused: false, source: 'decode' };
}

/**
 * How many times this process decoded the store at `filePath` since it was
 * last forgotten.
 * @param {string} filePath - Store file
 * @returns {number}
 */
function decodeCount(filePath) {
  const cached = decodedStores.get(filePath);
  return cached ? cached.decodes : 0;
}

/**
 * Drop the decoded copy of a store held by this process.
 * @param {string} [filePath] - Store file; all stores when omitted
 */
function forgetDecodedStore(filePath) {
  if (filePath === undefined) {
    decodedStores.clear();
  } else {
    decodedStores.delete(filePath);
  }
}

module.exports = {
  DECODED_COPY_FORMAT,
  decodeCount,
  decodeStoreContent,
  forgetDecodedStore,
};
