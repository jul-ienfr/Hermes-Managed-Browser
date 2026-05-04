import { parseResolution, validateVncGeometry } from '../../lib/vnc-geometry-doctor.js';

describe('VNC geometry doctor', () => {
  test('parses Xvfb-style resolutions', () => {
    expect(parseResolution('1600x900x24')).toEqual({ width: 1600, height: 900 });
    expect(parseResolution('bad')).toBeNull();
  });

  test('accepts fill-mode geometry where root, browser screen and viewport fit profile', () => {
    const result = validateVncGeometry({
      expected: { profileWindowSize: { width: 1600, height: 900 } },
      observed: {
        registry: { resolution: '1600x900x24' },
        browser: {
          screen: { width: 1600, height: 900 },
          viewport: { width: 1600, height: 900, outerWidth: 1600, outerHeight: 900 },
        },
      },
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  test('rejects a browser viewport larger than the visible profile window', () => {
    const result = validateVncGeometry({
      expected: { profileWindowSize: { width: 1366, height: 768 } },
      observed: {
        registry: { resolution: '1366x768x24' },
        browser: {
          screen: { width: 1366, height: 768 },
          viewport: { width: 1920, height: 1080, outerWidth: 1920, outerHeight: 1080 },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.key)).toContain('browser_viewport_exceeds_profile_window');
  });
});
