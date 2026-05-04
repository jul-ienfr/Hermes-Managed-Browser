# Managed Browser Scrapling-Style DOM Repair Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make managed browser replay more robust by adding Scrapling-style adaptive DOM signature repair: when a recorded ref/selector breaks, the browser rescans the live DOM, locally scores candidate elements, retries the best safe match, validates the observable outcome, and learns the repaired flow without calling the LLM.

**Architecture:** Keep the existing Camofox AgentHistory and self-healing replay as the backbone. Add a richer `dom_signature` beside `target_summary`, a dedicated DOM-similarity repair module, action-specific thresholds/safety gates, and persistence provenance for learned repairs. The LLM/planner remains explicit and last-resort only.

**Tech Stack:** Node.js ESM, Camofox/Playwright, Jest, existing `/home/jul/tools/camofox-browser` modules: `lib/action-context.js`, `lib/target-repair.js`, `lib/self-healing-replay.js`, `lib/agent-history-memory.js`, `server.js` memory/replay routes.

---

## Contexte vérifié

- Repository: `/home/jul/tools/camofox-browser`.
- Git state: repo already dirty and ahead of origin; do **not** commit blindly or include unrelated files.
- Test script from `package.json`:
  - `npm test` → `NODE_OPTIONS='--experimental-vm-modules' jest --runInBand --forceExit`
- Existing self-healing modules:
  - `lib/action-context.js` currently captures `ref`, `role`, `name`, `text`, allowed attributes, `nearbyText`, `index`.
  - `lib/target-repair.js` currently scores role/name/text/attributes/index only.
  - `lib/self-healing-replay.js` currently does: exact replay → `target_summary` repair → validation → optional planner fallback.
  - `lib/agent-history-memory.js` currently persists AgentHistory steps under `~/.hermes/browser_memory/<site>/<action>.AgentHistory.json`, parameterizes message text, redacts secrets, and supports direct replay.
- Existing tests relevant to this work:
  - `tests/unit/actionContext.test.js`
  - `tests/unit/targetRepair.test.js`
  - `tests/unit/selfHealingReplay.test.js`
  - `tests/unit/agentHistoryMemory.test.js`
  - `tests/unit/domDriftReplay.test.js`
  - fixtures under `tests/fixtures/`
- Existing previous plan: `docs/plans/2026-04-26-self-healing-browser-memory.md` already introduced the base self-healing replay layer. This new plan extends it with Scrapling-style DOM signatures.
- Project constraints from `AGENTS.md` / skills:
  - keep `server.js` free of `process.env` and `child_process` imports.
  - keep browser actions browser-only; no VNC/OCR/raw X11 fallback.
  - no site-specific hardcoding such as `leboncoin` in generic repair logic.
  - do not persist secrets or literal free-form message bodies.
  - actions with public/destructive side effects need stricter repair thresholds and must fail safe.

---

## Product Rule

```text
Known flow → exact local replay.
Broken ref → local target_summary repair.
Still broken → Scrapling-style DOM signature repair.
Repair succeeds → validate observable outcome.
Validation succeeds → optionally learn/persist repaired flow.
Still broken → interrupt handling / explicit LLM fallback only if allowed.
```

No routine replay should call the LLM.

---

## CLI Interoperability Addendum

Managed Browser should be usable as a shared browser daemon by external CLIs such as an employment-search CLI, a resale CLI, or future domain-specific tools. The CLI must not embed its own brittle Playwright session when it needs the same logged-in/profiled browser state.

Compatibility contract:

1. **Managed Browser owns browser state**
   - Profiles, cookies, tabs, AgentHistory memory, ref maps, and learned repairs live in Camofox managed browser.
   - Domain CLIs call a stable local API instead of controlling a separate browser process.

2. **CLI owns domain intent**
   - Example: `emploi-cli` decides "search jobs near Bogève" and formats France Travail business data.
   - Example: `reell-cli`/resale CLI decides "check inbox/listings/offers" and applies resale rules.
   - Managed Browser only executes/replays/repairs browser workflows and reports structured outcomes.

3. **Shared API primitives**
   - `profiles.list()`
   - `profiles.ensure(profile, owner_cli?, policy?)`
   - `lease.acquire(profile, owner_cli, ttl_seconds, mode="write")`
   - `open(profile, url, site_key?, lease_id)`
   - `snapshot(profile, tab_id, lease_id?)`
   - `act(profile, tab_id, action, ref|selector|semantic_hint, parameters?, lease_id)`
   - `memory.record(profile, tab_id, site_key, action_key, lease_id)`
   - `memory.replay(profile, site_key, action_key, parameters?, lease_id, allow_llm_fallback=false, learn_repairs=true)`
   - `checkpoint(profile, lease_id)`
   - `release(profile, lease_id)`

