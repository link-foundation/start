#!/usr/bin/env bun

/**
 * Merge multiple changeset files into a single changeset
 *
 * Key behavior:
 * - Combines all pending changesets into a single changeset file
 * - Uses the highest version bump type (major > minor > patch)
 * - Preserves all descriptions in chronological order (by file modification time)
 * - Removes the individual changeset files after merging
 * - Does nothing if there's only one or no changesets
 *
 * This script is run before `changeset version` to ensure a clean release
 * even when multiple PRs have merged before a release cycle.
 *
 * The package name is read from `<working-dir>/package.json` and the
 * changesets directory is `<working-dir>/.changeset`. The working directory
 * defaults to the current process working directory but can be overridden
 * with `--working-dir <dir>` so the script can be invoked from the repo
 * root in a multi-language layout (e.g. `--working-dir js`).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'fs';
import { join, resolve } from 'path';

// Version bump type priority (higher number = higher priority)
const BUMP_PRIORITY = {
  patch: 1,
  minor: 2,
  major: 3,
};

/**
 * Parse CLI arguments. Supports a single `--working-dir <dir>` flag plus
 * the corresponding `WORKING_DIR` environment variable.
 * @param {string[]} argv
 * @returns {{ workingDir: string }}
 */
function parseArgs(argv) {
  let workingDir = process.env.WORKING_DIR || '.';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--working-dir' && argv[index + 1]) {
      workingDir = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--working-dir=')) {
      workingDir = arg.slice('--working-dir='.length);
    }
  }
  return { workingDir };
}

/**
 * Read the package name from package.json so the merged changeset header
 * matches the existing fragments.
 * @param {string} workingDir
 * @returns {string}
 */
function readPackageName(workingDir) {
  const packageJsonPath = join(workingDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `package.json not found at ${packageJsonPath}. ` +
        'Pass --working-dir <dir> to point at the package root.'
    );
  }

  const { name } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!name) {
    throw new Error(`Missing "name" in ${packageJsonPath}`);
  }
  return name;
}

/**
 * Generate a random changeset file name (similar to what @changesets/cli does)
 * @returns {string}
 */
function generateChangesetName() {
  const adjectives = [
    'bright',
    'calm',
    'cool',
    'cyan',
    'dark',
    'fast',
    'gold',
    'good',
    'green',
    'happy',
    'kind',
    'loud',
    'neat',
    'nice',
    'pink',
    'proud',
    'quick',
    'red',
    'rich',
    'safe',
    'shy',
    'soft',
    'sweet',
    'tall',
    'warm',
    'wise',
    'young',
  ];
  const nouns = [
    'apple',
    'bird',
    'book',
    'car',
    'cat',
    'cloud',
    'desk',
    'dog',
    'door',
    'fish',
    'flower',
    'frog',
    'grass',
    'house',
    'key',
    'lake',
    'leaf',
    'moon',
    'mouse',
    'owl',
    'park',
    'rain',
    'river',
    'rock',
    'sea',
    'star',
    'sun',
    'tree',
    'wave',
    'wind',
  ];

  const randomAdjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];

  return `${randomAdjective}-${randomNoun}`;
}

/**
 * Build the changeset header regex for a given package name. Matches both
 * single- and double-quoted package names (the format @changesets/cli writes
 * by default uses single quotes).
 * @param {string} packageName
 * @returns {RegExp}
 */
function buildVersionTypeRegex(packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^['"]?${escapedName}['"]?:\\s+(major|minor|patch)`,
    'm'
  );
}

/**
 * Parse a changeset file and extract its metadata
 * @param {string} filePath
 * @param {RegExp} versionTypeRegex
 * @returns {{type: string, description: string, mtime: Date} | null}
 */
