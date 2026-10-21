#!/usr/bin/env node
/** Fail closed: cancelled or skipped required checks cannot open the next stage. */
const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : process.argv[index + 1] || '';
};
const required = option('--required').split(',').filter(Boolean);
// `--release <job>:<need>,<need>` names a release job and the jobs its `if`
// requires. A main push whose needs all succeeded must not skip it (#240).
const releases = option('--release')
  .split(';')
  .filter(Boolean)
  .map((spec) => {
    const [job, list = ''] = spec.split(':');
    return { job, needs: list.split(',').filter(Boolean) };
  });
const isMain = process.env.IS_MAIN === 'true';
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
// A skipped job logs nothing about its `if`, so print every term here.
console.log(`main push: ${isMain}`);
console.log(`needs: ${JSON.stringify(needs)}`);
for (const { job, needs: names } of releases) {
  const terms = names.map((name) => [name, needs[name]?.result || 'missing']);
  const ready = terms.every(([, result]) => result === 'success');
  const actual = needs[job]?.result || 'missing';
  const named = terms.map(([name, result]) => `needs.${name}.result=${result}`);
  console.log(
    `${job}: ${actual}; expected to run: ${isMain && ready}; ${named.join(' ')}`
  );
  if (isMain && ready && actual === 'skipped') {
    errors.push(
      `${job} was skipped on a main push although all of its needs succeeded; nothing was released`
    );
  }
}
if (errors.length) {
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Stage passed: ${required.join(', ')}`);
}