4. **Profile/browser identity model**
   - A `profile` is a real browser profile, and therefore a browser identity: its own Camofox context, cookies, storage, fingerprint/persona, tabs, cursor/session state, and AgentHistory timeline.
   - A CLI request must always be scoped to an explicit `profile` unless it calls a read-only discovery endpoint.
   - One CLI can own/use multiple profiles concurrently, for example `emploi-cli` can run `emploi-julien`, `emploi-test`, and `emploi-alt` while `resell-cli` uses `lbc-ju` and `lbc-ge`.
   - Managed Browser must never silently reuse another profile as fallback. If the requested profile is missing, locked, or unhealthy, return a structured error.

5. **Lease/lock model**
   - A CLI must acquire a profile/browser lease before acting.
   - Default lease scope is the whole profile/browser, not only a tab, because a profile maps to one browser identity and cross-tab side effects can share cookies/session state.
   - Concurrent CLIs can read snapshots when policy allows, but only one writer acts on a profile at a time.
   - Leases have TTLs and `owner` metadata such as `emploi-cli` or `resell-cli`.
   - A lease can include multiple tab IDs under the same profile, but cannot span different profiles; multi-profile orchestration is represented as multiple independent leases.

6. **Memory namespace**
   - Store flows under stable namespaces:
     - shared/site-level templates: `~/.hermes/browser_memory/<site>/<action>.AgentHistory.json`
     - profile-scoped learned variants: `~/.hermes/browser_memory/profiles/<profile>/<site>/<action>.AgentHistory.json`
     - optional metadata: `profile`, `owner_cli`, `domain`, `parameters`, `side_effect_level`, `created_by`.
   - Lookup order should be: profile-scoped flow first, then shared/site-level template if the flow is marked safe to share.
   - CLIs can request known action keys, but replay remains managed-browser-owned.

7. **Parameter boundary**
   - Saved flows can include parameters like `{{query}}`, `{{location}}`, `{{message}}`.
   - CLI supplies runtime parameters.
   - Managed Browser refuses missing parameters and never types placeholder strings directly.

8. **Safety boundary**
   - Read-only and navigation workflows may run automatically.
   - Public/destructive actions such as send/apply/buy/delete/publish require stricter thresholds and, where policy demands, explicit operator approval.
   - LLM fallback is never implicit from a CLI; it must be requested with `allow_llm_fallback=true` and still return `llm_used: true` in diagnostics.

9. **Structured results**
   - CLIs should consume machine-readable replay results:
     - `ok`, `mode`, `llm_used`, `replayed_steps`, `requires_human`, `requires_secret`, `requires_parameters`, `final_url`, `observed_text`, `artifacts`.
   - Avoid parsing human-readable browser logs as the integration layer.

This makes CLI harmony simple: domain CLIs become deterministic clients of one browser-memory service, rather than each CLI relearning login/session/replay logic differently.

---

## Acceptance Criteria

1. Recorded click/type steps can include a `dom_signature` with stable structural details:
   - tag name,
   - normalized text,
   - allowed attributes,
   - parent tag/text/attributes,
   - sibling tag names,
   - tag-only path,
   - depth/index,
   - nearby text.
2. DOM signatures never store secrets, typed password/OTP/card/token values, or literal free-form message bodies.
3. Replay order is preserved:
   1. exact handler with recorded ref/selector,
   2. existing `target_summary` repair,
   3. DOM signature repair,
   4. expected-outcome validation,
   5. optional learned persistence,
   6. explicit LLM fallback only if allowed.
4. DOM repair returns structured diagnostics:
   - `mode: "dom_signature_repaired"`,
   - `llm_used: false`,
   - `original_ref`, `repaired_ref`, `score`, `candidate`.
5. Action-specific thresholds are enforced:
   - high threshold for `type`, submit/send/public/destructive actions,
   - medium threshold for safe navigation/search actions,
   - fail safe on ambiguous matches.
6. If `learnRepairs === true` and validation passes, the repaired AgentHistory is persisted with provenance.
7. Tests demonstrate repair across DOM drift where ids/classes/refs change but semantic structure remains similar.
8. No target-site hardcoding in changed core files.
9. Verification commands pass:
   - `node --check` on changed modules,
   - targeted Jest tests,
   - `git diff --check`.

---

## Design Overview

### New module

Create:

- `lib/dom-signature-repair.js`

Responsibilities:

- normalize DOM-signature fields,
- compare saved signature vs live candidate signature,
- compute weighted similarity scores,
- select best candidate above action-specific threshold,
- reject ambiguous top candidates.

