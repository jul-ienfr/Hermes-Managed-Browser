# Self-Healing Browser Memory Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Upgrade Camofox browser memory from deterministic replay of recorded refs to a self-healing replay system that can recover from changed DOM structure, validate outcomes, handle common interruptions, and learn improved variants after success.

**Architecture:** Keep the existing AgentHistory replay as layer 1. Add richer step capture, a local candidate-matching repair engine, expected-outcome validation, interrupt handlers, and a controlled LLM fallback only after local replay/repair fails. The feature remains generic; Leboncoin is only a target use case and must not be hardcoded.

**Tech Stack:** Node.js ESM, Express, Playwright/Camoufox, Jest tests, existing `lib/agent-history-memory.js`, `server.js` routes, snapshots from `lib/snapshot.js`.

---

## Verified Context

- Repository: `/home/jul/tools/camofox-browser`.
- Server entrypoint: `server.js`.
- Memory module already exists: `lib/agent-history-memory.js`.
- Existing live endpoints:
  - `POST /memory/record`
  - `POST /memory/replay`
- Existing tab memory state:
  - `createTabState()` includes `agentHistorySteps: []`.
- Existing action recording hook:
  - `recordTabAction(tabState, action)` calls `recordSuccessfulBrowserAction(...)`.
- Existing recorded actions in `server.js` include:
  - navigate, click, type, press, scroll, back.
- Existing AgentHistory files are written under:
  - `~/.hermes/browser_memory/<site>/<action>.AgentHistory.json`
- Live smoke test already proved:
  - opening `https://example.com/` creates `default.AgentHistory.json`, `latest.AgentHistory.json`, `home.AgentHistory.json`.
  - `POST /memory/replay` returns `llm_used: false`.
- Project agent constraints from `AGENTS.md`:
  - keep `server.js` free of `process.env` reads and `child_process` imports.
  - do not introduce scanner-triggering combinations in one file.
  - run Jest tests for touched areas.

---

## Acceptance Criteria

1. Existing exact replay still works and still returns `llm_used: false` when no LLM fallback is used.
2. Recorded steps include enough target context to repair stale refs:
   - role/name/text/label/placeholder/href/id/class/data attributes when available,
   - approximate index/position,
   - nearby text,
   - before/after URL/title.
3. Replay validates expected outcomes after each step when present.
4. If a recorded ref fails, replay takes a fresh snapshot, finds candidate elements, scores them locally, and tries the best safe candidate.
5. Common interruptions can be handled before/after each step:
   - cookie banner,
   - login-required screen,
   - modal/popover blocking action,
   - captcha/human verification stops safely with `requires_human: true`.
6. Successful repaired replay can persist an improved flow variant.
7. LLM fallback is optional, explicit, and last-resort only.
8. No site-specific hardcoding such as `leboncoin` in core logic.
9. Tests cover unit behavior and route-level integration.

---

## Design Overview

Replay should follow this order:

```text
1. Exact low-level replay using recorded ref/selector
2. If exact replay fails: local target repair from fresh snapshot
3. Validate expected outcome
4. If blocked: run generic interrupt handlers
5. Retry repaired action once after interrupt handling
6. If still failing and allowLlmFallback=true: ask planner for one action
7. If fallback succeeds: persist learned variant
8. Else return structured failure with diagnostics
```

New modules:

- `lib/action-context.js`
  - extracts rich context for a target element at record time.
- `lib/outcome-validation.js`
  - validates URL/title/text/selector expectations.
- `lib/target-repair.js`
  - scores current snapshot candidates against saved target context.
- `lib/interrupt-handlers.js`
  - detects and resolves common generic browser blockers.
- `lib/self-healing-replay.js`
  - orchestrates exact replay, repair, validation, interrupts, and optional fallback.

Keep `lib/agent-history-memory.js` focused on persistence and basic AgentHistory shape.

---

## Phase 1 — Rich Step Capture

### Task 1: Add target context extraction tests

**Objective:** Define the minimal rich context needed to repair stale refs.

**Files:**
- Create: `tests/unit/actionContext.test.js`
- Create: `lib/action-context.js`

**Step 1: Write failing test**

Create `tests/unit/actionContext.test.js`:

```js
import { describe, expect, test } from '@jest/globals';
import { buildTargetContext, normalizeText } from '../../lib/action-context.js';

describe('action context', () => {
  test('normalizes visible text', () => {
    expect(normalizeText('  Modifier\n  l’annonce  ')).toBe('modifier l’annonce');
  });

  test('builds target context from snapshot node-like input', () => {
    const context = buildTargetContext({
      ref: 'e12',
      role: 'button',
      name: 'Modifier l’annonce',
      text: 'Modifier',
      attributes: {
        id: 'edit-ad',
        class: 'btn primary',
        'data-testid': 'edit-listing',
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
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- --runTestsByPath tests/unit/actionContext.test.js
```

