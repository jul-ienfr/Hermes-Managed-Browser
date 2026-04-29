import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_POLICY_PATH = path.join(os.homedir(), '.vnc-browser-profiles', 'managed-lifecycle-overrides.json');
const ALLOWED_MODES = new Set(['now', 'never', 'after_task', 'delay']);

class ManagedLifecyclePolicyError extends Error {
  constructor(message, { code = 'managed_lifecycle_policy_error', statusCode = 400 } = {}) {
    super(message);
    this.name = 'ManagedLifecyclePolicyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function policyStorePath() {
  return process.env.MANAGED_BROWSER_LIFECYCLE_POLICY_PATH || DEFAULT_POLICY_PATH;
}

function lifecycleKey({ profile, site }) {
  if (!profile || !site) throw new ManagedLifecyclePolicyError('profile and site are required for lifecycle policy');
  return `${profile}::${site}`;
}

function parsePositiveSeconds(value, label = 'delaySeconds') {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ManagedLifecyclePolicyError(`${label} must be a positive integer`, { code: 'invalid_delay' });
  }
  return number;
}

function normalizeLifecycleClosePolicy(close = {}) {
  const mode = close.mode;
  if (!ALLOWED_MODES.has(mode)) {
    throw new ManagedLifecyclePolicyError(`Unsupported lifecycle close mode: ${mode || ''}`.trim(), { code: 'unsupported_lifecycle_mode' });
  }
  if (mode === 'delay') {
    return { mode, delaySeconds: parsePositiveSeconds(close.delaySeconds) };
  }
  return { mode };
}

function readLifecycleDefaults({ filePath = policyStorePath() } = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeLifecycleDefaults(defaults, { filePath = policyStorePath() } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function setLifecycleDefault({ profile, site, close }, options = {}) {
  const normalized = normalizeLifecycleClosePolicy(close);
  const defaults = readLifecycleDefaults(options);
  defaults[lifecycleKey({ profile, site })] = {
    profile,
    site,
    close: normalized,
    updated_at: new Date().toISOString(),
  };
  const filePath = writeLifecycleDefaults(defaults, options);
  return { ok: true, success: true, profile, site, close: normalized, persisted: true, path: filePath, llm_used: false, external_actions: 0 };
}

function getLifecycleDefault({ profile, site }, options = {}) {
  const defaults = readLifecycleDefaults(options);
  const entry = defaults[lifecycleKey({ profile, site })] || null;
  return entry?.close || null;
}

export {
  ManagedLifecyclePolicyError,
  getLifecycleDefault,
  normalizeLifecycleClosePolicy,
  setLifecycleDefault,
};