### Extended module

Modify:

- `lib/action-context.js`

Add:

- `buildDomSignature(node)`
- `buildTargetContext(node)` should optionally include `dom_signature` when the node provides enough DOM metadata.

### Replay integration

Modify:

- `lib/self-healing-replay.js`

New repair chain:

```text
exact replay
  ↓ fail
existing target_summary repair
  ↓ no candidate / failed / validation failed
DOM signature repair
  ↓ success
validate expected_outcome
  ↓ success
return mode=dom_signature_repaired, llm_used=false
```

### Persistence integration

Modify:

- `lib/agent-history-memory.js`

Ensure `dom_signature` is preserved inside `hermes_meta.derived_flow.steps[*]` and, when repairs are learned, persist provenance without overwriting unrelated safety fields.

---

## Phase 1 — DOM Signature Data Model

### Task 1: Add DOM signature builder tests

**Objective:** Define the Scrapling-style element signature that managed browser should capture.

**Files:**
- Modify: `tests/unit/actionContext.test.js`
- Modify: `lib/action-context.js`

**Step 1: Add failing tests**

Append to `tests/unit/actionContext.test.js`:

```js
import { buildDomSignature } from '../../lib/action-context.js';

test('buildDomSignature captures stable structural element properties', () => {
  const signature = buildDomSignature({
    tag: 'BUTTON',
    text: '  Continuer\n',
    attributes: {
      id: 'continue-old',
      class: 'btn primary dynamic-123',
      'data-testid': 'continue-cta',
      onclick: 'ignored()',
    },
    parent: {
      tag: 'form',
      text: 'Créer un compte Continuer',
      attributes: { id: 'signup-form', onclick: 'ignored' },
    },
    siblings: [{ tag: 'input' }, { tag: 'button' }],
    path: ['HTML', 'BODY', 'MAIN', 'FORM', 'BUTTON'],
    depth: 5,
    index: 2,
    nearbyText: ['Créer un compte', 'Étape 1'],
  });

  expect(signature).toEqual({
    tag: 'button',
    text: 'continuer',
    attributes: {
      id: 'continue-old',
      class: 'btn primary dynamic-123',
      'data-testid': 'continue-cta',
    },
    parent: {
      tag: 'form',
      text: 'créer un compte continuer',
      attributes: { id: 'signup-form' },
    },
    siblings: ['input', 'button'],
    path: ['html', 'body', 'main', 'form', 'button'],
    depth: 5,
    index: 2,
    nearbyText: ['créer un compte', 'étape 1'],
  });
});

test('buildTargetContext includes dom_signature when structural data is provided', () => {
  const context = buildTargetContext({
    ref: 'e12',
    role: 'button',
    name: 'Continuer',
    tag: 'button',
    text: 'Continuer',
    path: ['html', 'body', 'button'],
  });

  expect(context.dom_signature).toMatchObject({
    tag: 'button',
    text: 'continuer',
    path: ['html', 'body', 'button'],
  });
});
```

**Step 2: Run failing test**

```bash
cd /home/jul/tools/camofox-browser
npm test -- --runTestsByPath tests/unit/actionContext.test.js
```

Expected: FAIL because `buildDomSignature` is not exported.

**Step 3: Implement minimal builder**

In `lib/action-context.js`, add helpers:

```js
function normalizeTag(value) {
  return normalizeText(value);
}

function normalizeTagPath(path = []) {
  return (Array.isArray(path) ? path : [])
    .map(normalizeTag)
    .filter(Boolean)
    .slice(-12);
}

function siblingTags(siblings = []) {
  return (Array.isArray(siblings) ? siblings : [])
    .map((item) => normalizeTag(typeof item === 'string' ? item : item?.tag || item?.nodeName))
    .filter(Boolean)
    .slice(0, 12);
}

function buildDomSignature(node = {}) {
  const parent = node.parent || {};
  const signature = {
    tag: normalizeTag(node.tag || node.nodeName || node.role),
    text: normalizeText(node.text || node.innerText || node.name || node.axName),
    attributes: pickAttributes(node.attributes),
    parent: {
      tag: normalizeTag(parent.tag || parent.nodeName),
      text: normalizeText(parent.text || parent.innerText),
      attributes: pickAttributes(parent.attributes),
    },
    siblings: siblingTags(node.siblings),
    path: normalizeTagPath(node.path),
    depth: Number.isInteger(node.depth) ? node.depth : null,
    index: Number.isInteger(node.index) ? node.index : null,
    nearbyText: Array.isArray(node.nearbyText) ? node.nearbyText.map(normalizeText).filter(Boolean).slice(0, 8) : [],
  };

  return signature;
}
```

