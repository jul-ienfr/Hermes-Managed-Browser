import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { buildTargetContext } from '../../lib/action-context.js';
import { replayStepsSelfHealing } from '../../lib/self-healing-replay.js';

function buttonCandidatesFromFixture(path) {
  const html = readFileSync(new URL(path, import.meta.url), 'utf8');
  return Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)).map((match, index) => {
    const attributes = {};
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes[attr[1]] = attr[2];
    }
    return buildTargetContext({
      ref: attributes.id || attributes['data-testid'] || `button-${index + 1}`,
      role: 'button',
      name: match[2],
      text: match[2],
      attributes,
      index,
    });
  });
}

describe('DOM drift fixture replay', () => {
  test('repairs a stale v1 button ref against the v2 semantic target and exposes repaired mode', async () => {
    const [savedButton] = buttonCandidatesFromFixture('../fixtures/dom-drift-v1.html');
    const v2Candidates = buttonCandidatesFromFixture('../fixtures/dom-drift-v2.html');
    const clickedRefs = [];

    const result = await replayStepsSelfHealing(
      [
        {
          kind: 'click',
          ref: savedButton.ref,
          target_summary: savedButton,
          expected_outcome: { text: 'continued' },
        },
      ],
      {
        handlers: {
          click: async (step) => {
            clickedRefs.push(step.ref);
            if (step.ref === 'continue-old') {
              return { ok: false, error: 'stale ref' };
            }
            return { ok: true, clicked: step.ref };
          },
        },
        getCandidates: async () => v2Candidates,
        validate: async () => ({ ok: true }),
      }
    );

    expect(clickedRefs).toEqual(['continue-old', 'continue-new']);
    expect(result).toMatchObject({ ok: true, llm_used: false, mode: 'repaired' });
    expect(result.modes).toContain('repaired');
    expect(result.results[0]).toMatchObject({
      ok: true,
      mode: 'repaired',
      original_ref: 'continue-old',
      repaired_ref: 'continue-new',
    });
  });
});
