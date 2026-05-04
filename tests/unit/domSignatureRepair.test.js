import {
  findBestDomSignatureCandidate,
  scoreDomSignatureCandidate,
  thresholdForStep,
} from '../../lib/dom-signature-repair.js';

const savedCheckoutButton = {
  tag: 'button',
  text: 'continue checkout',
  attributes: {
    id: 'checkout-primary-old',
    class: 'btn btn-primary old-hash',
    type: 'submit',
    'aria-label': 'Continue checkout',
    'data-testid': 'checkout-continue',
  },
  parent: {
    tag: 'form',
    text: 'checkout details',
    attributes: { id: 'checkout-form-old', class: 'checkout-panel' },
  },
  siblings: [
    { tag: 'a', text: 'back to cart', attributes: { href: '/cart' } },
    { tag: 'span', text: 'secure checkout' },
  ],
  path: ['html', 'body', 'main', 'section', 'form', 'button'],
  depth: 5,
  index: 8,
  nearbyText: ['order summary', 'shipping address'],
};

const driftedCheckoutButton = {
  ref: 'e42',
  dom_signature: {
    tag: 'button',
    text: 'continue checkout',
    attributes: {
      id: 'checkout-primary-new',
      class: 'button primary new-hash',
      type: 'submit',
      'aria-label': 'Continue checkout',
      'data-testid': 'checkout-continue',
    },
    parent: {
      tag: 'form',
      text: 'checkout details',
      attributes: { id: 'checkout-form-new', class: 'checkout-panel refreshed' },
    },
    siblings: [
      { tag: 'a', text: 'back to cart', attributes: { href: '/cart' } },
      { tag: 'span', text: 'secure checkout' },
    ],
    path: ['html', 'body', 'main', 'div', 'section', 'form', 'button'],
    depth: 6,
    index: 9,
    nearbyText: ['shipping address', 'order summary'],
  },
};

test('scoreDomSignatureCandidate scores robustly across id and class drift', () => {
  const score = scoreDomSignatureCandidate(savedCheckoutButton, driftedCheckoutButton);

  expect(score).toBeGreaterThanOrEqual(82);
  expect(score).toBeLessThanOrEqual(100);
});

test('findBestDomSignatureCandidate returns the strongest candidate with diagnostics', () => {
  const result = findBestDomSignatureCandidate(savedCheckoutButton, [
    {
      ref: 'e1',
      dom_signature: {
        tag: 'a',
        text: 'continue checkout',
        attributes: { href: '/checkout' },
        parent: { tag: 'nav', text: 'site links' },
        path: ['html', 'body', 'nav', 'a'],
        index: 2,
      },
    },
    driftedCheckoutButton,
    {
      ref: 'e3',
      dom_signature: {
        tag: 'button',
        text: 'apply coupon',
        attributes: { type: 'button', 'data-testid': 'coupon-apply' },
        parent: { tag: 'form', text: 'coupon' },
        path: ['html', 'body', 'main', 'form', 'button'],
        index: 20,
      },
    },
  ]);

  expect(result).toEqual({
    candidate: driftedCheckoutButton,
    ref: 'e42',
    score: expect.any(Number),
    threshold: thresholdForStep(),
    margin: expect.any(Number),
  });
  expect(result.score).toBeGreaterThanOrEqual(result.threshold);
});

test('findBestDomSignatureCandidate rejects ambiguous candidates and fails safe', () => {
  const first = { ref: 'e10', dom_signature: { ...driftedCheckoutButton.dom_signature, index: 9 } };
  const second = { ref: 'e11', dom_signature: { ...driftedCheckoutButton.dom_signature, index: 10 } };

  expect(findBestDomSignatureCandidate(savedCheckoutButton, [first, second])).toBeNull();
});