Then update `buildTargetContext(node)` to attach `dom_signature` only when at least one structural field exists:

```js
const hasDomData = Boolean(node.tag || node.nodeName || node.parent || node.siblings || node.path || Number.isInteger(node.depth));
const context = { ...existingFields };
if (hasDomData) context.dom_signature = buildDomSignature(node);
return context;
```

Export `buildDomSignature`.

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/actionContext.test.js
```

Expected: PASS.

---

### Task 2: Preserve DOM signatures in AgentHistory steps

**Objective:** Ensure a captured `dom_signature` survives persistence and replay loading.

**Files:**
- Modify: `tests/unit/agentHistoryMemory.test.js`
- Modify: `lib/agent-history-memory.js`

**Step 1: Add failing test**

Add a test asserting that `recordSuccessfulBrowserAction(...)` preserves `target_summary.dom_signature` or direct `dom_signature` in the saved step.

Example expectation:

```js
expect(saved.payload.hermes_meta.derived_flow.steps[0].target_summary.dom_signature).toMatchObject({
  tag: 'button',
  text: 'continuer',
});
```

**Step 2: Run failing test**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: FAIL if `dom_signature` is dropped by step enrichment.

**Step 3: Implement preservation**

In `lib/agent-history-memory.js`, inside `enrichStep(input)`, preserve structural metadata:

```js
if (input.dom_signature) step.dom_signature = input.dom_signature;
if (input.target_summary) step.target_summary = input.target_summary;
```

If `input.target_summary.dom_signature` exists, keep it nested; do not duplicate unless needed.

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

---

## Phase 2 — DOM Signature Similarity Engine

### Task 3: Create DOM signature repair tests

**Objective:** Define local similarity behavior inspired by Scrapling.

**Files:**
- Create: `lib/dom-signature-repair.js`
- Create: `tests/unit/domSignatureRepair.test.js`

**Step 1: Write failing tests**

Create `tests/unit/domSignatureRepair.test.js`:

```js
import { describe, expect, test } from '@jest/globals';
import { findBestDomSignatureCandidate, scoreDomSignatureCandidate } from '../../lib/dom-signature-repair.js';

const saved = {
  tag: 'button',
  text: 'continuer',
  attributes: { id: 'continue-old', class: 'btn primary', 'data-testid': 'continue-cta' },
  parent: { tag: 'form', text: 'créer un compte continuer', attributes: { id: 'signup-form' } },
  siblings: ['input', 'button'],
  path: ['html', 'body', 'main', 'form', 'button'],
  depth: 5,
  index: 2,
  nearbyText: ['créer un compte', 'étape 1'],
};

test('scoreDomSignatureCandidate rewards semantic and structural similarity despite id/class drift', () => {
  const candidate = {
    ref: 'e42',
    dom_signature: {
      tag: 'button',
      text: 'continuer',
      attributes: { id: 'continue-new', class: 'button primary-new', 'data-testid': 'continue-cta' },
      parent: { tag: 'form', text: 'créer un compte continuer', attributes: { id: 'signup-form-v2' } },
      siblings: ['input', 'button'],
      path: ['html', 'body', 'main', 'section', 'form', 'button'],
      depth: 6,
      index: 3,
      nearbyText: ['créer un compte', 'étape 1'],
    },
  };

  expect(scoreDomSignatureCandidate(saved, candidate)).toBeGreaterThanOrEqual(75);
});

test('findBestDomSignatureCandidate returns the best candidate above threshold', () => {
  const candidates = [
    { ref: 'wrong', dom_signature: { tag: 'a', text: 'aide', path: ['html', 'body', 'a'] } },
    { ref: 'right', dom_signature: { ...saved, attributes: { id: 'changed' } } },
  ];

  const best = findBestDomSignatureCandidate(saved, candidates, { threshold: 70 });
  expect(best).toMatchObject({ ref: 'right' });
  expect(best.dom_signature_score).toBeGreaterThanOrEqual(70);
});

test('findBestDomSignatureCandidate rejects ambiguous close top matches', () => {
  const candidates = [
    { ref: 'a', dom_signature: { ...saved, attributes: { id: 'a' } } },
    { ref: 'b', dom_signature: { ...saved, attributes: { id: 'b' } } },
  ];

  expect(findBestDomSignatureCandidate(saved, candidates, { threshold: 70, ambiguityGap: 5 })).toBeNull();
});
```

**Step 2: Run failing test**

```bash
npm test -- --runTestsByPath tests/unit/domSignatureRepair.test.js
```

Expected: FAIL because module does not exist.

**Step 3: Implement module**

Create `lib/dom-signature-repair.js` with simple deterministic scoring:

```js
import { normalizeText } from './action-context.js';

