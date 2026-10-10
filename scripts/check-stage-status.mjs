#!/usr/bin/env node
/** Fail closed: cancelled or skipped required checks cannot open the next stage. */
const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
const requiredIndex = process.argv.indexOf('--required');
const required = (
  requiredIndex < 0 ? '' : process.argv[requiredIndex + 1] || ''
)
  .split(',')
  .filter(Boolean);
const errors = [];
for (const [name, job] of Object.entries(needs)) {
  if (!['success', 'skipped'].includes(job.result)) {
    errors.push(`${name}: ${job.result}`);
  }
}
for (const name of required) {
  if (needs[name]?.result !== 'success') {
    errors.push(`required ${name}: ${needs[name]?.result || 'missing'}`);
  }
}
if (!required.length || !Object.keys(needs).length) {
  errors.push('stage must declare required checks and receive needs');
}
if (errors.length) {
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Stage passed: ${required.join(', ')}`);
}
