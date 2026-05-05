# Camofox Human Behavior V2 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Camofox browser actions behave like coherent human sessions, not isolated API commands, while staying browser-only: Playwright mouse/keyboard/wheel, no raw X11 automation, no synthetic JS site actions.

**Architecture:** Extend the current `lib/human-actions.js` into a small behavior engine with persistent per-tab cursor state, deterministic per-profile behavioral signatures, target preparation, improved aiming/scrolling/typing, and optional human-session recording for calibration. Keep the public browser endpoints compatible: existing `humanProfile = 'fast'` remains the default, with optional richer behavior enabled through new helper defaults.

**Tech Stack:** Node.js ESM, Playwright/Camoufox, Jest unit tests, existing Camofox server state in `server.js`.

---

## Verified Context

- Repo: `/home/jul/tools/camofox-browser`.
- Current human action implementation lives in `lib/human-actions.js`.
- Current default profile is already `fast`:
  - `getHumanProfile(name = 'fast')`
  - `humanMove(... profile = 'fast')`
  - `humanClick`, `humanType`, `humanScroll` default to fast.
- Current `fast` timings:
  - click pause before down `[25, 75]`, hold `[25, 70]`, after `[50, 130]`
  - typing delay `[12, 65]`
  - scroll steps `[2, 5]`
- Current endpoints in `server.js` use `humanProfile = 'fast'` for `/click`, `/type`, `/press`, `/scroll`.
- Current click path still has a Google SERP exception using `locator.click({ force: true })`; browser-only policy tests tolerate this only for Google.
- Existing tests:
  - `tests/unit/humanActions.test.js`
  - `tests/unit/browserOnlyPolicy.test.js`
  - `tests/unit/typeKeyboardMode.test.js`
  - `tests/unit/browserPersona.test.js`
- Last targeted verification before this plan: 35 Jest tests passed for human actions/browser-only/type mode, plus `node --check server.js`.
- Current browser persona is deterministic in `lib/browser-persona.js` from `userId` and already controls OS/locale/screen.

## Non-Negotiable Constraints

1. No raw X11 automation for site actions.
2. No page-side synthetic JS actions such as `dispatchEvent`, `.click()` injection, or DOM mutation to perform user actions.
3. Use Playwright browser primitives only:
   - `page.mouse.move/down/up/wheel`
   - `page.keyboard.type/press`
   - `locator.boundingBox/focus`
   - normal Playwright waits/locator visibility checks.
4. Keep default operation fast. Human realism must not make VNC/browser control painfully slow.
5. Sensitive fields must not intentionally receive typo behavior.
6. Add tests before implementation for each behavior change.

---

# Phase 1 — Persistent Cursor State

## Task 1: Add cursor state helpers to tab state — Complete

**Status:** Complete and validated in Phase 1.

**Objective:** Store the last mouse position per tab so consecutive actions start from the real previous position instead of `{x: 0, y: 0}`.

**Files:**
- Modify: `server.js` near `createTabState(...)`
- Test: `tests/unit/humanSessionState.test.js`

**Step 1: Write failing test**

Create `tests/unit/humanSessionState.test.js`:

```js
import { createHumanSessionState, updateHumanCursor, getHumanCursor } from '../../lib/human-session-state.js';

describe('human session state', () => {
  test('stores and returns last cursor position', () => {
    const state = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });

    updateHumanCursor(state, { x: 420, y: 240 });

    expect(getHumanCursor(state)).toEqual({ x: 420, y: 240 });
  });

  test('starts from deterministic viewport-relative position when no cursor exists yet', () => {
    const a = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });
    const b = createHumanSessionState({ viewport: { width: 1000, height: 800 }, seed: 123 });

    expect(getHumanCursor(a)).toEqual(getHumanCursor(b));
    expect(getHumanCursor(a).x).toBeGreaterThanOrEqual(0);
    expect(getHumanCursor(a).x).toBeLessThanOrEqual(1000);
    expect(getHumanCursor(a).y).toBeGreaterThanOrEqual(0);
    expect(getHumanCursor(a).y).toBeLessThanOrEqual(800);
  });
});
```

**Step 2: Verify RED**

Run:

```bash
npm test -- tests/unit/humanSessionState.test.js --runInBand
```

Expected: FAIL because `lib/human-session-state.js` does not exist.

**Step 3: Implement minimal helper**

Create `lib/human-session-state.js`:

