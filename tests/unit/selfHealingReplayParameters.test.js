import { describe, expect, test } from '@jest/globals';
import { replayStepSelfHealing, replaceRuntimePlaceholders, resolveParameterizedStep } from '../../lib/self-healing-replay.js';

describe('self-healing replay runtime parameters', () => {
  test('substitutes placeholders in evaluate expressions and array path fields', async () => {
    const step = {
      kind: 'file_upload',
      selector: 'input[type=file]',
      paths: ['{{photo_paths}}'],
      expression: "(() => '{{location}}')()",
      expected_outcome: {},
    };

    const resolved = resolveParameterizedStep(step, {
      photo_paths: '/tmp/a.jpg,/tmp/b.jpg',
      location: 'Bogève',
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.step.paths).toEqual(['/tmp/a.jpg,/tmp/b.jpg']);
    expect(resolved.step.expression).toBe("(() => 'Bogève')()");
  });

  test('reports missing placeholders from evaluate expressions and paths before running handlers', async () => {
    const result = await replayStepSelfHealing(
      {
        kind: 'evaluate',
        expression: "(() => '{{location}}')()",
        paths: ['{{photo_paths}}'],
        replaySafe: true,
      },
      { handlers: { evaluate: async () => ({ ok: true }) }, parameters: {} },
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('requires_parameter');
    expect(result.requires_parameters.sort()).toEqual(['location', 'photo_paths']);
  });

  test('recursively substitutes placeholders in arrays without touching non-strings', () => {
    expect(replaceRuntimePlaceholders(['{{one}}', 2, '{{two}}'], { one: 'a', two: 'b' })).toEqual(['a', 2, 'b']);
  });
});