Expected: FAIL because `lib/action-context.js` does not exist.

**Step 3: Implement minimal module**

Create `lib/action-context.js`:

```js
function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pickAttributes(attributes = {}) {
  const allowed = ['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'title', 'href', 'data-testid', 'data-test', 'data-cy'];
  const out = {};
  for (const key of allowed) {
    if (attributes[key]) out[key] = String(attributes[key]);
  }
  return out;
}

function buildTargetContext(node = {}) {
  return {
    ref: node.ref || null,
    role: node.role || node.nodeName || null,
    name: normalizeText(node.name || node.axName || node.label),
    text: normalizeText(node.text || node.innerText),
    attributes: pickAttributes(node.attributes),
    nearbyText: Array.isArray(node.nearbyText) ? node.nearbyText.map(normalizeText).filter(Boolean).slice(0, 8) : [],
    index: Number.isInteger(node.index) ? node.index : null,
  };
}

export { buildTargetContext, normalizeText, pickAttributes };
```

**Step 4: Run test to verify pass**

```bash
npm test -- --runTestsByPath tests/unit/actionContext.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/action-context.js tests/unit/actionContext.test.js
git commit -m "feat: add browser target context extraction"
```

---

### Task 2: Capture target context in recorded click/type steps

**Objective:** Enrich recorded steps with `target_summary` at action time.

**Files:**
- Modify: `server.js`
- Modify: `lib/agent-history-memory.js`
- Test: `tests/unit/agentHistoryMemory.test.js`

**Step 1: Add failing unit test**

In `tests/unit/agentHistoryMemory.test.js`, add a test similar to:

```js
test('recorded click preserves target summary', async () => {
  const tabState = createMemoryTabState();
  await recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e2',
    target_summary: { role: 'button', name: 'continuer' },
    result: { ok: true, url: 'https://example.com/next', title: 'Next' },
  });

  expect(tabState.agentHistorySteps[0].target_summary).toEqual({
    role: 'button',
    name: 'continuer',
  });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: FAIL if current shape does not preserve needed fields.

**Step 3: Implement minimal capture**

- Keep `enrichStep(...)` preserving `target_summary`.
- Add a helper near `recordTabAction(...)` in `server.js` to derive basic context from `tabState.refs` when `ref` is present.
- Do not make this perfect in this task; store whatever is already available.

Example shape:

```js
function targetSummaryFromRef(tabState, ref) {
  const node = tabState?.refs?.get?.(ref) || tabState?.refs?.get?.(String(ref).replace(/^@/, ''));
  if (!node) return null;
  return {
    ref,
    role: node.role || node.nodeName || null,
    name: node.name || node.axName || null,
    text: node.text || node.innerText || null,
    attributes: node.attributes || {},
    index: node.index ?? null,
  };
}
```

Then when recording click/type:

```js
recordTabAction(tabState, {
  kind: 'click',
  ref: req.body.ref,
  selector: req.body.selector,
  target_summary: targetSummaryFromRef(tabState, req.body.ref),
  result,
});
```

**Step 4: Run tests**

```bash
node --check server.js
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js tests/unit/actionContext.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server.js lib/agent-history-memory.js tests/unit/agentHistoryMemory.test.js
git commit -m "feat: enrich recorded browser actions with target context"
```

---

## Phase 2 — Expected Outcome Validation

### Task 3: Add outcome validation module

**Objective:** Provide deterministic validation for URL/title/text/selector expectations.

**Files:**
- Create: `lib/outcome-validation.js`
- Create: `tests/unit/outcomeValidation.test.js`

**Step 1: Write failing tests**

```js
import { describe, expect, test } from '@jest/globals';
import { validateOutcome } from '../../lib/outcome-validation.js';

