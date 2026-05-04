import { buildDomSignature, buildTargetContext, normalizeText } from '../../lib/action-context.js';

test('normalizeText collapses whitespace, trims, and lowercases', () => {
  expect(normalizeText('  Modifier\n  l’annonce  ')).toBe('modifier l’annonce');
});

test('buildTargetContext extracts minimal rich context from snapshot node-like input', () => {
  const context = buildTargetContext({
    ref: 'e12',
    role: 'button',
    name: 'Modifier l’annonce',
    text: 'Modifier',
    attributes: {
      id: 'edit-ad',
      class: 'btn primary',
      'data-testid': 'edit-listing',
      onclick: 'ignored',
    },
    nearbyText: ['Mes annonces', 'Prix'],
    index: 4,
  });

  expect(context).toEqual({
    ref: 'e12',
    role: 'button',
    name: 'modifier l’annonce',
    text: 'modifier',
    attributes: {
      id: 'edit-ad',
      class: 'btn primary',
      'data-testid': 'edit-listing',
    },
    nearbyText: ['mes annonces', 'prix'],
    index: 4,
  });
});

test('buildDomSignature captures safe structural metadata', () => {
  const signature = buildDomSignature({
    tag: 'BUTTON',
    text: '  Save\n Changes  ',
    attributes: {
      id: 'save-button',
      class: 'btn primary',
      name: 'save',
      type: 'button',
      placeholder: 'Save now',
      'aria-label': 'Save changes',
      title: 'Save',
      href: '/save',
      'data-testid': 'save-action',
      'data-test': 'save-test',
      'data-cy': 'save-cy',
      onclick: 'steal()',
    },
    parent: {
      tag: 'FORM',
      text: ' Account Settings ',
      attributes: {
        id: 'settings-form',
        class: 'panel',
        onsubmit: 'steal()',
      },
    },
    siblings: [
      { tag: 'LABEL', text: ' Name ', attributes: { for: 'name-field', class: 'field-label' } },
      { tag: 'A', text: ' Cancel ', attributes: { href: '/cancel', onclick: 'steal()' } },
    ],
    path: ['HTML', 'BODY', 'MAIN', 'FORM', 'BUTTON'],
    depth: 4,
    index: 2,
    nearbyText: ['Account Settings', 'Unsaved changes'],
  });

  expect(signature).toEqual({
    tag: 'button',
    text: 'save changes',
    attributes: {
      id: 'save-button',
      class: 'btn primary',
      name: 'save',
      type: 'button',
      placeholder: 'Save now',
      'aria-label': 'Save changes',
      title: 'Save',
      href: '/save',
      'data-testid': 'save-action',
      'data-test': 'save-test',
      'data-cy': 'save-cy',
    },
    parent: {
      tag: 'form',
      text: 'account settings',
      attributes: {
        id: 'settings-form',
        class: 'panel',
      },
    },
    siblings: [
      { tag: 'label', text: 'name', attributes: { class: 'field-label' } },
      { tag: 'a', text: 'cancel', attributes: { href: '/cancel' } },
    ],
    path: ['html', 'body', 'main', 'form', 'button'],
    depth: 4,
    index: 2,
    nearbyText: ['account settings', 'unsaved changes'],
  });
});

test('buildDomSignature excludes unsafe attributes, full html, and typed values', () => {
  const signature = buildDomSignature({
    tagName: 'input',
    text: ' Visible label ',
    innerHTML: '<input value="super-secret" onclick="steal()">',
    outerHTML: '<input value="super-secret" onclick="steal()">',
    html: '<input value="super-secret" onclick="steal()">',
    value: 'super-secret',
    typedValue: 'typed-secret',
    inputValue: 'hidden-secret',
    attributes: {
      id: 'email',
      value: 'secret@example.test',
      'data-secret': 'token',
      onclick: 'steal()',
      style: 'display:none',
      autocomplete: 'current-password',
      'aria-label': 'Email address',
    },
    parent: {
      tag: 'div',
      html: '<span>secret</span>',
      attributes: { value: 'parent-secret', class: 'field' },
    },
    siblings: [
      { tag: 'input', value: 'sibling-secret', attributes: { value: 'sibling-secret', name: 'username' } },
    ],
    path: ['HTML', 'BODY', '<input value="secret">', 'INPUT.email'],
    nearbyText: [' Contact ', ' Password: typed-secret '],
    depth: 3,
    index: 1,
  });

  expect(signature.attributes).toEqual({ id: 'email', 'aria-label': 'Email address' });
  expect(signature.parent.attributes).toEqual({ class: 'field' });
  expect(signature.siblings).toEqual([{ tag: 'input', attributes: { name: 'username' } }]);
  expect(signature.path).toEqual(['html', 'body', 'input', 'input']);
  expect(JSON.stringify(signature)).not.toContain('super-secret');
  expect(JSON.stringify(signature)).not.toContain('typed-secret');
  expect(JSON.stringify(signature)).not.toContain('hidden-secret');
  expect(JSON.stringify(signature)).not.toContain('secret@example.test');
  expect(JSON.stringify(signature)).not.toContain('onclick');
  expect(JSON.stringify(signature)).not.toContain('innerHTML');
  expect(JSON.stringify(signature)).not.toContain('outerHTML');
});

test('buildTargetContext includes dom_signature when structural DOM data exists', () => {
  const context = buildTargetContext({
    ref: 'e2',
    role: 'link',
    name: ' Open details ',
    tag: 'A',
    text: 'Open details',
    attributes: { href: '/details', onclick: 'steal()' },
    parent: { tag: 'LI', text: 'Result card' },
    siblings: [{ tag: 'SPAN', text: 'New' }],
    path: ['HTML', 'BODY', 'UL', 'LI', 'A'],
    depth: 4,
    index: 7,
    nearbyText: ['Result card'],
  });

  expect(context.dom_signature).toEqual({
    tag: 'a',
    text: 'open details',
    attributes: { href: '/details' },
    parent: { tag: 'li', text: 'result card' },
    siblings: [{ tag: 'span', text: 'new' }],
    path: ['html', 'body', 'ul', 'li', 'a'],
    depth: 4,
    index: 7,
    nearbyText: ['result card'],
  });
});
