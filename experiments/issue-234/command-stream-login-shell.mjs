#!/usr/bin/env bun
// Standalone reproduction for command-stream (issue #234): `$` runs simple
// commands as `/bin/sh -l -c`, so the login profile can reorder the caller's
// PATH (macOS /etc/profile runs path_helper) and print into captured stdout.
// Pipelines drop `-l`, so the two forms see different environments.
//
// Run: HOME=$(mktemp -d) sh -c 'printf "echo profile-noise\nPATH=/usr/bin:\$PATH\n" > "$HOME/.profile"; bun experiments/issue-234/command-stream-login-shell.mjs'
import { $ } from 'command-stream';

const env = { ...process.env, PATH: `/caller-first:${process.env.PATH}` };
const $env = $({ env, mirror: false });

const simple = await $env`printenv PATH`;
const piped = await $env`printenv PATH | cat`;
console.log('simple  stdout:', JSON.stringify(simple.stdout.slice(0, 60)));
console.log('pipeline stdout:', JSON.stringify(piped.stdout.slice(0, 60)));
const first = (out) => out.trim().split('\n').pop().split(':')[0];
console.log('first PATH entry (simple):  ', first(simple.stdout));
console.log('first PATH entry (pipeline):', first(piped.stdout));