function parseChangeset(filePath, versionTypeRegex) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const stats = statSync(filePath);

    const versionTypeMatch = content.match(versionTypeRegex);

    if (!versionTypeMatch) {
      console.warn(
        `Warning: Could not parse version type from ${filePath}, skipping`
      );
      return null;
    }

    // Extract description
    const parts = content.split('---');
    const description =
      parts.length >= 3 ? parts.slice(2).join('---').trim() : '';

    return {
      type: versionTypeMatch[1],
      description,
      mtime: stats.mtime,
    };
  } catch (error) {
    console.warn(`Warning: Failed to parse ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Get the highest priority bump type
 * @param {string[]} types
 * @returns {string}
 */
function getHighestBumpType(types) {
  let highest = 'patch';
  for (const type of types) {
    if (BUMP_PRIORITY[type] > BUMP_PRIORITY[highest]) {
      highest = type;
    }
  }
  return highest;
}

/**
 * Create a merged changeset file
 * @param {string} packageName
 * @param {string} type
 * @param {string[]} descriptions
 * @returns {string}
 */
function createMergedChangeset(packageName, type, descriptions) {
  const combinedDescription = descriptions.join('\n\n');

  return `---
'${packageName}': ${type}
---

${combinedDescription}
`;
}

export function mergeChangesetsIn(workingDir) {
  const resolvedDir = resolve(workingDir);
  const changesetDir = join(resolvedDir, '.changeset');

  if (!existsSync(changesetDir)) {
    throw new Error(
      `Changeset directory not found at ${changesetDir}. ` +
        'Pass --working-dir <dir> so the script can find it.'
    );
  }

  const packageName = readPackageName(resolvedDir);
  const versionTypeRegex = buildVersionTypeRegex(packageName);

  console.log(`Working directory: ${resolvedDir}`);
  console.log(`Changeset directory: ${changesetDir}`);
  console.log(`Package name: ${packageName}`);

  const changesetFiles = readdirSync(changesetDir).filter(
    (file) => file.endsWith('.md') && file !== 'README.md'
  );

  console.log(`Found ${changesetFiles.length} changeset file(s)`);

  if (changesetFiles.length <= 1) {
    console.log('No merging needed (0 or 1 changeset found)');
    return { merged: false };
  }

  console.log('Multiple changesets found, merging...');
  changesetFiles.forEach((file) => console.log(`  - ${file}`));

  const parsedChangesets = [];
  for (const file of changesetFiles) {
    const filePath = join(changesetDir, file);
    const parsed = parseChangeset(filePath, versionTypeRegex);
    if (parsed) {
      parsedChangesets.push({ file, filePath, ...parsed });
    }
  }

  if (parsedChangesets.length === 0) {
    throw new Error('No valid changesets could be parsed');
  }

  parsedChangesets.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  const bumpTypes = parsedChangesets.map((c) => c.type);
  const highestBumpType = getHighestBumpType(bumpTypes);

  console.log(`\nMerge summary:`);
  console.log(`  Bump types found: ${[...new Set(bumpTypes)].join(', ')}`);
  console.log(`  Using highest: ${highestBumpType}`);

  const descriptions = parsedChangesets
    .filter((c) => c.description)
    .map((c) => c.description);

  console.log(`  Descriptions to merge: ${descriptions.length}`);

  const mergedContent = createMergedChangeset(
    packageName,
    highestBumpType,
    descriptions
  );

  const mergedFileName = `merged-${generateChangesetName()}.md`;
  const mergedFilePath = join(changesetDir, mergedFileName);

  writeFileSync(mergedFilePath, mergedContent);
  console.log(`\nCreated merged changeset: ${mergedFileName}`);

  console.log('\nRemoving original changeset files:');
  for (const changeset of parsedChangesets) {
    unlinkSync(changeset.filePath);
    console.log(`  Removed: ${changeset.file}`);
  }

  console.log('\nChangeset merge completed successfully');
  console.log(`\nMerged changeset content:\n${mergedContent}`);

  return {
    merged: true,
    mergedFileName,
    bumpType: highestBumpType,
    descriptions,
  };
}

function main() {
  console.log('Checking for multiple changesets to merge...');
  const { workingDir } = parseArgs(process.argv.slice(2));
  try {
    mergeChangesetsIn(workingDir);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

const entryUrl = process.argv[1] ? `file://${resolve(process.argv[1])}` : '';
const invokedDirectly = import.meta.url === entryUrl;

if (invokedDirectly) {
  main();
}