function tokenSet(value) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  const left = Array.isArray(a) ? new Set(a.map(normalizeText).filter(Boolean)) : tokenSet(a);
  const right = Array.isArray(b) ? new Set(b.map(normalizeText).filter(Boolean)) : tokenSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function stringSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  return jaccard(left, right);
}

function attributeSimilarity(saved = {}, candidate = {}) {
  const keys = new Set([...Object.keys(saved || {}), ...Object.keys(candidate || {})]);
  if (keys.size === 0) return 1;
  let total = 0;
  for (const key of keys) {
    total += stringSimilarity(saved[key], candidate[key]);
  }
  return total / keys.size;
}

function pathSimilarity(saved = [], candidate = []) {
  return jaccard(saved, candidate);
}

function distanceSimilarity(a, b, maxDistance = 6) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return 0.5;
  return Math.max(0, 1 - Math.abs(a - b) / maxDistance);
}

function scoreDomSignatureCandidate(saved = {}, candidate = {}) {
  const current = candidate.dom_signature || candidate;
  const parentSaved = saved.parent || {};
  const parentCurrent = current.parent || {};

  const weighted = [
    [0.16, stringSimilarity(saved.tag, current.tag)],
    [0.18, stringSimilarity(saved.text, current.text)],
    [0.18, attributeSimilarity(saved.attributes, current.attributes)],
    [0.10, stringSimilarity(parentSaved.tag, parentCurrent.tag)],
    [0.10, stringSimilarity(parentSaved.text, parentCurrent.text)],
    [0.08, attributeSimilarity(parentSaved.attributes, parentCurrent.attributes)],
    [0.08, pathSimilarity(saved.path, current.path)],
    [0.05, jaccard(saved.siblings || [], current.siblings || [])],
    [0.04, jaccard(saved.nearbyText || [], current.nearbyText || [])],
    [0.03, distanceSimilarity(saved.index, current.index)],
  ];

  const score = weighted.reduce((sum, [weight, value]) => sum + weight * value, 0);
  return Math.round(score * 100);
}

function findBestDomSignatureCandidate(savedSignature = {}, candidates = [], options = {}) {
  const threshold = options.threshold ?? 70;
  const ambiguityGap = options.ambiguityGap ?? 8;
  const scored = (candidates || [])
    .map((candidate) => ({ ...candidate, dom_signature_score: scoreDomSignatureCandidate(savedSignature, candidate) }))
    .sort((a, b) => b.dom_signature_score - a.dom_signature_score);

  const best = scored[0];
  if (!best || best.dom_signature_score < threshold) return null;
  const second = scored[1];
  if (second && best.dom_signature_score - second.dom_signature_score < ambiguityGap) return null;
  return best;
}

export { findBestDomSignatureCandidate, scoreDomSignatureCandidate, stringSimilarity, jaccard };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/domSignatureRepair.test.js
```

Expected: PASS.

---

### Task 4: Add action-specific repair thresholds

**Objective:** Prevent aggressive repair for risky actions.

**Files:**
- Modify: `lib/dom-signature-repair.js`
- Modify: `tests/unit/domSignatureRepair.test.js`

**Step 1: Add tests**

Add tests for threshold policy:

```js
import { thresholdForStep } from '../../lib/dom-signature-repair.js';

test('thresholdForStep is stricter for type and submit-like actions', () => {
  expect(thresholdForStep({ kind: 'type' })).toBeGreaterThanOrEqual(85);
  expect(thresholdForStep({ kind: 'click', target_summary: { name: 'envoyer' } })).toBeGreaterThanOrEqual(85);
  expect(thresholdForStep({ kind: 'click', target_summary: { name: 'continuer' } })).toBeLessThan(85);
});
```

**Step 2: Implement policy**

In `lib/dom-signature-repair.js`:

```js
function thresholdForStep(step = {}) {
  const actionText = normalizeText([
    step.kind,
    step.target_summary?.name,
    step.target_summary?.text,
    step.target_summary?.attributes?.type,
    step.target_summary?.attributes?.['aria-label'],
  ].filter(Boolean).join(' '));

  if (step.kind === 'type') return 88;
  if (/\b(send|submit|envoyer|publier|acheter|payer|delete|supprimer|confirmer)\b/.test(actionText)) return 90;
  if (/\b(search|rechercher|continuer|suivant|next|login|connexion)\b/.test(actionText)) return 72;
  return 78;
}
```

Export it and use it as default threshold in `findBestDomSignatureCandidate` when a step is supplied.

**Step 3: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/domSignatureRepair.test.js
```

