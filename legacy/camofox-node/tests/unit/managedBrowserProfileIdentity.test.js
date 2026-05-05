import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listManagedBrowserProfileIdentities,
  managedBrowserProfileStatus,
  normalizeManagedBrowserProfileIdentity,
  requireManagedBrowserProfileIdentity,
} from '../../lib/managed-browser-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');

describe('managed browser profile identity contract', () => {
  test('mutating managed-browser operations reject missing and blank profile explicitly', () => {
    for (const body of [{}, { profile: '' }, { profile: '   ' }, { userId: 'leboncoin-cim' }]) {
      expect(() => requireManagedBrowserProfileIdentity(body, { operation: 'managed.visible-tab' })).toThrow(/explicit profile/i);
    }
  });

  test('normalizes profile as one browser identity for cookies storage persona tabs and session state', () => {
    const identity = normalizeManagedBrowserProfileIdentity({ profile: 'ju', site: 'leboncoin' });

    expect(identity).toMatchObject({
      profile: 'leboncoin-cim',
      siteKey: 'leboncoin',
      userId: 'leboncoin-cim',
      sessionKey: 'managed:leboncoin-cim',
      profileDir: '/home/jul/.vnc-browser-profiles/leboncoin-cim',
      browserPersonaKey: 'managed:leboncoin-cim:browser',
      humanPersonaKey: 'managed:leboncoin-cim:human',
      identity: {
        cookies: 'leboncoin-cim',
        storage: 'leboncoin-cim',
        browserPersona: 'managed:leboncoin-cim:browser',
        humanPersona: 'managed:leboncoin-cim:human',
        tabs: 'managed:leboncoin-cim',
        sessionState: 'managed:leboncoin-cim',
      },
    });
  });

  test('profiles.list/status/ensure handlers expose identity contract without silently defaulting', () => {
    expect(listManagedBrowserProfileIdentities().map((entry) => entry.profile).sort()).toEqual([
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

    expect(managedBrowserProfileStatus({ profile: 'leboncoin-ge' })).toMatchObject({
      ok: true,
      ensured: false,
      profile: 'leboncoin-ge',
      identity: {
        cookies: 'leboncoin-ge',
        storage: 'leboncoin-ge',
        tabs: 'managed:leboncoin-ge',
        sessionState: 'managed:leboncoin-ge',
      },
      lifecycle: { state: 'COLD', currentTabId: null },
    });

    expect(managedBrowserProfileStatus({ profile: 'leboncoin-ge' }, { ensure: true })).toMatchObject({
      ok: true,
      ensured: true,
      profile: 'leboncoin-ge',
    });

    expect(managedBrowserProfileStatus({ profile: 'vinted', site: 'vinted' })).toMatchObject({
      ok: true,
      ensured: false,
      profile: 'vinted-main',
      siteKey: 'vinted',
      identity: {
        cookies: 'vinted-main',
        storage: 'vinted-main',
        tabs: 'managed:vinted-main',
        sessionState: 'managed:vinted-main',
      },
      lifecycle: { state: 'COLD', currentTabId: null },
    });

    expect(() => managedBrowserProfileStatus({}, { ensure: true })).toThrow(/explicit profile/i);
  });

  test('server exposes profiles.list profiles.status and profiles.ensure endpoints and gates mutating managed routes by profile', () => {
    for (const route of [
      "app.get('/managed/profiles'",
      "app.get('/managed/profiles/:profile/status'",
      "app.post('/managed/profiles/ensure'",
    ]) {
      expect(serverSource).toContain(route);
    }

    for (const route of [
      "app.post('/managed/visible-tab'",
      "app.post('/managed/recover-tab'",
      "app.post('/managed/storage-checkpoint'",
    ]) {
      const start = serverSource.indexOf(route);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextRoute = serverSource.indexOf('\napp.', start + 1);
      const section = serverSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
      expect(section).toContain('requireManagedBrowserProfileIdentity(');
    }
  });

  test('managed visible-tab applies normalized profile identity instead of trusting raw request body', () => {
    const start = serverSource.indexOf("app.post('/managed/visible-tab'");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextRoute = serverSource.indexOf('\napp.', start + 1);
    const section = serverSource.slice(start, nextRoute === -1 ? undefined : nextRoute);

    expect(section).toContain('const identity = requireManagedBrowserProfileIdentity(visibleTabIdentityInput(req.body || {})');
    expect(section).toContain('const payload = managedCliPayload(identity, req.body');
    expect(section).toContain('ensureManagedLease({ ...payload');
    expect(section).toContain('createServerOwnedTab(session, {\n        ...payload,');
    expect(section).not.toContain('const { userId, sessionKey, url, profileDir, display, browserPersonaKey, humanPersonaKey, humanProfile, siteKey, task_id, taskId } = req.body;');
  });

  test('managed visible-tab has a narrow legacy userId-to-profile compatibility path for Hermes tools', () => {
    expect(normalizeManagedBrowserProfileIdentity({ profile: 'leboncoin-cim', site: 'leboncoin' })).toMatchObject({
      profile: 'leboncoin-cim',
      userId: 'leboncoin-cim',
    });

    const setStart = serverSource.indexOf('const LEGACY_VISIBLE_TAB_USER_ID_PROFILES');
    const start = serverSource.indexOf('function visibleTabIdentityInput');
    expect(setStart).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThanOrEqual(0);
    const section = serverSource.slice(setStart, serverSource.indexOf('// Create new tab', start));
    expect(section).toContain("'leboncoin-cim'");
    expect(section).toContain('return { ...body, profile: String(body.userId) };');
    expect(section).toContain('return body;');
  });
});
