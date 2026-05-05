import { normalizeChallengeResolutionConfig, resolveChallengePolicy } from './challenge-detection.js';
function hasExpectedOutcome(expected) {
  return Boolean(expected && typeof expected === 'object' && Object.keys(expected).length > 0);
}

function includesCaseInsensitive(value, expected) {
  return String(value || '').toLowerCase().includes(String(expected || '').toLowerCase());
}

function failure(key, expected, actual) {
  return {
    ok: false,
    reason: `${key} expectation failed`,
    diagnostics: {
      expectation: key,
      expected,
      actual,
    },
  };
}

async function validateOutcome(expected = {}, pageState) {
  if (pageState?.getChallengeDiagnostics) {
    const diagnostics = await pageState.getChallengeDiagnostics();
    const challengePolicy = resolveChallengePolicy(
      diagnostics,
      normalizeChallengeResolutionConfig(pageState.challengeResolution || {}),
      pageState.challengeContext || {}
    );
    if (!challengePolicy.ok) return { ...challengePolicy, diagnostics };
  }

  if (!hasExpectedOutcome(expected)) {
    return { ok: true, skipped: true };
  }

  if (expected.urlContains !== undefined) {
    const actual = await pageState.getUrl();
    if (!String(actual || '').includes(String(expected.urlContains))) {
      return failure('urlContains', expected.urlContains, actual);
    }
  }

  if (expected.titleIncludes !== undefined) {
    const actual = await pageState.getTitle();
    if (!includesCaseInsensitive(actual, expected.titleIncludes)) {
      return failure('titleIncludes', expected.titleIncludes, actual);
    }
  }

  if (expected.textIncludes !== undefined) {
    const actual = await pageState.hasText(expected.textIncludes);
    if (!actual) {
      return failure('textIncludes', expected.textIncludes, actual);
    }
  }

  if (expected.selectorVisible !== undefined) {
    const actual = await pageState.hasSelector(expected.selectorVisible);
    if (!actual) {
      return failure('selectorVisible', expected.selectorVisible, actual);
    }
  }

  return { ok: true };
}

export { validateOutcome };
