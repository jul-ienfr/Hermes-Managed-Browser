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

    expect(snapshot.viewport).toEqual({ width: 1440, height: 900 });
    expect(snapshot.webdriver).toBeDefined();
    expect(snapshot.languages).toBeDefined();
  });
});
