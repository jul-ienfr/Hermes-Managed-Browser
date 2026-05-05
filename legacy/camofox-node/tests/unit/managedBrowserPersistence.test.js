import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUserPersistencePaths } from '../../lib/persistence.js';
import { resolveManagedBrowserProfile } from '../../lib/managed-browser-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');
const pluginSource = fs.readFileSync(path.join(rootDir, 'plugin.ts'), 'utf-8');
const persistencePluginSource = fs.readFileSync(path.join(rootDir, 'plugins/persistence/index.js'), 'utf-8');

describe('managed browser persistence isolation', () => {
  test('Leboncoin managed profiles persist storage under distinct roots and user directories', () => {
    const ju = resolveManagedBrowserProfile({ profile: 'leboncoin-cim' });
    const ge = resolveManagedBrowserProfile({ profile: 'leboncoin-ge' });

    const juPaths = getUserPersistencePaths(ju.profileDir, ju.userId);
    const gePaths = getUserPersistencePaths(ge.profileDir, ge.userId);

    expect(ju.profileDir).not.toBe(ge.profileDir);
    expect(ju.userId).not.toBe(ge.userId);
    expect(juPaths.rootDir).toBe(path.resolve(ju.profileDir));
    expect(gePaths.rootDir).toBe(path.resolve(ge.profileDir));
    expect(juPaths.userDir).not.toBe(gePaths.userDir);
    expect(juPaths.storageStatePath).not.toBe(gePaths.storageStatePath);
    expect(juPaths.browserProfilePath).not.toBe(gePaths.browserProfilePath);
    expect(juPaths.metaPath).not.toBe(gePaths.metaPath);
    expect(juPaths.storageStatePath).toContain(path.resolve(ju.profileDir));
    expect(gePaths.storageStatePath).toContain(path.resolve(ge.profileDir));
  });

  test('managed tab creation forwards profileDir and managed marker to the server runtime', () => {
    expect(pluginSource).toContain('profileDir: policy.profileDir');
    expect(pluginSource).toContain('managedBrowser: true');
    expect(pluginSource).toContain('siteKey: policy.siteKey');
    expect(pluginSource).toContain('managedTabCreatePayload(policy, targetUrl)');
    expect(pluginSource).toContain('managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)');
    expect(serverSource).toContain('function assertRawTabCreateAllowed');
    expect(serverSource).toContain('Raw tab creation is disabled for managed Leboncoin profile');
  });

  test('server exposes explicit managed visible tab creation without external window adoption', () => {
    expect(serverSource).toContain("app.post('/managed/visible-tab'");
    expect(serverSource).toContain('if (display) requireSharedDisplayForUser(userId, display)');
    expect(serverSource).toContain('await getSession(userId, { profileDir })');
    expect(serverSource).toContain('async function createServerOwnedTab');
    expect(serverSource).toContain('const page = await session.context.newPage()');
    expect(serverSource).toContain('getTabGroup(session, sessionKey)');
    expect(serverSource).toContain('visible: true');
    expect(serverSource).not.toContain('remote-debugging-port');
  });

  test('server uses request profileDir as the persistence root for managed sessions', () => {
    expect(serverSource).toContain('function resolveProfileRoot(profileDir)');
    expect(serverSource).toContain('const profileRoot = resolveProfileRoot(profileDir);');
    expect(serverSource).toContain('loadPersistedBrowserProfile(profileRoot, userId');
    expect(serverSource).toContain('profileDir: profileRoot');
    expect(serverSource).toContain('await getSession(userId, { profileDir })');
    expect(serverSource).toContain('await ensureBrowser(userId, { profileDir })');
    expect(serverSource).toContain('profileDir: session.profileDir');
  });

  test('persistence plugin stores storage state under each session profileDir', () => {
    expect(persistencePluginSource).toContain('profileDir: sessionProfileDir');
    expect(persistencePluginSource).toContain('const effectiveProfileDir = sessionProfileDir || profileDir');
    expect(persistencePluginSource).toContain('loadPersistedStorageState(effectiveProfileDir, userId');
    expect(persistencePluginSource).toContain('persistStorageState({ profileDir: sessionProfileDir || profileDir');
    expect(persistencePluginSource).toContain("session:storage:checkpoint");
    expect(serverSource).toContain("app.post('/managed/storage-checkpoint'");
  });
});