Expected: PASS.

---

## Phase 3 — Wire DOM Repair Into Self-Healing Replay

### Task 5: Add self-healing replay test for DOM-signature fallback

**Objective:** Prove replay tries exact ref, then existing repair, then DOM signature repair without LLM.

**Files:**
- Modify: `tests/unit/selfHealingReplay.test.js`
- Modify: `lib/self-healing-replay.js`

**Step 1: Add failing test**

Append to `tests/unit/selfHealingReplay.test.js`:

```js
test('uses DOM signature repair after exact replay and target_summary repair fail', async () => {
  const calls = [];
  const result = await replayStepSelfHealing(
    {
      kind: 'click',
      ref: 'old-ref',
      target_summary: { role: 'button', name: 'continuer' },
      dom_signature: {
        tag: 'button',
        text: 'continuer',
        attributes: { 'data-testid': 'continue-cta' },
        parent: { tag: 'form', text: 'créer un compte', attributes: {} },
        siblings: ['input', 'button'],
        path: ['html', 'body', 'main', 'form', 'button'],
        index: 2,
      },
    },
    {
      handlers: {
        click: async (step) => {
          calls.push(step.ref);
          if (step.ref === 'dom-ref') return { ok: true };
          return { ok: false, error: 'stale ref' };
        },
      },
      refreshRefs: async () => {},
      getCandidates: async () => [
        { ref: 'weak-ref', role: 'link', name: 'aide', dom_signature: { tag: 'a', text: 'aide' } },
        {
          ref: 'dom-ref',
          role: 'button',
          name: 'continuer',
          dom_signature: {
            tag: 'button',
            text: 'continuer',
            attributes: { 'data-testid': 'continue-cta-v2' },
            parent: { tag: 'form', text: 'créer un compte continuer', attributes: {} },
            siblings: ['input', 'button'],
            path: ['html', 'body', 'section', 'form', 'button'],
            index: 3,
          },
        },
      ],
      validate: async () => ({ ok: true }),
    }
  );

  expect(result).toMatchObject({
    ok: true,
    mode: 'dom_signature_repaired',
    llm_used: false,
    original_ref: 'old-ref',
    repaired_ref: 'dom-ref',
  });
  expect(calls).toContain('old-ref');
  expect(calls).toContain('dom-ref');
});
```

**Step 2: Run failing test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL because DOM repair is not wired.

**Step 3: Implement DOM repair branch**

In `lib/self-healing-replay.js`:

- import:

```js
import { findBestDomSignatureCandidate, thresholdForStep } from './dom-signature-repair.js';
```

- after existing target repair fails or finds no candidate, add:

```js
const savedDomSignature = step.dom_signature || step.target_summary?.dom_signature;
if (savedDomSignature) {
  if (ctx.refreshRefs) await ctx.refreshRefs(step);
  const candidates = ctx.getCandidates ? await ctx.getCandidates(step) : [];
  const domCandidate = findBestDomSignatureCandidate(savedDomSignature, candidates || [], {
    threshold: thresholdForStep(step),
  });

  if (domCandidate?.ref && domCandidate.ref !== step.ref) {
    const repairedStep = { ...step, ref: domCandidate.ref };
    const repairedResult = await runHandler(handler, repairedStep);
    if (isSuccess(repairedResult)) {
      const validation = await validateStep(repairedStep, ctx);
      if (validation?.ok) {
        return {
          ok: true,
          mode: 'dom_signature_repaired',
          llm_used: false,
          result: repairedResult,
          validation,
          repaired_step: repairedStep,
          repaired_ref: domCandidate.ref,
          original_ref: step.ref,
          score: domCandidate.dom_signature_score,
          candidate: domCandidate,
        };
      }
    }
  }
}
```

Keep planner fallback after this branch, not before.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/domSignatureRepair.test.js
```

Expected: PASS.

---

### Task 6: Summarize DOM repair mode in public replay responses

**Objective:** Ensure `replayStepsSelfHealing(...)` reports `mode: "dom_signature_repaired"` when any step used DOM repair.

**Files:**
- Modify: `tests/unit/selfHealingReplay.test.js`
- Modify: `lib/self-healing-replay.js`

**Step 1: Add test**

Add a multi-step replay test where one step returns `mode: 'dom_signature_repaired'` and assert summary mode.

Expected:

```js
expect(replay).toMatchObject({ ok: true, mode: 'dom_signature_repaired', llm_used: false });
expect(replay.modes).toContain('dom_signature_repaired');
```

**Step 2: Implement summary priority**

Update `summarizeReplayResults`:

```js
const mode = modes.includes('dom_signature_repaired')
  ? 'dom_signature_repaired'
  : modes.includes('repaired')
    ? 'repaired'
    : modes[0] || null;
