import { normalizeText } from './action-context.js';

const DEFAULT_THRESHOLD = 70;
const TYPE_THRESHOLD = 85;
const HIGH_IMPACT_THRESHOLD = 90;
const DEFAULT_MIN_MARGIN = 5;

const HIGH_IMPACT_ACTIONS = new Set(['send', 'submit', 'buy', 'pay', 'delete', 'publish']);
const ATTRIBUTE_WEIGHTS = new Map([
  ['data-testid', 5],
  ['data-test', 5],
  ['data-cy', 5],
  ['name', 4],
  ['type', 4],
  ['placeholder', 4],
  ['aria-label', 4],
  ['title', 3],
  ['href', 3],
  ['id', 2],
  ['class', 2],
]);

function normalizeTag(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeComparable(value) {
  return normalizeText(value);
}

function signatureFrom(candidate = {}) {
  return candidate.dom_signature || candidate.domSignature || candidate;
}

function sameText(a, b) {
  const normalizedA = normalizeComparable(a);
  const normalizedB = normalizeComparable(b);
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

function includesEither(a, b) {
  const normalizedA = normalizeComparable(a);
  const normalizedB = normalizeComparable(b);
  return Boolean(
    normalizedA.length > 0 &&
    normalizedB.length > 0 &&
    (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
  );
}

function tokens(value) {
  return normalizeComparable(value)
    .split(/[^a-z0-9_-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenSimilarity(a, b) {
  const aTokens = new Set(tokens(a));
  const bTokens = new Set(tokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(aTokens.size, bTokens.size);
}

function arrayTextSimilarity(a = [], b = []) {
  const valuesA = (Array.isArray(a) ? a : []).map(normalizeComparable).filter(Boolean);
  const valuesB = (Array.isArray(b) ? b : []).map(normalizeComparable).filter(Boolean);
  if (valuesA.length === 0 || valuesB.length === 0) {
    return 0;
  }

  let matched = 0;
  const used = new Set();
  for (const valueA of valuesA) {
    const index = valuesB.findIndex((valueB, candidateIndex) => {
      return !used.has(candidateIndex) && (valueA === valueB || valueA.includes(valueB) || valueB.includes(valueA));
    });
    if (index >= 0) {
      used.add(index);
      matched += 1;
    }
  }

  return matched / Math.max(valuesA.length, valuesB.length);
}

function pathSimilarity(savedPath = [], candidatePath = []) {
  const saved = (Array.isArray(savedPath) ? savedPath : []).map(normalizeTag).filter(Boolean);
  const candidate = (Array.isArray(candidatePath) ? candidatePath : []).map(normalizeTag).filter(Boolean);
  if (saved.length === 0 || candidate.length === 0) {
    return 0;
  }

  let suffixMatches = 0;
  while (
    suffixMatches < saved.length &&
    suffixMatches < candidate.length &&
    saved[saved.length - 1 - suffixMatches] === candidate[candidate.length - 1 - suffixMatches]
  ) {
    suffixMatches += 1;
  }

  let orderedMatches = 0;
  let candidateIndex = 0;
  for (const tag of saved) {
    while (candidateIndex < candidate.length && candidate[candidateIndex] !== tag) {
      candidateIndex += 1;
    }
    if (candidateIndex < candidate.length) {
      orderedMatches += 1;
      candidateIndex += 1;
    }
  }

  return Math.max(
    suffixMatches / Math.max(saved.length, candidate.length),
    orderedMatches / Math.max(saved.length, candidate.length)
  );
}

function attributeScore(savedAttributes = {}, candidateAttributes = {}) {
  let score = 0;
  let availableWeight = 0;

  for (const [name, weight] of ATTRIBUTE_WEIGHTS.entries()) {
    const savedValue = savedAttributes?.[name];
    const candidateValue = candidateAttributes?.[name];
    if (savedValue === undefined || savedValue === null || savedValue === '') {
      continue;
    }

    availableWeight += weight;
    if (sameText(savedValue, candidateValue)) {
      score += weight;
    } else if ((name === 'id' || name === 'class') && tokenSimilarity(savedValue, candidateValue) > 0) {
      score += weight * tokenSimilarity(savedValue, candidateValue);
    } else if (includesEither(savedValue, candidateValue)) {
      score += weight * 0.6;
    }
  }

  if (availableWeight === 0) {
    return 0;
  }

  return 18 * (score / availableWeight);
}

function relatedScore(saved = {}, candidate = {}) {
  let score = 0;
  if (normalizeTag(saved.tag) && normalizeTag(saved.tag) === normalizeTag(candidate.tag)) {
    score += 4;
  }
  if (sameText(saved.text, candidate.text)) {
    score += 6;
  } else if (includesEither(saved.text, candidate.text)) {
    score += 3;
  }
  score += attributeScore(saved.attributes || {}, candidate.attributes || {}) * (4 / 18);
  return Math.min(score, 14);
}

function siblingSimilarity(savedSiblings = [], candidateSiblings = []) {
  const saved = Array.isArray(savedSiblings) ? savedSiblings : [];
  const candidates = Array.isArray(candidateSiblings) ? candidateSiblings : [];
  if (saved.length === 0 || candidates.length === 0) {
    return 0;
  }

  let total = 0;
  const used = new Set();
  for (const savedSibling of saved) {
    let bestScore = 0;
    let bestIndex = -1;
    candidates.forEach((candidateSibling, index) => {
      if (used.has(index)) {
        return;
      }
      let current = 0;
      if (normalizeTag(savedSibling.tag) && normalizeTag(savedSibling.tag) === normalizeTag(candidateSibling.tag)) {
        current += 0.4;
      }
      if (sameText(savedSibling.text, candidateSibling.text)) {
        current += 0.5;
      } else if (includesEither(savedSibling.text, candidateSibling.text)) {
        current += 0.25;
      }
      current += Math.min(attributeScore(savedSibling.attributes || {}, candidateSibling.attributes || {}) / 18, 0.1);
      if (current > bestScore) {
        bestScore = current;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
    }
    total += Math.min(bestScore, 1);
  }

  return total / Math.max(saved.length, candidates.length);
}

function indexDepthScore(saved = {}, candidate = {}) {
  let score = 0;
  if (Number.isInteger(saved.index) && Number.isInteger(candidate.index)) {
    const distance = Math.abs(saved.index - candidate.index);
    if (distance === 0) {
      score += 5;
    } else if (distance <= 1) {
      score += 4;
    } else if (distance <= 3) {
      score += 2;
    }
  }
  if (Number.isInteger(saved.depth) && Number.isInteger(candidate.depth)) {
    const distance = Math.abs(saved.depth - candidate.depth);
    if (distance === 0) {
      score += 3;
    } else if (distance <= 1) {
      score += 2;
    }
  }
  return score;
}

function scoreDomSignatureCandidate(savedSignature = {}, candidate = {}) {
  const saved = signatureFrom(savedSignature);
  const candidateSignature = signatureFrom(candidate);
  if (!saved || !candidateSignature || Object.keys(saved).length === 0 || Object.keys(candidateSignature).length === 0) {
    return 0;
  }

  let score = 0;

  if (normalizeTag(saved.tag) && normalizeTag(saved.tag) === normalizeTag(candidateSignature.tag)) {
    score += 12;
  }

  if (sameText(saved.text, candidateSignature.text)) {
    score += 20;
  } else if (includesEither(saved.text, candidateSignature.text)) {
    score += 12;
  }

  score += attributeScore(saved.attributes || {}, candidateSignature.attributes || {});
  score += relatedScore(saved.parent || {}, candidateSignature.parent || {});
  score += 10 * pathSimilarity(saved.path || [], candidateSignature.path || []);
  score += 10 * siblingSimilarity(saved.siblings || [], candidateSignature.siblings || []);
  score += 8 * arrayTextSimilarity(saved.nearbyText || [], candidateSignature.nearbyText || []);
  score += indexDepthScore(saved, candidateSignature);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function actionFromStep(step) {
  if (typeof step === 'string') {
    return normalizeComparable(step);
  }
  return normalizeComparable(step?.action || step?.kind || step?.type || step?.name || step?.method);
}

function failureResult(mode, best, runnerUp, threshold, margin) {
  return {
    ok: false,
    mode,
    llm_used: false,
    candidate: best?.candidate,
    ref: best?.candidate?.ref,
    score: best?.score || 0,
    threshold,
    margin,
    ...(runnerUp ? { runner_up: runnerUp.candidate, runner_up_score: runnerUp.score } : {}),
  };
}

function thresholdForStep(step = {}) {
  const action = actionFromStep(step);
  if (HIGH_IMPACT_ACTIONS.has(action)) {
    return HIGH_IMPACT_THRESHOLD;
  }
  if (action === 'type') {
    return TYPE_THRESHOLD;
  }
  return DEFAULT_THRESHOLD;
}

function findBestDomSignatureCandidate(savedSignature = {}, candidates = [], options = {}) {
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : thresholdForStep(options.step || options.action || {});
  const minMargin = Number.isFinite(options.minMargin) ? options.minMargin : DEFAULT_MIN_MARGIN;
  const scored = (candidates || [])
    .map((candidate) => ({ candidate, score: scoreDomSignatureCandidate(savedSignature, candidate) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < threshold) {
    if (options.explainFailure) {
      return failureResult('dom_signature_below_threshold', best, scored[1], threshold, best ? best.score : 0);
    }
    return null;
  }

  const runnerUp = scored[1];
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  if (runnerUp && margin < minMargin) {
    if (options.explainFailure) {
      return failureResult('dom_signature_ambiguous', best, runnerUp, threshold, margin);
    }
    return null;
  }

  return {
    candidate: best.candidate,
    ref: best.candidate?.ref,
    score: best.score,
    threshold,
    margin,
  };
}

export {
  findBestDomSignatureCandidate,
  scoreDomSignatureCandidate,
  thresholdForStep,
};