```js
import { createSeededRandom } from './human-actions.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createHumanSessionState({ viewport = { width: 1280, height: 720 }, seed = Date.now() } = {}) {
  const rng = createSeededRandom(seed);
  return {
    version: 1,
    seed,
    viewport,
    lastCursor: {
      x: Math.round(viewport.width * (0.25 + rng() * 0.5)),
      y: Math.round(viewport.height * (0.25 + rng() * 0.5)),
    },
    lastActionAt: 0,
  };
}

export function getHumanCursor(state) {
  return { ...state.lastCursor };
}

export function updateHumanCursor(state, position) {
  const viewport = state.viewport || { width: 1280, height: 720 };
  state.lastCursor = {
    x: clamp(Number(position.x) || 0, 0, viewport.width),
    y: clamp(Number(position.y) || 0, 0, viewport.height),
  };
  state.lastActionAt = Date.now();
  return getHumanCursor(state);
}
```

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/humanSessionState.test.js --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add lib/human-session-state.js tests/unit/humanSessionState.test.js
git commit -m "feat: add human browser session cursor state"
```

## Task 2: Initialize human session state in tab state — Complete

**Status:** Complete and validated in Phase 1.

**Objective:** Every tab gets `tabState.humanSession` seeded from user/profile/tab information.

**Files:**
- Modify: `server.js` in `createTabState(page, options = {})`
- Modify: `server.js` where `createTabState` is called, if viewport/user data is available
- Test: `tests/unit/humanSessionState.test.js`

**Step 1: Write failing test**

Add to `tests/unit/humanSessionState.test.js`:

```js
import { createHumanSessionState } from '../../lib/human-session-state.js';

