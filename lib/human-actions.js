const ADJACENT_KEYS = {
  q: 'wa', w: 'qeas', e: 'rdsw', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yijh', i: 'uokj', o: 'iplk', p: 'ol',
  a: 'qszw', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  0: '9', 1: '2q', 2: '13w', 3: '24e', 4: '35r', 5: '46t', 6: '57y', 7: '68u', 8: '79i', 9: '80o',
};

const PROFILES = {
  fast: {
    name: 'fast',
    speed: 1.25,
    click: { pauseBeforeDownMs: [25, 75], holdMs: [25, 70], pauseAfterMs: [50, 130] },
    typing: { keystrokeDelayMs: [12, 65], wordPauseMs: [25, 90], correctionPauseMs: [60, 160] },
    scroll: { steps: [2, 5], stepPauseMs: [10, 35], pauseAfterMs: [45, 120] },
  },
  medium: {
    name: 'medium',
    speed: 1,
    click: { pauseBeforeDownMs: [90, 220], holdMs: [55, 150], pauseAfterMs: [180, 420] },
    typing: { keystrokeDelayMs: [40, 220], wordPauseMs: [80, 260], correctionPauseMs: [160, 420] },
    scroll: { steps: [4, 9], stepPauseMs: [30, 90], pauseAfterMs: [140, 360] },
  },
  slow: {
    name: 'slow',
    speed: 0.7,
    click: { pauseBeforeDownMs: [140, 360], holdMs: [70, 190], pauseAfterMs: [260, 700] },
    typing: { keystrokeDelayMs: [65, 320], wordPauseMs: [140, 420], correctionPauseMs: [240, 700] },
    scroll: { steps: [5, 12], stepPauseMs: [45, 130], pauseAfterMs: [220, 600] },
  },
};

export function getHumanProfile(name = 'fast') {
  return PROFILES[name] || PROFILES.fast;
}

export function createSeededRandom(seed = Date.now()) {
  let state = Number(seed) >>> 0;
  return function rng() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function defaultRng() {
  return Math.random();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rand(rng, min, max) {
  return min + (max - min) * rng();
}

function randInt(rng, min, max) {
  return Math.floor(rand(rng, min, max + 1));
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function jitter(value, percent, rng) {
  return Math.max(0, value + gaussian(rng) * value * percent);
}

function rangeDelay(range, rng, { jitterPercent = 0.15 } = {}) {
  const [min, max] = range;
  const mean = (min + max) / 2;
  const sigma = Math.max(1, (max - min) / 4);
  const sampled = clamp(mean + gaussian(rng) * sigma, min, max);
  return Math.round(clamp(jitter(sampled, jitterPercent, rng), min, max));
}

export async function humanPause(page, range = [80, 240], options = {}) {
  const rng = options.rng || defaultRng;
  const delay = rangeDelay(range, rng, { jitterPercent: options.jitter ?? 0.15 });
  if (page?.waitForTimeout) {
    const sleep = page.waitForTimeout(delay);
    const guardMs = Math.max(delay + 250, Number(options.timeoutMs) || 1000);
    await Promise.race([
      sleep.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, guardMs)),
    ]);
  }
  return delay;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function bezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}

function humanPath(from, to, steps, rng, randomness = 0.22) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const perp = { x: -dy / distance, y: dx / distance };
  const p1Offset = rand(rng, 0.2, 0.4);
  const p2Offset = rand(rng, 0.6, 0.8);
  const dev1 = distance * randomness * rand(rng, -1, 1);
  const dev2 = distance * randomness * rand(rng, -1, 1);
  const p1 = { x: from.x + dx * p1Offset + perp.x * dev1, y: from.y + dy * p1Offset + perp.y * dev1 };
  const p2 = { x: from.x + dx * p2Offset + perp.x * dev2, y: from.y + dy * p2Offset + perp.y * dev2 };
  const path = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = easeInOutCubic(i / steps);
    const point = bezier(from, p1, p2, to, t);
    path.push({ x: point.x + gaussian(rng) * 0.5, y: point.y + gaussian(rng) * 0.5 });
  }
  return path;
}

function clampPointToViewport(point, viewport, { edgePadding = 0 } = {}) {
  if (!viewport) return point;
  const maxX = Math.max(edgePadding, viewport.width - 1);
  const maxY = Math.max(edgePadding, viewport.height - 1);
  return {
    x: clamp(point.x, edgePadding, maxX),
    y: clamp(point.y, edgePadding, maxY),
  };
}

