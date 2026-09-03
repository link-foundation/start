/**
 * Repository-level ESLint configuration (issue #168).
 *
 * `js/eslint.config.mjs` has `js/` as its base path, so `eslint .` run from
 * `js/` silently skips the repository-level `scripts/` directory - the release
 * automation, i.e. the code that broke in runs 33746569750/33746569769. The
 * CI/CD templates keep a single config at the repository root for exactly this
 * reason; this file restores that coverage without duplicating the rules.
 */

import jsConfig from './js/eslint.config.mjs';

export default [
  ...jsConfig,
  {
    ignores: [
      // Linted by `bun run lint` inside js/, with js/ as the base path.
      'js/**',
      'rust/**',
      // Throwaway reproduction scripts; kept as evidence, not as shipped code.
      'experiments/**',
      // Collected CI logs and analysis artefacts.
      'dev/**',
      'node_modules/**',
    ],
  },
];
