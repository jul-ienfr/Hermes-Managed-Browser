import { describe, expect, test } from '@jest/globals';

import {
  ManagedBrowserClientError,
  createManagedBrowserClient,
} from '../../lib/managed-browser-client.js';

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function invalidJsonResponse(text = 'not json', options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    async json() {
      throw new SyntaxError('Unexpected token o in JSON');
    },
    async text() {
      return text;
    },
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return typeof response === 'function' ? response(url, options) : response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('createManagedBrowserClient', () => {
  test('profileStatus posts exact endpoint and payload and normalizes stable fields', async () => {
    const fetchImpl = recordingFetch(jsonResponse({ ok: true, profile: 'p1', site: 'example', ready: true }));
    const client = createManagedBrowserClient({ baseUrl: 'http://local.test/base/', fetchImpl });

    const result = await client.profileStatus({ profile: 'p1', site: 'example' });

    expect(fetchImpl.calls).toEqual([
      {
        url: 'http://local.test/base/profile/status',
        options: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: 'p1', site: 'example' }),
        },
        body: { profile: 'p1', site: 'example' },
      },
    ]);
    expect(result).toMatchObject({ ok: true, success: true, operation: 'profile.status', profile: 'p1', site: 'example', llm_used: false });
  });

  test('runFlow omits allow_llm_repair by default and forwards max side-effect policy', async () => {
    const fetchImpl = recordingFetch(jsonResponse({ ok: true, profile: 'p2', site: 'shop', llm_used: false }));
    const client = createManagedBrowserClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl });

    const result = await client.runFlow({
      profile: 'p2',
      site: 'shop',
      flow: 'checkout-readiness',
      params: { sku: '123' },
      maxSideEffectLevel: 'submit_apply',
    });

    expect(fetchImpl.calls[0]).toEqual({
      url: 'http://127.0.0.1:8765/flow/run',
      options: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'p2',
          site: 'shop',
          flow: 'checkout-readiness',
          params: { sku: '123' },
          max_side_effect_level: 'submit_apply',
        }),
      },
      body: {
        profile: 'p2',
        site: 'shop',
        flow: 'checkout-readiness',
        params: { sku: '123' },
        max_side_effect_level: 'submit_apply',
      },
    });
    expect(fetchImpl.calls[0].body).not.toHaveProperty('allow_llm_repair');
    expect(result).toMatchObject({ ok: true, success: true, operation: 'flow.run', profile: 'p2', site: 'shop', llm_used: false });
  });

  test('runFlow sends allow_llm_repair only when explicitly true', async () => {
    const fetchImpl = recordingFetch(jsonResponse({ success: true, profile: 'p3', site: 'market', llm_used: true }));
    const client = createManagedBrowserClient({ baseUrl: 'http://browser.test', fetchImpl });

    const result = await client.runFlow({
      profile: 'p3',
      site: 'market',
      flow: 'post-listing',
      params: {},
      allowLlmRepair: true,
    });

    expect(fetchImpl.calls[0].url).toBe('http://browser.test/flow/run');
    expect(fetchImpl.calls[0].body).toEqual({
      profile: 'p3',
      site: 'market',
      flow: 'post-listing',
      params: {},
      allow_llm_repair: true,
    });
    expect(result).toMatchObject({ ok: true, success: true, operation: 'flow.run', profile: 'p3', site: 'market', llm_used: true });
  });

  test('snapshot and checkpointStorage use managed contract endpoints', async () => {
    const fetchImpl = recordingFetch(jsonResponse({ ok: true, profile: 'p4', site: 'docs' }));
    const client = createManagedBrowserClient({ baseUrl: 'http://browser.test/api', fetchImpl });

    await client.snapshot({ profile: 'p4', site: 'docs', tabId: 'tab-1' });
    await client.checkpointStorage({ profile: 'p4', site: 'docs', reason: 'before-write' });

    expect(fetchImpl.calls.map((call) => [call.url, call.body])).toEqual([
      ['http://browser.test/api/managed/cli/snapshot', { profile: 'p4', site: 'docs', tabId: 'tab-1' }],
      ['http://browser.test/api/storage/checkpoint', { profile: 'p4', site: 'docs', reason: 'before-write' }],
    ]);
  });

  test('non-2xx responses throw normalized ManagedBrowserClientError fields', async () => {
    const fetchImpl = recordingFetch(jsonResponse(
      { ok: false, code: 'profile_not_found', error: 'missing profile' },
      { ok: false, status: 404, statusText: 'Not Found' },
    ));
    const client = createManagedBrowserClient({ baseUrl: 'http://browser.test', fetchImpl });

    await expect(client.profileStatus({ profile: 'missing', site: 'example' })).rejects.toMatchObject({
      name: 'ManagedBrowserClientError',
      status: 404,
      statusText: 'Not Found',
      body: { ok: false, code: 'profile_not_found', error: 'missing profile' },
      code: 'profile_not_found',
      operation: 'profile.status',
    });
  });

  test('invalid JSON responses throw normalized parse errors with response body text', async () => {
    const fetchImpl = recordingFetch(invalidJsonResponse('<html>bad gateway</html>', { status: 200, statusText: 'OK' }));
    const client = createManagedBrowserClient({ baseUrl: 'http://browser.test', fetchImpl });

    await expect(client.snapshot({ profile: 'p5', site: 'news' })).rejects.toMatchObject({
      name: 'ManagedBrowserClientError',
      status: 200,
      statusText: 'OK',
      body: '<html>bad gateway</html>',
      code: 'invalid_json',
      operation: 'snapshot',
    });
  });
});
