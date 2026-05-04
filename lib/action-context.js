const ALLOWED_ATTRIBUTE_NAMES = new Set([
  'id',
  'class',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'title',
  'href',
  'data-testid',
  'data-test',
  'data-cy',
]);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasOwnValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function isSensitiveText(value) {
  return /\b(password|passcode|secret|token|api[-_ ]?key|authorization|auth|credential|credit card|card number|cvv|ssn)\b/i.test(String(value || ''));
}

function normalizeSafeText(value) {
  if (!hasOwnValue(value) || isSensitiveText(value)) {
    return '';
  }
  return normalizeText(value);
}

function pickAttributes(attributes = {}) {
  const picked = {};
  for (const [rawKey, value] of Object.entries(attributes || {})) {
    const key = String(rawKey || '').toLowerCase();
    if (
      ALLOWED_ATTRIBUTE_NAMES.has(key)
      && value !== undefined
      && value !== null
      && !isSensitiveText(value)
    ) {
      picked[key] = String(value);
    }
  }
  return picked;
}

function normalizeTag(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.startsWith('#')) {
    return '';
  }
  const match = raw.match(/[a-z][a-z0-9-]*/);
  return match ? match[0] : '';
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      if (value && typeof value === 'object') {
        return Object.keys(value).length > 0;
      }
      return value !== undefined && value !== null && value !== '';
    })
  );
}

function buildRelatedSignature(node = {}) {
  const signature = {
    tag: normalizeTag(node.tag || node.tagName || node.nodeName),
    text: normalizeSafeText(node.text || node.innerText || node.name || node.axName || node.label),
    attributes: pickAttributes(node.attributes),
  };
  return compactObject(signature);
}

function buildDomSignature(node = {}) {
  const tag = normalizeTag(node.tag || node.tagName || node.nodeName);
  const parent = node.parent ? buildRelatedSignature(node.parent) : undefined;
  const siblings = Array.isArray(node.siblings)
    ? node.siblings.map(buildRelatedSignature).filter((sibling) => Object.keys(sibling).length > 0)
    : [];
  const path = Array.isArray(node.path)
    ? node.path.map(normalizeTag).filter(Boolean)
    : [];
  const nearbyText = Array.isArray(node.nearbyText)
    ? node.nearbyText.map(normalizeSafeText).filter(Boolean)
    : [];

  return compactObject({
    tag,
    text: normalizeSafeText(node.text || node.innerText || node.name || node.axName || node.label),
    attributes: pickAttributes(node.attributes),
    parent,
    siblings,
    path,
    depth: Number.isInteger(node.depth) ? node.depth : undefined,
    index: Number.isInteger(node.index) ? node.index : undefined,
    nearbyText,
  });
}

function hasStructuralDomData(node = {}) {
  return Boolean(
    node.tag
    || node.tagName
    || Array.isArray(node.path)
    || node.parent
    || Array.isArray(node.siblings)
    || Number.isInteger(node.depth)
  );
}

function buildTargetContext(node = {}) {
  const context = {
    ref: node.ref,
    role: node.role || node.nodeName,
    name: normalizeText(node.name || node.axName || node.label),
    text: normalizeText(node.text || node.innerText),
    attributes: pickAttributes(node.attributes),
    nearbyText: Array.isArray(node.nearbyText) ? node.nearbyText.map(normalizeText) : [],
    index: node.index,
  };

  if (hasStructuralDomData(node)) {
    const domSignature = buildDomSignature(node);
    if (Object.keys(domSignature).length > 0) {
      context.dom_signature = domSignature;
    }
  }

  return context;
}

export { buildDomSignature, buildTargetContext, normalizeText, pickAttributes };