```

**Step 3: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

---

## Phase 4 — Capture Real DOM Metadata From Managed Browser

### Task 7: Extend snapshot/ref metadata to include structural fields

**Objective:** Ensure live candidates passed to repair include `dom_signature` data, not only accessibility fields.

**Files:**
- Modify: `lib/snapshot.js`
- Modify: `tests/unit/snapshot.test.js` or `tests/unit/actionContext.test.js`
- Possibly modify: `server.js` ref-map creation path, only if refs currently drop structural fields.

**Step 1: Inspect current ref map shape**

Before coding, inspect where refs are created in `lib/snapshot.js` and how `server.js` stores refs. Confirm fields available per ref.

**Step 2: Add failing test**

Add a test that a fake DOM node snapshot/ref includes enough structural data for `buildTargetContext`:

Expected ref node should expose at least:

```js
{
  tag: 'button',
  attributes: { id: '...', class: '...', 'data-testid': '...' },
  parent: { tag: 'form', text: '...', attributes: {} },
  siblings: ['input', 'button'],
  path: ['html', 'body', 'main', 'form', 'button'],
  depth: 5,
  nearbyText: [...]
}
```

**Step 3: Implement minimal metadata extraction**

In snapshot/ref generation, collect only safe structural data:

- tag names,
- allowed attributes only,
- normalized visible text snippets,
- parent data,
- sibling tag names,
- tag-only path.

Do **not** collect arbitrary inline event handlers, hidden input values, full HTML, or typed values.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/snapshot.test.js tests/unit/actionContext.test.js
```

Expected: PASS.

---

### Task 8: Ensure `getCandidates` returns DOM signatures in replay handlers

**Objective:** Make the replay candidate list usable by DOM repair.

**Files:**
- Modify: `lib/memory-replay-handlers.js`
- Modify: `tests/unit/selfHealingReplay.test.js` or create focused `tests/unit/memoryReplayHandlers.test.js` if existing coverage is insufficient.

**Step 1: Add failing test**

Mock a ref map containing DOM metadata and assert `getCandidates` returns candidates with `dom_signature`.

Expected:

```js
expect(candidates[0].dom_signature).toMatchObject({ tag: 'button' });
```

**Step 2: Implement candidate conversion**

Ensure candidate conversion uses:

```js
buildTargetContext({ ref, index, ...(node || {}) })
```

and does not strip `dom_signature`.

**Step 3: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/actionContext.test.js
```

Expected: PASS.

---

## Phase 5 — Learn Repaired DOM Flows Safely

### Task 9: Add learned repair provenance tests

**Objective:** When DOM repair succeeds and `learnRepairs` is true, persist the improved ref with clear provenance.

**Files:**
- Modify: `tests/unit/agentHistoryMemory.test.js`
- Modify: `tests/unit/selfHealingReplay.test.js`
- Modify: `lib/self-healing-replay.js`
- Modify: `lib/agent-history-memory.js` only if persistence API lacks provenance shape.

**Step 1: Add test**

In self-healing replay test, pass a fake `learnRepair` callback:

```js
const learned = [];
const result = await replayStepSelfHealing(step, {
  learnRepairs: true,
  learnRepair: async (payload) => learned.push(payload),
  ...ctx,
});

