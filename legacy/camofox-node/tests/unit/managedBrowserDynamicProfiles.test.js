import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function importPolicyWithProfilesFile(filePath) {
  process.env.MANAGED_BROWSER_PROFILES_FILE = filePath;
  return import(`../../lib/managed-browser-policy.js?dynamic=${Date.now()}-${Math.random()}`);
}

describe('managed browser dynamic profile registry', () => {
  let tmpDir;
  let profilesFile;
  const oldEnv = process.env.MANAGED_BROWSER_PROFILES_FILE;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'managed-profiles-'));
    profilesFile = path.join(tmpDir, 'managed-profiles.json');
  });

  afterEach(async () => {
    if (oldEnv === undefined) delete process.env.MANAGED_BROWSER_PROFILES_FILE;
    else process.env.MANAGED_BROWSER_PROFILES_FILE = oldEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('loads profiles and aliases from the file on every resolution without process restart', async () => {
    await writeFile(profilesFile, JSON.stringify({
      profiles: {
        'courses-dynamic-a': {
          siteKey: 'dynamic-a',
          defaultStartUrl: 'https://a.example/',
          aliases: ['dynamic-a'],
        },
      },
    }), 'utf8');

    const policy = await importPolicyWithProfilesFile(profilesFile);
    expect(policy.resolveManagedBrowserProfile({ profile: 'dynamic-a', site: 'dynamic-a' })).toMatchObject({
      profile: 'courses-dynamic-a',
      siteKey: 'dynamic-a',
      userId: 'courses-dynamic-a',
      sessionKey: 'managed:courses-dynamic-a',
      defaultStartUrl: 'https://a.example/',
      source: 'dynamic',
    });

    await writeFile(profilesFile, JSON.stringify({
      profiles: {
        'courses-dynamic-a': {
          siteKey: 'dynamic-a',
          defaultStartUrl: 'https://a.example/',
          aliases: ['dynamic-a'],
        },
        'courses-dynamic-b': {
          siteKey: 'dynamic-b',
          defaultStartUrl: 'https://b.example/',
          aliases: ['dynamic-b'],
        },
      },
    }), 'utf8');

    expect(policy.resolveManagedBrowserProfile({ profile: 'dynamic-b', site: 'dynamic-b' })).toMatchObject({
      profile: 'courses-dynamic-b',
      siteKey: 'dynamic-b',
      userId: 'courses-dynamic-b',
      sessionKey: 'managed:courses-dynamic-b',
      defaultStartUrl: 'https://b.example/',
      source: 'dynamic',
    });
    expect(policy.listManagedBrowserProfiles().map((entry) => entry.profile)).toContain('courses-dynamic-b');
  });

  test('dynamic registry can supply Intermarché without changing server code', async () => {
    await writeFile(profilesFile, JSON.stringify({
      profiles: {
        'courses-intermarche-file': {
          siteKey: 'intermarche',
          defaultStartUrl: 'https://www.intermarche.com/',
          aliases: ['intermarche-file'],
          securityPolicy: { requireConfirmationForBindingActions: false },
        },
      },
    }), 'utf8');

    const policy = await importPolicyWithProfilesFile(profilesFile);
    expect(policy.resolveManagedBrowserProfile({ profile: 'intermarche-file', site: 'intermarche' })).toMatchObject({
      profile: 'courses-intermarche-file',
      siteKey: 'intermarche',
      profileDir: expect.stringContaining('/.vnc-browser-profiles/courses-intermarche-file'),
      securityPolicy: {
        site: 'intermarche',
        browserOnly: true,
        requireConfirmationForBindingActions: false,
      },
      source: 'dynamic',
    });
  });
});
