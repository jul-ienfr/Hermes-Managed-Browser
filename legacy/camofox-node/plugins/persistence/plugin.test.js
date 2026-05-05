import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';

describe('persistence plugin', () => {
  let tmpDir, events, ctx, mockApp;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persist-plugin-'));
    events = createPluginEvents();
    mockApp = {};
    ctx = {
      events,
      config: { cookiesDir: path.join(tmpDir, 'cookies') },
      log: jest.fn(),
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('skips registration when no profileDir configured', async () => {
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no profileDir'));
  });

  test('restores persisted state on session:creating', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    // Simulate a prior persisted state
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-1');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [],
    }));

    const contextOptions = { viewport: { width: 1280, height: 720 } };
    await events.emitAsync('session:creating', { userId: 'user-1', contextOptions });

    expect(contextOptions.storageState).toBe(storageStatePath);
  });

  test('checkpoints on session:cookies:import', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: '.test.com', path: '/' }] }));
      }),
    };

    // Simulate session created then cookie import
    await events.emitAsync('session:created', { userId: 'user-2', context: mockContext });
    await events.emitAsync('session:cookies:import', { userId: 'user-2' });

    expect(mockContext.storageState).toHaveBeenCalled();

    // Verify file was written
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('x');
  });

  test('restores and checkpoints managed sessions under their session profileDir', async () => {
    await register(mockApp, ctx, { profileDir: path.join(tmpDir, 'default-root') });

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const juRoot = path.join(tmpDir, 'leboncoin-cim');
    const geRoot = path.join(tmpDir, 'leboncoin-ge');
    const juPaths = getUserPersistencePaths(juRoot, 'leboncoin-cim');
    const gePaths = getUserPersistencePaths(geRoot, 'leboncoin-ge');

    await fs.mkdir(juPaths.userDir, { recursive: true });
    await fs.writeFile(juPaths.storageStatePath, JSON.stringify({
      cookies: [{ name: 'ju', value: '1', domain: '.example.com', path: '/' }],
      origins: [],
    }));

    const contextOptions = {};
    await events.emitAsync('session:creating', { userId: 'leboncoin-cim', contextOptions, profileDir: juRoot });
    expect(contextOptions.storageState).toBe(juPaths.storageStatePath);

    const juContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'ju2', value: '2', domain: '.example.com', path: '/' }], origins: [] }));
      }),
    };
    const geContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'ge', value: '1', domain: '.example.com', path: '/' }], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'leboncoin-cim', context: juContext, profileDir: juRoot });
    await events.emitAsync('session:created', { userId: 'leboncoin-ge', context: geContext, profileDir: geRoot });
    await events.emitAsync('session:cookies:import', { userId: 'leboncoin-cim' });
    await events.emitAsync('session:destroying', { userId: 'leboncoin-ge', context: geContext, profileDir: geRoot, reason: 'test' });

    const juSaved = JSON.parse(await fs.readFile(juPaths.storageStatePath, 'utf8'));
    const geSaved = JSON.parse(await fs.readFile(gePaths.storageStatePath, 'utf8'));
    expect(juSaved.cookies[0].name).toBe('ju2');
    expect(geSaved.cookies[0].name).toBe('ge');
  });

  test('checkpoints on explicit session:storage:checkpoint', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const managedRoot = path.join(tmpDir, 'managed-root');
    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'sid', value: '1', domain: '.example.com', path: '/' }], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'leboncoin-cim', context: mockContext, profileDir: managedRoot });
    await events.emitAsync('session:storage:checkpoint', { userId: 'leboncoin-cim', reason: 'manual_login', profileDir: managedRoot });

    expect(mockContext.storageState).toHaveBeenCalledTimes(1);

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(managedRoot, 'leboncoin-cim');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('sid');
  });

  test('checkpoints on session:destroying before context close', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'user-3', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-3', reason: 'test', context: mockContext });
    await events.emitAsync('session:destroyed', { userId: 'user-3', reason: 'test' });

    expect(mockContext.storageState).toHaveBeenCalledTimes(1);
  });

  test('env var CAMOFOX_PROFILE_DIR overrides pluginConfig', async () => {
    const envDir = path.join(tmpDir, 'env-override');
    const orig = process.env.CAMOFOX_PROFILE_DIR;
    process.env.CAMOFOX_PROFILE_DIR = envDir;
    try {
      await register(mockApp, ctx, { profileDir: '/should/not/use' });
      expect(ctx.log).toHaveBeenCalledWith('info', 'persistence plugin enabled', { profileDir: envDir });
    } finally {
      if (orig === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
      else process.env.CAMOFOX_PROFILE_DIR = orig;
    }
  });
});
