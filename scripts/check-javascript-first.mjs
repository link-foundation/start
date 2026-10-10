#!/usr/bin/env bun
/** Parse all workflow YAML, including new files, to guard the only Rust entry. */
import { YAML } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const asList = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function includesRustLanguage(value) {
  if (typeof value === 'string') {
    return value
      .toLowerCase()
      .split(/[\s,]+/)
      .includes('rust');
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(includesRustLanguage);
  }
  return false;
}

export function checkJavaScriptFirst(workflows) {
  const errors = [];
  const js = workflows['js.yml'];
  const rust = workflows['rust.yml'];
  if (!js || !rust) {
    return ['js.yml and rust.yml are required'];
  }
  if (Object.keys(rust.on || {}).join(',') !== 'workflow_call') {
    errors.push(
      'rust.yml must have only workflow_call; independent events bypass JavaScript'
    );
  }
  for (const trigger of ['push', 'pull_request']) {
    const event = js.on?.[trigger];
    if (!event || event.paths || event['paths-ignore']) {
      errors.push(`js.yml ${trigger} must run without path filters`);
    }
  }
  const gate = js.jobs?.['pipeline-status'];
  const call = js.jobs?.['rust-stage'];
  if (
    !call ||
    call.uses !== './.github/workflows/rust.yml' ||
    asList(call.needs).join(',') !== 'pipeline-status' ||
    String(call.if).replace(/\s/g, '') !==
      "${{!cancelled()&&needs.pipeline-status.result=='success'}}" ||
    call.concurrency?.['cancel-in-progress'] !== false
  ) {
    errors.push(
      'Rust caller must require successful pipeline-status and never cancel Rust'
    );
  }
  if (!gate || gate.name !== 'JavaScript Stage' || gate.if !== 'always()') {
    errors.push(
      'JavaScript Stage must aggregate results even after cancellation'
    );
  }
  const required = ['syntax-check', 'lint', 'test', 'coverage', 'parity'];
  const gateSteps = JSON.stringify(gate?.steps || []);
  for (const name of required) {
    if (!asList(gate?.needs).includes(name) || !js.jobs?.[name]) {
      errors.push(`JavaScript Stage is missing required ${name}`);
    }
  }
  if (
    !gateSteps.includes(
      'check-stage-status.mjs --required syntax-check,lint,test,coverage,parity'
    )
  ) {
    errors.push(
      'JavaScript Stage must reject skipped/cancelled required checks'
    );
  }
  if (js.jobs?.parity?.if !== undefined) {
    errors.push('parity must always run regardless of changed paths');
  }
  const paritySteps = JSON.stringify(js.jobs?.parity?.steps || []);
  for (const helper of [
    'check-javascript-first.mjs',
    'check-feature-parity.mjs',
    'generate-rust.mjs --check',
    'shared-golden.js',
  ]) {
    if (!paritySteps.includes(helper)) {
      errors.push(`JavaScript parity job must run ${helper}`);
    }
  }
  for (const [filename, workflow] of Object.entries(workflows)) {
    for (const [name, job] of Object.entries(workflow.jobs || {})) {
      if (
        filename === 'js.yml' &&
        name !== 'rust-stage' &&
        name !== 'pipeline-status' &&
        !asList(gate?.needs).includes(name)
      ) {
        errors.push(`JavaScript Stage must collect ${name}`);
      }
      const serialized = JSON.stringify(job);
      if (
        serialized.includes('START_RELEASE_SSH_KEY') &&
        (job.environment !== 'release-main' ||
          !String(job.if).includes("github.ref == 'refs/heads/main'"))
      ) {
        errors.push(
          `${filename}/${name} must restrict release key access to the main-only environment`
        );
      }
      const startsRust =
        /\bcargo\b|\brustc\b|\brustup\b|rust-toolchain|cargo-audit|cargo-tarpaulin/.test(
          serialized
        ) ||
        (serialized.includes('codeql-action') &&
          (includesRustLanguage(job.strategy?.matrix) ||
            (job.steps || []).some((step) =>
              includesRustLanguage(step.with?.languages)
            )));
      if (startsRust && filename !== 'rust.yml') {
        errors.push(
          `${filename}/${name} can start Rust outside the gated workflow`
        );
      }
      if (
        job.uses?.includes('/rust.yml') &&
        !(filename === 'js.yml' && name === 'rust-stage')
      ) {
        errors.push(
          `${filename}/${name} is an unauthorized Rust workflow caller`
        );
      }
      if (
        job.uses?.includes('.github/workflows/') &&
        !job.uses.endsWith('/rust.yml')
      ) {
        errors.push(
          `${filename}/${name}: review new reusable workflow before admitting it to the gate`
        );
      }
      if (
        filename === 'rust.yml' &&
        job.concurrency &&
        job.concurrency['cancel-in-progress'] !== false
      ) {
        errors.push(`${filename}/${name} must not cancel a gated Rust job`);
      }
      if (
        filename !== 'rust.yml' &&
        job.concurrency?.['cancel-in-progress'] === true
      ) {
        errors.push(`${filename}/${name} must never cancel main`);
      }
    }
  }
  if (
    !JSON.stringify(rust.jobs?.['test-parity']?.steps).includes(
      'check-feature-parity.mjs'
    )
  ) {
    errors.push('Rust must independently verify the feature manifest');
  }
  return errors;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const directory = resolve(root, '.github/workflows');
  const workflows = Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [
        name,
        YAML.parse(readFileSync(resolve(directory, name), 'utf8')),
      ])
  );
  const errors = checkJavaScriptFirst(workflows);
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exitCode = errors.length ? 1 : 0;
  if (!errors.length) {
    console.log(
      'Every Rust job uses the successful JavaScript stage on the same commit.'
    );
  }
}
