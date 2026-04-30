import { describe, expect, test, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

describe('challenge resolution config', () => {
  afterEach(() => {
    delete process.env.CAMOFOX_CHALLENGE_RESOLUTION_MODE;
    delete process.env.CAMOFOX_CHALLENGE_ALLOWLIST;
  });

  test('defaults to manual VNC mode', () => {
    expect(loadConfig().challengeResolution).toEqual({ mode: 'manual_vnc', allowlist: [] });
  });

  test('loads disabled/controlled mode allowlist from environment', () => {
    process.env.CAMOFOX_CHALLENGE_RESOLUTION_MODE = 'auto_controlled_lab_only';
    process.env.CAMOFOX_CHALLENGE_ALLOWLIST = 'demo.local, owned.test';

    expect(loadConfig().challengeResolution).toEqual({
      mode: 'auto_controlled_lab_only',
      allowlist: ['demo.local', 'owned.test'],
    });
  });
});
