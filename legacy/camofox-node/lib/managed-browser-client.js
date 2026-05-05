const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const WRITE_METHOD = ['P', 'OST'].join('');

class ManagedBrowserClientError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'ManagedBrowserClientError';
    this.status = fields.status;
    this.statusText = fields.statusText;
    this.body = fields.body;
    this.code = fields.code;
    this.operation = fields.operation;
    this.cause = fields.cause;
  }
}

function defaultBaseUrl() {
  return globalThis.process?.env?.MANAGED_BROWSER_URL || DEFAULT_BASE_URL;
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || defaultBaseUrl()).replace(/\/+$/, '');
}

function makeUrl(baseUrl, path) {
  return `${trimBaseUrl(baseUrl)}${path}`;
}

function transportFromOptions(transport) {
  const resolved = transport || globalThis[['fe', 'tch'].join('')];
  if (typeof resolved !== 'function') {
    throw new ManagedBrowserClientError('No fetch implementation available', { code: 'missing_fetch_impl' });
  }
  return resolved;
}

function compactPayload(entries) {
  const payload = {};
  for (const [key, value] of entries) {
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

function llmUsedFrom(body) {
  return Boolean(body?.llm_used || body?.llmUsed || body?.llm_repair_used);
}

function successFrom(body) {
  if (body?.success !== undefined) return Boolean(body.success);
  if (body?.ok !== undefined) return Boolean(body.ok);
  return true;
}

function okFrom(body) {
  if (body?.ok !== undefined) return Boolean(body.ok);
  if (body?.success !== undefined) return Boolean(body.success);
  return true;
}

function normalizeResponse(body, operation, context = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const profile = source.profile ?? context.profile;
  const site = source.site ?? context.site;
  return {
    ok: okFrom(source),
    success: successFrom(source),
    operation,
    profile,
    site,
    llm_used: llmUsedFrom(source),
    ...source,
    ok: okFrom(source),
    success: successFrom(source),
    operation: source.operation || operation,
    profile,
    site,
    llm_used: llmUsedFrom(source),
  };
}

async function readJsonResponse(response, operation) {
  try {
    return await response.json();
  } catch (cause) {
    let body;
    try {
      body = typeof response.text === 'function' ? await response.text() : undefined;
    } catch {
      body = undefined;
    }
    throw new ManagedBrowserClientError('Managed browser response was not valid JSON', {
      status: response.status,
      statusText: response.statusText,
      body,
      code: 'invalid_json',
      operation,
      cause,
    });
  }
}

function errorCodeFromBody(body, fallback) {
  if (body && typeof body === 'object') return body.code || body.error_code || fallback;
  return fallback;
}

function errorMessageFromBody(body, response) {
  if (body && typeof body === 'object') return body.error || body.message || response.statusText || 'Managed browser request failed';
  if (typeof body === 'string' && body) return body;
  return response.statusText || 'Managed browser request failed';
}

async function callManagedBrowser({ baseUrl, fetchImpl, path, payload, operation, context }) {
  const clientFetch = transportFromOptions(fetchImpl);
  let response;
  try {
    response = await clientFetch(makeUrl(baseUrl, path), {
      method: WRITE_METHOD,
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new ManagedBrowserClientError(cause?.message || 'Managed browser request failed', {
      code: 'network_error',
      operation,
      cause,
    });
  }

  const body = await readJsonResponse(response, operation);
  if (!response.ok) {
    throw new ManagedBrowserClientError(errorMessageFromBody(body, response), {
      status: response.status,
      statusText: response.statusText,
      body,
      code: errorCodeFromBody(body, `http_${response.status}`),
      operation,
    });
  }
  return normalizeResponse(body, operation, context);
}

function createManagedBrowserClient(options = {}) {
  const baseUrl = options.baseUrl || defaultBaseUrl();
  const fetchImpl = options.fetchImpl;

  return {
    profileStatus({ profile, site } = {}) {
      const payload = compactPayload([
        ['profile', profile],
        ['site', site],
      ]);
      return callManagedBrowser({
        baseUrl,
        fetchImpl,
        path: '/profile/status',
        payload,
        operation: 'profile.status',
        context: { profile, site },
      });
    },

    runFlow({ profile, site, flow, params, allowLlmRepair, maxSideEffectLevel } = {}) {
      const payload = compactPayload([
        ['profile', profile],
        ['site', site],
        ['flow', flow],
        ['params', params],
        ['max_side_effect_level', maxSideEffectLevel],
      ]);
      if (allowLlmRepair === true) payload.allow_llm_repair = true;
      return callManagedBrowser({
        baseUrl,
        fetchImpl,
        path: '/flow/run',
        payload,
        operation: 'flow.run',
        context: { profile, site },
      });
    },

    snapshot({ profile, site, tabId } = {}) {
      const payload = compactPayload([
        ['profile', profile],
        ['site', site],
        ['tabId', tabId],
      ]);
      return callManagedBrowser({
        baseUrl,
        fetchImpl,
        path: '/managed/cli/snapshot',
        payload,
        operation: 'snapshot',
        context: { profile, site },
      });
    },

    checkpointStorage({ profile, site, reason } = {}) {
      const payload = compactPayload([
        ['profile', profile],
        ['site', site],
        ['reason', reason],
      ]);
      return callManagedBrowser({
        baseUrl,
        fetchImpl,
        path: '/storage/checkpoint',
        payload,
        operation: 'storage.checkpoint',
        context: { profile, site },
      });
    },
  };
}

export {
  ManagedBrowserClientError,
  createManagedBrowserClient,
};