async function boundedMouseMove(page, x, y, timeout = 1000) {
  const timeoutMs = Math.max(500, timeout);
  const controller = new AbortController();
  const move = page.mouse.move(x, y, { steps: 1 }).then(
    () => ({ timedOut: false }),
    () => ({ timedOut: true })
  );
  const guard = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
  const result = await Promise.race([move, guard]);
  controller.abort();
  if (result.timedOut) {
    const err = new Error('mouse move soft timeout');
    err.code = 'mouse_move_soft_timeout';
    throw err;
  }
  return result;
}

async function playMousePath(page, path, interval, rng, options = {}) {
  const moveTimeout = options.moveTimeout ?? 1000;
  const viewport = options.viewport || null;
  let skippedMoves = 0;
  for (const rawPoint of path) {
    const point = clampPointToViewport(rawPoint, viewport);
    try {
      await boundedMouseMove(page, point.x, point.y, moveTimeout);
      skippedMoves = 0;
    } catch (err) {
      if (err.code !== 'mouse_move_soft_timeout') throw err;
      skippedMoves += 1;
      if (skippedMoves >= (options.maxSkippedMoves ?? 1)) break;
    }
    await humanPause(page, [Math.max(5, interval * 0.7), interval * 1.3], { rng, jitter: 0.25 });
  }
}


export function chooseHumanTargetPoint(box, options = {}) {
  if (!box) throw new Error('chooseHumanTargetPoint requires a box');
  const rng = options.rng || defaultRng;
  const minDimension = Math.max(1, Math.min(Number(box.width) || 1, Number(box.height) || 1));
  const careFactor = clamp(1 + (44 - Math.min(44, minDimension)) / 44, 1, 2);
  const marginX = Math.min(Math.max(2, box.width * 0.2 * careFactor), Math.max(2, box.width / 2 - 1));
  const marginY = Math.min(Math.max(2, box.height * 0.2 * careFactor), Math.max(2, box.height / 2 - 1));
  const minX = box.x + marginX;
  const maxX = box.x + Math.max(marginX, box.width - marginX);
  const minY = box.y + marginY;
  const maxY = box.y + Math.max(marginY, box.height - marginY);
  return {
    point: {
      x: rand(rng, Math.min(minX, maxX), Math.max(minX, maxX)),
      y: rand(rng, Math.min(minY, maxY), Math.max(minY, maxY)),
    },
    careFactor,
  };
}

