import crypto from 'node:crypto';

function hashInt(input, salt) {
  const digest = crypto.createHash('sha256').update(`${salt}:${String(input)}`).digest();
  return digest.readUInt32BE(0);
}

function unit(input, salt) {
  return hashInt(input, salt) / 0xffffffff;
}

function range(input, salt, min, max) {
  return min + (max - min) * unit(input, salt);
}

function applyOverrides(persona, overrides) {
  const allowedOverrides = [
    'profile',
    'motionJitter',
    'overshootChance',
    'hesitationChance',
    'readingSpeed',
    'typoRateText',
  ];
  const next = { ...persona };
  for (const key of allowedOverrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) next[key] = overrides[key];
  }
  return next;
}

export function buildHumanBehaviorPersona(profileKey, overrides = {}) {
  const key = String(profileKey || 'default');
  const persona = {
    version: 1,
    key,
    seed: hashInt(key, 'human-seed'),
    profile: 'fast',
    motionJitter: Number(range(key, 'motion-jitter', 0.16, 0.32).toFixed(3)),
    overshootChance: Number(range(key, 'overshoot', 0.08, 0.28).toFixed(3)),
    hesitationChance: Number(range(key, 'hesitation', 0.04, 0.18).toFixed(3)),
    readingSpeed: Number(range(key, 'reading-speed', 0.85, 1.25).toFixed(3)),
    typoRateText: Number(range(key, 'typo-rate', 0.005, 0.025).toFixed(4)),
  };

  return applyOverrides(persona, overrides);
}
