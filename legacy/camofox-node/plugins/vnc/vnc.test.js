import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

// Mock the launcher module — index.js no longer imports child_process directly
const mockWatcher = () => {
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.exitCode = null;
  proc.kill = jest.fn();
  return proc;
};
const mockStartWatcher = jest.fn(mockWatcher);
const mockResolveVncConfig = jest.fn((pluginConfig = {}) => ({
  enabled: pluginConfig.enabled || false,
  resolution: pluginConfig.resolution
    ? (pluginConfig.resolution.split('x').length > 2 ? pluginConfig.resolution : `${pluginConfig.resolution}x24`)
    : '1920x1080x24',
  vncPassword: pluginConfig.password || '',
  viewOnly: pluginConfig.viewOnly || false,
  vncPort: pluginConfig.vncPort || '5900',
  novncPort: pluginConfig.novncPort || '6080',
}));

jest.unstable_mockModule('./vnc-launcher.js', () => ({
  resolveVncConfig: mockResolveVncConfig,
  startWatcher: mockStartWatcher,
}));

// Mock auth middleware
jest.unstable_mockModule('../../lib/auth.js', () => ({
  requireAuth: () => (_req, _res, next) => next(),
}));

// Minimal VirtualDisplay mock (real class has side-effects that break in test)
class MockVirtualDisplay {
  get xvfb_args() {
    return ['-screen', '0', '1x1x24', '-ac', '-nolisten', 'tcp'];
  }
}

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');

const { register } = await import('./index.js');
const __dirname = dirname(fileURLToPath(import.meta.url));

describe('vnc plugin', () => {
  let events, ctx, mockApp, routes;

  beforeEach(() => {
    events = new EventEmitter();
    events.setMaxListeners(50);
    routes = {};
    mockApp = {
      get: jest.fn((path, ...handlers) => { routes[`GET ${path}`] = handlers; }),
      post: jest.fn((path, ...handlers) => { routes[`POST ${path}`] = handlers; }),
    };
    ctx = {
      events,
      config: {},
      log: jest.fn(),
      sessions: new Map(),
      safeError: (err) => typeof err === 'string' ? err : (err?.message || 'Internal error'),
      VirtualDisplay: MockVirtualDisplay,
      createVirtualDisplay: () => new MockVirtualDisplay(),
    };
    mockStartWatcher.mockClear();
    mockStartWatcher.mockImplementation(mockWatcher);
    mockResolveVncConfig.mockClear();
    mockResolveVncConfig.mockImplementation((pluginConfig = {}) => ({
      enabled: pluginConfig.enabled || false,
      resolution: pluginConfig.resolution
        ? (pluginConfig.resolution.split('x').length > 2 ? pluginConfig.resolution : `${pluginConfig.resolution}x24`)
        : '1920x1080x24',
      vncPassword: pluginConfig.password || '',
      viewOnly: pluginConfig.viewOnly || false,
      vncPort: pluginConfig.vncPort || '5900',
      novncPort: pluginConfig.novncPort || '6080',
      bind: pluginConfig.bind || '127.0.0.1',
      humanOnly: pluginConfig.humanOnly !== false,
      managedRegistryOnly: pluginConfig.managedRegistryOnly !== false,
    }));
  });

  test('does not register when disabled', async () => {
    await register(mockApp, ctx, {});
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(mockApp.get).not.toHaveBeenCalled();
  });

  test('registers when pluginConfig.enabled is true', async () => {
    await register(mockApp, ctx, { enabled: true });
    expect(mockStartWatcher).toHaveBeenCalled();
    expect(mockApp.get).toHaveBeenCalledWith(
      '/sessions/:userId/storage_state',
      expect.any(Function),
      expect.any(Function),
    );
  });

  test('passes resolved config to startWatcher', async () => {
    await register(mockApp, ctx, { enabled: true, password: 'secret', vncPort: 5901, bind: '0.0.0.0' });
    expect(mockStartWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        vncPassword: 'secret',
        vncPort: 5901,
        bind: '0.0.0.0',
        humanOnly: true,
        managedRegistryOnly: true,
        log: ctx.log,
        events,
      }),
    );
  });

  test('overrides createVirtualDisplay with custom resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1280x720' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1280x720x24');
  });

  test('allows profile-specific Xvfb resolution so noVNC is filled by that profile window', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080' });

    const vd = ctx.createVirtualDisplay({ resolution: '1680x945x24' });
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1680x945x24');
  });

  test('appends x24 depth to WxH resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x24');
  });

  test('preserves explicit depth in resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080x32' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x32');
  });

  test('storage_state endpoint returns 404 for unknown user', async () => {
    await register(mockApp, ctx, { enabled: true });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'unknown' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('storage_state endpoint returns state for active session', async () => {
    await register(mockApp, ctx, { enabled: true });

    const mockState = { cookies: [{ name: 'sid', value: 'abc' }], origins: [] };
    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => mockState) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { json: jest.fn() };

    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith(mockState);
  });

  test('storage_state endpoint uses safeError on failure', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => { throw new Error('context destroyed'); }) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    // safeError returns the message string — not the raw Error object
    expect(res.json).toHaveBeenCalledWith({ error: 'context destroyed' });
  });

  test('emits vnc:storage:exported and session:storage:export on export', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => ({ cookies: [], origins: [] })) },
    });

    const exported = [];
    events.on('vnc:storage:exported', (e) => exported.push(e));
    events.on('session:storage:export', (e) => exported.push(e));

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    await handler(
      { params: { userId: 'user-1' }, reqId: 'test' },
      { json: jest.fn() },
    );

    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({ userId: 'user-1' });
  });

  test('watcher is killed on server:shutdown', async () => {
    await register(mockApp, ctx, { enabled: true });

    const proc = mockStartWatcher.mock.results[0].value;
    events.emit('server:shutdown');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('human VNC LAN auth exception is limited to VNC routes', () => {
    const source = readFileSync(join(__dirname, 'index.js'), 'utf8');

    expect(source).toContain('function isPrivateLanAddress');
    expect(source).toContain('authMiddleware: humanVncAuthMiddleware');
    expect(source).toContain("app.get('/sessions/:userId/storage_state', authMiddleware");
  });

  test('noVNC URL opens with automatic websocket connection parameters', () => {
    const source = readFileSync(join(__dirname, 'index.js'), 'utf8');

    expect(source).toContain('autoconnect=true');
    expect(source).toContain('resize=scale');
    expect(source).toContain('path=websockify');
  });

  test('noVNC patch provides crypto.randomUUID fallback before UI handlers', () => {
    const patch = readFileSync(join(__dirname, 'novnc-error-handler.patch.js'), 'utf8');

    expect(patch).toContain("typeof window.crypto.randomUUID !== 'function'");
    expect(patch).toContain("Object.defineProperty(window.crypto, 'randomUUID'");
    expect(patch.indexOf('Object.defineProperty(window.crypto')).toBeLessThan(patch.indexOf("window.addEventListener('error'"));
  });
});