export function planHumanMotion({
  from = { x: 0, y: 0 },
  to,
  profile = 'fast',
  rng = defaultRng,
  steps,
  durationMs,
  overshootChance = 0,
  viewport,
  includeTimestamps = false,
  motionJitter,
  slightMissChance = 0,
  targetBox,
} = {}) {
  if (!to) throw new Error('planHumanMotion requires a target position');
  const prof = getHumanProfile(profile);
  const boundedTo = clampPointToViewport(to, viewport, { edgePadding: 1 });
  const boundedFrom = clampPointToViewport(from, viewport, { edgePadding: 1 });
  const distance = Math.hypot(boundedTo.x - boundedFrom.x, boundedTo.y - boundedFrom.y);
  const targetCareFactor = targetBox ? chooseHumanTargetPoint(targetBox, { rng }).careFactor : 1;
  const shouldOvershoot = distance > 120 && rng() < overshootChance;
  const actualDuration = durationMs || Math.round(clamp(jitter(120 + distance * 1.7, 0.2, rng) * targetCareFactor / prof.speed, 80, 3500));
  const randomness = Number.isFinite(Number(motionJitter)) ? clamp(Number(motionJitter), 0.03, 0.5) : 0.22;
  const paths = [];
  let missed = false;

  if (shouldOvershoot) {
    const overshoot = clampPointToViewport(overshootPoint(boundedFrom, boundedTo, rng), viewport, { edgePadding: 1 });
    const overshootDistance = Math.hypot(overshoot.x - boundedFrom.x, overshoot.y - boundedFrom.y);
    const correctionDistance = Math.hypot(boundedTo.x - overshoot.x, boundedTo.y - overshoot.y);
    const mainSteps = steps || clamp(Math.round(overshootDistance / 10), 10, 100);
    const correctionSteps = clamp(Math.round(correctionDistance / 4), 3, 12);
    paths.push(...humanPath(boundedFrom, overshoot, mainSteps, rng, randomness));
    paths.push(...humanPath(overshoot, boundedTo, correctionSteps, rng, 0.08));
  } else if (distance > 180 && rng() < slightMissChance) {
    missed = true;
    const miss = clampPointToViewport({
      x: boundedTo.x + rand(rng, -10, 10),
      y: boundedTo.y + rand(rng, -8, 8),
    }, viewport, { edgePadding: 1 });
    const missSteps = steps || clamp(Math.round(distance / 10), 10, 100);
    paths.push(...humanPath(boundedFrom, miss, missSteps, rng, randomness));
    paths.push(...humanPath(miss, boundedTo, clamp(Math.round(Math.hypot(boundedTo.x - miss.x, boundedTo.y - miss.y) / 3), 3, 10), rng, 0.06));
  } else {
    const actualSteps = steps || clamp(Math.round(distance / 10), 10, 100);
    paths.push(...humanPath(boundedFrom, boundedTo, actualSteps, rng, randomness));
  }

  const boundedPoints = paths.map((point) => clampPointToViewport(point, viewport, { edgePadding: 1 }));
  boundedPoints.push(boundedTo);
  const interval = Math.max(8, Math.round(actualDuration / Math.max(1, boundedPoints.length)));
  const points = includeTimestamps
    ? boundedPoints.map((point, index) => ({ ...point, atMs: index === boundedPoints.length - 1 ? actualDuration : Math.min(actualDuration, Math.round((index + 1) * interval)) }))
    : boundedPoints;

  return {
    points,
    finalPoint: boundedTo,
    durationMs: actualDuration,
    intervalMs: interval,
    steps: points.length,
    overshot: shouldOvershoot,
    missed,
    careFactor: targetCareFactor,
  };
}

export function planHumanScroll(options = {}) {
  const rng = options.rng || defaultRng;
  const profile = options.profile || 'fast';
  const prof = getHumanProfile(profile);
  const direction = options.direction || 'down';
  const amount = Number.isFinite(Number(options.amount)) ? Math.abs(Number(options.amount)) : randInt(rng, 180, 520);
  const bursty = options.bursty ?? true;
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const total = amount * sign;
  const wheelDeltas = [];

  if (bursty) {
    const burstCount = randInt(rng, prof.scroll.steps[0], prof.scroll.steps[1]);
    const weights = [];
    for (let i = 0; i < burstCount; i += 1) weights.push(rand(rng, 0.45, 1.65));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let sent = 0;
    for (let burstIndex = 0; burstIndex < burstCount; burstIndex += 1) {
      const burstTarget = burstIndex === burstCount - 1 ? total - sent : total * (weights[burstIndex] / totalWeight);
      const eventsInBurst = randInt(rng, 1, 4);
      let burstSent = 0;
      for (let eventIndex = 0; eventIndex < eventsInBurst; eventIndex += 1) {
        const remaining = burstTarget - burstSent;
        const base = eventIndex === eventsInBurst - 1 ? remaining : remaining / (eventsInBurst - eventIndex);
        const delta = eventIndex === eventsInBurst - 1 ? remaining : jitter(base, 0.35, rng);
        burstSent += delta;
        sent += delta;
        wheelDeltas.push(delta);
      }
    }
  } else {
    const stepCount = randInt(rng, prof.scroll.steps[0], prof.scroll.steps[1]);
    let sent = 0;
    for (let i = 0; i < stepCount; i += 1) {
      const remaining = total - sent;
      const base = i === stepCount - 1 ? remaining : remaining / (stepCount - i);
      const delta = i === stepCount - 1 ? remaining : jitter(base, 0.2, rng);
      sent += delta;
      wheelDeltas.push(delta);
    }
  }

  const inverseCorrectionChance = Math.min(1, Math.max(0, Number(options.inverseCorrectionChance ?? 0.08)));
  const inverseCorrection = amount >= 150 && rng() < inverseCorrectionChance;
  if (inverseCorrection) wheelDeltas.push(-sign * rand(rng, Math.min(12, amount * 0.03), Math.min(45, amount * 0.12)));

  const events = wheelDeltas.map((delta, index) => ({
    deltaX: vertical ? 0 : delta,
    deltaY: vertical ? delta : 0,
    pauseRangeMs: prof.scroll.stepPauseMs,
    index,
  }));
  return { direction, amount, bursty, inverseCorrection, events };
}

