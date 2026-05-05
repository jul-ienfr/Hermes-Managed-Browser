import { createSeededRandom } from './human-actions.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeViewport(viewport = DEFAULT_VIEWPORT) {
  const width = Number(viewport.width);
  const height = Number(viewport.height);

  return {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_VIEWPORT.width,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_VIEWPORT.height,
  };
}

export function createHumanSessionState({ viewport = DEFAULT_VIEWPORT, seed = Date.now(), behaviorPersona = null } = {}) {
  const normalizedViewport = normalizeViewport(viewport);
  const sessionSeed = behaviorPersona?.seed ?? seed;
  const rng = createSeededRandom(sessionSeed);

  return {
    version: 1,
    seed: sessionSeed,
    behaviorPersona,
    viewport: normalizedViewport,
    lastCursor: {
      x: Math.round(normalizedViewport.width * (0.25 + rng() * 0.5)),
      y: Math.round(normalizedViewport.height * (0.25 + rng() * 0.5)),
    },
    lastActionAt: 0,
  };
}

export function getHumanCursor(state) {
  return { ...state.lastCursor };
}

export function updateHumanCursor(state, position) {
  const viewport = normalizeViewport(state.viewport);
  state.viewport = viewport;
  state.lastCursor = {
    x: clamp(Number(position.x) || 0, 0, viewport.width),
    y: clamp(Number(position.y) || 0, 0, viewport.height),
  };
  state.lastActionAt = Date.now();
  return getHumanCursor(state);
}
