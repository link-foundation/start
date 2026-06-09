#!/usr/bin/env bun
/**
 * Tests for Docker runtime options: --volume/-v, --mount, --env/-e, --privileged
 *
 * Reproduces issue #132: callers need to configure bind mounts, volumes,
 * environment variables, and privileged mode for the docker isolation backend
 * so they can mount tool credentials and run Docker-in-Docker images without
 * wrapping `docker run` themselves.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { parseArgs } = require('../src/lib/args-parser');
const { buildDockerRuntimeArgs } = require('../src/lib/isolation');

describe('Docker runtime options parsing', () => {
  it('should parse repeatable --volume and -v', () => {
    const result = parseArgs([
      '--isolated',
      'docker',
      '--volume',
      '/host/a:/container/a',
      '-v',
      '/host/b:/container/b:ro',
      '--',
      'ls',
    ]);
    assert.deepStrictEqual(result.wrapperOptions.volumes, [
      '/host/a:/container/a',
      '/host/b:/container/b:ro',
    ]);
  });

  it('should parse --volume=value and -v=value', () => {
    const result = parseArgs([
      '-i',
      'docker',
      '--volume=/host/a:/c/a',
      '-v=/host/b:/c/b',
      '--',
      'ls',
    ]);
    assert.deepStrictEqual(result.wrapperOptions.volumes, [
      '/host/a:/c/a',
      '/host/b:/c/b',
    ]);
  });

  it('should parse repeatable --mount', () => {
    const result = parseArgs([
      '-i',
      'docker',
      '--mount',
      'type=bind,src=/h,dst=/c',
      '--mount=type=volume,src=vol,dst=/data',
      '--',
      'ls',
    ]);
    assert.deepStrictEqual(result.wrapperOptions.mounts, [
      'type=bind,src=/h,dst=/c',
      'type=volume,src=vol,dst=/data',
    ]);
  });

  it('should parse repeatable --env and -e', () => {
    const result = parseArgs([
      '-i',
      'docker',
      '--env',
      'FOO=bar',
      '-e',
      'GH_TOKEN=secret',
      '--env=BAZ=qux',
      '--',
      'env',
    ]);
    assert.deepStrictEqual(result.wrapperOptions.env, [
      'FOO=bar',
      'GH_TOKEN=secret',
      'BAZ=qux',
    ]);
  });

  it('should parse --privileged', () => {
    const result = parseArgs(['-i', 'docker', '--privileged', '--', 'ls']);
    assert.strictEqual(result.wrapperOptions.privileged, true);
  });

  it('should default runtime options to empty/false', () => {
    const result = parseArgs(['-i', 'docker', '--', 'ls']);
    assert.deepStrictEqual(result.wrapperOptions.volumes, []);
    assert.deepStrictEqual(result.wrapperOptions.mounts, []);
    assert.deepStrictEqual(result.wrapperOptions.env, []);
    assert.strictEqual(result.wrapperOptions.privileged, false);
  });

  it('should throw when --volume requires an argument', () => {
    assert.throws(() => {
      parseArgs(['-i', 'docker', '--volume', '--', 'ls']);
    }, /requires a volume argument/);
  });

  it('should throw when --env requires an argument', () => {
    assert.throws(() => {
      parseArgs(['-i', 'docker', '--env', '--', 'ls']);
    }, /requires a KEY=VALUE argument/);
  });
});

describe('Docker runtime options validation', () => {
  it('should reject --volume with non-docker backend', () => {
    assert.throws(() => {
      parseArgs(['-i', 'tmux', '-v', '/a:/b', '--', 'ls']);
    }, /--volume option is only valid when isolation stack includes docker/);
  });

  it('should reject --mount without isolation', () => {
    assert.throws(() => {
      parseArgs(['--mount', 'type=bind,src=/a,dst=/b', '--', 'ls']);
    }, /--mount option is only valid when isolation stack includes docker/);
  });

  it('should reject --env with non-docker backend', () => {
    assert.throws(() => {
      parseArgs(['-i', 'ssh', '--endpoint', 'u@h', '-e', 'A=1', '--', 'ls']);
    }, /--env option is only valid when isolation stack includes docker/);
  });

  it('should reject --privileged without docker', () => {
    assert.throws(() => {
      parseArgs(['--privileged', '--', 'ls']);
    }, /--privileged option is only valid when isolation stack includes docker/);
  });

  it('should accept runtime options when stack includes docker', () => {
    const result = parseArgs([
      '-i',
      'screen docker',
      '-v',
      '/a:/b',
      '-e',
      'A=1',
      '--privileged',
      '--',
      'ls',
    ]);
    assert.deepStrictEqual(result.wrapperOptions.volumes, ['/a:/b']);
    assert.deepStrictEqual(result.wrapperOptions.env, ['A=1']);
    assert.strictEqual(result.wrapperOptions.privileged, true);
  });
});

describe('buildDockerRuntimeArgs', () => {
  it('should build empty args by default', () => {
    assert.deepStrictEqual(buildDockerRuntimeArgs({}), []);
  });

  it('should add --privileged first', () => {
    assert.deepStrictEqual(buildDockerRuntimeArgs({ privileged: true }), [
      '--privileged',
    ]);
  });

  it('should expand env, volumes, and mounts in order', () => {
    const args = buildDockerRuntimeArgs({
      privileged: true,
      env: ['FOO=bar', 'GH_TOKEN=secret'],
      volumes: ['/h/a:/c/a', '/h/b:/c/b:ro'],
      mounts: ['type=bind,src=/h,dst=/c'],
    });
    assert.deepStrictEqual(args, [
      '--privileged',
      '-e',
      'FOO=bar',
      '-e',
      'GH_TOKEN=secret',
      '-v',
      '/h/a:/c/a',
      '-v',
      '/h/b:/c/b:ro',
      '--mount',
      'type=bind,src=/h,dst=/c',
    ]);
  });
});
