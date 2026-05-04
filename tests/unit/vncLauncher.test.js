import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const spawn = jest.fn(() => ({
  pid: 1234,
  exitCode: null,
  on: jest.fn(),
  kill: jest.fn(),
}));

jest.unstable_mockModule('node:child_process', () => ({ spawn }));

const { resolveVncConfig, startWatcher } = await import('../../plugins/vnc/vnc-launcher.js');

describe('vnc human-only policy source', () => {
  test('watcher does not scan arbitrary Xvfb displays in managed-registry-only mode', () => {
    const source = fs.readFileSync(path.resolve('plugins/vnc/vnc-watcher.sh'), 'utf8');

    expect(source).toContain('CAMOFOX_VNC_MANAGED_REGISTRY_ONLY="${CAMOFOX_VNC_MANAGED_REGISTRY_ONLY:-1}"');
    expect(source).toContain('if [ "$CAMOFOX_VNC_MANAGED_REGISTRY_ONLY" = "1" ]; then');
    expect(source).toContain('-rfbport $VNC_PORT -localhost');
    expect(source.indexOf('return 1')).toBeLessThan(source.indexOf('ps -eo args='));
  });

  test('health exposes VNC as human-only managed-registry metadata', () => {
    const source = fs.readFileSync(path.resolve('server.js'), 'utf8');

    expect(source).toContain('vncHumanOnly: Boolean(VNC_HEALTH_INFO.humanOnly)');
    expect(source).toContain('vncManagedRegistryOnly: Boolean(VNC_HEALTH_INFO.managedRegistryOnly)');
    expect(source).toContain("vncBind: VNC_HEALTH_INFO.bind || '127.0.0.1'");
  });
});

describe('vnc launcher config', () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv };
    delete process.env.ENABLE_VNC;
    delete process.env.CAMOFOX_VNC_DISPLAY_REGISTRY;
    delete process.env.CAMOFOX_VNC_DISPLAY_SELECTION;
    delete process.env.VNC_BIND;
    delete process.env.CAMOFOX_VNC_HUMAN_ONLY;
    delete process.env.CAMOFOX_VNC_MANAGED_REGISTRY_ONLY;
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test('resolves registry and selection paths from plugin config', () => {
    const config = resolveVncConfig({
      enabled: true,
      displayRegistry: '/tmp/registry.json',
      displaySelection: '/tmp/selected.json',
    });

    expect(config.displayRegistry).toBe('/tmp/registry.json');
    expect(config.displaySelection).toBe('/tmp/selected.json');
  });

  test('defaults VNC to local human-only managed-registry mode', () => {
    const config = resolveVncConfig({ enabled: true });

    expect(config.bind).toBe('127.0.0.1');
    expect(config.humanOnly).toBe(true);
    expect(config.managedRegistryOnly).toBe(true);
  });

  test('human-only mode ignores public VNC_BIND environment overrides', () => {
    process.env.VNC_BIND = '0.0.0.0';

    const config = resolveVncConfig({ enabled: true, humanOnly: true, bind: '127.0.0.1' });

    expect(config.bind).toBe('127.0.0.1');
  });

  test('passes human-only local bind and registry-only policy to the watcher', () => {
    startWatcher({
      resolution: '1920x1080x24',
      vncPassword: '',
      viewOnly: false,
      vncPort: 5901,
      novncPort: 6081,
      bind: '127.0.0.1',
      humanOnly: true,
      managedRegistryOnly: true,
      displayRegistry: '/tmp/registry.json',
      displaySelection: '/tmp/selected.json',
      log: jest.fn(),
      events: { emit: jest.fn() },
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const env = spawn.mock.calls[0][2].env;
    expect(env.VNC_BIND).toBe('127.0.0.1');
    expect(env.CAMOFOX_VNC_HUMAN_ONLY).toBe('1');
    expect(env.CAMOFOX_VNC_MANAGED_REGISTRY_ONLY).toBe('1');
    expect(env.CAMOFOX_VNC_DISPLAY_REGISTRY).toBe('/tmp/registry.json');
    expect(env.CAMOFOX_VNC_DISPLAY_SELECTION).toBe('/tmp/selected.json');
  });
});
