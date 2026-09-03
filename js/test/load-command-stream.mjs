import { describe, expect, it } from 'bun:test';

import {
  loadCommandStream,
  resolveNamedExport,
} from '../../scripts/load-command-stream.mjs';

const $ = () => {};

/**
 * Namespace shape produced by `import()` of a CommonJS file on Node < 22.12,
 * before `use-m` unwraps it. use-m returns `default` here, so `const { $ }`
 * works.
 */
const NODE_20_NAMESPACE = { default: Object.assign($, { $, exec: () => {} }) };

/**
 * Same file on Node >= 22.12. Node adds a `module.exports` named export when
 * cjs-module-lexer cannot infer the real names, so use-m sees two keys, skips
 * the unwrap and hands the raw namespace to the caller (issue #168).
 */
const NODE_24_NAMESPACE = {
  default: Object.assign($, { $, exec: () => {} }),
  'module.exports': Object.assign($, { $, exec: () => {} }),
};

/** Shape use-m returns when it did unwrap: the `$` function itself. */
const UNWRAPPED = Object.assign($, { $, exec: () => {} });

describe('load-command-stream', () => {
  it('reproduces the Node 24 namespace that broke the release jobs', () => {
    // Regression guard for the actual failure: destructuring the raw
    // namespace yields undefined, hence "$ is not a function".
    const { $: destructured } = NODE_24_NAMESPACE;
    expect(destructured).toBeUndefined();
  });

  it('resolves $ from the Node >= 22.12 CommonJS namespace', () => {
    expect(typeof resolveNamedExport(NODE_24_NAMESPACE, '$', 'x').$).toBe(
      'function'
    );
  });

  it('resolves $ from the Node < 22.12 CommonJS namespace', () => {
    expect(typeof resolveNamedExport(NODE_20_NAMESPACE, '$', 'x').$).toBe(
      'function'
    );
  });

  it('resolves $ when use-m already unwrapped the module', () => {
    expect(typeof resolveNamedExport(UNWRAPPED, '$', 'x').$).toBe('function');
  });

  it('resolves $ from an ESM namespace with named exports', () => {
    const namespace = { $, exec: () => {}, default: $ };
    expect(typeof resolveNamedExport(namespace, '$', 'x').$).toBe('function');
  });

  it('throws an actionable error instead of "$ is not a function"', () => {
    expect(() =>
      resolveNamedExport({ nope: 1 }, '$', 'command-stream')
    ).toThrow(
      /use\('command-stream'\) did not expose a callable "\$".*keys \[nope\]/s
    );
  });

  it('reports the received value when use-m resolved nothing', () => {
    expect(() => resolveNamedExport(undefined, '$', 'command-stream')).toThrow(
      /Received undefined/
    );
  });

  it('loads command-stream through an injected use() implementation', async () => {
    const calls = [];
    const use = async (name) => {
      calls.push(name);
      return NODE_24_NAMESPACE;
    };
    const module = await loadCommandStream(use);
    expect(calls).toEqual(['command-stream']);
    expect(typeof module.$).toBe('function');
  });
});