function overshootPoint(from, to, rng) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const factor = rand(rng, 0.03, 0.08);
  return { x: to.x + dx * factor, y: to.y + dy * factor };
}

export async function humanMove(
  page,
  {
    from = { x: 0, y: 0 },
    to,
    profile = 'fast',
    rng = defaultRng,
    steps,
    durationMs,
    overshootChance = 0,
    moveTimeout = 1000,
    viewport,
    includeTimestamps = false,
    motionJitter,
    slightMissChance = 0,
    targetBox,
  } = {}
) {
  const resolvedViewport = viewport || page?.viewportSize?.() || null;
  const plan = planHumanMotion({
    from,
    to,
    profile,
    rng,
    steps,
    durationMs,
    overshootChance,
    viewport: resolvedViewport,
    includeTimestamps,
    motionJitter,
    slightMissChance,
    targetBox,
  });

  await playMousePath(page, plan.points, plan.intervalMs, rng, { moveTimeout, viewport: resolvedViewport });
  const finalPoint = plan.finalPoint;
  await boundedMouseMove(page, finalPoint.x, finalPoint.y, moveTimeout);
  await page.waitForTimeout(rangeDelay([Math.max(5, plan.intervalMs * 0.7), plan.intervalMs * 1.3], rng, { jitterPercent: 0.25 }));

  return {
    position: finalPoint,
    steps: plan.steps + 1,
    durationMs: plan.durationMs,
    overshot: plan.overshot,
    missed: plan.missed,
    careFactor: plan.careFactor,
  };
}


export async function humanSettle(page, position, options = {}) {
  const enabled = options.enabled ?? options.settleJitter ?? false;
  if (!enabled) return { position, moves: 0 };

  const rng = options.rng || defaultRng;
  const moveCount = clamp(Math.round(options.moves ?? randInt(rng, 1, 3)), 1, 3);
  const pauseRange = options.pauseMs || [6, 18];

  for (let i = 0; i < moveCount; i += 1) {
    const isFinal = i === moveCount - 1;
    const radius = isFinal ? 0 : rand(rng, 1, 3);
    const angle = rand(rng, 0, Math.PI * 2);
    const point = isFinal
      ? position
      : { x: position.x + Math.cos(angle) * radius, y: position.y + Math.sin(angle) * radius };
    await page.mouse.move(point.x, point.y);
    if (page?.waitForTimeout) await page.waitForTimeout(rangeDelay(pauseRange, rng, { jitterPercent: 0.1 }));
  }

  return { position, moves: moveCount };
}

async function targetPoint(locator, rng, knownBox = null) {
  const box = knownBox || await locator.boundingBox();
  if (!box) throw new Error('target has no bounding box');
  return chooseHumanTargetPoint(box, { rng }).point;
}

async function boundingBoxWithTimeout(locator, timeoutMs = 1000) {
  return Promise.race([
    locator.boundingBox(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('boundingBox timed out')), timeoutMs)),
  ]);
}

