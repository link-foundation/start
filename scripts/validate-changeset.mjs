#!/usr/bin/env node

/**
 * Validate changeset for CI - ensures exactly one valid changeset exists
 *
 * Usage: node scripts/validate-changeset.mjs [--working-dir <dir>]
 *
 * IMPORTANT: Update the package name below to match your package.json
 */

import { readdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
let workingDir = 'js'; // Default to js folder

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--working-dir' && args[i + 1]) {
    workingDir = args[i + 1];
    i++;
  }
}

// TODO: Update this to match your package name in package.json
const PACKAGE_NAME = 'start-command';

const isChangesetFile = (file) => file.endsWith('.md') && file !== 'README.md';

const toGitPath = (filePath) => filePath.replace(/\\/g, '/');

const getChangedChangesetFiles = (changesetDir) => {
  const baseSha = process.env.GITHUB_BASE_SHA;
  const headSha = process.env.GITHUB_HEAD_SHA;

  if (!baseSha || !headSha) {
    return null;
  }

  const normalizedChangesetDir = toGitPath(changesetDir).replace(/\/$/, '');

  try {
    const output = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--diff-filter=AMR',
        `${baseSha}...${headSha}`,
        '--',
        normalizedChangesetDir,
      ],
      { encoding: 'utf8' }
    );

    console.log(
      `Using PR diff ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} for changeset validation`
    );

    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((filePath) => {
            const normalizedPath = toGitPath(filePath.trim());
            const prefix = `${normalizedChangesetDir}/`;

            if (!normalizedPath.startsWith(prefix)) {
              return null;
            }

            const file = normalizedPath.slice(prefix.length);

            if (file.includes('/') || !isChangesetFile(file)) {
              return null;
            }

            return file;
          })
          .filter(Boolean)
      ),
    ];
  } catch (error) {
    console.warn(
      `Could not determine PR changesets from git diff (${error.message}); falling back to scanning ${changesetDir}`
    );
    return null;
  }
};

try {
  // Count changeset files (excluding README.md and config.json)
  const changesetDir = join(workingDir, '.changeset');
  const changedChangesetFiles = getChangedChangesetFiles(changesetDir);
  const changesetFiles =
    changedChangesetFiles ?? readdirSync(changesetDir).filter(isChangesetFile);

  const changesetCount = changesetFiles.length;
  console.log(`Found ${changesetCount} changeset file(s)`);

  // Ensure exactly one changeset file exists
  if (changesetCount === 0) {
    console.error(
      "::error::No changeset found. Please add a changeset by running 'npm run changeset' and commit the result."
    );
    process.exit(1);
  } else if (changesetCount > 1) {
    console.error(
      `::error::Multiple changesets found (${changesetCount}). Each PR should have exactly ONE changeset.`
    );
    console.error('::error::Found changeset files:');
    changesetFiles.forEach((file) => console.error(`  ${file}`));
    process.exit(1);
  }

  // Get the changeset file
  const changesetFile = join(changesetDir, changesetFiles[0]);
  console.log(`Validating changeset: ${changesetFile}`);

  // Read the changeset file
  const content = readFileSync(changesetFile, 'utf-8');

  // Check if changeset has a valid type (major, minor, or patch)
  const versionTypeRegex = new RegExp(
    `^['"]${PACKAGE_NAME}['"]:\\s+(major|minor|patch)`,
    'm'
  );
  if (!versionTypeRegex.test(content)) {
    console.error(
      '::error::Changeset must specify a version type: major, minor, or patch'
    );
    console.error(`::error::Expected format in ${changesetFile}:`);
    console.error('::error::---');
    console.error(`::error::'${PACKAGE_NAME}': patch`);
    console.error('::error::---');
    console.error('::error::');
    console.error('::error::Your description here');
    console.error('\nFile content:');
    console.error(content);
    process.exit(1);
  }

  // Extract description (everything after the closing ---) and check it's not empty
  const parts = content.split('---');
  if (parts.length < 3) {
    console.error(
      '::error::Changeset must include a description of the changes'
    );
    console.error(
      "::error::The description should appear after the closing '---' in the changeset file"
    );
    console.error(`::error::Current content of ${changesetFile}:`);
    console.error(content);
    process.exit(1);
  }

  const description = parts.slice(2).join('---').trim();
  if (!description) {
    console.error(
      '::error::Changeset must include a description of the changes'
    );
    console.error(
      "::error::The description should appear after the closing '---' in the changeset file"
    );
    console.error(`::error::Current content of ${changesetFile}:`);
    console.error(content);
    process.exit(1);
  }

  // Extract version type
  const versionTypeMatch = content.match(versionTypeRegex);
  const versionType = versionTypeMatch ? versionTypeMatch[1] : 'unknown';

  console.log('✅ Changeset validation passed');
  console.log(`   Type: ${versionType}`);
  console.log(`   Description: ${description}`);
} catch (error) {
  console.error('Error during changeset validation:', error.message);
  if (process.env.DEBUG) {
    console.error('Stack trace:', error.stack);
  }
  process.exit(1);
}
