#!/usr/bin/env node

/**
 * Interop shim for `await use('command-stream')` (issue #168).
 *
 * `use-m` unwraps a CommonJS module only when the namespace it gets back from
 * `import()` carries nothing but `default`:
 *
 *   if (keys.length === 1 && keys[0] === 'default') return module.default;
 *
 * Node >= 22.12 broke that assumption. When `cjs-module-lexer` cannot infer
 * the named exports of a CommonJS file — which is the case for
 * `command-stream`'s `src/$.cjs`, whose exports are assigned dynamically —
 * Node adds a second named export called `module.exports`:
 *
 *   node v20.20.2  import('.../$.cjs') -> [Module] { default }
 *   node v24.19.0  import('.../$.cjs') -> [Module] { default, 'module.exports' }
 *
 * With two keys `use-m` returns the raw namespace, so `const { $ } = await
 * use('command-stream')` yields `undefined` and the first template literal
 * fails with `$ is not a function`. That is exactly what killed the release
 * jobs of runs 33734680882/33734680890, 33740815350/33740815303 and
 * 33746569769/33746569750 on `main`, all of which run on Node 24.
 *
 * This module normalises every shape we have observed, so the scripts work on
 * Node 20, Node 22, Node 24 and Bun alike, and fails with an actionable error
 * (listing the keys it did see) instead of `$ is not a function`.
 *
 * Set START_DEBUG=1 (or re-run the job with GitHub debug logging) to print the
 * shape that was actually resolved. The default state is off.
 */

import { debug } from "./debug-print.mjs";

/**
 * Candidate containers for the real module object, in resolution order.
 * `module.exports` is the Node >= 22.12 named export described above.
 */
function candidates(loaded) {
  return [
    loaded,
    loaded?.default,
    loaded?.["module.exports"],
    loaded?.default?.default,
  ];
}

function describe(loaded) {
  if (loaded === null || loaded === undefined) {
    return String(loaded);
  }
  const keys = Object.keys(loaded);
  return `${typeof loaded} with keys [${keys.join(", ")}]`;
}

/**
 * Pick the object that actually carries `exportName` out of whatever `use-m`
 * returned for `moduleName`.
 *
 * @param {unknown} loaded value returned by `await use(moduleName)`
 * @param {string} exportName named export the caller needs
 * @param {string} moduleName package name, used for the error message only
 * @returns {Record<string, unknown>} object exposing `exportName`
 */
export function resolveNamedExport(loaded, exportName, moduleName) {
  for (const candidate of candidates(loaded)) {
    if (candidate && typeof candidate[exportName] === "function") {
      debug(`resolved ${moduleName}.${exportName}`, {
        received: describe(loaded),
        via: candidate === loaded ? "namespace" : "unwrapped",
      });
      return candidate;
    }
  }
  throw new Error(
    `use('${moduleName}') did not expose a callable "${exportName}". ` +
      `Received ${describe(loaded)}. This usually means the CommonJS interop ` +
      `of use-m did not unwrap the module (see scripts/load-command-stream.mjs).`
  );
}

/**
 * Load `command-stream` through `use-m` and return its exports with `$`
 * guaranteed to be callable.
 *
 * @param {(name: string) => Promise<unknown>} use the `use` function from use-m
 * @returns {Promise<Record<string, unknown>>} command-stream exports
 */
export async function loadCommandStream(use) {
  const loaded = await use("command-stream");
  return resolveNamedExport(loaded, "$", "command-stream");
}
