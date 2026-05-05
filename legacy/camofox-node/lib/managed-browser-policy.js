import { readDynamicManagedBrowserProfiles } from './managed-browser-dynamic-profiles.js';

const MANAGED_PROFILES = new Map([
  [
    'leboncoin-cim',
    {
      profile: 'leboncoin-cim',
      siteKey: 'leboncoin',
      userId: 'leboncoin-cim',
      sessionKey: 'managed:leboncoin-cim',
      defaultStartUrl: 'https://www.leboncoin.fr/',
      profileDir: '/home/jul/.vnc-browser-profiles/leboncoin-cim',
      browserPersonaKey: 'managed:leboncoin-cim:browser',
      humanPersonaKey: 'managed:leboncoin-cim:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'leboncoin', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
  [
    'leboncoin-ge',
    {
      profile: 'leboncoin-ge',
      siteKey: 'leboncoin',
      userId: 'leboncoin-ge',
      sessionKey: 'managed:leboncoin-ge',
      defaultStartUrl: 'https://www.leboncoin.fr/',
      profileDir: '/home/jul/.vnc-browser-profiles/leboncoin-ge',
      browserPersonaKey: 'managed:leboncoin-ge:browser',
      humanPersonaKey: 'managed:leboncoin-ge:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'leboncoin', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
  [
    'vinted-main',
    {
      profile: 'vinted-main',
      siteKey: 'vinted',
      userId: 'vinted-main',
      sessionKey: 'managed:vinted-main',
      defaultStartUrl: 'https://www.vinted.fr/',
      profileDir: '/home/jul/.vnc-browser-profiles/vinted-main',
      browserPersonaKey: 'managed:vinted-main:browser',
      humanPersonaKey: 'managed:vinted-main:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'vinted', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
    [
    'facebook-ju',
    {
      profile: 'facebook-ju',
      siteKey: 'facebook-marketplace',
      userId: 'facebook-ju',
      sessionKey: 'managed:facebook-ju',
      defaultStartUrl: 'https://www.facebook.com/marketplace/',
      profileDir: '/home/jul/.vnc-browser-profiles/facebook-ju',
      browserPersonaKey: 'managed:facebook-ju:browser',
      humanPersonaKey: 'managed:facebook-ju:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'facebook-marketplace', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
  [
    'emploi-officiel',
    {
      profile: 'emploi-officiel',
      siteKey: 'france-travail',
      userId: 'emploi-officiel',
      sessionKey: 'managed:emploi-officiel',
      defaultStartUrl: 'https://candidat.francetravail.fr/actualisation',
      profileDir: '/home/jul/.vnc-browser-profiles/emploi-officiel',
      browserPersonaKey: 'managed:emploi-officiel:browser',
      humanPersonaKey: 'managed:emploi-officiel:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'france-travail', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
  [
    'emploi-candidature',
    {
      profile: 'emploi-candidature',
      siteKey: 'france-travail',
      userId: 'emploi-candidature',
      sessionKey: 'managed:emploi-candidature',
      defaultStartUrl: 'https://candidat.francetravail.fr/offres/recherche',
      profileDir: '/home/jul/.vnc-browser-profiles/emploi-candidature',
      browserPersonaKey: 'managed:emploi-candidature:browser',
      humanPersonaKey: 'managed:emploi-candidature:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'france-travail', browserOnly: true, requireConfirmationForBindingActions: true },
    },
  ],
  [
    'courses',
    {
      profile: 'courses',
      siteKey: 'leclerc',
      userId: 'courses',
      sessionKey: 'managed:courses',
      defaultStartUrl: 'https://www.e.leclerc/',
      profileDir: '/home/jul/.vnc-browser-profiles/courses',
      browserPersonaKey: 'managed:courses:browser',
      humanPersonaKey: 'managed:courses:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'leclerc', browserOnly: true, requireConfirmationForBindingActions: false },
    },
  ],
  [
    'courses-auchan',
    {
      profile: 'courses-auchan',
      siteKey: 'auchan',
      userId: 'courses-auchan',
      sessionKey: 'managed:courses-auchan',
      defaultStartUrl: 'https://www.auchan.fr/',
      profileDir: '/home/jul/.vnc-browser-profiles/courses-auchan',
      browserPersonaKey: 'managed:courses-auchan:browser',
      humanPersonaKey: 'managed:courses-auchan:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'auchan', browserOnly: true, requireConfirmationForBindingActions: false },
    },
  ],
  [
    'courses-intermarche',
    {
      profile: 'courses-intermarche',
      siteKey: 'intermarche',
      userId: 'courses-intermarche',
      sessionKey: 'managed:courses-intermarche',
      defaultStartUrl: 'https://www.intermarche.com/',
      profileDir: '/home/jul/.vnc-browser-profiles/courses-intermarche',
      browserPersonaKey: 'managed:courses-intermarche:browser',
      humanPersonaKey: 'managed:courses-intermarche:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: { warmup: { enabled: false, reason: 'manual-profile-only' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 240 } },
      securityPolicy: { site: 'intermarche', browserOnly: true, requireConfirmationForBindingActions: false },
    },
  ],
  [
    'example-demo',
    {
      profile: 'example-demo',
      siteKey: 'example',
      userId: 'example-demo',
      sessionKey: 'managed:example-demo',
      defaultStartUrl: 'https://example.com/',
      profileDir: '/home/jul/.vnc-browser-profiles/example-demo',
      browserPersonaKey: 'managed:example-demo:browser',
      humanPersonaKey: 'managed:example-demo:human',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous' },
      lifecyclePolicy: { warmup: { enabled: true, reason: 'safe-demo-profile' }, rotation: { mode: 'manual', maxSessionAgeMinutes: 60 } },
      securityPolicy: { site: 'example', browserOnly: true, requireConfirmationForBindingActions: false },
    },
  ],
]);

const PROFILE_ALIASES = new Map([
  ['ju', { profile: 'leboncoin-cim', siteKey: 'leboncoin' }],
  ['leboncoin-cim', { profile: 'leboncoin-cim', siteKey: 'leboncoin' }],
  ['ge', { profile: 'leboncoin-ge', siteKey: 'leboncoin' }],
  ['cim', { profile: 'leboncoin-cim', siteKey: 'leboncoin' }],
  ['vinted', { profile: 'vinted-main', siteKey: 'vinted' }],
  ['emploi', { profile: 'emploi-candidature', siteKey: 'france-travail' }],
  ['france-travail', { profile: 'emploi-officiel', siteKey: 'france-travail' }],
  ['auchan', { profile: 'courses-auchan', siteKey: 'auchan' }],
  ['intermarche', { profile: 'courses-intermarche', siteKey: 'intermarche' }],
]);

const FORBIDDEN_PROFILE_PATTERNS = [/^camofox-/];
const FORBIDDEN_PROFILES = new Set(['', 'default', 'camoufox-default', 'leboncoin-manual']);

function dynamicRegistry() {
  return readDynamicManagedBrowserProfiles();
}

function mergedProfileAliases() {
  const merged = new Map(PROFILE_ALIASES);
  for (const [alias, target] of dynamicRegistry().aliases) merged.set(alias, target);
  return merged;
}

function mergedManagedProfiles() {
  const merged = new Map(MANAGED_PROFILES);
  for (const [profile, policy] of dynamicRegistry().profiles) merged.set(profile, policy);
  return merged;
}

function normalizeManagedBrowserProfile(profile, site) {
  if (typeof profile !== 'string' || !profile.trim()) {
    throw new Error('managed_browser requires an explicit profile. Use profile="leboncoin-cim" or profile="leboncoin-ge".');
  }

  const rawProfile = profile.trim();
  const normalizedSite = typeof site === 'string' && site.trim() ? site.trim() : undefined;
  const alias = mergedProfileAliases().get(rawProfile);
  if (alias) {
    if (normalizedSite && normalizedSite !== alias.siteKey) {
      throw new Error(`Profile alias "${rawProfile}" belongs to site "${alias.siteKey}", not "${normalizedSite}".`);
    }
    return alias.profile;
  }

  return rawProfile;
}

function buildManagedProfileIdentity(policy) {
  return {
    cookies: policy.userId,
    storage: policy.userId,
    browserPersona: policy.browserPersonaKey,
    humanPersona: policy.humanPersonaKey,
    tabs: policy.sessionKey,
    sessionState: policy.sessionKey,
  };
}

function resolveManagedBrowserProfile(input = {}) {
  const normalizedProfile = normalizeManagedBrowserProfile(input.profile, input.site);
  if (FORBIDDEN_PROFILES.has(normalizedProfile) || FORBIDDEN_PROFILE_PATTERNS.some((pattern) => pattern.test(normalizedProfile))) {
    throw new Error(`Profile "${normalizedProfile}" is not allowed for managed_browser.`);
  }

  const policy = mergedManagedProfiles().get(normalizedProfile);
  if (!policy) {
    throw new Error(`Unknown managed_browser profile "${normalizedProfile}".`);
  }

  if (input.site && input.site !== policy.siteKey) {
    throw new Error(`Profile "${normalizedProfile}" belongs to site "${policy.siteKey}", not "${input.site}".`);
  }

  return {
    ...policy,
    identity: buildManagedProfileIdentity(policy),
    displayPolicy: { ...policy.displayPolicy },
    lifecyclePolicy: {
      warmup: { ...policy.lifecyclePolicy.warmup },
      rotation: { ...policy.lifecyclePolicy.rotation },
    },
    securityPolicy: { ...policy.securityPolicy },
  };
}

function normalizeManagedBrowserProfileIdentity(input = {}) {
  return resolveManagedBrowserProfile(input);
}

function requireManagedBrowserProfileIdentity(input = {}, options = {}) {
  try {
    return normalizeManagedBrowserProfileIdentity(input);
  } catch (err) {
    if (err?.message?.includes('explicit profile')) {
      const operation = options.operation ? `${options.operation} ` : '';
      throw Object.assign(new Error(`${operation}requires an explicit profile for managed browser identity; missing or blank profile is not allowed.`), {
        statusCode: 400,
        code: 'profile_required',
      });
    }
    throw err;
  }
}

function managedBrowserContextKey(ctx = {}, policy) {
  return `${ctx.agentId || 'managed-browser'}:${policy.profile}:${policy.sessionKey}`;
}

function listManagedBrowserProfiles() {
  return Array.from(mergedManagedProfiles().values()).map((policy) => ({ ...policy, identity: buildManagedProfileIdentity(policy) }));
}

function listManagedBrowserProfileIdentities() {
  return listManagedBrowserProfiles();
}

function managedBrowserProfileStatus(input = {}, options = {}) {
  const policy = requireManagedBrowserProfileIdentity(input, { operation: options.ensure ? 'profiles.ensure' : 'profiles.status' });
  const observed = options.observed || {};
  const currentTabId = observed.currentTabId || null;
  const lifecycle = observed.lifecycle || {
    state: currentTabId ? 'READY' : 'COLD',
    updatedAt: observed.updatedAt || null,
    currentTabId,
  };

  return {
    ok: true,
    ensured: Boolean(options.ensure),
    profile: policy.profile,
    siteKey: policy.siteKey,
    userId: policy.userId,
    sessionKey: policy.sessionKey,
    profileDir: policy.profileDir,
    browserPersonaKey: policy.browserPersonaKey,
    humanPersonaKey: policy.humanPersonaKey,
    identity: policy.identity,
    displayPolicy: policy.displayPolicy,
    lifecyclePolicy: policy.lifecyclePolicy,
    securityPolicy: policy.securityPolicy,
    lifecycle,
  };
}

export {
  listManagedBrowserProfileIdentities,
  listManagedBrowserProfiles,
  managedBrowserContextKey,
  managedBrowserProfileStatus,
  normalizeManagedBrowserProfileIdentity,
  requireManagedBrowserProfileIdentity,
  resolveManagedBrowserProfile,
};
