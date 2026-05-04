import { buildDomMetadata, safeNodeMetadataFromElement } from '../../lib/snapshot.js';
import { buildTargetContext } from '../../lib/action-context.js';
import { liveCandidatesFromTabState } from '../../lib/memory-replay-handlers.js';
import { candidatesFromRefs } from '../../lib/target-repair.js';

describe('live candidate DOM metadata plumbing', () => {
  test('snapshot metadata extraction captures safe structural fields for DOM signatures', () => {
    const node = {
      tagName: 'BUTTON',
      innerText: 'Checkout now',
      attributes: {
        id: 'checkout-button',
        class: 'primary cta',
        onclick: 'steal()',
        'data-testid': 'checkout',
        value: 'typed secret value',
        'aria-label': 'Checkout',
      },
      parentElement: {
        tagName: 'FORM',
        innerText: 'Checkout now Total $10',
        attributes: {
          id: 'cart-form',
          onsubmit: 'steal()',
          action: '/pay',
        },
        children: [
          { tagName: 'A', innerText: 'Back' },
          null,
          { tagName: 'INPUT', innerText: '' },
        ],
      },
      previousElementSibling: { tagName: 'A', innerText: 'Back' },
      nextElementSibling: { tagName: 'INPUT', innerText: '' },
    };
    node.parentElement.children[1] = node;
    node.closest = (selector) => (selector === '[hidden], [aria-hidden="true"]' ? null : undefined);

    const metadata = safeNodeMetadataFromElement(node);

    expect(metadata).toEqual(expect.objectContaining({
      tag: 'button',
      text: 'Checkout now',
      attributes: {
        id: 'checkout-button',
        class: 'primary cta',
        'data-testid': 'checkout',
        'aria-label': 'Checkout',
      },
      parent: expect.objectContaining({
        tag: 'form',
        text: 'Checkout now Total $10',
        attributes: { id: 'cart-form' },
      }),
      siblings: [{ tag: 'a' }, { tag: 'input' }],
      path: ['form', 'button'],
      depth: 1,
      index: 1,
    }));
    expect(metadata.nearbyText).toEqual(expect.arrayContaining(['Back', 'Checkout now Total $10']));
    expect(JSON.stringify(metadata)).not.toContain('onclick');
    expect(JSON.stringify(metadata)).not.toContain('onsubmit');
    expect(JSON.stringify(metadata)).not.toContain('typed secret value');
    expect(JSON.stringify(metadata)).not.toContain('/pay');
  });

  test('hidden nodes and sensitive text do not produce reusable metadata', () => {
    const hidden = {
      tagName: 'INPUT',
      type: 'hidden',
      value: 'super-secret-token',
      innerText: 'token secret',
      attributes: { type: 'hidden', value: 'super-secret-token', name: 'auth_token' },
      closest: () => hidden,
    };

    expect(safeNodeMetadataFromElement(hidden)).toEqual({});
    expect(buildDomMetadata({ tag: 'input', text: 'password secret', value: 'typed-password' })).toEqual({ tag: 'input' });
    expect(buildDomMetadata({
      tag: 'input',
      type: 'hidden',
      value: 'super-secret-token',
      attributes: { type: 'hidden', value: 'super-secret-token', name: 'auth_token' },
    })).toEqual({});
  });

  test('live candidates from refs include DOM signatures built from ref node metadata only', () => {
    const refs = new Map([
      ['e7', {
        role: 'button',
        name: 'Checkout',
        tag: 'button',
        text: 'Checkout now',
        attributes: {
          id: 'checkout-button',
          class: 'primary',
          onclick: 'steal()',
          value: 'typed secret value',
        },
        parent: { tag: 'form', text: 'Checkout form', attributes: { id: 'cart-form', onclick: 'steal()' } },
        siblings: [{ tag: 'a', text: 'Back', attributes: { href: '/cart' } }, { tag: 'input' }],
        path: ['html', 'body', 'form', 'button'],
        depth: 3,
        index: 1,
        nearbyText: ['Back', 'Checkout form'],
        outerHTML: '<button onclick="steal()">Checkout</button>',
        value: 'typed secret value',
      }],
    ]);

    const [candidate] = candidatesFromRefs(refs);

    expect(candidate.dom_signature).toEqual(expect.objectContaining({
      tag: 'button',
      text: 'checkout now',
      attributes: { id: 'checkout-button', class: 'primary' },
      parent: { tag: 'form', text: 'checkout form', attributes: { id: 'cart-form' } },
      siblings: expect.arrayContaining([expect.objectContaining({ tag: 'a' }), expect.objectContaining({ tag: 'input' })]),
      path: ['html', 'body', 'form', 'button'],
      depth: 3,
      index: 1,
      nearbyText: ['back', 'checkout form'],
    }));
    expect(JSON.stringify(candidate)).not.toContain('outerHTML');
    expect(JSON.stringify(candidate)).not.toContain('onclick');
    expect(JSON.stringify(candidate)).not.toContain('typed secret value');
  });

  test('memory replay live candidate source exposes ref node metadata without secrets', () => {
    const tabState = {
      refs: new Map([
        ['e4', {
          role: 'textbox',
          name: 'Email',
          tag: 'input',
          attributes: { id: 'email', type: 'email', value: 'typed@example.test', oninput: 'steal()' },
          parent: { tag: 'form', attributes: { id: 'login' } },
          path: ['html', 'body', 'form', 'input'],
          depth: 3,
          index: 0,
        }],
      ]),
    };

    const [candidate] = candidatesFromRefs(new Map(
      liveCandidatesFromTabState(tabState).map((node) => [node.ref, node])
    ));

    expect(candidate.dom_signature).toEqual(expect.objectContaining({
      tag: 'input',
      attributes: { id: 'email', type: 'email' },
      parent: { tag: 'form', attributes: { id: 'login' } },
      path: ['html', 'body', 'form', 'input'],
      depth: 3,
      index: 0,
    }));
    expect(JSON.stringify(candidate)).not.toContain('typed@example.test');
    expect(JSON.stringify(candidate)).not.toContain('oninput');
  });

  test('buildTargetContext converts direct node metadata into DOM signature for saved action summaries', () => {
    const context = buildTargetContext({
      ref: 'e3',
      role: 'link',
      name: 'Continue',
      tag: 'a',
      attributes: { href: '/continue', onmouseover: 'steal()', 'data-cy': 'continue-link' },
      parent: { tag: 'nav', text: 'Primary navigation', attributes: { class: 'top-nav', onclick: 'steal()' } },
      siblings: [{ tag: 'a' }, { tag: 'button' }],
      path: ['html', 'body', 'nav', 'a'],
      depth: 3,
      index: 0,
      nearbyText: ['Home', 'Continue'],
      innerHTML: '<span>Continue</span>',
    });

    expect(context.dom_signature).toEqual(expect.objectContaining({
      tag: 'a',
      attributes: { href: '/continue', 'data-cy': 'continue-link' },
      parent: { tag: 'nav', text: 'primary navigation', attributes: { class: 'top-nav' } },
      path: ['html', 'body', 'nav', 'a'],
      depth: 3,
      index: 0,
    }));
    expect(JSON.stringify(context)).not.toContain('innerHTML');
    expect(JSON.stringify(context)).not.toContain('onmouseover');
  });
});
