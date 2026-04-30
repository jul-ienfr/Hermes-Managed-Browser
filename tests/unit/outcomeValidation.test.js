import { describe, expect, test } from '@jest/globals';
import { validateOutcome } from '../../lib/outcome-validation.js';

describe('outcome validation', () => {
  test('passes when urlContains is present in current URL', async () => {
    const pageState = {
      getUrl: async () => 'https://example.com/account/listings',
    };

    await expect(validateOutcome({ urlContains: '/account' }, pageState)).resolves.toMatchObject({
      ok: true,
    });
  });

  test('fails with a textIncludes diagnostic when expected text is absent', async () => {
    const pageState = {
      hasText: async () => false,
    };

    await expect(validateOutcome({ textIncludes: 'Annonce publiée' }, pageState)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('textIncludes'),
    });
  });

  test('returns human_required when challenge diagnostics detect a managed challenge', async () => {
    const pageState = {
      getChallengeDiagnostics: async () => ({ detected: true, provider: 'turnstile', category: 'managed_challenge', url: 'https://example.test/' }),
      challengeResolution: { mode: 'manual_vnc', allowlist: [] },
    };

    await expect(validateOutcome({ textIncludes: 'Dashboard' }, pageState)).resolves.toMatchObject({
      ok: false,
      error: 'human_required',
      exposeVnc: true,
      retryAllowed: false,
      llmRepairAllowed: false,
    });
  });
});