export async function humanPrepareTarget(page, locator, options = {}) {
  const rng = options.rng || defaultRng;
  const timeout = options.timeout ?? 10000;
  const boxTimeout = options.boxTimeout ?? Math.min(1000, Math.max(100, timeout));
  let initialBox = null;
  if (options.preferBoundingBox) {
    try {
      initialBox = await boundingBoxWithTimeout(locator, boxTimeout);
    } catch (err) {
      if (!options.allowBoundingBoxFallback) throw err;
    }
  }
  if (!initialBox) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
    } catch (err) {
      if (!options.allowBoundingBoxFallback) throw err;
      const fallbackBox = await boundingBoxWithTimeout(locator, boxTimeout);
      if (!fallbackBox) throw err;
      initialBox = fallbackBox;
    }
  }

  let box = initialBox || await boundingBoxWithTimeout(locator, boxTimeout);
  if (!box) {
    await locator.scrollIntoViewIfNeeded({ timeout: options.scrollTimeout ?? 3000 });
    await humanPause(page, [options.afterScrollPauseMs ?? 120, options.afterScrollPauseMs ?? 120], { rng });
    box = await boundingBoxWithTimeout(locator, boxTimeout);
  }
  if (!box) throw new Error('Element not visible (no bounding box)');

  const viewport = options.viewport || page?.viewportSize?.() || { width: 1280, height: 720 };
  const centerY = box.y + box.height / 2;
  const comfortableTop = viewport.height * 0.20;
  const comfortableBottom = viewport.height * 0.80;

  if (!options.skipComfortScroll && (centerY < comfortableTop || centerY > comfortableBottom)) {
    const delta = centerY - viewport.height * 0.5;
    await humanScroll(page, {
      direction: delta > 0 ? 'down' : 'up',
      amount: Math.abs(delta),
      rng,
      profile: options.profile || 'fast',
    });
    await humanPause(page, [options.afterScrollPauseMs ?? 120, options.afterScrollPauseMs ?? 120], { rng });
    box = await boundingBoxWithTimeout(locator, boxTimeout);
    if (!box) throw new Error('Element not visible after scroll (no bounding box)');
  }

  const readingSpeed = Number(options.behaviorPersona?.readingSpeed) || 1;
  const readingPause = options.skipReadingPause ? [0, 0] : (options.readingPauseMs || [Math.round(40 / readingSpeed), Math.round(140 / readingSpeed)]);
  await humanPause(page, readingPause, { rng });
  return { ok: true, box };
}

export async function humanClick(page, locator, options = {}) {
  const rng = options.rng || defaultRng;
  const profile = options.profile || 'fast';
  const prof = getHumanProfile(profile);
  const actionDeadline = Number.isFinite(options.deadlineAt) ? options.deadlineAt : null;
  const timeLeft = (fallbackMs) => actionDeadline ? Math.max(0, actionDeadline - Date.now()) : fallbackMs;
  const timeout = Math.min(options.timeout ?? 10000, timeLeft(options.timeout ?? 10000));
  const boxTimeout = options.boxTimeout ?? Math.min(1000, Math.max(100, timeout));
  const locatorClickFallback = async (err) => {
    let fallback = 'locator.click';
    let fallbackError = err;
    try {
      await locator.click({ timeout: Math.min(options.locatorClickTimeout ?? 3000, Math.max(100, timeLeft(3000))) });
    } catch (clickErr) {
      fallbackError = clickErr;
      if (!options.allowKeyboardActivateFallback) throw clickErr;
      fallback = 'keyboard.activate';
      await locator.focus({ timeout: Math.min(options.focusTimeout ?? 1000, Math.max(100, timeLeft(1000))) });
      await humanPause(page, [15, 45], { rng, timeoutMs: 250 });
      await page.keyboard.press('Enter');
    }
    const cursor = options.from || { x: 0, y: 0 };
    return {
      ok: true,
      position: cursor,
      cursor,
      move: { position: cursor, steps: 0, durationMs: 0, fallback, error: fallbackError.message },
      settle: { position: cursor, moves: 0 },
      fallback,
    };
  };
  let initialBox = null;
  if (options.preferBoundingBox) {
    try {
      initialBox = await boundingBoxWithTimeout(locator, boxTimeout);
    } catch (err) {
      if (options.allowLocatorClickFallback) return locatorClickFallback(err);
      if (!options.allowBoundingBoxFallback) throw err;
    }
  }
  if (!initialBox) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
    } catch (err) {
      if (!options.allowBoundingBoxFallback) throw err;
      const fallbackBox = await boundingBoxWithTimeout(locator, boxTimeout);
      if (!fallbackBox) throw err;
      initialBox = fallbackBox;
    }
  }
  const to = await targetPoint(locator, rng, initialBox);
  let move;
  try {
    move = timeLeft(1) > 0
      ? await humanMove(page, {
        from: options.from || { x: 0, y: 0 },
        to,
        profile,
        rng,
        overshootChance: options.overshootChance ?? 0,
        moveTimeout: Math.min(options.moveTimeout ?? 1000, Math.max(100, timeLeft(1000))),
        viewport: options.viewport,
      })
      : { position: to, steps: 0, durationMs: 0, overshot: false, skipped: true };
  } catch (err) {
    if (err.code !== 'mouse_move_soft_timeout' || !options.allowLocatorClickFallback) throw err;
    return locatorClickFallback(err);
  }
  const settle = await humanSettle(page, to, {
    rng,
    enabled: options.settleJitter ?? false,
    moves: options.settleMoves,
  });
  await humanPause(page, prof.click.pauseBeforeDownMs, { rng });
  const mouseTimeout = Math.min(options.mouseTimeout ?? 2000, Math.max(100, timeLeft(options.mouseTimeout ?? 2000)));
  await Promise.race([
    page.mouse.down(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('mouse down timed out')), mouseTimeout)),
  ]);
  await humanPause(page, prof.click.holdMs, { rng });
  await Promise.race([
    page.mouse.up(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('mouse up timed out')), mouseTimeout)),
  ]);
  await humanPause(page, prof.click.pauseAfterMs, { rng });
  return { ok: true, position: to, cursor: to, move, settle };
}

