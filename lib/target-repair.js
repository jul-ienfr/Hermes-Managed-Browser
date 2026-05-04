import { buildTargetContext, normalizeText } from './action-context.js';

const ATTRIBUTE_SCORE_NAMES = [
  'id',
  'name',
  'placeholder',
  'aria-label',
  'href',
  'data-testid',
  'data-test',
  'data-cy',
];

function normalizeComparable(value) {
  return normalizeText(value);
}

function same(a, b) {
  const normalizedA = normalizeComparable(a);
  const normalizedB = normalizeComparable(b);
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

function includesEither(a, b) {
  const normalizedA = normalizeComparable(a);
  const normalizedB = normalizeComparable(b);
  return (
    normalizedA.length > 0 &&
    normalizedB.length > 0 &&
    (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
  );
}

function scoreCandidate(saved = {}, candidate = {}) {
  let score = 0;

  if (same(saved.role, candidate.role)) {
    score += 25;
  }

  if (same(saved.name, candidate.name)) {
    score += 35;
  } else if (includesEither(saved.name, candidate.name)) {
    score += 20;
  }

  if (same(saved.text, candidate.text)) {
    score += 20;
  } else if (includesEither(saved.text, candidate.text)) {
    score += 10;
  }

  const savedAttributes = saved.attributes || {};
  const candidateAttributes = candidate.attributes || {};
  for (const attributeName of ATTRIBUTE_SCORE_NAMES) {
    if (same(savedAttributes[attributeName], candidateAttributes[attributeName])) {
      score += 15;
    }
  }

  if (Number.isInteger(saved.index) && Number.isInteger(candidate.index)) {
    const distance = Math.abs(saved.index - candidate.index);
    if (distance === 0) {
      score += 8;
    } else if (distance <= 3) {
      score += 4;
    }
  }

  return Math.min(score, 100);
}

function findBestCandidate(saved = {}, candidates = [], { threshold = 60 } = {}) {
  let best = null;
  let bestScore = -1;

  for (const candidate of candidates || []) {
    const score = scoreCandidate(saved, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= threshold ? best : null;
}

function candidatesFromRefs(refs) {
  if (!refs || typeof refs.entries !== 'function') {
    return [];
  }

  return Array.from(refs.entries()).map(([ref, node], index) =>
    buildTargetContext({ ref, index, ...(node || {}) })
  );
}

export { candidatesFromRefs, findBestCandidate, includesEither, same, scoreCandidate };
