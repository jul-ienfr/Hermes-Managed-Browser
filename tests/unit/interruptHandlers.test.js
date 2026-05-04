import { describe, expect, test } from '@jest/globals';
import { adaptivePacingForInterrupt, chooseCookieConsentCandidate, detectInterrupt } from '../../lib/interrupt-handlers.js';

describe('interrupt handlers', () => {
  test('detects captcha-like human verification', () => {
    const interrupt = detectInterrupt({
      url: 'https://example.com/',
      title: 'Security check',
      text: 'Veuillez confirmer que vous êtes humain captcha',
    });

    expect(interrupt).toMatchObject({
      type: 'human_verification',
      requires_human: true,
    });
  });

  test('detects cookie banner', () => {
    const interrupt = detectInterrupt({
      text: 'Nous utilisons des cookies Accepter Refuser',
    });

    expect(interrupt).toMatchObject({
      type: 'cookie_banner',
    });
    expect(interrupt.requires_human).toBe(false);
  });

  test('detects rate limiting signals', () => {
    const interrupt = detectInterrupt({
      title: '429 Too Many Requests',
      text: 'Réessayez plus tard',
    });

    expect(interrupt).toMatchObject({
      type: 'rate_limited',
      requires_human: false,
    });
  });

  test('chooses preferred cookie consent candidate without LLM', () => {
    const candidate = chooseCookieConsentCandidate([
      { ref: 'e1', role: 'button', name: 'tout accepter' },
      { ref: 'e2', role: 'button', name: 'continuer sans accepter' },
    ]);

    expect(candidate).toMatchObject({ ref: 'e2' });
  });

  test('maps interrupts to deterministic adaptive pacing actions', () => {
    expect(adaptivePacingForInterrupt(null)).toEqual({ action: 'continue', delayMs: 0, reason: 'no_interrupt' });
    expect(adaptivePacingForInterrupt({ type: 'cookie_banner' })).toMatchObject({ action: 'handle_interrupt', reason: 'cookie_banner' });
    expect(adaptivePacingForInterrupt({ type: 'human_verification' })).toMatchObject({ action: 'pause_for_human', reason: 'human_verification' });
    expect(adaptivePacingForInterrupt({ type: 'rate_limited' })).toMatchObject({ action: 'backoff', reason: 'rate_limited' });
  });

  test('scales adaptive pacing by human profile and consecutive interrupts', () => {
    const fast = adaptivePacingForInterrupt({ type: 'rate_limited' }, { profile: 'fast' });
    const slow = adaptivePacingForInterrupt({ type: 'rate_limited' }, { profile: 'slow' });
    const repeated = adaptivePacingForInterrupt({ type: 'rate_limited' }, { profile: 'medium', consecutiveInterrupts: 2 });

    expect(fast.delayMs).toBeLessThan(slow.delayMs);
    expect(repeated.delayMs).toBeGreaterThan(adaptivePacingForInterrupt({ type: 'rate_limited' }, { profile: 'medium' }).delayMs);
  });
});
