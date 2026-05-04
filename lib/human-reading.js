const READING_PROFILES = {
  fast: {
    baseMs: 120,
    msPerChar: 0.45,
    capMs: 1200,
  },
  medium: {
    baseMs: 220,
    msPerChar: 0.75,
    capMs: 2500,
  },
  slow: {
    baseMs: 350,
    msPerChar: 1.1,
    capMs: 4000,
  },
};

function normalizeProfile(profile) {
  if (typeof profile === 'string') return READING_PROFILES[profile] || READING_PROFILES.fast;
  if (profile?.name && READING_PROFILES[profile.name]) return READING_PROFILES[profile.name];
  return READING_PROFILES.fast;
}

function normalizeTextLength(textLength) {
  const length = Number(textLength);
  if (!Number.isFinite(length)) return 0;
  return Math.max(0, Math.round(length));
}

export function estimateReadingPauseMs({ textLength = 0, profile = 'fast' } = {}) {
  const readingProfile = normalizeProfile(profile);
  const normalizedLength = normalizeTextLength(textLength);
  const estimated = readingProfile.baseMs + normalizedLength * readingProfile.msPerChar;
  return Math.round(Math.min(readingProfile.capMs, Math.max(readingProfile.baseMs, estimated)));
}

export async function humanReadingPause(page, { textLength = 0, profile = 'fast' } = {}) {
  const delay = estimateReadingPauseMs({ textLength, profile });
  if (page?.waitForTimeout) await page.waitForTimeout(delay);
  return delay;
}
