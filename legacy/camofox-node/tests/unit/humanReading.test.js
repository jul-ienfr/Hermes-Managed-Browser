import { estimateReadingPauseMs } from '../../lib/human-reading.js';

describe('human reading pauses', () => {
  test('reading pause increases with text length but remains bounded for fast profile', () => {
    const shortPause = estimateReadingPauseMs({ textLength: 100, profile: 'fast' });
    const longPause = estimateReadingPauseMs({ textLength: 2000, profile: 'fast' });

    expect(shortPause).toBeLessThan(longPause);
    expect(longPause).toBeLessThanOrEqual(1200);
  });

  test('fast profile keeps very large pages capped near default fast behavior', () => {
    expect(estimateReadingPauseMs({ textLength: 100_000, profile: 'fast' })).toBe(1200);
  });

  test('medium and slow profiles may pause longer than fast for the same text', () => {
    const fastPause = estimateReadingPauseMs({ textLength: 3000, profile: 'fast' });
    const mediumPause = estimateReadingPauseMs({ textLength: 3000, profile: 'medium' });
    const slowPause = estimateReadingPauseMs({ textLength: 3000, profile: 'slow' });

    expect(mediumPause).toBeGreaterThan(fastPause);
    expect(slowPause).toBeGreaterThan(mediumPause);
  });

  test('invalid or tiny text lengths still get a small bounded orientation pause', () => {
    expect(estimateReadingPauseMs({ textLength: -50, profile: 'fast' })).toBeGreaterThanOrEqual(120);
    expect(estimateReadingPauseMs({ textLength: Number.NaN, profile: 'fast' })).toBeLessThanOrEqual(1200);
  });
});
