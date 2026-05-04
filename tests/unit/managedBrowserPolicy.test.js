import {
  listManagedBrowserProfiles,
  managedBrowserContextKey,
  resolveManagedBrowserProfile,
} from '../../lib/managed-browser-policy.js';

describe('managed browser profile policy', () => {
  test('resolves canonical Leboncoin profiles', () => {
    expect(resolveManagedBrowserProfile({ profile: 'leboncoin-cim' })).toMatchObject({
      profile: 'leboncoin-cim',
      siteKey: 'leboncoin',
      userId: 'leboncoin-cim',
      sessionKey: 'managed:leboncoin-cim',
      defaultStartUrl: 'https://www.leboncoin.fr/',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: {
        warmup: { enabled: false, reason: 'manual-profile-only' },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 240 },
      },
    });

    expect(resolveManagedBrowserProfile({ profile: 'leboncoin-ge' })).toMatchObject({
      profile: 'leboncoin-ge',
      siteKey: 'leboncoin',
      userId: 'leboncoin-ge',
      sessionKey: 'managed:leboncoin-ge',
      defaultStartUrl: 'https://www.leboncoin.fr/',
      defaultHumanProfile: 'fast',
      displayPolicy: { mode: 'managed-autonomous', allowServerOwnedVisibleLaunch: true },
      lifecyclePolicy: {
        warmup: { enabled: false, reason: 'manual-profile-only' },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 240 },
      },
    });
  });

  test('resolves ju and ge aliases only for Leboncoin', () => {
    expect(resolveManagedBrowserProfile({ profile: 'ju' }).profile).toBe('leboncoin-cim');
    expect(resolveManagedBrowserProfile({ profile: 'leboncoin-cim' }).profile).toBe('leboncoin-cim');
    expect(resolveManagedBrowserProfile({ profile: 'ge', site: 'leboncoin' }).profile).toBe('leboncoin-ge');
    expect(resolveManagedBrowserProfile({ profile: 'cim', site: 'leboncoin' }).profile).toBe('leboncoin-cim');
    expect(resolveManagedBrowserProfile({ profile: 'leboncoin-cim', site: 'leboncoin' }).profile).toBe('leboncoin-cim');
    expect(() => resolveManagedBrowserProfile({ profile: 'ju', site: 'other-site' })).toThrow('belongs to site');
  });

  test('rejects missing, generic, manual, and unknown profiles', () => {
    for (const profile of [undefined, '', 'default', 'camoufox-default', 'leboncoin-manual', 'camofox-abc', 'unknown']) {
      expect(() => resolveManagedBrowserProfile({ profile })).toThrow();
    }
  });

  test('returns isolated persona and profile directories per profile', () => {
    const ju = resolveManagedBrowserProfile({ profile: 'leboncoin-cim' });
    const ge = resolveManagedBrowserProfile({ profile: 'leboncoin-ge' });

    expect(ju.profileDir).not.toBe(ge.profileDir);
    expect(ju.browserPersonaKey).not.toBe(ge.browserPersonaKey);
    expect(ju.humanPersonaKey).not.toBe(ge.humanPersonaKey);
    expect(ju.sessionKey).not.toBe(ge.sessionKey);
  });

  test('uses profile in current-tab context key', () => {
    const ctx = { agentId: 'agent-a' };
    const ju = resolveManagedBrowserProfile({ profile: 'leboncoin-cim' });
    const ge = resolveManagedBrowserProfile({ profile: 'leboncoin-ge' });

    expect(managedBrowserContextKey(ctx, ju)).not.toBe(managedBrowserContextKey(ctx, ge));
    expect(managedBrowserContextKey(ctx, ju)).toContain('leboncoin-cim');
  });

  test('resolves official and application France Travail profiles through the same registry contract', () => {
    expect(resolveManagedBrowserProfile({ profile: 'emploi-officiel', site: 'france-travail' })).toMatchObject({
      profile: 'emploi-officiel',
      siteKey: 'france-travail',
      userId: 'emploi-officiel',
      sessionKey: 'managed:emploi-officiel',
      defaultStartUrl: 'https://candidat.francetravail.fr/actualisation',
      profileDir: '/home/jul/.vnc-browser-profiles/emploi-officiel',
      defaultHumanProfile: 'fast',
      lifecyclePolicy: {
        warmup: { enabled: false, reason: 'manual-profile-only' },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 240 },
      },
      securityPolicy: {
        site: 'france-travail',
        browserOnly: true,
        requireConfirmationForBindingActions: true,
      },
    });
    expect(resolveManagedBrowserProfile({ profile: 'emploi-candidature', site: 'france-travail' })).toMatchObject({
      profile: 'emploi-candidature',
      siteKey: 'france-travail',
      userId: 'emploi-candidature',
      sessionKey: 'managed:emploi-candidature',
      defaultStartUrl: 'https://candidat.francetravail.fr/offres/recherche',
      profileDir: '/home/jul/.vnc-browser-profiles/emploi-candidature',
    });
    expect(resolveManagedBrowserProfile({ profile: 'emploi', site: 'france-travail' }).profile).toBe('emploi-candidature');
    expect(resolveManagedBrowserProfile({ profile: 'france-travail' }).profile).toBe('emploi-officiel');
    expect(() => resolveManagedBrowserProfile({ profile: 'emploi-officiel', site: 'leboncoin' })).toThrow('belongs to site');
  });

  test('resolves a non-Leboncoin managed profile through the same registry contract', () => {
    expect(resolveManagedBrowserProfile({ profile: 'example-demo', site: 'example' })).toMatchObject({
      profile: 'example-demo',
      siteKey: 'example',
      userId: 'example-demo',
      sessionKey: 'managed:example-demo',
      defaultStartUrl: 'https://example.com/',
      defaultHumanProfile: 'fast',
      lifecyclePolicy: {
        warmup: { enabled: true, reason: 'safe-demo-profile' },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 60 },
      },
      securityPolicy: {
        site: 'example',
        browserOnly: true,
        requireConfirmationForBindingActions: false,
      },
    });
    expect(() => resolveManagedBrowserProfile({ profile: 'example-demo', site: 'leboncoin' })).toThrow('belongs to site');
  });

  test('resolves the grocery shopping profile for drive openings', () => {
    expect(resolveManagedBrowserProfile({ profile: 'courses', site: 'leclerc' })).toMatchObject({
      profile: 'courses',
      siteKey: 'leclerc',
      userId: 'courses',
      sessionKey: 'managed:courses',
      defaultStartUrl: 'https://www.e.leclerc/',
      profileDir: '/home/jul/.vnc-browser-profiles/courses',
      defaultHumanProfile: 'fast',
      lifecyclePolicy: {
        warmup: { enabled: false, reason: 'manual-profile-only' },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 240 },
      },
      securityPolicy: {
        site: 'leclerc',
        browserOnly: true,
        requireConfirmationForBindingActions: false,
      },
    });
    expect(() => resolveManagedBrowserProfile({ profile: 'courses', site: 'intermarche' })).toThrow('belongs to site');
  });

  test('resolves Intermarché grocery profile and alias', () => {
    expect(resolveManagedBrowserProfile({ profile: 'courses-intermarche', site: 'intermarche' })).toMatchObject({
      profile: 'courses-intermarche',
      siteKey: 'intermarche',
      userId: 'courses-intermarche',
      sessionKey: 'managed:courses-intermarche',
      defaultStartUrl: 'https://www.intermarche.com/',
      profileDir: '/home/jul/.vnc-browser-profiles/courses-intermarche',
      securityPolicy: {
        site: 'intermarche',
        browserOnly: true,
        requireConfirmationForBindingActions: false,
      },
    });
    expect(resolveManagedBrowserProfile({ profile: 'intermarche', site: 'intermarche' }).profile).toBe('courses-intermarche');
  });

  test('lists only managed profile policies', () => {
    expect(listManagedBrowserProfiles().map((policy) => policy.profile).sort()).toEqual([
      'courses',
      'courses-auchan',
      'courses-intermarche',
      'emploi-candidature',
      'emploi-officiel',
      'example-demo',
      'leboncoin-cim',
      'leboncoin-ge',
      'vinted-main',
    ]);
  });
});
