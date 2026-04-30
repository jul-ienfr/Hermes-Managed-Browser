import { jest } from '@jest/globals';
import {
  createSeededRandom,
  getHumanProfile,
  humanPause,
  humanMove,
  humanClick,
  humanType,
  humanScroll,
  humanPrepareTarget,
  humanSettle,
  effectiveMistakesRate,
  planHumanMotion,
  chooseHumanTargetPoint,
  planHumanScroll,
} from '../../lib/human-actions.js';

function createFakePage() {
  const page = {
    mouse: {
      move: jest.fn(async () => {}),
      down: jest.fn(async () => {}),
      up: jest.fn(async () => {}),
      wheel: jest.fn(async () => {}),
    },
    keyboard: {
      press: jest.fn(async () => {}),
      type: jest.fn(async () => {}),
    },
    waitForTimeout: jest.fn(async () => {}),
    viewportSize: jest.fn(() => ({ width: 800, height: 600 })),
  };
  return page;
}

function createLocator(box = { x: 100, y: 200, width: 80, height: 40 }, overrides = {}) {
  return {
    boundingBox: jest.fn(async () => box),
    focus: jest.fn(async () => {}),
    waitFor: jest.fn(async () => {}),
    scrollIntoViewIfNeeded: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('human browser actions', () => {

  test('planHumanMotion returns deterministic viewport-bounded points with timestamps and final target', () => {
    const rng = createSeededRandom(101);

    const plan = planHumanMotion({
      from: { x: 10, y: 20 },
      to: { x: 500, y: 300 },
      rng,
      viewport: { width: 640, height: 480 },
      includeTimestamps: true,
      profile: 'fast',
    });

    expect(plan.points.length).toBeGreaterThan(10);
    expect(plan.finalPoint).toEqual({ x: 500, y: 300 });
    expect(plan.points.at(-1)).toMatchObject({ x: 500, y: 300 });
    expect(plan.points.every((point) => point.x >= 1 && point.x <= 639 && point.y >= 1 && point.y <= 479)).toBe(true);
    expect(plan.points.every((point) => Number.isFinite(point.atMs))).toBe(true);
    expect(plan.points.at(-1).atMs).toBe(plan.durationMs);
  });

  test('chooseHumanTargetPoint avoids target edges and slows down small targets', () => {
    const smallRng = createSeededRandom(202);
    const largeRng = createSeededRandom(202);
    const small = chooseHumanTargetPoint({ x: 100, y: 200, width: 20, height: 12 }, { rng: smallRng });
    const large = chooseHumanTargetPoint({ x: 100, y: 200, width: 200, height: 120 }, { rng: largeRng });

    expect(small.point.x).toBeGreaterThan(100);
    expect(small.point.x).toBeLessThan(120);
    expect(small.careFactor).toBeGreaterThan(large.careFactor);
  });

  test('planHumanScroll returns uneven bounded wheel events with optional inverse correction', () => {
    const plan = planHumanScroll({ amount: 420, direction: 'down', rng: createSeededRandom(303), inverseCorrectionChance: 1 });

    expect(plan.events.length).toBeGreaterThan(2);
    expect(new Set(plan.events.map((event) => Math.round(event.deltaY))).size).toBeGreaterThan(1);
    expect(plan.events.at(-1).deltaY).toBeLessThan(0);
    expect(Math.abs(plan.events.reduce((sum, event) => sum + event.deltaY, 0))).toBeLessThanOrEqual(420 + 60);
  });
  test('profile defaults to fast human timings', () => {
    const profile = getHumanProfile();

    expect(profile.name).toBe('fast');
    expect(profile.click.pauseBeforeDownMs[1]).toBeLessThanOrEqual(80);
    expect(profile.typing.keystrokeDelayMs[1]).toBeLessThanOrEqual(80);
    expect(profile.scroll.steps[0]).toBeGreaterThanOrEqual(2);
  });

  test('humanPause waits within the configured jittered range', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(123);

    const waited = await humanPause(page, [100, 200], { rng, jitter: 0 });

    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThanOrEqual(200);
    expect(page.waitForTimeout).toHaveBeenCalledWith(waited);
  });

  test('humanMove follows many browser mouse steps instead of teleporting', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(7);

    await humanMove(page, { from: { x: 0, y: 0 }, to: { x: 300, y: 120 }, rng });

    expect(page.mouse.move.mock.calls.length).toBeGreaterThan(10);
    expect(page.waitForTimeout.mock.calls.length).toBe(page.mouse.move.mock.calls.length);
    expect(page.mouse.move.mock.calls.every((call) => call[2]?.steps === 1)).toBe(true);
    const [lastX, lastY] = page.mouse.move.mock.calls.at(-1);
    expect(lastX).toBeGreaterThan(250);
    expect(lastX).toBeLessThan(350);
    expect(lastY).toBeGreaterThan(80);
    expect(lastY).toBeLessThan(160);
  });

  test('humanClick moves to a jittered element point, pauses, then uses browser mouse down/up', async () => {
    const page = createFakePage();
    const locator = createLocator();
    const rng = createSeededRandom(11);

    const result = await humanClick(page, locator, { rng, from: { x: 0, y: 0 } });

    expect(locator.boundingBox).toHaveBeenCalled();
    expect(page.mouse.move.mock.calls.length).toBeGreaterThan(5);
    expect(page.mouse.down).toHaveBeenCalledTimes(1);
    expect(page.mouse.up).toHaveBeenCalledTimes(1);
    expect(result.position.x).toBeGreaterThan(100);
    expect(result.position.x).toBeLessThan(180);
    expect(result.position.y).toBeGreaterThan(200);
    expect(result.position.y).toBeLessThan(240);
  });

  test('humanClick starts movement from provided cursor and returns updated cursor', async () => {
    const page = createFakePage();
    const locator = createLocator({ x: 500, y: 300, width: 100, height: 50 });
    const rng = createSeededRandom(33);

    const result = await humanClick(page, locator, {
      rng,
      from: { x: 400, y: 250 },
    });

    const firstMove = page.mouse.move.mock.calls[0];
    expect(firstMove[0]).toBeGreaterThan(390);
    expect(firstMove[1]).toBeGreaterThan(240);
    expect(result.cursor).toEqual(result.position);
  });

  test('humanClick can fall back to bounding box when Playwright visible wait hangs', async () => {
    const page = createFakePage();
    const locator = createLocator(
      { x: 100, y: 200, width: 80, height: 40 },
      { waitFor: jest.fn(async () => { throw new Error('locator.waitFor timed out'); }) }
    );
    const rng = createSeededRandom(11);
    await expect(humanClick(page, locator, { rng, allowBoundingBoxFallback: false })).rejects.toThrow('locator.waitFor timed out');

    const result = await humanClick(page, locator, { rng, allowBoundingBoxFallback: true });

    expect(locator.waitFor).toHaveBeenCalled();
    expect(locator.boundingBox).toHaveBeenCalled();
    expect(page.mouse.down).toHaveBeenCalledTimes(1);
    expect(page.mouse.up).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  test('humanMove clamps cursor path to the visible viewport', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(9);

    const result = await humanMove(page, {
      from: { x: 4000, y: -200 },
      to: { x: 900, y: 700 },
      rng,
      steps: 2,
    });

    expect(result.position).toEqual({ x: 799, y: 599 });
    for (const [x, y] of page.mouse.move.mock.calls) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(799);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(599);
    }
  });

  test('humanMove can use explicit session viewport when the browser viewport API is unavailable', async () => {
    const page = createFakePage();
    page.viewportSize = undefined;
    const rng = createSeededRandom(9);

    const result = await humanMove(page, {
      from: { x: 4000, y: -200 },
      to: { x: 900, y: 700 },
      viewport: { width: 640, height: 480 },
      rng,
      steps: 2,
    });

    expect(result.position).toEqual({ x: 639, y: 479 });
    for (const [x, y] of page.mouse.move.mock.calls) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(639);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(479);
    }
  });

  test('humanMove can overshoot then correct exactly to target', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(2);

    const result = await humanMove(page, {
      from: { x: 0, y: 0 },
      to: { x: 500, y: 0 },
      rng,
      overshootChance: 1,
    });

    const xs = page.mouse.move.mock.calls.map((call) => call[0]);
    expect(Math.max(...xs)).toBeGreaterThan(500);
    expect(result.overshot).toBe(true);
    expect(result.position).toEqual({ x: 500, y: 1 });
    expect(page.mouse.move.mock.calls.at(-1)).toEqual([500, 1, { steps: 1 }]);
  });

  test('humanMove skips overshoot for short moves even when forced', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(2);

    const result = await humanMove(page, {
      from: { x: 0, y: 0 },
      to: { x: 80, y: 0 },
      rng,
      overshootChance: 1,
    });

    const xs = page.mouse.move.mock.calls.map((call) => call[0]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(82);
    expect(result.overshot).toBe(false);
    expect(result.position).toEqual({ x: 80, y: 1 });
  });

  test('humanSettle adds tiny movements around target and returns to target', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(45);
    const position = { x: 250, y: 125 };

    const result = await humanSettle(page, position, { rng, enabled: true, moves: 3 });

    expect(result.moves).toBe(3);
    expect(result.position).toEqual(position);
    expect(page.mouse.move).toHaveBeenCalledTimes(3);
    for (const [x, y] of page.mouse.move.mock.calls) {
      expect(Math.hypot(x - position.x, y - position.y)).toBeLessThanOrEqual(3.1);
    }
    expect(page.mouse.move.mock.calls.at(-1)).toEqual([250, 125]);
  });

  test('humanClick settles with tiny moves after main movement and before mouse down when enabled', async () => {
    const page = createFakePage();
    const locator = createLocator({ x: 500, y: 300, width: 100, height: 50 });
    const rng = createSeededRandom(33);

    await humanClick(page, locator, {
      rng,
      from: { x: 400, y: 250 },
      settleJitter: true,
      settleMoves: 2,
    });

    const downOrder = page.mouse.down.mock.invocationCallOrder[0];
    const moveOrders = page.mouse.move.mock.invocationCallOrder;
    const moveCalls = page.mouse.move.mock.calls;
    const settleCalls = moveCalls.slice(-2);
    expect(moveOrders.at(-1)).toBeLessThan(downOrder);
    expect(moveOrders.at(-3)).toBeLessThan(moveOrders.at(-2));
    expect(settleCalls).toHaveLength(2);
    const [targetX, targetY] = settleCalls.at(-1);
    for (const [x, y] of settleCalls) {
      expect(Math.hypot(x - targetX, y - targetY)).toBeLessThanOrEqual(3.1);
    }
  });

  test('humanType focuses and types character-by-character with variable browser keyboard delays', async () => {
    const page = createFakePage();
    const locator = createLocator();
    const rng = createSeededRandom(19);

    await humanType(page, locator, 'salut', { rng, clearFirst: false, mistakesRate: 0 });

    expect(locator.focus).toHaveBeenCalled();
    expect(page.keyboard.type).toHaveBeenCalledTimes(5);
    expect(page.keyboard.type.mock.calls.map((call) => call[0]).join('')).toBe('salut');
    const delays = page.keyboard.type.mock.calls.map((call) => call[1].delay);
    expect(new Set(delays).size).toBeGreaterThan(1);
    expect(delays.every((delay) => delay >= 12 && delay <= 65)).toBe(true);
  });

  test('humanType can make and correct a typo using adjacent keys', async () => {
    const page = createFakePage();
    const locator = createLocator();
    const rng = createSeededRandom(1);

    await humanType(page, locator, 'aaaa', { rng, clearFirst: false, mistakesRate: 1 });

    expect(page.keyboard.press).toHaveBeenCalledWith('Backspace');
    expect(page.keyboard.type.mock.calls.length).toBeGreaterThan(4);
  });

  test('effectiveMistakesRate disables typo behavior for sensitive input kinds', () => {
    for (const inputKind of ['password', 'email', 'tel', 'otp', 'code', 'url', 'number']) {
      expect(effectiveMistakesRate({ inputKind, mistakesRate: 1 })).toBe(0);
    }
    expect(effectiveMistakesRate({ inputKind: 'search', mistakesRate: 0.25 })).toBe(0.25);
    expect(effectiveMistakesRate({ mistakesRate: undefined })).toBe(0.02);
  });

  test('humanType suppresses typo corrections for sensitive input kinds', async () => {
    const page = createFakePage();
    const locator = createLocator();
    const rng = createSeededRandom(1);

    await humanType(page, locator, 'user@example.com', {
      rng,
      clearFirst: false,
      mistakesRate: 1,
      inputKind: 'email',
    });

    expect(page.keyboard.press).not.toHaveBeenCalledWith('Backspace');
    expect(page.keyboard.type.mock.calls.map((call) => call[0]).join('')).toBe('user@example.com');
  });

  test('humanScroll splits wheel movement into several browser wheel events with pauses', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(23);

    const result = await humanScroll(page, { direction: 'down', amount: 500, rng });

    expect(result.steps).toBeGreaterThanOrEqual(2);
    expect(page.mouse.wheel).toHaveBeenCalledTimes(result.steps);
    expect(page.waitForTimeout.mock.calls.length).toBeGreaterThanOrEqual(result.steps);
    const totalY = page.mouse.wheel.mock.calls.reduce((sum, call) => sum + call[1], 0);
    expect(totalY).toBeGreaterThan(0);
  });

  test('humanScroll sends uneven wheel bursts by default', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(99);

    const result = await humanScroll(page, { direction: 'down', amount: 800, rng });

    const deltas = page.mouse.wheel.mock.calls.map((call) => call[1]);
    expect(result.bursty).toBe(true);
    expect(new Set(deltas.map((delta) => Math.round(Math.abs(delta)))).size).toBeGreaterThan(1);
    expect(deltas.every((delta) => delta > 0)).toBe(true);
  });

  test('humanScroll can add an inverse wheel correction for larger scrolls', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(25);

    const result = await humanScroll(page, {
      direction: 'down',
      amount: 500,
      rng,
      inverseCorrectionChance: 1,
    });

    const deltas = page.mouse.wheel.mock.calls.map((call) => call[1]);
    expect(result.inverseCorrection).toBe(true);
    expect(deltas.some((delta) => delta < 0)).toBe(true);
  });

  test('humanScroll skips inverse wheel correction for small scrolls', async () => {
    const page = createFakePage();
    const rng = createSeededRandom(101);

    const result = await humanScroll(page, {
      direction: 'down',
      amount: 120,
      rng,
      inverseCorrectionChance: 1,
    });

    const deltas = page.mouse.wheel.mock.calls.map((call) => call[1]);
    expect(result.inverseCorrection).toBe(false);
    expect(deltas.every((delta) => delta > 0)).toBe(true);
  });

  test('humanPrepareTarget scrolls element into comfortable viewport when requested', async () => {
    const page = createFakePage();
    page.viewportSize = jest.fn(() => ({ width: 1000, height: 700 }));
    const locator = createLocator({ x: 100, y: 900, width: 200, height: 50 });
    const rng = createSeededRandom(44);

    const result = await humanPrepareTarget(page, locator, { rng, viewport: { width: 1000, height: 700 } });

    expect(locator.boundingBox).toHaveBeenCalled();
    expect(page.mouse.wheel).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, box: { x: 100, y: 900, width: 200, height: 50 } });
  });

  test('humanPrepareTarget rejects invisible elements before action', async () => {
    const page = createFakePage();
    const locator = createLocator(null);

    await expect(humanPrepareTarget(page, locator)).rejects.toThrow('Element not visible');
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });
});
