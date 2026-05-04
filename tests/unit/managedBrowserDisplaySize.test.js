import { describe, expect, test } from '@jest/globals';
import {
  enforceProfileWindowBounds,
  managedProfileDisplayResolution,
  managedProfileLaunchArgs,
  managedProfileWindowSize,
  parseDisplaySize,
  safeManagedWindowBounds,
  withManagedProfileLaunchArgs,
} from '../../lib/managed-browser-display-size.js';

const MANAGED_PROFILES = ['leboncoin-cim', 'leboncoin-ge', 'vinted-main', 'emploi-candidature', 'emploi-officiel', 'courses', 'courses-auchan', 'courses-intermarche'];

describe('managed browser display sizing', () => {
  test('parses VNC display sizes with optional depth', () => {
    expect(parseDisplaySize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseDisplaySize('1920x1080x24')).toEqual({ width: 1920, height: 1080 });
  });

  test('uses stable per-profile window sizes under the VNC bounds', () => {
    expect(Object.fromEntries(MANAGED_PROFILES.map((userId) => [userId, managedProfileWindowSize(userId)]))).toEqual({
      'leboncoin-cim': { width: 1920, height: 1080 },
      'leboncoin-ge': { width: 1680, height: 945 },
      'vinted-main': { width: 1440, height: 900 },
      'emploi-candidature': { width: 1600, height: 900 },
      'emploi-officiel': { width: 1440, height: 900 },
      courses: { width: 1536, height: 864 },
      'courses-auchan': { width: 1366, height: 768 },
      'courses-intermarche': { width: 1600, height: 900 },
    });

    for (const userId of MANAGED_PROFILES) {
      const size = managedProfileWindowSize(userId, { vncBounds: '1920x1080x24' });
      expect(size.width).toBeLessThanOrEqual(1920);
      expect(size.height).toBeLessThanOrEqual(1080);
    }
  });

  test('keeps every managed window strictly within small VNC bounds with a safety margin', () => {
    expect(safeManagedWindowBounds('1366x768x24')).toEqual({ width: 1366, height: 768 });
    for (const userId of MANAGED_PROFILES) {
      expect(managedProfileWindowSize(userId, { vncBounds: '1366x768x24' })).toEqual({ width: 1366, height: 768 });
    }
  });

  test('clamps persisted oversized managed profiles instead of trusting stale persisted dimensions', () => {
    const oversized = {
      persona: {
        screen: { width: 3456, height: 1408 },
        window: { outerWidth: 3456, outerHeight: 1408 },
        viewport: { width: 3456, height: 1408 },
        deviceScaleFactor: 2,
      },
      contextDefaults: {
        viewport: { width: 3456, height: 1408 },
        deviceScaleFactor: 2,
      },
      launchConstraints: { os: 'windows', locale: 'fr-FR', screen: null, window: null, webglConfig: null },
    };

    const bounded = enforceProfileWindowBounds(oversized, { userId: 'emploi-candidature', vncBounds: '1920x1080x24' });

    expect(bounded.persona.screen).toEqual({ width: 1600, height: 900 });
    expect(bounded.persona.window).toEqual({ outerWidth: 1600, outerHeight: 900 });
    expect(bounded.persona.viewport).toEqual({ width: 1600, height: 900 });
    expect(bounded.contextDefaults.viewport).toEqual({ width: 1600, height: 900 });
    expect(bounded.contextDefaults.deviceScaleFactor).toBe(1);
    expect(bounded.managedDisplayPolicy.invariant).toBe('profile_window_size_must_not_exceed_vnc_display');
  });

  test('builds browser launch args that replace oversized/default window hints', () => {
    const profile = {
      persona: {
        window: { outerWidth: 1600, outerHeight: 900 },
      },
    };

    expect(managedProfileLaunchArgs(profile)).toEqual([
      '--width=1600',
      '--height=900',
      '--window-size=1600,900',
    ]);

    expect(withManagedProfileLaunchArgs({ args: ['--width=3456', '--foo', '--window-size=3456,1408'] }, profile)).toEqual({
      args: ['--foo', '--width=1600', '--height=900', '--window-size=1600,900'],
    });
  });

  test('derives a per-profile VNC root resolution from the managed profile size', () => {
    const bounded = enforceProfileWindowBounds({ contextDefaults: {} }, { userId: 'leboncoin-ge', vncBounds: '1920x1080' });
    expect(managedProfileDisplayResolution(bounded)).toBe('1680x945x24');
    expect(managedProfileDisplayResolution(bounded, 32)).toBe('1680x945x32');
  });

  test('derives a stable managed size even for profiles without a specific persisted size', () => {
    const profile = { contextDefaults: { viewport: { width: 1728, height: 1117 } } };
    const bounded = enforceProfileWindowBounds(profile, { userId: 'new-managed-profile', vncBounds: '1920x1080' });
    const boundedAgain = enforceProfileWindowBounds(profile, { userId: 'new-managed-profile', vncBounds: '1920x1080' });
    expect(bounded).not.toBe(profile);
    expect(bounded.persona.screen).toEqual(boundedAgain.persona.screen);
    expect(bounded.contextDefaults.viewport).toEqual(bounded.persona.screen);
    expect(bounded.persona.screen.width).toBeLessThanOrEqual(1920);
    expect(bounded.persona.screen.height).toBeLessThanOrEqual(1080);
  });
});