test('thresholdForStep is stricter for typing and high-impact actions', () => {
  expect(thresholdForStep()).toBe(70);
  expect(thresholdForStep({ action: 'click' })).toBe(70);
  expect(thresholdForStep({ action: 'type' })).toBe(85);
  expect(thresholdForStep({ kind: 'type' })).toBe(85);
  expect(thresholdForStep({ action: 'send' })).toBe(90);
  expect(thresholdForStep({ action: 'submit' })).toBe(90);
  expect(thresholdForStep({ action: 'buy' })).toBe(90);
  expect(thresholdForStep({ action: 'pay' })).toBe(90);
  expect(thresholdForStep({ action: 'delete' })).toBe(90);
  expect(thresholdForStep({ action: 'publish' })).toBe(90);
  expect(thresholdForStep({ kind: 'publish' })).toBe(90);
  expect(thresholdForStep('type')).toBe(85);
});

test('findBestDomSignatureCandidate can return structured ambiguous diagnostics', () => {
  const first = { ref: 'e10', dom_signature: { ...driftedCheckoutButton.dom_signature, index: 9 } };
  const second = { ref: 'e11', dom_signature: { ...driftedCheckoutButton.dom_signature, index: 10 } };

  expect(
    findBestDomSignatureCandidate(savedCheckoutButton, [first, second], { explainFailure: true })
  ).toMatchObject({
    ok: false,
    mode: 'dom_signature_ambiguous',
    llm_used: false,
    score: expect.any(Number),
    threshold: thresholdForStep(),
    margin: expect.any(Number),
    candidate: first,
    runner_up: second,
  });
});

test('findBestDomSignatureCandidate can return structured below-threshold diagnostics', () => {
  const weakCandidate = {
    ref: 'e90',
    dom_signature: {
      tag: 'input',
      text: 'search catalog',
      attributes: { name: 'q', placeholder: 'search' },
      parent: { tag: 'header', text: 'global search' },
      path: ['html', 'body', 'header', 'form', 'input'],
      index: 1,
    },
  };

  expect(
    findBestDomSignatureCandidate(savedCheckoutButton, [weakCandidate], { step: { kind: 'submit' }, explainFailure: true })
  ).toMatchObject({
    ok: false,
    mode: 'dom_signature_below_threshold',
    llm_used: false,
    score: expect.any(Number),
    threshold: 90,
    candidate: weakCandidate,
  });
});

test('low-confidence matches return null instead of repairing', () => {
  const result = findBestDomSignatureCandidate(
    savedCheckoutButton,
    [
      {
        ref: 'e90',
        dom_signature: {
          tag: 'input',
          text: 'search catalog',
          attributes: { name: 'q', placeholder: 'search' },
          parent: { tag: 'header', text: 'global search' },
          siblings: [{ tag: 'button', text: 'search' }],
          path: ['html', 'body', 'header', 'form', 'input'],
          depth: 4,
          index: 1,
          nearbyText: ['navigation', 'account'],
        },
      },
    ],
    { step: { action: 'click' } }
  );

  expect(result).toBeNull();
});

test('stricter step thresholds reject otherwise plausible risky repairs', () => {
  const plausibleButNotSafeEnough = {
    ref: 'e50',
    dom_signature: {
      tag: 'button',
      text: 'continue checkout',
      attributes: { type: 'submit' },
      parent: { tag: 'form', text: 'checkout details' },
      siblings: [
        { tag: 'a', text: 'back to cart', attributes: { href: '/cart' } },
        { tag: 'span', text: 'secure checkout' },
      ],
      path: ['html', 'body', 'main', 'form', 'button'],
      depth: 5,
      index: 11,
      nearbyText: ['order summary', 'shipping address'],
    },
  };

  expect(findBestDomSignatureCandidate(savedCheckoutButton, [plausibleButNotSafeEnough])).not.toBeNull();
  expect(
    findBestDomSignatureCandidate(savedCheckoutButton, [plausibleButNotSafeEnough], {
      step: { action: 'submit' },
    })
  ).toBeNull();
});
