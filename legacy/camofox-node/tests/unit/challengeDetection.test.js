import { describe, expect, test } from '@jest/globals';
import {
  classifyChallengeSignal,
  collectChallengeDiagnostics,
  resolveChallengePolicy,
  normalizeChallengeResolutionConfig,
} from '../../lib/challenge-detection.js';

describe('challenge detection and policy', () => {
  test('classifies common challenge providers without solving them', () => {
    const urls = [
      'https://www.google.com/recaptcha/api2/anchor',
      'https://newassets.hcaptcha.com/captcha/v1',
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://client-api.arkoselabs.com/fc/gc/',
      'https://token.awswaf.com/',
    ];

    expect(urls.map((url) => classifyChallengeSignal({ url }).provider)).toEqual([
      'recaptcha', 'hcaptcha', 'turnstile', 'arkose', 'aws_waf',
    ]);
  });

  test('collects redacted iframe diagnostics and never exposes secret-like values', () => {
    const diagnostics = collectChallengeDiagnostics({
      url: 'https://example.test/login?token=secret-value',
      title: 'Please verify',
      frames: [
        { url: 'https://www.google.com/recaptcha/api2/anchor?k=site-key&secret=hidden', name: 'a', boundingBox: { x: 1, y: 2, width: 300, height: 80 } },
      ],
      headers: { authorization: 'Bearer secret', cookie: 'sid=secret', 'user-agent': 'Mozilla/5.0' },
      devicePixelRatio: 2,
    });

    expect(diagnostics.detected).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('secret-value');
    expect(JSON.stringify(diagnostics)).not.toContain('Bearer secret');
    expect(JSON.stringify(diagnostics)).toContain('[REDACTED]');
  });

  test('manual mode returns human_required and disabled mode blocks without VNC', () => {
    const signal = { detected: true, provider: 'turnstile', category: 'managed_challenge' };

    expect(resolveChallengePolicy(signal, normalizeChallengeResolutionConfig({ mode: 'manual_vnc' }))).toMatchObject({
      ok: false,
      error: 'human_required',
      exposeVnc: true,
      retryAllowed: false,
      llmRepairAllowed: false,
    });
    expect(resolveChallengePolicy(signal, normalizeChallengeResolutionConfig({ mode: 'disabled' }))).toMatchObject({
      ok: false,
      error: 'challenge_blocked',
      exposeVnc: false,
    });
  });

  test('auto controlled mode requires allowlist and is blocked for real managed accounts', () => {
    expect(normalizeChallengeResolutionConfig({ mode: 'auto_controlled_lab_only', allowlist: ['demo.local'] })).toMatchObject({
      mode: 'auto_controlled_lab_only',
      allowlist: ['demo.local'],
    });

    expect(resolveChallengePolicy(
      { detected: true, provider: 'recaptcha', url: 'https://www.leboncoin.fr/' },
      normalizeChallengeResolutionConfig({ mode: 'auto_controlled_lab_only', allowlist: ['demo.local'] }),
      { managedAccountKind: 'leboncoin' },
    )).toMatchObject({ error: 'human_required', autoAllowed: false });
  });
});
