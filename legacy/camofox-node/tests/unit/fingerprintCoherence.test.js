import { describe, expect, test } from '@jest/globals';
import {
  collectBrowserFingerprintSnapshot,
  redactFingerprintDiagnostics,
  validateFingerprintCoherence,
} from '../../lib/fingerprint-coherence.js';

describe('fingerprint coherence', () => {
  test('flags language timezone platform webdriver and viewport mismatches', () => {
    const result = validateFingerprintCoherence({
      expected: {
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        platform: 'Win32',
        viewport: { width: 1440, height: 900 },
      },
      observed: {
        languages: ['en-US'],
        timezoneId: 'America/New_York',
        platform: 'Linux x86_64',
        webdriver: true,
        viewport: { width: 800, height: 600 },
        storage: { cookiesEnabled: false, localStorageAvailable: false },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining([
      'language_locale_mismatch', 'timezone_mismatch', 'platform_mismatch', 'webdriver_exposed', 'viewport_mismatch', 'storage_unavailable',
    ]));
  });

  test('flags deeper managed browser fingerprint mismatches observed on anti-bot diagnostics', () => {
    const result = validateFingerprintCoherence({
      expected: {
        locale: 'fr-FR',
        languages: ['fr-FR', 'fr', 'en-US', 'en'],
        screen: { width: 1600, height: 900 },
        viewport: { width: 1600, height: 900 },
        webgl: { vendor: 'Intel', renderer: 'Intel(R) HD Graphics, or similar' },
        doNotTrack: '0',
      },
      observed: {
        languages: ['fr-FR'],
        screen: { width: 2560, height: 1440 },
        viewport: { width: 1292, height: 1345 },
        webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar' },
        doNotTrack: '1',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining([
      'viewport_mismatch', 'screen_mismatch', 'webgl_mismatch', 'donottrack_mismatch',
    ]));
  });

  test('redacts cookies authorization and challenge payloads from diagnostics', () => {
    const redacted = redactFingerprintDiagnostics({
      headers: { cookie: 'sid=secret', authorization: 'Bearer secret', accept: 'text/html' },
      challengePayload: 'captcha-secret',
      nested: { token: 'abc', safe: 'ok' },
    });

    expect(redacted.headers.cookie).toBe('[REDACTED]');
    expect(redacted.headers.authorization).toBe('[REDACTED]');
    expect(redacted.challengePayload).toBe('[REDACTED]');
    expect(redacted.nested.token).toBe('[REDACTED]');
    expect(redacted.nested.safe).toBe('ok');
  });

  test('collectBrowserFingerprintSnapshot evaluates browser side fields through page API', async () => {
    const page = {
      viewportSize: () => ({ width: 1440, height: 900 }),
      evaluate: async () => ({
        userAgent: 'Mozilla/5.0',
        platform: 'Win32',
        languages: ['fr-FR', 'fr'],
        language: 'fr-FR',
        webdriver: false,
        timezoneId: 'Europe/Paris',
        storage: { cookiesEnabled: true, localStorageAvailable: true },
      }),
    };

    const snapshot = await collectBrowserFingerprintSnapshot(page);

    expect(snapshot.playwrightViewport).toEqual({ width: 1440, height: 900 });
    expect(snapshot.webdriver).toBeDefined();
    expect(snapshot.languages).toBeDefined();
  });
});
