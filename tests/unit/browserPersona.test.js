import { buildBrowserPersona } from '../../lib/browser-persona.js';

describe('buildBrowserPersona', () => {
  test('is deterministic for the same user', () => {
    expect(buildBrowserPersona('agent-alpha')).toEqual(buildBrowserPersona('agent-alpha'));
  });

  test('changes at least one visible persona axis across different users', () => {
    const alpha = buildBrowserPersona('agent-alpha');
    const bravo = buildBrowserPersona('agent-bravo');
    expect(
      alpha.os !== bravo.os
      || alpha.locale !== bravo.locale
      || alpha.screen.width !== bravo.screen.width
      || alpha.screen.height !== bravo.screen.height
    ).toBe(true);
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

  test('keeps the visible browser viewport close to the VNC display size', () => {
    const persona = buildBrowserPersona('persistent-vnc-profile');
    expect(persona.screen.width).toBeGreaterThanOrEqual(1366);
    expect(persona.screen.height).toBeGreaterThanOrEqual(768);
    expect(persona.window.outerWidth).toBe(persona.screen.width);
    expect(persona.window.outerHeight).toBe(persona.screen.height);
    expect(persona.viewport.width).toBe(persona.screen.width);
    expect(persona.viewport.height).toBe(persona.screen.height);
    expect(persona.launchScreenConstraints).toEqual({
      minWidth: persona.screen.width,
      maxWidth: persona.screen.width,
      minHeight: persona.screen.height,
      maxHeight: persona.screen.height,
    });
  });

  test('uses exact screen constraints from the camoufox-js cross-OS safe set', () => {
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
});
