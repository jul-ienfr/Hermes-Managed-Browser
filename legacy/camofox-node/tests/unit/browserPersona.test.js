import { describe, expect, test } from '@jest/globals';
import { buildBrowserPersona } from '../../lib/browser-persona.js';

const VISIBLE_DISPLAY = { width: 1920, height: 1080 };
const MANAGED_PROFILES = ['leboncoin-cim', 'leboncoin-ge', 'vinted-main', 'courses', 'courses-auchan', 'courses-intermarche'];

describe('buildBrowserPersona', () => {
  test('is deterministic for the same user', () => {
    expect(buildBrowserPersona('agent-alpha')).toEqual(buildBrowserPersona('agent-alpha'));
  });

  test('changes at least one visible persona axis across different users', () => {
    const alpha = buildBrowserPersona('agent-alpha');
    const beta = buildBrowserPersona('agent-beta');

    expect({ os: alpha.os, locale: alpha.locale, screen: alpha.screen }).not.toEqual({
      os: beta.os,
      locale: beta.locale,
      screen: beta.screen,
    });
  });

  test('returns launch-safe shape', () => {
    const persona = buildBrowserPersona('agent-charlie');

    expect(['windows', 'macos', 'linux']).toContain(persona.os);
    expect(persona.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    expect(persona.timezoneId).toContain('/');
    expect(persona.screen.width).toBeGreaterThan(1000);
    expect(persona.window.outerWidth).toBe(persona.screen.width);
    expect(persona.viewport.width).toBeLessThanOrEqual(persona.screen.width);
  });

  test('uses exact screen constraints from the camoufox-js cross-OS safe set for generic profiles', () => {
    const crossOsSafeScreens = new Set(['1536x864', '1728x1117', '1920x1080']);
    const userIds = [
      'agent-alpha',
      'agent-bravo',
      'agent-charlie',
      'test',
      'persistent-vnc-profile',
      '00000000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];

    for (const userId of userIds) {
      const persona = buildBrowserPersona(userId);
      expect(crossOsSafeScreens.has(`${persona.screen.width}x${persona.screen.height}`)).toBe(true);
      expect(persona.launchScreenConstraints).toEqual({
        minWidth: persona.screen.width,
        maxWidth: persona.screen.width,
        minHeight: persona.screen.height,
        maxHeight: persona.screen.height,
      });
    }
  });

  test('managed browser profiles keep stable desktop sizes inside Julien visible display', () => {
    const personas = MANAGED_PROFILES.map((userId) => buildBrowserPersona(userId));

    expect(personas.map((persona) => persona.screen)).toEqual([
      { width: 1920, height: 1080 },
      { width: 1680, height: 945 },
      { width: 1440, height: 900 },
      { width: 1536, height: 864 },
      { width: 1366, height: 768 },
      { width: 1600, height: 900 },
    ]);
  });

  test('managed browser dimensions clamp window viewport and launch constraints to visible display', () => {
    for (const userId of MANAGED_PROFILES) {
      const persona = buildBrowserPersona(userId);

      expect(persona.screen.width).toBeLessThanOrEqual(VISIBLE_DISPLAY.width);
      expect(persona.screen.height).toBeLessThanOrEqual(VISIBLE_DISPLAY.height);
      expect(persona.window.outerWidth).toBeLessThanOrEqual(persona.screen.width);
      expect(persona.window.outerHeight).toBeLessThanOrEqual(persona.screen.height);
      expect(persona.viewport.width).toBeLessThanOrEqual(persona.screen.width);
      expect(persona.viewport.height).toBeLessThanOrEqual(persona.screen.height);
      expect(persona.launchScreenConstraints.maxWidth).toBe(persona.screen.width);
      expect(persona.launchScreenConstraints.maxHeight).toBe(persona.screen.height);
      expect(persona.launchScreenConstraints.maxWidth).toBeLessThanOrEqual(VISIBLE_DISPLAY.width);
      expect(persona.launchScreenConstraints.maxHeight).toBeLessThanOrEqual(VISIBLE_DISPLAY.height);
    }
  });
});