test('session state accepts deterministic string seeds through caller hashing', () => {
  const state = createHumanSessionState({ viewport: { width: 1920, height: 1080 }, seed: 42 });
  expect(state.viewport).toEqual({ width: 1920, height: 1080 });
  expect(state.lastCursor.x).toBeGreaterThan(0);
});
```

This small test protects the helper while `server.js` integration remains syntax/lint verified.

**Step 2: Verify RED/GREEN**

The test may already pass; if it does, proceed with server integration and rely on `node --check` plus existing route tests. Do not overfit server internals.

**Step 3: Implement server integration**

In `server.js` imports:

```js
import { createHumanSessionState, getHumanCursor, updateHumanCursor } from './lib/human-session-state.js';
```

In `createTabState(page, options = {})`, add:

```js
humanSession: createHumanSessionState({
  viewport: options.viewport || options.persona?.viewport || { width: 1280, height: 720 },
  seed: options.humanSeed || Date.now(),
}),
```

If `options` does not currently include persona/viewport, start with default viewport only. Later tasks can seed by user/profile.

**Step 4: Verify**

```bash
node --check server.js
npm test -- tests/unit/humanSessionState.test.js --runInBand
```

Expected: PASS.

---

# Phase 2 — Cursor-Aware Actions

## Task 3: Make `humanClick` consume and return cursor state — Complete

**Status:** Complete and validated in Phase 2.

**Objective:** `humanClick` should start from the prior cursor and return the new cursor position.

**Files:**
- Modify: `lib/human-actions.js`
- Test: `tests/unit/humanActions.test.js`

**Step 1: Write failing test**

Add:

```js
test('humanClick starts movement from provided cursor and returns updated cursor', async () => {
  const page = createFakePage();
  const locator = createLocator({ x: 500, y: 300, width: 100, height: 50 });
  const rng = createSeededRandom(33);

  const result = await humanClick(page, locator, {
    rng,
    from: { x: 400, y: 250 },
  });

  const firstMove = page.mouse.move.mock.calls[0];
  expect(firstMove[0]).toBeGreaterThan(390);
  expect(firstMove[1]).toBeGreaterThan(240);
  expect(result.cursor).toEqual(result.position);
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

Expected: FAIL because `result.cursor` is absent.

**Step 3: Implement**

In `humanClick`, return:

```js
return { ok: true, position: to, cursor: to, move };
```

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

Expected: PASS.

## Task 4: Wire endpoint click to persistent cursor state — Complete

**Status:** Complete and validated in Phase 2.

**Objective:** `/tabs/:tabId/click` uses `tabState.humanSession.lastCursor` as `from` and updates it after click.

**Files:**
- Modify: `server.js` click endpoint
- Test: `tests/unit/browserOnlyPolicy.test.js` or new static route test

**Step 1: Write failing static policy test**

In `tests/unit/browserOnlyPolicy.test.js`, add:

```js
test('click endpoint wires persistent human cursor state', () => {
  const clickBlock = serverSource.slice(
    serverSource.indexOf("app.post('/tabs/:tabId/click'"),
    serverSource.indexOf('// Type')
  );

  expect(clickBlock).toMatch(/getHumanCursor\(tabState\.humanSession\)/);
  expect(clickBlock).toMatch(/updateHumanCursor\(tabState\.humanSession/);
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement**

Replace normal click call:

```js
const clickResult = await humanClick(tabState.page, locator, {
  profile: humanProfile,
  from: getHumanCursor(tabState.humanSession),
});
updateHumanCursor(tabState.humanSession, clickResult.cursor || clickResult.position);
```

Keep Google SERP exception unchanged for now, but after Google force click, consider updating cursor from bounding box center if available.

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js --runInBand
node --check server.js
```

---

# Phase 3 — Deterministic Behavioral Signatures

## Task 5: Add human behavior persona builder — Complete

**Status:** Complete and validated in Phase 3.

**Objective:** Each browser profile/user gets a deterministic behavior signature so multiple profiles do not move/type identically.

**Files:**
- Create: `lib/human-behavior-persona.js`
- Test: `tests/unit/humanBehaviorPersona.test.js`

**Step 1: Write failing test**

```js
import { buildHumanBehaviorPersona } from '../../lib/human-behavior-persona.js';

describe('human behavior persona', () => {
  test('is deterministic for same profile key', () => {
    expect(buildHumanBehaviorPersona('leboncoin-ge')).toEqual(buildHumanBehaviorPersona('leboncoin-ge'));
  });

  test('varies across profile keys while keeping fast default', () => {
    const a = buildHumanBehaviorPersona('leboncoin-ge');
    const b = buildHumanBehaviorPersona('leboncoin-cim');

    expect(a.profile).toBe('fast');
    expect(b.profile).toBe('fast');
    expect(a.seed).not.toBe(b.seed);
    expect(a.motionJitter).not.toBe(b.motionJitter);
  });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/humanBehaviorPersona.test.js --runInBand
```

Expected: FAIL.

**Step 3: Implement**

Create:

```js
import crypto from 'node:crypto';

function hashInt(input, salt) {
  const digest = crypto.createHash('sha256').update(`${salt}:${String(input)}`).digest();
  return digest.readUInt32BE(0);
}

function unit(input, salt) {
  return hashInt(input, salt) / 0xffffffff;
}

function range(input, salt, min, max) {
  return min + (max - min) * unit(input, salt);
}

export function buildHumanBehaviorPersona(profileKey, overrides = {}) {
  const key = String(profileKey || 'default');
  return {
    version: 1,
    key,
    seed: hashInt(key, 'human-seed'),
    profile: overrides.profile || 'fast',
    motionJitter: Number(range(key, 'motion-jitter', 0.16, 0.32).toFixed(3)),
    overshootChance: Number(range(key, 'overshoot', 0.08, 0.28).toFixed(3)),
    hesitationChance: Number(range(key, 'hesitation', 0.04, 0.18).toFixed(3)),
    readingSpeed: Number(range(key, 'reading-speed', 0.85, 1.25).toFixed(3)),
    typoRateText: Number(range(key, 'typo-rate', 0.005, 0.025).toFixed(4)),
  };
}
```

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/humanBehaviorPersona.test.js --runInBand
```

## Task 6: Attach behavior persona to tab state — Complete

**Status:** Complete and validated in Phase 3.

**Objective:** `tabState.humanSession` includes behavior persona and seed based on `userId`/profile.

**Files:**
- Modify: `server.js`
- Modify: `lib/human-session-state.js`
- Test: `tests/unit/humanSessionState.test.js`

**Implementation direction:**
- Import `buildHumanBehaviorPersona` in `server.js`.
- When creating tab state, pass `behaviorPersona` or `seed`.
- Do not require schema migration; this is runtime state.

**Verification:**

```bash
npm test -- tests/unit/humanSessionState.test.js tests/unit/humanBehaviorPersona.test.js --runInBand
node --check server.js
```

---

# Phase 4 — Target Preparation / Intent Model

## Task 7: Add `humanPrepareTarget` — Complete

**Status:** Complete and validated in Phase 4.

**Objective:** Before click/type, simulate looking/positioning: ensure target visible, optionally scroll into view, brief reading pause, and optional micro-movement near target.

**Files:**
- Modify: `lib/human-actions.js`
- Test: `tests/unit/humanActions.test.js`

**Step 1: Write failing tests**

Add:

```js
test('humanPrepareTarget scrolls element into comfortable viewport when requested', async () => {
  const page = createFakePage();
  page.viewportSize = jest.fn(() => ({ width: 1000, height: 700 }));
  const locator = createLocator({ x: 100, y: 900, width: 200, height: 50 });
  const rng = createSeededRandom(44);

  const { humanPrepareTarget } = await import('../../lib/human-actions.js');
  const result = await humanPrepareTarget(page, locator, { rng, viewport: { width: 1000, height: 700 } });

  expect(page.mouse.wheel).toHaveBeenCalled();
  expect(result.box).toEqual({ x: 100, y: 900, width: 200, height: 50 });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

Expected: FAIL because `humanPrepareTarget` is missing.

**Step 3: Implement minimal**

```js
export async function humanPrepareTarget(page, locator, options = {}) {
  const rng = options.rng || defaultRng;
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element not visible (no bounding box)');
  const viewport = options.viewport || page.viewportSize?.() || { width: 1280, height: 720 };
  const centerY = box.y + box.height / 2;
  const comfortableTop = viewport.height * 0.25;
  const comfortableBottom = viewport.height * 0.75;

  if (centerY < comfortableTop || centerY > comfortableBottom) {
    const delta = centerY - viewport.height * 0.5;
    await humanScroll(page, { direction: delta > 0 ? 'down' : 'up', amount: Math.abs(delta), rng, profile: options.profile || 'fast' });
  }

  await humanPause(page, options.readingPauseMs || [40, 140], { rng });
  return { ok: true, box };
}
```

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

## Task 8: Use `humanPrepareTarget` before click/type endpoints — Complete

**Status:** Complete and validated in Phase 4.

**Objective:** Browser endpoints perform preparation before actual click/type.

**Files:**
- Modify: `server.js`
- Test: `tests/unit/browserOnlyPolicy.test.js`

**Test:** Static policy test checks click/type blocks contain `humanPrepareTarget` before `humanClick`/`humanType`.

**Implementation:**
- Import `humanPrepareTarget`.
- In click endpoint before `humanClick`, call:

```js
await humanPrepareTarget(tabState.page, locator, {
  profile: humanProfile,
  viewport: tabState.humanSession?.viewport,
});
```

- In type endpoint when locator exists, call same before `humanType`.

**Verification:**

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js tests/unit/humanActions.test.js --runInBand
node --check server.js
```

---

# Phase 5 — Advanced Mouse Aiming

## Task 9: Add overshoot and final correction to `humanMove` — Complete

**Status:** Complete and validated in Phase 5.

**Objective:** Long moves sometimes overshoot the target then correct back, making cursor movement less robotic.

**Files:**
- Modify: `lib/human-actions.js`
- Test: `tests/unit/humanActions.test.js`

**Test idea:**

```js
test('humanMove can overshoot then correct to target', async () => {
  const page = createFakePage();
  const rng = createSeededRandom(2);

  const result = await humanMove(page, {
    from: { x: 0, y: 0 },
    to: { x: 500, y: 0 },
    rng,
    overshootChance: 1,
  });

  const xs = page.mouse.move.mock.calls.map((call) => call[0]);
  expect(Math.max(...xs)).toBeGreaterThan(500);
  expect(result.position).toEqual({ x: 500, y: 0 });
});
```

**Implementation direction:**
- Add optional `overshootChance`.
- If distance > 120 and rng < chance, first move to a point 3–8% beyond target, then final shorter correction path.
- Return final `position: to`.

**Verification:**

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

## Task 10: Add final micro-jitter around target before click — Complete

**Status:** Complete and validated in Phase 5.

**Objective:** The cursor can settle with tiny movements before down/up.

**Test idea:** with `settleJitter: true`, assert extra small `mouse.move` calls happen after main movement and before `mouse.down`.

**Implementation direction:**
- Add `humanSettle(page, position, options)`.
- Use 1–3 moves within 1–3 px.
- Keep fast profile default low overhead.

---

# Phase 6 — Better Scroll Model

## Task 11: Implement wheel bursts and occasional inverse correction — Complete

**Status:** Complete and validated in Phase 6.

**Objective:** Scrolling should look like human wheel bursts rather than evenly split deltas.

**Files:**
- Modify: `lib/human-actions.js`
- Test: `tests/unit/humanActions.test.js`

**Test idea:**

```js
test('humanScroll sends uneven wheel bursts', async () => {
  const page = createFakePage();
  const rng = createSeededRandom(99);

  await humanScroll(page, { direction: 'down', amount: 800, rng, bursty: true });

  const deltas = page.mouse.wheel.mock.calls.map((call) => call[1]);
  expect(new Set(deltas.map((d) => Math.round(Math.abs(d)))).size).toBeGreaterThan(1);
});
```

**Implementation direction:**
- Add `bursty = true` default.
- Break scroll into bursts, each burst into 1–4 wheel events.
- Small inverse correction probability <= 0.12, disabled if `amount < 150`.

---

# Phase 7 — Context-Aware Typing

## Task 12: Classify input sensitivity — Complete

**Status:** Complete and validated in Phase 7.

**Objective:** Disable typos for email/password/tel/code-like fields; allow tiny typo rate only for free text.

**Files:**
- Modify: `lib/human-actions.js`
- Test: `tests/unit/humanActions.test.js`

**Test idea:**

```js
test('humanType disables intentional typos for sensitive input kinds', async () => {
  const page = createFakePage();
  const locator = createLocator();
  const rng = createSeededRandom(1);

  await humanType(page, locator, 'secret@example.com', {
    rng,
    clearFirst: false,
    mistakesRate: 1,
    inputKind: 'email',
  });

  expect(page.keyboard.press).not.toHaveBeenCalledWith('Backspace');
});
```

**Implementation direction:**
- Add helper `effectiveMistakesRate({ inputKind, mistakesRate })`.
- Sensitive kinds: `password`, `email`, `tel`, `otp`, `code`, `url`, `number`.
- Default endpoint still passes `mistakesRate: 0` unless user explicitly opts in.

## Task 13: Add paste-like option for long structured values — Deferred

**Status:** Deferred in Phase 7 per recommendation; not implemented to avoid unsafe/global clipboard behavior.

**Objective:** Humans often paste email/address/order IDs; allow browser clipboard-like behavior only if safe and visible.

**Important:** Do not use OS clipboard globally. Prefer Playwright keyboard only. If paste is implemented, use focus then `page.keyboard.insertText` only if available and policy accepts it; otherwise skip this task.

**Recommendation:** Defer this until needed. It is lower priority and more policy-sensitive.

---

# Phase 8 — Post-Navigation Reading Pauses

## Task 14: Add page-readiness human pause helper — Complete

**Status:** Complete and validated in Phase 8.

**Objective:** After navigation or popup adoption, wait a small human-readable amount based on page complexity.

**Files:**
- Modify: `lib/human-actions.js` or create `lib/human-reading.js`
- Test: `tests/unit/humanReading.test.js`

**Test idea:**

```js
import { estimateReadingPauseMs } from '../../lib/human-reading.js';

test('reading pause increases with text length but remains bounded for fast profile', () => {
  expect(estimateReadingPauseMs({ textLength: 100, profile: 'fast' })).toBeLessThan(
    estimateReadingPauseMs({ textLength: 2000, profile: 'fast' })
  );
  expect(estimateReadingPauseMs({ textLength: 2000, profile: 'fast' })).toBeLessThanOrEqual(1200);
});
```

**Implementation direction:**
- Estimate from snapshot text length when available.
- Fast profile cap around 1200ms.
- Medium/slow can be longer.
- Do not block every micro-action; apply after navigation/page load, not after each key.

---

# Phase 9 — Optional Human Session Recorder

## Task 15: Add local-only recorder schema — Complete

**Status:** Complete and validated in Phase 9.

**Objective:** Define a schema to record real VNC/manual sessions for calibration later.

**Files:**
- Create: `docs/human-session-recorder.md`
- Optional create: `lib/human-session-recording.js`
- Test: `tests/unit/humanSessionRecording.test.js`

**Schema:** JSONL events only, no secrets:

```json
{"t":0,"type":"mouse.move","x":120,"y":300}
{"t":153,"type":"mouse.down","button":"left"}
{"t":187,"type":"mouse.up","button":"left"}
{"t":430,"type":"wheel","dx":0,"dy":380}
{"t":920,"type":"key.type","class":"letter","delay":43}
```

**Privacy rules:**
- Never store raw typed text by default.
- Store character class only: letter/digit/space/punctuation/control.
- Never record password/email full values.
- Store per-profile derived timing distributions, not raw replay of private content.

**Validation:** Passed in Phase 9: `tests/unit/humanSessionRecording.test.js` passed with 4 tests; browser-only policy tests passed; `node --check server.js` passed.

## Task 16: Add calibration import from recorded summaries — Deferred

**Status:** Deferred in Phase 9; not implemented because no real manual local session summaries were present. Do not invent calibration data.

**Objective:** Convert recorded distributions into behavior persona overrides.

**Recommendation:** Do only after 2–3 real manual sessions exist. Not needed for immediate product behavior.

---

# Phase 10 — Integration Verification and Documentation

## Task 17: Strengthen browser-only policy tests — Complete

**Status:** Complete and validated in Phase 10.

**Objective:** Prevent regressions back to X11, JS synthetic clicks, or blanket force clicks.

**Files:**
- Modify: `tests/unit/browserOnlyPolicy.test.js`

**Add checks:**
- `server.js` normal click/type/press/scroll paths call human helpers.
- `lib/human-actions.js` does not contain `dispatchEvent`, `document.querySelector(...).click`, `xdotool`, `cliclick`, `robotjs`.
- Force click allowed only in explicit Google SERP branch.

**Command:**

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js --runInBand
```

**Validation:** Passed in Phase 10: 8 browser-only policy tests passed.

## Task 18: Document behavior knobs — Complete

**Status:** Complete and validated in Phase 10.

**Objective:** Make future tuning obvious.

**Files:**
- Create or modify: `docs/browser-control-policy.md`
- Create: `docs/human-behavior.md`

**Document:**
- Default `fast` profile.
- Per-profile behavior signatures.
- Cursor state.
- Sensitive field typing policy.
- What is forbidden: X11, JS synthetic site actions.
- How to run tests.

## Task 19: Final targeted verification — Complete

**Status:** Complete and validated in Phase 10.

Run:

```bash
npm test -- tests/unit/humanActions.test.js tests/unit/humanSessionState.test.js tests/unit/humanBehaviorPersona.test.js tests/unit/browserOnlyPolicy.test.js tests/unit/typeKeyboardMode.test.js tests/unit/browserPersona.test.js tests/unit/humanReading.test.js --runInBand
node --check server.js
```

Expected:
- All relevant Jest tests pass.
- `server.js` syntax check passes.

**Validation:** Passed in Phase 10: 7 Jest suites / 68 tests passed, including `humanReading`; `node --check server.js` passed.

**Plan completion note after Phase 9:** Production core is complete and targeted validation has passed. Optional/non-core items remain deferred: Task 13 paste-like structured value input, Task 16 calibration import pending 2–3 real manual local summaries, and Task 20 live VNC smoke test pending a safe local fixture. Do not treat those deferred optional items as implemented.

## Task 20: Optional live VNC smoke test — Deferred / not run

**Status:** Deferred in Phase 10; not run because no safe local live VNC fixture was identified in scope, and sensitive account interaction is explicitly disallowed. Automated targeted verification passed, so this does not block production readiness.

**Objective:** Verify the behavior feels good visually in VNC without interacting with sensitive accounts.

**Safe target:** local HTML fixture or a blank test page, not Leboncoin account actions.

**Manual acceptance criteria:**
- Cursor starts from previous action, not corner.
- Clicks remain fast.
- Scroll feels natural but not sluggish.
- Typing is fast and stable.
- No accidental typo in structured/sensitive fields.

---

# Recommended Execution Order

1. Phase 1: Persistent cursor state.
2. Phase 2: Cursor-aware click endpoint.
3. Phase 3: Deterministic behavior persona.
4. Phase 4: `humanPrepareTarget` for click/type.
5. Phase 6: Better scroll model.
6. Phase 7: Context-aware typing.
7. Phase 5: Advanced mouse aiming.
8. Phase 8: Post-navigation reading pauses.
9. Phase 10: Docs/policy/final verification.
10. Phase 9 recorder only after the core behavior works well.

# Cut Line for First PR / First Commit Series

For a clean first delivery, stop after Phase 4:

- cursor state
- cursor-aware click
- behavior persona
- target preparation
- tests and docs

This already gives a large realism improvement without making the system complicated.

# Risk Notes

- Too much realism can make automation annoying. Keep `fast` actually fast.
- Overshoot/jitter must not click outside target; overshoot happens during movement only, final down/up must stay inside bounding box.
- Intentional typos should stay disabled by default in endpoints.
- Static tests are useful for policy, but behavior tests should exercise real helper functions.
- If a route test needs too much mocking, prefer extracting route-independent helper functions.
