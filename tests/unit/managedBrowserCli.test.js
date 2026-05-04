import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { main, parseArgs, requestForCommand } from '../../scripts/managed-browser.js';

const DEFAULT_URL = 'http://127.0.0.1:8765';

function fakeSpawn(calls, exitCode = 0) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call = { cmd, args, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', exitCode)));
    return child;
  };
}

describe('managed-browser CLI argument parsing and request selection', () => {
  test('credential set password requires stdin or interactive input and refuses argument secrets', () => {
    expect(parseArgs(['credential', 'set', 'password', '--profile', 'emploi', '--site', 'france-travail', '--stdin', '--json'])).toEqual({
      command: 'credential set',
      kind: 'password',
      profile: 'emploi',
      site: 'france-travail',
      stdin: true,
      json: true,
    });

    expect(() => parseArgs(['credential', 'set', 'password', '--profile', 'emploi', '--site', 'france-travail', '--value', 'SECRET'])).toThrow('secrets must not be passed as arguments');
  });

  test('credential set is handled locally and never builds an HTTP request containing the secret', () => {
    const parsed = parseArgs(['credential', 'set', 'otp', '--profile', 'emploi', '--site', 'france-travail', '--stdin']);

    expect(requestForCommand(parsed)).toEqual({
      local: true,
      operation: 'credential.set.otp',
    });
  });

  test('auth status and ensure expose status-only daemon endpoints without secret fields', () => {
    expect(requestForCommand(parseArgs(['auth', 'status', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
      endpoint: '/auth/status',
      operation: 'auth.status',
      payload: { profile: 'emploi', site: 'france-travail' },
    });

    expect(requestForCommand(parseArgs(['auth', 'ensure', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
      endpoint: '/auth/ensure',
      operation: 'auth.ensure',
      payload: { profile: 'emploi', site: 'france-travail' },
    });
  });

  test('auth commands require an explicit site so credentials stay scoped', () => {
    expect(() => parseArgs(['auth', 'status', '--profile', 'emploi'])).toThrow('Missing required --site <site>');
  });

  test('lifecycle commands let CLIs open, close, delay-close, or set profile defaults', () => {
    expect(requestForCommand(parseArgs(['lifecycle', 'open', '--profile', 'emploi-officiel', '--site', 'france-travail', '--url', 'https://example.com', '--json']))).toEqual({
      endpoint: '/lifecycle/open',
      operation: 'lifecycle.open',
      payload: { profile: 'emploi-officiel', site: 'france-travail', url: 'https://example.com' },
    });
    expect(requestForCommand(parseArgs(['lifecycle', 'close', '--profile', 'emploi-officiel', '--site', 'france-travail', '--after-task', '--json']))).toEqual({
      endpoint: '/lifecycle/close',
      operation: 'lifecycle.close',
      payload: { profile: 'emploi-officiel', site: 'france-travail', close: { mode: 'after_task' } },
    });
    expect(requestForCommand(parseArgs(['lifecycle', 'close', '--profile', 'emploi-officiel', '--site', 'france-travail', '--after-seconds', '900', '--json']))).toEqual({
      endpoint: '/lifecycle/close',
      operation: 'lifecycle.close',
      payload: { profile: 'emploi-officiel', site: 'france-travail', close: { mode: 'delay', delaySeconds: 900 } },
    });
    expect(requestForCommand(parseArgs(['lifecycle', 'default', '--profile', 'emploi-officiel', '--site', 'france-travail', '--never-close', '--json']))).toEqual({
      endpoint: '/lifecycle/default',
      operation: 'lifecycle.default',
      payload: { profile: 'emploi-officiel', site: 'france-travail', close: { mode: 'never' } },
    });
  });

  test('profile status posts profile/site to /profile/status and supports json output', () => {
    const parsed = parseArgs(['profile', 'status', '--profile', 'emploi-main', '--site', 'linkedin', '--json']);

    expect(parsed).toEqual({
      command: 'profile status',
      profile: 'emploi-main',
      site: 'linkedin',
      json: true,
    });
    expect(requestForCommand(parsed)).toEqual({
      endpoint: '/profile/status',
      payload: { profile: 'emploi-main', site: 'linkedin' },
      operation: 'profile.status',
    });
  });

  test('fingerprint doctor is read-only and posts to a dedicated diagnostic endpoint', () => {
    const parsed = parseArgs(['fingerprint', 'doctor', '--profile', 'courses-intermarche', '--site', 'intermarche', '--json']);

    expect(parsed).toEqual({
      command: 'fingerprint doctor',
      profile: 'courses-intermarche',
      site: 'intermarche',
      json: true,
    });
    expect(requestForCommand(parsed)).toEqual({
      endpoint: '/fingerprint/doctor',
      payload: { profile: 'courses-intermarche', site: 'intermarche' },
      operation: 'fingerprint.doctor',
    });
  });

  test('flow run maps params and side-effect policy, and does not enable llm repair by default', () => {
    const parsed = parseArgs([
      'flow', 'run', 'apply-to-job',
      '--profile', 'emploi-main',
      '--site', 'linkedin',
      '--param', 'jobId=123',
      '--param', 'dryRun=false',
      '--max-side-effect-level', 'submit_apply',
      '--json',
    ]);

    expect(requestForCommand(parsed)).toEqual({
      endpoint: '/flow/run',
      operation: 'flow.run',
      payload: {
        flow: 'apply-to-job',
        profile: 'emploi-main',
        site: 'linkedin',
        params: { jobId: '123', dryRun: 'false' },
        max_side_effect_level: 'submit_apply',
      },
    });
  });

  test('flow run includes allow_llm_repair only when flag is explicit', () => {
    const parsed = parseArgs([
      'flow', 'run', 'recover-flow',
      '--profile', 'emploi-main',
      '--allow-llm-repair',
    ]);

    expect(requestForCommand(parsed).payload).toMatchObject({
      flow: 'recover-flow',
      profile: 'emploi-main',
      allow_llm_repair: true,
    });
  });

  test('flow list and inspect select stable no-LLM catalog endpoints', () => {
    expect(requestForCommand(parseArgs(['flow', 'list', '--profile', 'p1', '--site', 'leboncoin', '--json']))).toEqual({
      endpoint: '/flow/list',
      operation: 'flow.list',
      payload: { profile: 'p1', site: 'leboncoin' },
    });

    expect(requestForCommand(parseArgs(['flow', 'inspect', 'type_reply', '--profile', 'p1', '--site', 'leboncoin', '--json']))).toEqual({
      endpoint: '/flow/inspect',
      operation: 'flow.inspect',
      payload: { flow: 'type_reply', profile: 'p1', site: 'leboncoin' },
    });
  });

  test('snapshot, file upload, and storage checkpoint select stable managed endpoints', () => {
    expect(requestForCommand(parseArgs(['snapshot', '--profile', 'p1', '--site', 's1', '--tab-id', 'tab-7']))).toEqual({
      endpoint: '/managed/cli/snapshot',
      operation: 'snapshot',
      payload: { profile: 'p1', site: 's1', tabId: 'tab-7' },
    });

    expect(requestForCommand(parseArgs(['file', 'upload', '--profile', 'p1', '--site', 's1', '--tab-id', 'tab-7', '--selector', 'input[type="file"]', '--path', '/tmp/a.jpg', '--path', '/tmp/b.jpg', '--json']))).toEqual({
      endpoint: '/file-upload',
      operation: 'file.upload',
      payload: { profile: 'p1', site: 's1', tabId: 'tab-7', selector: 'input[type="file"]', paths: ['/tmp/a.jpg', '/tmp/b.jpg'] },
    });

    expect(requestForCommand(parseArgs(['storage', 'checkpoint', '--profile', 'p1', '--reason', 'before-submit']))).toEqual({
      endpoint: '/storage/checkpoint',
      operation: 'storage.checkpoint',
      payload: { profile: 'p1', reason: 'before-submit' },
    });
  });
});

describe('managed-browser CLI transport and output', () => {
  let originalFetch;
  let originalEnv;
  let stdout;
  let stderr;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = process.env.MANAGED_BROWSER_URL;
    stdout = { write: jest.fn() };
    stderr = { write: jest.fn() };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.MANAGED_BROWSER_URL;
    else process.env.MANAGED_BROWSER_URL = originalEnv;
  });

  test('main prints help with exit code 0 without contacting the daemon', async () => {
    global.fetch = jest.fn();

    const code = await main(['--help'], { stdout, stderr });

    expect(code).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(stdout.write.mock.calls.join('\n')).toContain('Usage:');
    expect(stderr.write).not.toHaveBeenCalled();
  });

  test('main posts to MANAGED_BROWSER_URL and prints stable json with ok/success/operation/profile/site/llm_used', async () => {
    process.env.MANAGED_BROWSER_URL = 'http://localhost:9999/api';
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, profile: 'emploi-main', site: 'linkedin', extra: 'value' }),
      text: async () => '',
    }));

    const code = await main(['profile', 'status', '--profile', 'emploi-main', '--site', 'linkedin', '--json'], { stdout, stderr });

    expect(code).toBe(0);
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:9999/api/profile/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'emploi-main', site: 'linkedin' }),
    });
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toMatchObject({
      ok: true,
      success: true,
      operation: 'profile.status',
      profile: 'emploi-main',
      site: 'linkedin',
      llm_used: false,
      extra: 'value',
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  test('main uses default local endpoint and returns human-friendly daemon unavailable error without stack', async () => {
    delete process.env.MANAGED_BROWSER_URL;
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const code = await main(['snapshot', '--profile', 'emploi-main'], { stdout, stderr });

    expect(code).toBe(1);
    expect(global.fetch.mock.calls[0][0]).toBe(`${DEFAULT_URL}/managed/cli/snapshot`);
    expect(stderr.write.mock.calls.join('\n')).toContain('Managed browser daemon unavailable');
    expect(stderr.write.mock.calls.join('\n')).not.toContain('TypeError');
    expect(stderr.write.mock.calls.join('\n')).not.toContain('\n    at ');
  });

  test('main retries alternate local daemons when default daemon does not know a dynamic profile', async () => {
    delete process.env.MANAGED_BROWSER_URL;
    global.fetch = jest.fn(async (url) => {
      if (String(url).startsWith(DEFAULT_URL)) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Unknown managed_browser profile "courses-intermarche-fresh".' }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, profile: 'courses-intermarche-fresh', site: 'intermarche' }),
        text: async () => '',
      };
    });

    const code = await main(['profile', 'status', '--profile', 'courses-intermarche-fresh', '--site', 'intermarche', '--json'], { stdout, stderr });

    expect(code).toBe(0);
    expect(global.fetch.mock.calls.map((call) => call[0])).toEqual([
      `${DEFAULT_URL}/profile/status`,
      'http://127.0.0.1:9377/profile/status',
    ]);
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toMatchObject({
      success: true,
      operation: 'profile.status',
      profile: 'courses-intermarche-fresh',
      site: 'intermarche',
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  test('main renders non-2xx errors without raw stack trace', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 423,
      statusText: 'Locked',
      json: async () => ({ ok: false, error: 'profile_locked', profile: 'emploi-main' }),
      text: async () => '',
    }));

    const code = await main(['profile', 'status', '--profile', 'emploi-main'], { stdout, stderr });

    expect(code).toBe(1);
    const err = stderr.write.mock.calls.join('\n');
    expect(err).toContain('profile.status failed (HTTP 423)');
    expect(err).toContain('profile_locked');
    expect(err).not.toContain(' at ');
  });

  test('main stores credential stdin locally through pass without daemon or secret output', async () => {
    const secret = 'CLI_SUPER_SECRET_PASSWORD';
    const stdin = Readable.from([secret]);
    const calls = [];
    const spawn = fakeSpawn(calls);
    global.fetch = jest.fn();

    const code = await main(['credential', 'set', 'password', '--profile', 'emploi', '--site', 'france-travail', '--stdin', '--json'], { stdout, stderr, stdin, spawn });

    expect(code).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      cmd: 'pass',
      args: ['insert', '--force', '--multiline', 'managed-browser/emploi/france-travail/password'],
      input: secret,
    });
    expect(stdout.write.mock.calls.join('\n')).not.toContain(secret);
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toMatchObject({
      operation: 'credential.set.password',
      profile: 'emploi',
      site: 'france-travail',
      kind: 'password',
      stored: true,
      redacted: true,
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