expect(result.ok).toBe(true);
expect(learned[0]).toMatchObject({
  mode: 'dom_signature_repaired',
  original_ref: 'old-ref',
  repaired_ref: 'dom-ref',
});
```

**Step 2: Implement callback after validation success**

In successful DOM repair branch:

```js
if (ctx.learnRepairs && ctx.learnRepair) {
  await ctx.learnRepair({
    mode: 'dom_signature_repaired',
    original_step: step,
    repaired_step: repairedStep,
    original_ref: step.ref,
    repaired_ref: domCandidate.ref,
    score: domCandidate.dom_signature_score,
    candidate: domCandidate,
  });
}
```

**Step 3: Wire server-level persistence if not already wired**

In the `/memory/replay` route wiring, pass a `learnRepair` callback that updates the AgentHistory steps and calls `persistAgentHistorySteps(...)` with `learnedFrom` metadata.

Provenance shape:

```json
{
  "mode": "dom_signature_repaired",
  "old_ref": "e12",
  "new_ref": "e39",
  "score": 87,
  "timestamp": "..."
}
```

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

---

### Task 10: Fail safe for risky or ambiguous learned repairs

**Objective:** Prevent persistent corruption of flows when a repair is uncertain.

**Files:**
- Modify: `lib/dom-signature-repair.js`
- Modify: `lib/self-healing-replay.js`
- Modify: `tests/unit/domSignatureRepair.test.js`
- Modify: `tests/unit/selfHealingReplay.test.js`

**Step 1: Add tests**

Cases:

1. Two close candidates → no repair.
2. `type` step candidate score below 88 → no repair.
3. Submit/send-like click below 90 → no repair.
4. Repair that executes but validation fails → no learning.

**Step 2: Implement structured failures**

Return clear modes:

```js
{ ok: false, mode: 'dom_signature_ambiguous', llm_used: false, candidates: [...] }
{ ok: false, mode: 'dom_signature_below_threshold', llm_used: false, score, threshold }
{ ok: false, mode: 'dom_signature_validation_failed', llm_used: false, validation }
```

Keep planner fallback after these failures only if `allowLlmFallback === true`.

**Step 3: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/domSignatureRepair.test.js tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

---

## Phase 6 — Documentation and Verification

### Task 11: Add managed browser adaptive repair docs

**Objective:** Document the feature for future agents/operators.

**Files:**
- Create or modify: `docs/managed-browser-adaptive-repair.md`
- Modify if appropriate: `docs/browser-control-policy.md`

**Content outline:**

```markdown
# Managed Browser Adaptive Repair

## Rule
Known → replay local. Broken → local repair. Still broken → explicit LLM fallback.

## Layers
1. Exact AgentHistory ref replay
2. target_summary repair
3. DOM signature repair inspired by Scrapling
4. outcome validation
5. learned repair persistence

## Safety
- no secrets
- parameterized messages
- high thresholds for type/send/destructive actions
- ambiguous matches fail safe

## Diagnostics
- exact
- repaired
- dom_signature_repaired
- blocked
- requires_secret
- requires_parameter
- llm_fallback
```

**Verification:** docs added and no secret/site-specific text.

---

### Task 12: Final targeted validation

**Objective:** Verify syntax, tests, whitespace, and generic behavior.

**Commands:**

```bash
cd /home/jul/tools/camofox-browser
node --check lib/action-context.js
node --check lib/dom-signature-repair.js
node --check lib/target-repair.js
node --check lib/self-healing-replay.js
node --check lib/agent-history-memory.js
node --check server.js
npm test -- --runTestsByPath \
  tests/unit/actionContext.test.js \
  tests/unit/domSignatureRepair.test.js \
  tests/unit/targetRepair.test.js \
  tests/unit/selfHealingReplay.test.js \
  tests/unit/agentHistoryMemory.test.js \
  tests/unit/domDriftReplay.test.js
git diff --check
```

**Expected:** all commands exit 0.

**Genericity check:**

```bash
python3 - <<'PY'
from pathlib import Path
changed = [
  'lib/action-context.js',
  'lib/dom-signature-repair.js',
  'lib/self-healing-replay.js',
  'lib/agent-history-memory.js',
]
for file in changed:
    text = Path(file).read_text(errors='ignore').lower()
    assert 'leboncoin' not in text, file
print('generic core ok')
PY
```

**Expected:** `generic core ok`.

---

## Optional Live Smoke Test

Only after unit tests pass and the service is restarted/reloaded if needed.

1. Open a low-risk page with managed browser.
2. Record a click flow.
3. Manually modify the saved flow ref to simulate stale ref, or use a fixture route if available.
4. Replay with `learnRepairs: true`.
5. Verify response:

```json
{
  "ok": true,
  "mode": "dom_signature_repaired",
  "llm_used": false
}
```

6. Verify on-disk AgentHistory under:

```text
~/.hermes/browser_memory/<site>/<action>.AgentHistory.json
```

contains updated repaired ref and provenance.

Do not smoke-test by sending messages, buying, deleting, publishing, or any action with external effect.

---

## Non-Goals

- Do not add Scrapling as a runtime dependency.
- Do not scrape raw full HTML into memory files.
- Do not use the LLM for routine repair.
- Do not use VNC/OCR/raw X11 as fallback.
- Do not hardcode Leboncoin or any other target site.
- Do not lower safety thresholds just to make tests pass.

---

## Final State

When complete, managed browser will have this practical behavior:

```text
Recorded ref works → replay exact, no LLM.
Recorded ref broke → repair from accessibility summary, no LLM.
Accessibility summary insufficient → repair from DOM signature, no LLM.
Repair validated → learn improved flow.
Ambiguous/risky/broken → fail safe or explicit LLM fallback only if allowed.
```

This is the useful part of Scrapling adapted to Camofox managed browser: deterministic local relocation by signature and similarity, not an AI call for every stale selector.
