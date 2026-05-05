import { candidatesFromRefs, findBestCandidate, scoreCandidate } from '../../lib/target-repair.js';

test('scoreCandidate scores exact role, name, and text highly', () => {
  const saved = { role: 'button', name: 'modifier l’annonce', text: 'modifier' };
  const candidate = { ref: 'e9', role: 'button', name: 'modifier l’annonce', text: 'modifier' };

  expect(scoreCandidate(saved, candidate)).toBeGreaterThanOrEqual(80);
});

test('findBestCandidate returns the top candidate above threshold', () => {
  const saved = { role: 'button', name: 'continuer' };
  const candidates = [
    { ref: 'e1', role: 'link', name: 'aide' },
    { ref: 'e2', role: 'button', name: 'continuer' },
  ];

  expect(findBestCandidate(saved, candidates).ref).toBe('e2');
});

test('candidatesFromRefs converts refs into normalized repair candidates', () => {
  const refs = new Map([
    ['e1', { role: 'button', name: 'Continuer', attributes: { id: 'go' } }],
  ]);

  expect(candidatesFromRefs(refs)).toEqual([
    expect.objectContaining({ ref: 'e1', role: 'button', name: 'continuer' }),
  ]);
});
