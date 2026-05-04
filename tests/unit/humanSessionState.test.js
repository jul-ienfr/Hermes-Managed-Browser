import { createHumanSessionState, updateHumanCursor, getHumanCursor } from '../../lib/human-session-state.js';

describe('human session state', () => {
  test('stores and returns last cursor position', () => {
    const state = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });

    updateHumanCursor(state, { x: 420, y: 240 });

    expect(getHumanCursor(state)).toEqual({ x: 420, y: 240 });
  });

  test('starts from deterministic viewport-relative position when no cursor exists yet', () => {
    const a = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });
    const b = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });

    expect(getHumanCursor(a)).toEqual(getHumanCursor(b));
    expect(getHumanCursor(a).x).toBeGreaterThanOrEqual(0);
    expect(getHumanCursor(a).x).toBeLessThanOrEqual(1000);
    expect(getHumanCursor(a).y).toBeGreaterThanOrEqual(0);
    expect(getHumanCursor(a).y).toBeLessThanOrEqual(800);
  });

  test('clamps cursor updates to viewport bounds', () => {
    const state = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });

    updateHumanCursor(state, { x: 1200, y: -50 });

    expect(getHumanCursor(state)).toEqual({ x: 1000, y: 0 });
  });

  test('session state accepts deterministic string seeds through caller hashing', () => {
    const state = createHumanSessionState({ viewport: { width: 1920, height: 1080 }, seed: 42 });

    expect(state.viewport).toEqual({ width: 1920, height: 1080 });
    expect(state.lastCursor.x).toBeGreaterThan(0);
  });

  test('session includes behavior persona and uses its seed', () => {
    const behaviorPersona = {
      version: 1,
      key: 'user-a:default',
      seed: 98765,
      profile: 'fast',
      motionJitter: 0.2,
    };

    const state = createHumanSessionState({
      viewport: { width: 1000, height: 800 },
      seed: 123,
      behaviorPersona,
    });
    const sameSeed = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 98765 });

    expect(state.behaviorPersona).toEqual(behaviorPersona);
    expect(state.seed).toBe(98765);
    expect(getHumanCursor(state)).toEqual(getHumanCursor(sameSeed));
  });
});