describe('outcome validation', () => {
  test('passes when url contains expected text', async () => {
    const result = await validateOutcome({ urlContains: '/account' }, {
      getUrl: async () => 'https://example.com/account/listings',
      getTitle: async () => 'Account',
      hasText: async () => false,
      hasSelector: async () => false,
    });
    expect(result.ok).toBe(true);
  });

  test('fails with diagnostics when expected text is missing', async () => {
    const result = await validateOutcome({ textIncludes: 'Annonce publiée' }, {
      getUrl: async () => 'https://example.com/',
      getTitle: async () => 'Home',
      hasText: async () => false,
      hasSelector: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('textIncludes');
  });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/outcomeValidation.test.js
```

Expected: FAIL.

**Step 3: Implement module**

```js
async function validateOutcome(expected = {}, pageState) {
  if (!expected || Object.keys(expected).length === 0) return { ok: true, skipped: true };

  if (expected.urlContains) {
    const url = await pageState.getUrl();
    if (!url.includes(expected.urlContains)) return { ok: false, reason: `urlContains missing: ${expected.urlContains}`, url };
  }

  if (expected.titleIncludes) {
    const title = await pageState.getTitle();
    if (!title.toLowerCase().includes(String(expected.titleIncludes).toLowerCase())) {
      return { ok: false, reason: `titleIncludes missing: ${expected.titleIncludes}`, title };
    }
  }

  if (expected.textIncludes) {
    const found = await pageState.hasText(expected.textIncludes);
    if (!found) return { ok: false, reason: `textIncludes missing: ${expected.textIncludes}` };
  }

  if (expected.selectorVisible) {
    const found = await pageState.hasSelector(expected.selectorVisible);
    if (!found) return { ok: false, reason: `selectorVisible missing: ${expected.selectorVisible}` };
  }

  return { ok: true };
}

export { validateOutcome };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/outcomeValidation.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/outcome-validation.js tests/unit/outcomeValidation.test.js
git commit -m "feat: add browser replay outcome validation"
```

---

### Task 4: Store expected outcomes in AgentHistory steps

**Objective:** Allow callers and future learning code to store observable success conditions.

**Files:**
- Modify: `lib/agent-history-memory.js`
- Test: `tests/unit/agentHistoryMemory.test.js`

**Step 1: Add failing test**

```js
test('preserves expected outcome on recorded step', async () => {
  const tabState = createMemoryTabState();
  await recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e1',
    expected_outcome: { urlContains: '/next' },
    result: { ok: true, url: 'https://example.com/next' },
  });
  expect(tabState.agentHistorySteps[0].expected_outcome).toEqual({ urlContains: '/next' });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: FAIL if overwritten to `{}`.

**Step 3: Implement**

In `enrichStep(input)`, replace:

```js
const step = { kind: input.kind, expected_outcome: {} };
```

with:

```js
const step = { kind: input.kind, expected_outcome: input.expected_outcome || {} };
```

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js tests/unit/outcomeValidation.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/agent-history-memory.js tests/unit/agentHistoryMemory.test.js
git commit -m "feat: preserve expected outcomes in browser memory"
```

---

## Phase 3 — Local Target Repair

### Task 5: Add target scoring module

**Objective:** Score current candidate elements against saved target context.

**Files:**
- Create: `lib/target-repair.js`
- Create: `tests/unit/targetRepair.test.js`

**Step 1: Write failing tests**

```js
import { describe, expect, test } from '@jest/globals';
import { scoreCandidate, findBestCandidate } from '../../lib/target-repair.js';

describe('target repair', () => {
  test('scores exact role and name highly', () => {
    const saved = { role: 'button', name: 'modifier l’annonce', text: 'modifier' };
    const candidate = { ref: 'e9', role: 'button', name: 'modifier l’annonce', text: 'modifier' };
    expect(scoreCandidate(saved, candidate)).toBeGreaterThanOrEqual(80);
  });

  test('finds best candidate from list', () => {
    const saved = { role: 'button', name: 'continuer' };
    const best = findBestCandidate(saved, [
      { ref: 'e1', role: 'link', name: 'aide' },
      { ref: 'e2', role: 'button', name: 'continuer' },
    ]);
    expect(best.ref).toBe('e2');
  });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/targetRepair.test.js
```

Expected: FAIL.

**Step 3: Implement scoring**

```js
function same(a, b) {
  return String(a || '') && String(a || '') === String(b || '');
}

function includesEither(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  return aa && bb && (aa.includes(bb) || bb.includes(aa));
}

function scoreCandidate(saved = {}, candidate = {}) {
  let score = 0;
  if (same(saved.role, candidate.role)) score += 25;
  if (same(saved.name, candidate.name)) score += 35;
  else if (includesEither(saved.name, candidate.name)) score += 20;
  if (same(saved.text, candidate.text)) score += 20;
  else if (includesEither(saved.text, candidate.text)) score += 10;

  const savedAttrs = saved.attributes || {};
  const candidateAttrs = candidate.attributes || {};
  for (const key of ['data-testid', 'data-test', 'data-cy', 'id', 'name', 'placeholder', 'aria-label', 'href']) {
    if (savedAttrs[key] && savedAttrs[key] === candidateAttrs[key]) score += 15;
  }

  if (Number.isInteger(saved.index) && Number.isInteger(candidate.index)) {
    const distance = Math.abs(saved.index - candidate.index);
    if (distance === 0) score += 8;
    else if (distance <= 3) score += 4;
  }

  return Math.min(score, 100);
}

function findBestCandidate(saved, candidates, { threshold = 60 } = {}) {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(saved, candidate) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= threshold ? ranked[0] : null;
}

export { findBestCandidate, scoreCandidate };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/targetRepair.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/target-repair.js tests/unit/targetRepair.test.js
git commit -m "feat: add local browser target repair scoring"
```

---

### Task 6: Add candidate extraction from current refs

**Objective:** Convert `tabState.refs` into normalized repair candidates.

**Files:**
- Modify: `lib/target-repair.js`
- Test: `tests/unit/targetRepair.test.js`

**Step 1: Add failing test**

```js
import { candidatesFromRefs } from '../../lib/target-repair.js';

test('builds candidates from ref map', () => {
  const refs = new Map([
    ['e1', { role: 'button', name: 'Continuer', attributes: { id: 'go' } }],
  ]);
  expect(candidatesFromRefs(refs)).toEqual([
    expect.objectContaining({ ref: 'e1', role: 'button', name: 'continuer' }),
  ]);
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/targetRepair.test.js
```

Expected: FAIL.

**Step 3: Implement**

Use `buildTargetContext` from `lib/action-context.js`:

```js
import { buildTargetContext } from './action-context.js';

function candidatesFromRefs(refs) {
  if (!refs || typeof refs.entries !== 'function') return [];
  return Array.from(refs.entries()).map(([ref, node], index) => buildTargetContext({ ref, index, ...node }));
}
```

Export `candidatesFromRefs`.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/targetRepair.test.js tests/unit/actionContext.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/target-repair.js tests/unit/targetRepair.test.js
git commit -m "feat: build browser repair candidates from refs"
```

---

## Phase 4 — Self-Healing Replay Orchestrator

### Task 7: Create self-healing replay module with exact replay pass-through

**Objective:** Introduce orchestrator without changing behavior yet.

**Files:**
- Create: `lib/self-healing-replay.js`
- Create: `tests/unit/selfHealingReplay.test.js`

**Step 1: Write failing test**

```js
import { describe, expect, test } from '@jest/globals';
import { replayStepSelfHealing } from '../../lib/self-healing-replay.js';

describe('self-healing replay', () => {
  test('uses exact handler first', async () => {
    const calls = [];
    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('exact');
    expect(calls).toEqual(['e1']);
  });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL.

**Step 3: Implement pass-through**

```js
async function replayStepSelfHealing(step, ctx) {
  const handler = ctx.handlers[step.kind];
  if (!handler) return { ok: false, error: `No handler for ${step.kind}` };

  const exact = await handler(step);
  if (exact?.ok !== false && !exact?.error) {
    const validation = await ctx.validate(step.expected_outcome || {});
    if (validation.ok) return { ok: true, mode: 'exact', result: exact, validation };
    return { ok: false, mode: 'exact_validation_failed', result: exact, validation };
  }

  return { ok: false, mode: 'exact_failed', result: exact };
}

export { replayStepSelfHealing };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: add self-healing replay pass-through"
```

---

### Task 8: Add local repair fallback to self-healing replay

**Objective:** When exact ref fails, find a repaired ref and retry.

**Files:**
- Modify: `lib/self-healing-replay.js`
- Test: `tests/unit/selfHealingReplay.test.js`

**Step 1: Add failing test**

```js
test('repairs stale click ref from candidates', async () => {
  const calls = [];
  const result = await replayStepSelfHealing(
    { kind: 'click', ref: 'e1', target_summary: { role: 'button', name: 'continuer' } },
    {
      handlers: {
        click: async (step) => {
          calls.push(step.ref);
          if (step.ref === 'e1') return { ok: false, error: 'stale ref' };
          return { ok: true };
        },
      },
      refreshRefs: async () => {},
      getCandidates: async () => [{ ref: 'e9', role: 'button', name: 'continuer' }],
      validate: async () => ({ ok: true }),
    }
  );

  expect(result.ok).toBe(true);
  expect(result.mode).toBe('repaired');
  expect(calls).toEqual(['e1', 'e9']);
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL.

**Step 3: Implement repair branch**

- Import `findBestCandidate`.
- After exact failure:
  - call `refreshRefs()` if present,
  - call `getCandidates()`,
  - score against `step.target_summary`,
  - clone step with repaired `ref`,
  - retry handler once.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/targetRepair.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: repair stale browser refs during replay"
```

---

### Task 9: Wire self-healing replay into `/memory/replay`

**Objective:** Use exact+repair replay path from the public endpoint.

**Files:**
- Modify: `server.js`
- Modify: `lib/agent-history-memory.js` if needed
- Test: existing route tests or create `tests/unit/memoryReplayRoute.test.js` if route tests are already mocked.

**Step 1: Add route-level test**

If the project has existing server route tests, extend them. Otherwise create a focused test that mocks handler behavior and asserts the self-healing result shape includes:

```js
expect(response.body).toMatchObject({
  ok: true,
  llm_used: false,
});
expect(response.body.results[0].mode).toBeDefined();
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: existing self-healing tests pass; route test initially fails until wired.

**Step 3: Implement wiring**

Option A, minimal:
- Keep `replayAgentHistory(...)` loading steps.
- Replace the internal per-step dispatch with a new exported `replayAgentHistorySelfHealing(...)`.

Option B, cleaner:
- Add a new function in `lib/self-healing-replay.js`:

```js
async function replayStepsSelfHealing(steps, ctx) {
  const results = [];
  for (const step of steps) {
    const result = await replayStepSelfHealing(step, ctx);
    results.push({ step, ...result });
    if (!result.ok) return { ok: false, llm_used: false, replayed_steps: results.length, results };
  }
  return { ok: true, llm_used: false, replayed_steps: results.length, results };
}
```

- In `/memory/replay`, build ctx:
  - `handlers` = current navigate/click/type/press/scroll/back handlers,
  - `refreshRefs` = rebuild refs,
  - `getCandidates` = `candidatesFromRefs(tabState.refs)`,
  - `validate` = wrapper around `validateOutcome`.

**Step 4: Run checks**

```bash
node --check server.js
node --check lib/self-healing-replay.js
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/targetRepair.test.js tests/unit/outcomeValidation.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server.js lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: wire self-healing browser memory replay"
```

---

## Phase 5 — Interrupt Handlers

### Task 10: Add generic interrupt detection

**Objective:** Detect common blockers without site-specific logic.

**Files:**
- Create: `lib/interrupt-handlers.js`
- Create: `tests/unit/interruptHandlers.test.js`

**Step 1: Write failing tests**

```js
import { describe, expect, test } from '@jest/globals';
import { detectInterrupt } from '../../lib/interrupt-handlers.js';

describe('interrupt handlers', () => {
  test('detects captcha-like human verification', () => {
    const interrupt = detectInterrupt({
      url: 'https://example.com/',
      title: 'Security check',
      text: 'Veuillez confirmer que vous êtes humain captcha',
    });
    expect(interrupt.type).toBe('human_verification');
    expect(interrupt.requires_human).toBe(true);
  });

  test('detects cookie banner', () => {
    const interrupt = detectInterrupt({ text: 'Nous utilisons des cookies Accepter Refuser' });
    expect(interrupt.type).toBe('cookie_banner');
  });
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/interruptHandlers.test.js
```

Expected: FAIL.

**Step 3: Implement detection**

```js
function detectInterrupt(state = {}) {
  const haystack = `${state.url || ''} ${state.title || ''} ${state.text || ''}`.toLowerCase();
  if (/captcha|êtes humain|human verification|security check|cloudflare/.test(haystack)) {
    return { type: 'human_verification', requires_human: true };
  }
  if (/cookies|accepter.*cookies|manage consent|préférences/.test(haystack)) {
    return { type: 'cookie_banner', requires_human: false };
  }
  if (/connectez-vous|se connecter|login|connexion requise/.test(haystack)) {
    return { type: 'login_required', requires_human: false };
  }
  return null;
}

export { detectInterrupt };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/interruptHandlers.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/interrupt-handlers.js tests/unit/interruptHandlers.test.js
git commit -m "feat: detect generic browser replay interrupts"
```

---

### Task 11: Stop safely on human verification

**Objective:** Never try to bypass captcha/human verification.

**Files:**
- Modify: `lib/self-healing-replay.js`
- Test: `tests/unit/selfHealingReplay.test.js`

**Step 1: Add failing test**

```js
test('stops on human verification interrupt', async () => {
  const result = await replayStepSelfHealing(
    { kind: 'click', ref: 'e1' },
    {
      detectInterrupt: async () => ({ type: 'human_verification', requires_human: true }),
      handlers: { click: async () => ({ ok: true }) },
      validate: async () => ({ ok: true }),
    }
  );

  expect(result.ok).toBe(false);
  expect(result.requires_human).toBe(true);
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL.

**Step 3: Implement pre-step interrupt check**

At start of `replayStepSelfHealing`:

```js
const interrupt = ctx.detectInterrupt ? await ctx.detectInterrupt() : null;
if (interrupt?.requires_human) {
  return { ok: false, mode: 'blocked', interrupt, requires_human: true };
}
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/interruptHandlers.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: stop browser replay on human verification"
```

---

### Task 12: Add generic cookie banner resolver

**Objective:** Close obvious cookie banners using local candidate scoring, not LLM.

**Files:**
- Modify: `lib/interrupt-handlers.js`
- Test: `tests/unit/interruptHandlers.test.js`

**Step 1: Add failing test**

```js
import { chooseCookieConsentCandidate } from '../../lib/interrupt-handlers.js';

test('prefers reject or minimal consent buttons', () => {
  const chosen = chooseCookieConsentCandidate([
    { ref: 'e1', role: 'button', name: 'tout accepter' },
    { ref: 'e2', role: 'button', name: 'continuer sans accepter' },
  ]);
  expect(chosen.ref).toBe('e2');
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/interruptHandlers.test.js
```

Expected: FAIL.

**Step 3: Implement**

```js
function chooseCookieConsentCandidate(candidates = []) {
  const preferences = [
    /continuer sans accepter/,
    /refuser/,
    /reject/,
    /tout refuser/,
    /accepter/,
    /accept/,
  ];
  for (const pattern of preferences) {
    const found = candidates.find((candidate) => pattern.test(String(candidate.name || candidate.text || '').toLowerCase()));
    if (found) return found;
  }
  return null;
}

export { detectInterrupt, chooseCookieConsentCandidate };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/interruptHandlers.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/interrupt-handlers.js tests/unit/interruptHandlers.test.js
git commit -m "feat: choose generic cookie banner action"
```

---

## Phase 6 — Learning Improved Variants

### Task 13: Persist repaired steps after successful replay

**Objective:** When a stale ref is repaired successfully, save the improved ref/context as a variant so future replay is faster.

**Files:**
- Modify: `lib/self-healing-replay.js`
- Modify: `lib/agent-history-memory.js` if a helper is needed
- Test: `tests/unit/selfHealingReplay.test.js`

**Step 1: Add failing test**

```js
test('reports repaired step so caller can persist improved variant', async () => {
  const result = await replayStepSelfHealing(
    { kind: 'click', ref: 'old', target_summary: { role: 'button', name: 'continuer' } },
    {
      handlers: {
        click: async (step) => step.ref === 'old' ? { ok: false } : { ok: true },
      },
      refreshRefs: async () => {},
      getCandidates: async () => [{ ref: 'new', role: 'button', name: 'continuer' }],
      validate: async () => ({ ok: true }),
    }
  );
  expect(result.repaired_step.ref).toBe('new');
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL.

**Step 3: Implement result field**

When repaired handler succeeds, return:

```js
return { ok: true, mode: 'repaired', result: repairedResult, validation, repaired_step: repairedStep };
```

**Step 4: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: expose repaired browser replay steps"
```

---

### Task 14: Save learned variants from `/memory/replay`

**Objective:** Allow successful repaired replay to write an updated flow file.

**Files:**
- Modify: `server.js`
- Modify: `lib/agent-history-memory.js`
- Test: route/integration test

**Step 1: Define API behavior**

Extend `POST /memory/replay` body:

```json
{
  "userId": "agent",
  "siteKey": "example.com",
  "actionKey": "login",
  "learnRepairs": true
}
```

Expected response includes:

```json
{
  "ok": true,
  "learned": true,
  "learnedPath": "/home/jul/.hermes/browser_memory/example.com/login.AgentHistory.json"
}
```

**Step 2: Add failing test**

Use a mocked repaired replay result and assert persistence helper is called only when:

- replay `ok === true`,
- at least one result has `repaired_step`,
- `learnRepairs === true`.

**Step 3: Implement**

- Build `updatedSteps` by replacing original steps with `repaired_step` where present.
- Persist to same `siteKey/actionKey` or to `actionKey.repaired` if safer.
- Prefer same actionKey after tests prove no data loss.
- Add `hermes_meta.learned_from` with previous action path and timestamp if easy.

**Step 4: Run tests**

```bash
node --check server.js
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server.js lib/agent-history-memory.js tests
git commit -m "feat: persist learned browser replay repairs"
```

---

## Phase 7 — Optional Controlled LLM Fallback

### Task 15: Add fallback interface without implementing provider

**Objective:** Make LLM fallback explicit and disabled by default.

**Files:**
- Modify: `lib/self-healing-replay.js`
- Test: `tests/unit/selfHealingReplay.test.js`

**Step 1: Add failing tests**

```js
test('does not use planner fallback unless explicitly allowed', async () => {
  let planned = false;
  const result = await replayStepSelfHealing(
    { kind: 'click', ref: 'missing' },
    {
      handlers: { click: async () => ({ ok: false }) },
      getCandidates: async () => [],
      validate: async () => ({ ok: true }),
      plannerFallback: async () => { planned = true; return { ok: true }; },
      allowLlmFallback: false,
    }
  );
  expect(planned).toBe(false);
  expect(result.ok).toBe(false);
});

test('uses planner fallback only when allowed', async () => {
  const result = await replayStepSelfHealing(
    { kind: 'click', ref: 'missing' },
    {
      handlers: { click: async () => ({ ok: false }) },
      getCandidates: async () => [],
      validate: async () => ({ ok: true }),
      plannerFallback: async () => ({ ok: true, action: { kind: 'click', ref: 'e99' } }),
      allowLlmFallback: true,
    }
  );
  expect(result.ok).toBe(true);
  expect(result.llm_used).toBe(true);
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: FAIL.

**Step 3: Implement interface**

At the final failure branch:

```js
if (ctx.allowLlmFallback && ctx.plannerFallback) {
  const planned = await ctx.plannerFallback(step);
  return { ...planned, mode: 'llm_fallback', llm_used: true };
}
return { ok: false, mode: 'repair_failed', llm_used: false, result: exact };
```

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/self-healing-replay.js tests/unit/selfHealingReplay.test.js
git commit -m "feat: add explicit browser replay planner fallback hook"
```

---

## Phase 8 — Generic Intent Memory Layer

### Task 16: Add action-key aliases and semantic labels

**Objective:** Store human-meaningful intent labels without turning core replay into site-specific code.

**Files:**
- Modify: `lib/agent-history-memory.js`
- Test: `tests/unit/agentHistoryMemory.test.js`

**Step 1: Add failing test**

```js
test('persists semantic labels in metadata', async () => {
  const tabState = createMemoryTabState();
  await recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/account',
    result: { ok: true, url: 'https://example.com/account' },
  });
  const saved = await recordFlow(tabState, 'example.com', 'open_my_account', {
    labels: ['account', 'listings'],
  });
  expect(saved.payload.hermes_meta.labels).toEqual(['account', 'listings']);
});
```

**Step 2: Run test**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: FAIL.

**Step 3: Implement optional metadata**

- Extend `persistRuntimeSteps(steps, siteKey, actionKey, aliases = [], options = {})`.
- Add `labels: options.labels || []` under `hermes_meta`.
- Extend `recordFlow(tabState, siteKey, actionKey, options = {})`.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/agent-history-memory.js tests/unit/agentHistoryMemory.test.js
git commit -m "feat: add semantic labels to browser memory flows"
```

---

### Task 17: Add `/memory/search` endpoint

**Objective:** Let callers find flows by site/action/label before deciding what to replay.

**Files:**
- Modify: `server.js`
- Modify: `lib/agent-history-memory.js`
- Test: route test or unit test for search helper

**Step 1: Add helper test**

Test a helper like:

```js
const results = await searchFlows({ siteKey: 'example.com', query: 'account' });
expect(results[0]).toMatchObject({ actionKey: 'open_my_account' });
```

**Step 2: Implement search helper**

- Scan `~/.hermes/browser_memory/<site>/*.AgentHistory.json`.
- Match query against:
  - action key,
  - aliases,
  - labels,
  - title/url from steps.
- Return compact metadata only, not full secrets or typed text.

**Step 3: Add endpoint**

`GET /memory/search?siteKey=example.com&q=account`

Response:

```json
{
  "ok": true,
  "results": [
    { "siteKey": "example.com", "actionKey": "open_my_account", "labels": ["account"] }
  ]
}
```

**Step 4: Run tests**

```bash
node --check server.js
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server.js lib/agent-history-memory.js tests
git commit -m "feat: search browser memory flows by intent labels"
```

---

## Phase 9 — Safety and Privacy

### Task 18: Redact sensitive typed values by default

**Objective:** Avoid storing passwords, OTPs, card data, or private messages in replay files unless explicitly allowed.

**Files:**
- Modify: `lib/agent-history-memory.js`
- Create/modify: `tests/unit/agentHistoryMemory.test.js`

**Step 1: Add failing tests**

```js
test('redacts password-like typed values', async () => {
  const tabState = createMemoryTabState();
  await recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: 'e1',
    text: 'super-secret',
    target_summary: { attributes: { type: 'password' } },
    result: { ok: true, url: 'https://example.com/login' },
  });
  expect(tabState.agentHistorySteps[0].text).toBe('__REDACTED__');
});
```

**Step 2: Implement redaction**

Redact if:
- target `type=password`,
- target name/placeholder contains `password`, `mot de passe`, `otp`, `code`,
- text looks like card number or long token.

Store:

```js
step.text_redacted = true;
step.text = '__REDACTED__';
```

**Step 3: Replay behavior**

If replay sees redacted text:
- do not type it,
- return `requires_secret: true`,
- allow caller to provide runtime value separately later.

**Step 4: Run tests**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js tests/unit/selfHealingReplay.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/agent-history-memory.js tests
git commit -m "feat: redact sensitive browser memory inputs"
```

---

## Phase 10 — Live Validation

### Task 19: Add local HTML fixture for DOM drift

**Objective:** Prove self-healing works when a button ref changes but semantic target stays same.

**Files:**
- Create: `tests/fixtures/dom-drift-v1.html`
- Create: `tests/fixtures/dom-drift-v2.html`
- Create/modify: e2e test file if project has e2e setup.

**Step 1: Create fixtures**

`v1`:

```html
<button id="continue-old">Continuer</button>
```

`v2`:

```html
<div><button data-testid="continue-new">Continuer</button></div>
```

**Step 2: Add e2e test**

- Record on v1.
- Replay on v2.
- Assert exact ref fails but repair clicks v2 button.
- Assert response mode includes `repaired`.

**Step 3: Run e2e**

```bash
npm run test:e2e -- --runTestsByPath tests/e2e/selfHealingMemory.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tests/fixtures tests/e2e/selfHealingMemory.test.js
git commit -m "test: prove browser memory repairs DOM drift"
```

---

### Task 20: Run generic live smoke test, then site-specific manual validation elsewhere

**Objective:** Verify the generic system without hardcoding a marketplace.

**Files:**
- No code changes unless bugs found.

**Step 1: Run syntax checks**

```bash
node --check server.js
node --check lib/action-context.js
node --check lib/target-repair.js
node --check lib/outcome-validation.js
node --check lib/interrupt-handlers.js
node --check lib/self-healing-replay.js
```

Expected: no syntax errors.

**Step 2: Run targeted tests**

```bash
npm test -- --runTestsByPath \
  tests/unit/actionContext.test.js \
  tests/unit/targetRepair.test.js \
  tests/unit/outcomeValidation.test.js \
  tests/unit/interruptHandlers.test.js \
  tests/unit/selfHealingReplay.test.js \
  tests/unit/agentHistoryMemory.test.js
```

Expected: PASS.

**Step 3: Run existing relevant regression tests**

```bash
npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js
npm test
```

Expected: PASS, or document unrelated flaky failures and rerun exact failing test.

**Step 4: Live smoke test**

- Start/restart Camofox.
- Open a benign public test page.
- Record a click/type flow.
- Verify files under `~/.hermes/browser_memory/<site>/`.
- Replay with `POST /memory/replay`.
- Confirm response contains:
  - `ok: true`,
  - `llm_used: false`, unless explicit fallback was requested,
  - `mode: exact` or `mode: repaired` per step.

**Step 5: Site-specific validation elsewhere**

For Leboncoin or another real marketplace:
- use browser only,
- do not call private APIs,
- stop on captcha/human verification,
- do not send buyer messages or publish/edit listings without explicit confirmation policy,
- record named flows such as `login`, `open_my_ads`, `edit_listing`, `reply_draft`.

**Step 6: Commit any bug fixes**

```bash
git status --short
git add <changed-files>
git commit -m "fix: stabilize self-healing browser memory live replay"
```

---

## Final Verification Checklist

- [ ] No `leboncoin` hardcoding in generic modules.
- [ ] No `process.env` reads added to `server.js`.
- [ ] No `child_process` imports added to `server.js`.
- [ ] Exact replay still works.
- [ ] Stale ref repair works.
- [ ] Outcome validation can fail a false-positive click.
- [ ] Captcha/human verification returns `requires_human: true`.
- [ ] Cookie banner handling prefers minimal consent/refusal.
- [ ] Repaired replay can be learned/persisted.
- [ ] LLM fallback disabled by default.
- [ ] Sensitive typed values are redacted by default.
- [ ] Unit tests pass.
- [ ] At least one live browser smoke test passes.

---

## Operator Notes

This plan intentionally avoids building a full autonomous agent in one step. The valuable part is the layered reliability:

```text
record richer facts → replay exact → repair locally → validate outcome → handle interrupts → learn repair → optional LLM fallback
```

That is the practical path toward “understanding magic” while keeping cost, risk, and side effects controlled.
