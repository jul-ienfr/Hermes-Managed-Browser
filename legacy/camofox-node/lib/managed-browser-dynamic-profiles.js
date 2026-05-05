import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SITE_KEY_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function defaultManagedProfilesPath() {
  return process.env.MANAGED_BROWSER_PROFILES_FILE
    || path.join(process.env.HOME || os.homedir() || process.cwd(), '.config', 'camofox-browser', 'managed-profiles.json');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateName(value, kind) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const re = kind === 'site' ? SITE_KEY_RE : PROFILE_NAME_RE;
  if (!re.test(normalized)) {
    throw new Error(`Invalid managed_browser ${kind} "${String(value || '')}" in dynamic profile registry.`);
  }
  return normalized;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function managedProfilePolicyFromDynamic(profile, raw = {}) {
  const canonical = validateName(raw.profile || profile, 'profile');
  if (canonical !== profile) {
    throw new Error(`Dynamic profile key "${profile}" must match profile field "${canonical}".`);
  }
  const siteKey = validateName(raw.siteKey || raw.site || raw.securityPolicy?.site, 'site');
  const userId = raw.userId ? validateName(raw.userId, 'profile') : canonical;
  const defaultStartUrl = String(raw.defaultStartUrl || raw.startUrl || '').trim();
  if (!defaultStartUrl || !/^https?:\/\//i.test(defaultStartUrl)) {
    throw new Error(`Dynamic profile "${profile}" requires an http(s) defaultStartUrl.`);
  }

  const profileDir = String(raw.profileDir || path.join(process.env.HOME || os.homedir() || process.cwd(), '.vnc-browser-profiles', canonical));
  const browserPersonaKey = String(raw.browserPersonaKey || `managed:${canonical}:browser`);
  const humanPersonaKey = String(raw.humanPersonaKey || `managed:${canonical}:human`);
  const defaultHumanProfile = String(raw.defaultHumanProfile || 'fast');

  return {
    profile: canonical,
    siteKey,
    userId,
    sessionKey: String(raw.sessionKey || `managed:${canonical}`),
    defaultStartUrl,
    profileDir,
    browserPersonaKey,
    humanPersonaKey,
    defaultHumanProfile,
    displayPolicy: {
      mode: 'managed-autonomous',
      allowServerOwnedVisibleLaunch: true,
      ...(raw.displayPolicy && typeof raw.displayPolicy === 'object' ? raw.displayPolicy : {}),
    },
    lifecyclePolicy: {
      warmup: {
        enabled: normalizeBoolean(raw.lifecyclePolicy?.warmup?.enabled, false),
        reason: String(raw.lifecyclePolicy?.warmup?.reason || 'dynamic-profile'),
      },
      rotation: {
        mode: String(raw.lifecyclePolicy?.rotation?.mode || 'manual'),
        maxSessionAgeMinutes: Number.parseInt(String(raw.lifecyclePolicy?.rotation?.maxSessionAgeMinutes || 240), 10),
      },
    },
    securityPolicy: {
      site: siteKey,
      browserOnly: normalizeBoolean(raw.securityPolicy?.browserOnly, true),
      requireConfirmationForBindingActions: normalizeBoolean(raw.securityPolicy?.requireConfirmationForBindingActions, false),
      ...(raw.securityPolicy && typeof raw.securityPolicy === 'object' ? raw.securityPolicy : {}),
      site: siteKey,
    },
    source: 'dynamic',
  };
}

function normalizeAliasEntry(aliasKey, raw, profilePolicy) {
  const alias = validateName(aliasKey, 'profile');
  if (typeof raw === 'string') {
    return { alias, profile: validateName(raw, 'profile'), siteKey: profilePolicy?.siteKey };
  }
  if (raw && typeof raw === 'object') {
    return {
      alias,
      profile: validateName(raw.profile || profilePolicy?.profile, 'profile'),
      siteKey: validateName(raw.siteKey || raw.site || profilePolicy?.siteKey, 'site'),
    };
  }
  return { alias, profile: profilePolicy.profile, siteKey: profilePolicy.siteKey };
}

function parseDynamicRegistryPayload(payload) {
  const profileEntries = payload?.profiles || {};
  const aliases = new Map();
  const profiles = new Map();

  const iterable = Array.isArray(profileEntries)
    ? profileEntries.map((entry) => [entry?.profile, entry])
    : Object.entries(profileEntries);

  for (const [rawName, rawPolicy] of iterable) {
    const profile = validateName(rawName || rawPolicy?.profile, 'profile');
    const policy = managedProfilePolicyFromDynamic(profile, rawPolicy || {});
    profiles.set(profile, policy);

    const rawAliases = rawPolicy?.aliases || rawPolicy?.alias || [];
    const aliasList = Array.isArray(rawAliases) ? rawAliases : [rawAliases];
    for (const candidate of aliasList.filter(Boolean)) {
      const aliasEntry = normalizeAliasEntry(String(candidate), null, policy);
      aliases.set(aliasEntry.alias, { profile: aliasEntry.profile, siteKey: aliasEntry.siteKey });
    }
  }

  for (const [rawAlias, rawTarget] of Object.entries(payload?.aliases || {})) {
    const aliasEntry = normalizeAliasEntry(rawAlias, rawTarget, profiles.get(rawTarget?.profile || rawTarget));
    aliases.set(aliasEntry.alias, { profile: aliasEntry.profile, siteKey: aliasEntry.siteKey });
  }

  return { profiles, aliases };
}

function readDynamicManagedBrowserProfiles({ filePath = defaultManagedProfilesPath(), logger } = {}) {
  try {
    if (!fs.existsSync(filePath)) return { profiles: new Map(), aliases: new Map(), filePath, loaded: false };
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) return { profiles: new Map(), aliases: new Map(), filePath, loaded: true };
    const parsed = JSON.parse(text);
    const registry = parseDynamicRegistryPayload(parsed);
    return { ...registry, filePath, loaded: true };
  } catch (err) {
    logger?.warn?.('failed to read managed browser dynamic profiles', { filePath, error: err?.message || String(err) });
    throw err;
  }
}

function dynamicManagedBrowserProfilesPath() {
  return defaultManagedProfilesPath();
}

export {
  dynamicManagedBrowserProfilesPath,
  managedProfilePolicyFromDynamic,
  parseDynamicRegistryPayload,
  readDynamicManagedBrowserProfiles,
};
