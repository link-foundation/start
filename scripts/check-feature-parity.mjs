#!/usr/bin/env node
/** Feature evidence and per-feature change parity; test counts are secondary. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export function checkFeatureChanges(features, changed) {
  const errors = [];
  for (const feature of features) {
    const touches = (side) =>
      [...feature[side].implementation, ...feature[side].tests].some((path) =>
        changed.includes(path)
      );
    if (touches('javascript') !== touches('rust')) {
      errors.push(
        `${feature.id}: change the JavaScript and Rust implementations or behavioral tests together`
      );
    }
  }
  return errors;
}
function listSource(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? listSource(path, extension)
      : path.endsWith(extension)
        ? [relative(root, path).replaceAll('\\', '/')]
        : [];
  });
}
export function validateManifest(manifest) {
  const errors = [];
  const evidence = new Set();
  const ids = new Set();
  const manuals = new Set();
  const generated = JSON.parse(
    readFileSync(resolve(root, 'parity/translation.json'))
  ).generated.map((entry) => entry.rust);
  for (const feature of manifest.features || []) {
    if (!feature.id || ids.has(feature.id)) {
      errors.push(`Missing or duplicated feature id: ${feature.id}`);
    }
    ids.add(feature.id);
    for (const side of ['javascript', 'rust']) {
      for (const kind of ['implementation', 'tests']) {
        const paths = feature[side]?.[kind];
        if (!Array.isArray(paths) || !paths.length) {
          errors.push(`${feature.id}: missing ${side} ${kind} evidence`);
        }
        for (const path of paths || []) {
          if (!existsSync(resolve(root, path))) {
            errors.push(`${feature.id}: missing evidence file ${path}`);
          }
          if (kind === 'implementation') {
            evidence.add(path);
          }
        }
      }
    }
    for (const manual of feature.manualRust || []) {
      manuals.add(manual.path);
      if (
        !manual.reason ||
        !manual.blockers?.length ||
        manual.blockers.some(
          (url) =>
            !/^https:\/\/github\.com\/link-foundation\/meta-language\/issues\/\d+$/.test(
              url
            )
        )
      ) {
        errors.push(
          `${manual.path}: manual Rust requires an explicit reason and upstream issues`
        );
      }
    }
    if (feature.golden) {
      for (const key of ['fixture', 'javascriptTest', 'rustTest']) {
        if (!existsSync(resolve(root, feature.golden[key]))) {
          errors.push(`${feature.id}: missing golden ${key}`);
        }
      }
    }
  }
  for (const path of [
    ...listSource(resolve(root, 'js/src'), '.js'),
    ...listSource(resolve(root, 'rust/src'), '.rs'),
  ]) {
    if (!evidence.has(path)) {
      errors.push(`Unlisted implementation: ${path}`);
    }
    if (
      path.startsWith('rust/') &&
      !generated.includes(path) &&
      !manuals.has(path)
    ) {
      errors.push(`Hand-written Rust has no translation blocker: ${path}`);
    }
  }
  return errors;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'parity/features.json'))
  );
  const errors = validateManifest(manifest);
  if (!process.argv.includes('--manifest-only')) {
    let base = process.env.PARITY_BASE_SHA;
    if (!base || /^0+$/.test(base)) {
      base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    }
    const changed = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', `${base}...HEAD`],
      { cwd: root, encoding: 'utf8' }
    )
      .trim()
      .split('\n');
    if (process.env.PARITY_VERBOSE === '1') {
      console.log(JSON.stringify({ base, changed }, null, 2));
    }
    errors.push(...checkFeatureChanges(manifest.features, changed));
  }
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exitCode = errors.length ? 1 : 0;
  if (!errors.length) {
    console.log(
      `Verified ${manifest.features.length} features, source inventory and behavior evidence.`
    );
  }
}
