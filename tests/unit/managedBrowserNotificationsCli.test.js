import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { main, parseArgs, requestForCommand } from '../../scripts/managed-browser.js';

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('managed-browser notifications CLI parsing and request selection', () => {
  test('maps status enable disable list poll notification commands with supported flags', () => {
    expect(requestForCommand(parseArgs(['notifications', 'status', '--profile', 'p', '--site', 'leboncoin', '--origin', 'https://www.leboncoin.fr', '--json']))).toEqual({
      endpoint: '/notifications/status',
      operation: 'notifications.status',
      payload: { profile: 'p', site: 'leboncoin', origin: 'https://www.leboncoin.fr' },
    });

    expect(requestForCommand(parseArgs(['notifications', 'enable', '--profile', 'p', '--confirm']))).toEqual({
      endpoint: '/notifications/enable',
      operation: 'notifications.enable',
      payload: { profile: 'p', confirm: true },
    });

    expect(requestForCommand(parseArgs(['notifications', 'disable', '--profile', 'p', '--site', 's']))).toEqual({
      endpoint: '/notifications/disable',
      operation: 'notifications.disable',
      payload: { profile: 'p', site: 's' },
    });

    expect(requestForCommand(parseArgs(['notifications', 'list', '--profile', 'p', '--limit', '10']))).toEqual({
      endpoint: '/notifications/list',
      operation: 'notifications.list',
      payload: { profile: 'p', limit: 10 },
    });

    expect(requestForCommand(parseArgs(['notifications', 'poll', '--profile', 'p', '--state', '/tmp/state.json', '--limit', '5']))).toEqual({
      endpoint: '/notifications/poll',
      operation: 'notifications.poll',
      payload: { profile: 'p', state: '/tmp/state.json', limit: 5 },
    });

    expect(requestForCommand(parseArgs(['notifications', 'self-test', '--profile', 'p', '--site', 's', '--origin', 'https://example.test']))).toEqual({
      endpoint: '/notifications/self-test',
      operation: 'notifications.self-test',
      payload: { profile: 'p', site: 's', origin: 'https://example.test' },
    });
  });

  test('parses watch as a bounded polling command without daemon enable flags', () => {
    expect(parseArgs([
      'notifications', 'watch', '--profile', 'p', '--site', 's', '--origin', 'https://example.test',
      '--interval-seconds', '2', '--once', '--max-cycles', '3', '--limit', '4', '--state', '/tmp/state.json', '--json',
    ])).toEqual({
      command: 'notifications watch',
      profile: 'p',
      site: 's',
      origin: 'https://example.test',
      intervalSeconds: 2,
      once: true,
      maxCycles: 3,
      limit: 4,
      state: '/tmp/state.json',
      json: true,
    });
  });
});

describe('managed-browser notifications watch transport', () => {
  let originalFetch;
  let originalEnv;
  let stdout;
  let stderr;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = process.env.MANAGED_BROWSER_URL;
    process.env.MANAGED_BROWSER_URL = 'http://managed.test';
    stdout = { write: jest.fn() };
    stderr = { write: jest.fn() };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.MANAGED_BROWSER_URL;
    else process.env.MANAGED_BROWSER_URL = originalEnv;
  });

  test('watch --once checks permission then polls once and never enables permissions or marks read', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.endsWith('/notifications/status')) return response({ success: true, permission: 'granted' });
      if (url.endsWith('/notifications/poll')) return response({ success: true, permission: 'granted', notifications: [{ id: 'n1' }], cursor: 'n1' });
      throw new Error(`unexpected url ${url}`);
    });

    const code = await main(['notifications', 'watch', '--profile', 'p', '--site', 's', '--origin', 'https://example.test', '--once', '--json'], { stdout, stderr, sleep: jest.fn() });

    expect(code).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.map((call) => call[0])).toEqual([
      'http://managed.test/notifications/status',
      'http://managed.test/notifications/poll',
    ]);
    expect(global.fetch.mock.calls[1][1].body).toBe(JSON.stringify({ profile: 'p', site: 's', origin: 'https://example.test' }));
    const output = JSON.parse(stdout.write.mock.calls.at(-1)[0]);
    expect(output).toMatchObject({ success: true, operation: 'notifications.watch', profile: 'p', site: 's', permission: 'granted', cycles: 1, llm_used: false, external_actions: 0 });
    expect(output.notifications).toEqual([{ id: 'n1' }]);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  test('watch reports requires_enable for default or denied permission without attempting enable', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.endsWith('/notifications/status')) return response({ success: true, permission: 'default' });
      throw new Error(`unexpected url ${url}`);
    });

    const code = await main(['notifications', 'watch', '--profile', 'p', '--origin', 'https://example.test', '--json'], { stdout, stderr });

    expect(code).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('http://managed.test/notifications/status');
    const output = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(output).toMatchObject({ success: false, status: 'requires_enable', permission: 'default', llm_used: false, external_actions: 0 });
  });

  test('watch honors --max-cycles and carries state path to every poll', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.endsWith('/notifications/status')) return response({ success: true, permission: 'granted' });
      if (url.endsWith('/notifications/poll')) return response({ success: true, permission: 'granted', notifications: [], cursor: 'same' });
      throw new Error(`unexpected url ${url}`);
    });
    const sleep = jest.fn(async () => {});

    const code = await main(['notifications', 'watch', '--profile', 'p', '--state', '/tmp/state.json', '--max-cycles', '2', '--interval-seconds', '0', '--json'], { stdout, stderr, sleep });

    expect(code).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls.slice(1).map((call) => JSON.parse(call[1].body).state)).toEqual(['/tmp/state.json', '/tmp/state.json']);
    expect(sleep).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stdout.write.mock.calls.at(-1)[0]);
    expect(output.cycles).toBe(2);
    expect(output.llm_used).toBe(false);
    expect(output.external_actions).toBe(0);
  });
});