function typoFor(char, rng) {
  const lower = String(char).toLowerCase();
  const adjacent = ADJACENT_KEYS[lower];
  if (adjacent) return adjacent[randInt(rng, 0, adjacent.length - 1)];
  if (/^[a-z]$/i.test(char)) return 'abcdefghijklmnopqrstuvwxyz'[randInt(rng, 0, 25)];
  if (/^[0-9]$/.test(char)) return String(randInt(rng, 0, 9));
  return char;
}

const SENSITIVE_INPUT_KINDS = new Set(['password', 'email', 'tel', 'otp', 'code', 'url', 'number']);

export function effectiveMistakesRate({ inputKind, mistakesRate } = {}) {
  const normalizedKind = typeof inputKind === 'string' ? inputKind.toLowerCase() : '';
  if (SENSITIVE_INPUT_KINDS.has(normalizedKind)) return 0;
  const rate = mistakesRate ?? 0.02;
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate)) return 0;
  return clamp(numericRate, 0, 1);
}

export async function humanType(page, locator, text, options = {}) {
  const rng = options.rng || defaultRng;
  const profile = options.profile || 'fast';
  const prof = getHumanProfile(profile);
  const clearFirst = options.clearFirst ?? true;
  const mistakesRate = effectiveMistakesRate({ inputKind: options.inputKind, mistakesRate: options.mistakesRate });
  if (locator) {
    try {
      await locator.focus({ timeout: options.timeout ?? 10000 });
    } catch (err) {
      if (!options.allowDomFocusFallback) throw err;
      await locator.evaluate((element) => element.focus());
    }
  }
  await humanPause(page, [60, 160], { rng });
  if (clearFirst) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await humanPause(page, [40, 110], { rng });
    await page.keyboard.press('Backspace');
    await humanPause(page, [70, 170], { rng });
  }
  for (const char of text) {
    if (/^[a-z0-9]$/i.test(char) && rng() < mistakesRate) {
      await page.keyboard.type(typoFor(char, rng), { delay: rangeDelay(prof.typing.keystrokeDelayMs, rng) });
      await humanPause(page, prof.typing.correctionPauseMs, { rng });
      await page.keyboard.press('Backspace');
      await humanPause(page, [50, 130], { rng });
    }
    await page.keyboard.type(char, { delay: rangeDelay(prof.typing.keystrokeDelayMs, rng) });
    if (char === ' ') await humanPause(page, prof.typing.wordPauseMs, { rng });
  }
  return { ok: true, chars: text.length };
}

export async function humanPress(page, key, options = {}) {
  const rng = options.rng || defaultRng;
  await humanPause(page, [60, 180], { rng });
  await page.keyboard.press(key);
  await humanPause(page, [80, 260], { rng });
  return { ok: true, key };
}

export async function humanScroll(page, options = {}) {
  const rng = options.rng || defaultRng;
  const profile = options.profile || 'fast';
  const prof = getHumanProfile(profile);
  const plan = planHumanScroll({ ...options, rng, profile });

  for (const event of plan.events) {
    await page.mouse.wheel(event.deltaX, event.deltaY);
    await humanPause(page, prof.scroll.stepPauseMs, { rng, jitter: 0.1 });
  }
  await humanPause(page, prof.scroll.pauseAfterMs, { rng });
  return {
    ok: true,
    direction: plan.direction,
    amount: plan.amount,
    steps: plan.events.length,
    bursty: plan.bursty,
    inverseCorrection: plan.inverseCorrection,
  };
}
