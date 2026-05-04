import { buildHumanBehaviorPersona } from '../../lib/human-behavior-persona.js';

describe('human behavior persona', () => {
  test('is deterministic for same profile key', () => {
    expect(buildHumanBehaviorPersona('leboncoin-ge')).toEqual(buildHumanBehaviorPersona('leboncoin-ge'));
  });

  test('varies across profile keys while keeping fast default', () => {
    const a = buildHumanBehaviorPersona('leboncoin-ge');
    const b = buildHumanBehaviorPersona('leboncoin-cim');

    expect(a.profile).toBe('fast');
    expect(b.profile).toBe('fast');
    expect(a.seed).not.toBe(b.seed);
    expect(a.motionJitter).not.toBe(b.motionJitter);
  });

  test('applies explicit overrides without changing deterministic seed', () => {
    const base = buildHumanBehaviorPersona('agent-a');
    const overridden = buildHumanBehaviorPersona('agent-a', { profile: 'medium', typoRateText: 0 });

    expect(overridden.seed).toBe(base.seed);
    expect(overridden.profile).toBe('medium');
    expect(overridden.typoRateText).toBe(0);
  });
});
