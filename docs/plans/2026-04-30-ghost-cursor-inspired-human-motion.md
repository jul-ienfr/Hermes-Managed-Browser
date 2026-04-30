# Ghost-Cursor-Inspired Human Motion Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Improve the managed Camofox browser's mouse/scroll behavior using the useful ideas from `Xetera/ghost-cursor` without replacing the managed browser, switching to Puppeteer, or weakening existing safety/reliability guards.

**Architecture:** Keep `lib/human-actions.js` as the browser-only action engine. Add a small internal "ghost-like" motion layer for path generation, target selection, overshoot/correction, movement timing, and scroll bursts, then wire it into existing `humanMove`, `humanClick`, `humanPrepareTarget`, and `humanScroll` behind options/defaults. Do not call Puppeteer `GhostCursor(page)` directly; adapt the algorithms to Playwright/Camofox primitives and existing endpoint contracts.

**Tech Stack:** Node.js ESM, Playwright/Camoufox, Jest, current managed-browser endpoints in `server.js`.

---

## Verified Context

- Repo: `/home/jul/tools/camofox-browser`.
- Existing action engine: `lib/human-actions.js`.
- Existing tests include:
  - `tests/unit/humanActions.test.js`
  - `tests/unit/browserOnlyPolicy.test.js`
  - `tests/unit/humanBehaviorPersona.test.js`
  - `tests/unit/humanSessionState.test.js`
  - `tests/unit/humanReading.test.js`
  - `tests/e2e/formSubmission.test.js`
- `package.json` currently depends on Playwright/Camoufox, not `ghost-cursor` or Puppeteer.
- `lib/human-actions.js` already has:
  - `createSeededRandom(seed)`
  - `getHumanProfile(name = 'fast')`
  - cubic-Bezier `humanPath(from, to, steps, rng, randomness)`
  - viewport clamp before movement
  - bounded low-level `page.mouse.move(x, y, { steps: 1 })`
  - `humanMove(...)` with optional `overshootChance`
  - `targetPoint(locator, rng, knownBox)` with 20% target margins
  - `humanPrepareTarget(...)`
  - `humanClick(...)` returning `{ cursor: to }`
  - `humanSettle(...)`
  - `humanScroll(...)`
  - sensitive-input typo disabling via `effectiveMistakesRate(...)`
- Existing saved V2 plan: `docs/plans/2026-04-27-human-behavior-v2.md`; phases 1-12/14/15 are marked complete, long structured paste and calibration import are deferred.
- Current workspace is very dirty. Treat this plan as design-only. Do not stage/commit unrelated files unless explicitly asked.

## External Reference Summary: `Xetera/ghost-cursor`

Useful ideas to borrow:

1. Generate realistic route data between coordinates.
2. Preserve cursor start and choose non-center target points inside elements.
3. Overshoot or slightly miss on long moves, then correct.
4. Make speed depend on distance and target size.
5. Provide movement timestamps/delays.
6. Scroll into view and scroll in a human-looking way.

Ideas not to borrow directly:

1. Do not replace managed browser with Puppeteer.
2. Do not call `GhostCursor(page).click(selector)` directly from routes.
3. Do not add Puppeteer as a control surface unless a later spike proves a strict, isolated benefit.
4. Do not bypass existing refs, action locks, timeout guards, popup adoption, snapshot refresh, or managed profile persistence.

## External Reference Summary: `ellisfan/bypass-datadome`

Useful ideas to borrow as a defensive/coherence checklist:

1. DataDome-style checks cover the full browser fingerprint, not only visible mouse behavior.
2. Header-level identity must align with JavaScript-visible identity: `User-Agent`, `Accept-Language`, `Sec-CH-UA*`, `navigator.*`, viewport, timezone, storage, plugins, codecs, WebGL, and automation traces.
3. Fingerprint values should be generated as coherent personas, not random independent fields.
4. Persona values should remain stable per managed profile and differ across profiles.
5. Challenge handling should be explicit: detect challenge pages, mark `human_required`, expose VNC/manual-login flow, then checkpoint storage after human resolution.

Ideas not to borrow directly:

1. Do not forge DataDome `tag.js` payloads or cookies by POSTing fake data to `api-js.datadome.co/js/`.
2. Do not embed DataDome-specific bypass logic, `ddk`, `ddv`, or challenge-solver code.
3. Do not add `browserforge` as runtime dependency by default; treat it as conceptual inspiration unless a later measured spike proves value.
4. Do not weaken privacy/security by logging raw fingerprint payloads, cookies, challenge tokens, or secrets.


## External Reference Summary: `botswin/BotBrowser`

Useful ideas to borrow as architecture/validation inspiration:

1. Treat the browser identity as a coherent bundle, not a set of independent overrides: UA, Client Hints, screen metrics, timezone, locale/languages, fonts, GPU/WebGL, touch/mobile surfaces, worker inheritance, proxy/IP geo, and headless/headful parity must agree.
2. Add explicit fingerprint validation workflows using public observatories such as CreepJS, Pixelscan, and Iphey, saving only redacted local reports.
3. Document profile-level stability: the same managed profile should keep a stable browser posture across restarts, while different managed profiles should not accidentally share identity artifacts.
4. Review network leakage as part of identity quality: WebRTC/STUN, proxy bypasses, QUIC/UDP behavior, and timezone/locale derived from proxy/IP.
5. Study the “per-context fingerprint” idea only as a future scale optimization; for current managed accounts, separate persistent profiles remain simpler and safer.
6. Review automation-control artifacts: CDP/Playwright bindings, init-script traces, headless differences, extension/process artifacts, and whether our cleanup is measurable rather than assumed.

Ideas not to borrow directly:

1. Do not replace Camoufox with BotBrowser by default; BotBrowser’s full core is proprietary/opaque and would add a heavy supply-chain and operations dependency.
2. Do not depend on BotBrowser premium/proprietary profile formats for normal managed-browser operation.
3. Do not chase Cloudflare/Akamai/Kasada/DataDome bypass claims or add site-specific challenge solvers.
4. Do not collapse many real managed accounts into a single browser process until profile isolation, crash blast radius, storage isolation, and manual handoff are proven.
5. Do not treat CreepJS/Pixelscan/Iphey as “pass/fail bypass” targets; use them as diagnostics for consistency regressions.


## External Reference Summary: `dessant/buster`

Useful ideas to borrow for challenge handling only:

1. reCAPTCHA challenges often live inside nested iframes; challenge diagnostics should include frame URL, frame hierarchy, bounding box, and `devicePixelRatio`-aware coordinates.
2. A browser-side extension/sidecar can notify the operator that a challenge exists without trying to solve it automatically.
3. Audio challenge availability can be classified as an accessibility/manual-handoff signal, not as an automation target.
4. Client-app/native-message patterns are useful as an architecture reference for a future optional operator-assist extension, but are not required for the current Playwright/Camoufox server.

Ideas not to borrow directly:

1. Do not integrate Buster as a CAPTCHA solver extension in managed profiles.
2. Do not copy GPL-3.0 code into this MIT/managed-browser project.
3. Do not add speech-to-text CAPTCHA solving, challenge reset loops, or automatic retries.
4. Do not dispatch synthetic page events to manipulate challenge widgets.

## External Reference Summary: `NopeCHALLC/nopecha-extension`

Useful ideas to borrow as taxonomy and policy inspiration only:

1. Maintain a broad challenge-provider taxonomy: reCAPTCHA, hCaptcha, FunCAPTCHA/Arkose, Cloudflare Turnstile, AWS WAF CAPTCHA, text CAPTCHA, canvas/bounding-box, drag-drop, and video/audio challenges.
2. Represent challenge state explicitly in snapshots/outcome validation: `detected`, `provider`, `type`, `frameUrl`, `siteKeyPresent`, `humanRequired`, and `suggestedAction`.
3. Add policy hooks around challenges: stop automation, surface VNC/manual handoff, checkpoint storage after a verified human resolution, then resume only after page state changes.
4. Treat mouse precision and bounding-box lessons as diagnostics for iframe/canvas widgets, not as instructions to solve the widget.

Ideas not to borrow directly:

1. Do not install NopeCHA or any third-party solver extension by default.
2. Do not call NopeCHA, CapMonster, 2Captcha, or similar CAPTCHA-solving APIs from managed-browser routes, replay, repair, or plugins.
3. Do not ship automatic CAPTCHA solving for reCAPTCHA, hCaptcha, FunCAPTCHA, Turnstile, AWS WAF, or text CAPTCHA.
4. Do not leak screenshots, challenge payloads, site context, profile identity, cookies, tokens, or user data to a solver service.
5. Do not optimize for “undetectable CAPTCHA mouse actions”; the managed-browser policy is detect → human handoff → checkpoint → resume.

## Challenge Resolution Mode Policy

Managed Browser should expose a clear operator setting for CAPTCHA/challenge handling, but the safe default remains manual VNC.

Proposed configuration surface:

```json
{
  "challengeResolution": {
    "mode": "manual_vnc",
    "allowedAutoScopes": [],
    "solverProvider": null,
    "requireExplicitPerSiteOptIn": true,
    "checkpointAfterHuman": true,
    "redactDiagnostics": true
  }
}
```

Supported modes:

1. `manual_vnc` — default. Detect challenge, stop automation, return `human_required`, expose VNC/noVNC, checkpoint storage after human resolution.
2. `disabled` — detect challenge and stop automation without opening/suggesting VNC. Useful for jobs that must never pause for manual intervention.
3. `auto_controlled_lab_only` — reserved/future option for owned test pages, synthetic demos, accessibility research, or environments where Julien has explicit authorization. It must be allowlisted per site/profile, off by default, and unavailable for real managed accounts unless explicitly enabled by config and policy tests.

Hard restrictions for any future auto path:

- Never auto-solve on Leboncoin, France Travail, banking, email, admin, or real personal accounts by default.
- Never call a third-party solver unless a separate explicit implementation plan is accepted for a specific authorized scope.
- Never send cookies, auth headers, tokens, screenshots containing account data, typed text, or full page context to an external solver.
- Never silently downgrade from manual to auto.
- Never let LLM repair/replay decide to solve a challenge; it can only respect the configured mode.
- Auto mode must be feature-flagged, auditable, and covered by policy tests that prove it is blocked outside allowlisted controlled scopes.

## Non-Negotiable Constraints

1. Browser actions remain browser-only: `page.mouse`, `page.keyboard`, locator APIs.
2. No raw X11 automation for site actions.
3. No page-side synthetic JS user actions such as injected `.click()` or `dispatchEvent`.
4. Keep default profile `fast`; visible VNC/manual-login responsiveness matters more than theatrical realism.
5. Every production behavior change starts with a failing Jest test.
6. Any optional new dependency must be justified by tests and size/maintenance review. Default recommendation: no dependency; implement a tiny internal adapter.
7. Preserve existing fallbacks and diagnostics around Camofox hangs: viewport clamp, low-level mouse timeouts, locator-click fallback where already allowed.
8. Do not implement a DataDome bypass. The DataDome reference is only a fingerprint-coherence/audit input.
9. Do not log or persist raw challenge payloads, cookies, tokens, or typed secrets.

---

# Phase 0 — Baseline and Safety Snapshot

### Task 0.1: Capture current behavior baseline

**Objective:** Record current test and code state before changing motion behavior.

**Files:**
- Read: `lib/human-actions.js`
- Read: `tests/unit/humanActions.test.js`
- Read: `tests/unit/browserOnlyPolicy.test.js`
- Output: no production file changes

**Step 1: Run targeted baseline tests**

Run:

```bash
cd /home/jul/tools/camofox-browser
npm test -- tests/unit/humanActions.test.js tests/unit/browserOnlyPolicy.test.js tests/unit/humanBehaviorPersona.test.js tests/unit/humanSessionState.test.js --runInBand
node --check server.js
```

Expected: PASS or document failures before modifying code.

**Step 2: Check workspace dirtiness**

Run:

```bash
git status --short
```

Expected: workspace may be dirty. Do not reset. Record which files this plan will touch.

**Step 3: Commit**

No commit unless the user asks; this is baseline-only.

---

# Phase 1 — Extract a Testable Motion Planner

### Task 1.1: Add `planHumanMotion` API test

**Objective:** Create a pure function that plans ghost-like motion without touching Playwright.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify later: `lib/human-actions.js`

**Step 1: Write failing test**

Add to `tests/unit/humanActions.test.js`:

```js
import { createSeededRandom, planHumanMotion } from '../../lib/human-actions.js';

test('planHumanMotion returns deterministic viewport-bounded points ending at target', () => {
  const rngA = createSeededRandom(123);
  const rngB = createSeededRandom(123);
  const options = {
    from: { x: 40, y: 50 },
    to: { x: 700, y: 500 },
    viewport: { width: 800, height: 600 },
    profile: 'fast',
    targetBox: { x: 680, y: 480, width: 80, height: 40 },
  };

  const a = planHumanMotion({ ...options, rng: rngA });
  const b = planHumanMotion({ ...options, rng: rngB });

  expect(a.points).toEqual(b.points);
  expect(a.points.at(-1)).toEqual({ x: 700, y: 500 });
  for (const point of a.points) {
    expect(point.x).toBeGreaterThanOrEqual(1);
    expect(point.x).toBeLessThanOrEqual(799);
    expect(point.y).toBeGreaterThanOrEqual(1);
    expect(point.y).toBeLessThanOrEqual(599);
  }
  expect(a.durationMs).toBeGreaterThan(0);
});
```

**Step 2: Verify RED**

Run:

```bash
npm test -- tests/unit/humanActions.test.js -t 'planHumanMotion returns deterministic' --runInBand
```

Expected: FAIL because `planHumanMotion` is not exported.

**Step 3: Implement minimal pure planner**

In `lib/human-actions.js`, export a wrapper around current path logic:

```js
export function planHumanMotion({
  from,
  to,
  profile = 'fast',
  rng = defaultRng,
  viewport,
  targetBox,
  steps,
  durationMs,
  overshootChance = 0,
  randomness = 0.22,
} = {}) {
  if (!to) throw new Error('planHumanMotion requires a target position');
  const prof = getHumanProfile(profile);
  const boundedTo = clampPointToViewport(to, viewport, { edgePadding: 1 });
  const boundedFrom = clampPointToViewport(from || { x: 0, y: 0 }, viewport, { edgePadding: 1 });
  const distance = Math.hypot(boundedTo.x - boundedFrom.x, boundedTo.y - boundedFrom.y);
  const sizeFactor = targetBox ? Math.max(0.75, Math.min(1.25, Math.sqrt(Math.max(1, targetBox.width * targetBox.height)) / 80)) : 1;
  const actualDuration = durationMs || Math.round(clamp(jitter(120 + distance * 1.7 / sizeFactor, 0.2, rng) / prof.speed, 80, 3500));
  const actualSteps = steps || clamp(Math.round(distance / 10), 10, 100);
  const points = humanPath(boundedFrom, boundedTo, actualSteps, rng, randomness)
    .map((point) => clampPointToViewport(point, viewport, { edgePadding: 1 }));
  if (!points.length || points.at(-1).x !== boundedTo.x || points.at(-1).y !== boundedTo.y) {
    points.push(boundedTo);
  }
  return { points, durationMs: actualDuration, distance, overshot: false };
}
```

**Step 4: Verify GREEN**

Run:

```bash
npm test -- tests/unit/humanActions.test.js -t 'planHumanMotion returns deterministic' --runInBand
```

Expected: PASS.

---

### Task 1.2: Route `humanMove` through `planHumanMotion`

**Objective:** Make `humanMove` consume the planner while preserving current public return shape.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing/guard test**

Add:

```js
test('humanMove reports planner step count and final cursor', async () => {
  const page = createFakePage();
  const rng = createSeededRandom(124);

  const result = await humanMove(page, {
    from: { x: 40, y: 50 },
    to: { x: 300, y: 210 },
    viewport: { width: 800, height: 600 },
    rng,
    overshootChance: 0,
  });

  expect(result.position).toEqual({ x: 300, y: 210 });
  expect(result.steps).toBe(page.mouse.move.mock.calls.length);
  expect(page.mouse.move.mock.calls.at(-1).slice(0, 2)).toEqual([300, 210]);
});
```

**Step 2: Verify RED or meaningful guard**

Run:

```bash
npm test -- tests/unit/humanActions.test.js -t 'humanMove reports planner' --runInBand
```

Expected: FAIL if current count differs, or PASS as a guard. If it passes immediately, keep it as regression coverage and proceed with refactor only.

**Step 3: Refactor `humanMove`**

Replace duplicated planning logic in `humanMove` with:

```js
const plan = planHumanMotion({
  from,
  to,
  profile,
  rng,
  viewport: resolvedViewport,
  steps,
  durationMs,
  overshootChance,
  targetBox: options.targetBox,
});
const interval = Math.max(8, Math.round(plan.durationMs / Math.max(1, plan.points.length)));
await playMousePath(page, plan.points, interval, rng, { moveTimeout, viewport: resolvedViewport });
const boundedTo = plan.points.at(-1);
await boundedMouseMove(page, boundedTo.x, boundedTo.y, moveTimeout);
```

Then return the same shape:

```js
return {
  position: boundedTo,
  steps: plan.points.length + 1,
  durationMs: plan.durationMs,
  overshot: plan.overshot,
};
```

**Step 4: Verify**

Run:

```bash
npm test -- tests/unit/humanActions.test.js --runInBand
```

Expected: PASS.

---

# Phase 2 — Ghost-Cursor-Like Target Selection

### Task 2.1: Export and test `chooseHumanTargetPoint`

**Objective:** Replace hidden target-point logic with testable behavior equivalent to ghost-cursor's "random point inside element, not always center".

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
import { chooseHumanTargetPoint, createSeededRandom } from '../../lib/human-actions.js';

test('chooseHumanTargetPoint respects padding and is deterministic', () => {
  const box = { x: 100, y: 200, width: 300, height: 100 };
  const a = chooseHumanTargetPoint(box, { rng: createSeededRandom(42), paddingPercentage: 20 });
  const b = chooseHumanTargetPoint(box, { rng: createSeededRandom(42), paddingPercentage: 20 });

  expect(a).toEqual(b);
  expect(a.x).toBeGreaterThanOrEqual(160);
  expect(a.x).toBeLessThanOrEqual(340);
  expect(a.y).toBeGreaterThanOrEqual(220);
  expect(a.y).toBeLessThanOrEqual(280);
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/humanActions.test.js -t 'chooseHumanTargetPoint' --runInBand
```

Expected: FAIL because export does not exist.

**Step 3: Implement**

In `lib/human-actions.js`:

```js
export function chooseHumanTargetPoint(box, { rng = defaultRng, paddingPercentage = 20, destination } = {}) {
  if (!box) throw new Error('chooseHumanTargetPoint requires a bounding box');
  if (destination) return { x: box.x + destination.x, y: box.y + destination.y };
  const pad = clamp(Number(paddingPercentage) || 0, 0, 100) / 100;
  const marginX = Math.max(1, (box.width * pad) / 2);
  const marginY = Math.max(1, (box.height * pad) / 2);
  return {
    x: rand(rng, box.x + marginX, box.x + box.width - marginX),
    y: rand(rng, box.y + marginY, box.y + box.height - marginY),
  };
}
```

Then update `targetPoint(...)` to call `chooseHumanTargetPoint(...)`.

**Step 4: Verify**

```bash
npm test -- tests/unit/humanActions.test.js -t 'chooseHumanTargetPoint' --runInBand
```

Expected: PASS.

---

### Task 2.2: Feed target box into motion duration

**Objective:** Make movement speed depend on both distance and target size, as ghost-cursor does.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
test('planHumanMotion moves more carefully toward small targets', () => {
  const base = {
    from: { x: 10, y: 10 },
    to: { x: 500, y: 300 },
    viewport: { width: 900, height: 700 },
    profile: 'fast',
  };

  const small = planHumanMotion({ ...base, rng: createSeededRandom(7), targetBox: { x: 490, y: 290, width: 12, height: 12 } });
  const large = planHumanMotion({ ...base, rng: createSeededRandom(7), targetBox: { x: 450, y: 250, width: 200, height: 120 } });

  expect(small.durationMs).toBeGreaterThan(large.durationMs);
});
```

**Step 2: Verify RED**

Run the exact test. Expected: FAIL if Task 1.1 used a weak size factor; adjust formula to satisfy this behavior.

**Step 3: Implement formula**

In `planHumanMotion`, replace the size factor with a clear helper:

```js
function targetSizeSpeedFactor(targetBox) {
  if (!targetBox) return 1;
  const diagonal = Math.hypot(targetBox.width, targetBox.height);
  return clamp(diagonal / 120, 0.65, 1.35);
}
```

Use:

```js
const sizeFactor = targetSizeSpeedFactor(targetBox);
const actualDuration = durationMs || Math.round(clamp(jitter(120 + distance * 1.7 / sizeFactor, 0.2, rng) / prof.speed, 80, 3500));
```

**Step 4: Verify**

```bash
npm test -- tests/unit/humanActions.test.js -t 'small targets' --runInBand
```

Expected: PASS.

---

# Phase 3 — Overshoot/Miss/Correction Parity

### Task 3.1: Move overshoot planning into `planHumanMotion`

**Objective:** Make overshoot behavior testable without fake Playwright pages.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
test('planHumanMotion can overshoot then correct to final target', () => {
  const result = planHumanMotion({
    from: { x: 0, y: 100 },
    to: { x: 500, y: 100 },
    viewport: { width: 700, height: 400 },
    rng: createSeededRandom(2),
    overshootChance: 1,
  });

  expect(result.overshot).toBe(true);
  expect(Math.max(...result.points.map((point) => point.x))).toBeGreaterThan(500);
  expect(result.points.at(-1)).toEqual({ x: 500, y: 100 });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/humanActions.test.js -t 'planHumanMotion can overshoot' --runInBand
```

Expected: FAIL until planner owns overshoot.

**Step 3: Implement planner overshoot**

Move current `humanMove` overshoot branch into `planHumanMotion`:

```js
const shouldOvershoot = distance > 120 && rng() < overshootChance;
const segments = [];
if (shouldOvershoot) {
  const overshoot = clampPointToViewport(overshootPoint(boundedFrom, boundedTo, rng), viewport, { edgePadding: 1 });
  segments.push(humanPath(boundedFrom, overshoot, steps || clamp(Math.round(distance / 10), 10, 100), rng, randomness));
  segments.push(humanPath(overshoot, boundedTo, clamp(Math.round(Math.hypot(boundedTo.x - overshoot.x, boundedTo.y - overshoot.y) / 4), 3, 12), rng, 0.08));
} else {
  segments.push(humanPath(boundedFrom, boundedTo, actualSteps, rng, randomness));
}
const points = segments.flat().map((point) => clampPointToViewport(point, viewport, { edgePadding: 1 }));
points.push(boundedTo);
```

**Step 4: Verify**

Run:

```bash
npm test -- tests/unit/humanActions.test.js -t 'planHumanMotion can overshoot' --runInBand
```

Expected: PASS.

---

### Task 3.2: Add slight miss/correct option for long moves

**Objective:** Borrow ghost-cursor's "slightly miss then re-adjust" behavior separately from overshooting beyond the target line.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
test('planHumanMotion can slightly miss beside the target before correcting', () => {
  const result = planHumanMotion({
    from: { x: 0, y: 0 },
    to: { x: 500, y: 250 },
    viewport: { width: 900, height: 700 },
    rng: createSeededRandom(19),
    missChance: 1,
    overshootChance: 0,
  });

  expect(result.missed).toBe(true);
  expect(result.points.at(-1)).toEqual({ x: 500, y: 250 });
  const beforeFinal = result.points.at(-2);
  expect(Math.hypot(beforeFinal.x - 500, beforeFinal.y - 250)).toBeGreaterThanOrEqual(3);
  expect(Math.hypot(beforeFinal.x - 500, beforeFinal.y - 250)).toBeLessThanOrEqual(24);
});
```

**Step 2: Verify RED**

Expected: FAIL because `missChance` / `missed` do not exist.

**Step 3: Implement**

Add helper:

```js
function missPointNearTarget(to, rng, radiusRange = [4, 18]) {
  const angle = rand(rng, 0, Math.PI * 2);
  const radius = rand(rng, radiusRange[0], radiusRange[1]);
  return { x: to.x + Math.cos(angle) * radius, y: to.y + Math.sin(angle) * radius };
}
```

In planner, when no overshoot and `distance > 160 && rng() < missChance`, generate main segment to `missPoint`, then correction segment to `boundedTo`. Clamp both.

**Step 4: Wire option cautiously**

Do not enable globally yet. In `humanClick`, pass:

```js
missChance: options.missChance ?? options.behaviorPersona?.missChance ?? 0,
```

**Step 5: Verify**

```bash
npm test -- tests/unit/humanActions.test.js -t 'slightly miss' --runInBand
```

Expected: PASS.

---

# Phase 4 — Timestamped Path / Replay Diagnostics

### Task 4.1: Add optional timestamps to planner

**Objective:** Match ghost-cursor's `useTimestamps` idea for debugging/recording without changing actual Playwright execution.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
test('planHumanMotion can include monotonic timestamps', () => {
  const result = planHumanMotion({
    from: { x: 10, y: 10 },
    to: { x: 110, y: 110 },
    rng: createSeededRandom(3),
    useTimestamps: true,
    startTimestamp: 1000,
    durationMs: 500,
  });

  expect(result.points[0]).toHaveProperty('timestamp');
  expect(result.points[0].timestamp).toBeGreaterThanOrEqual(1000);
  expect(result.points.at(-1).timestamp).toBe(1500);
  for (let i = 1; i < result.points.length; i += 1) {
    expect(result.points[i].timestamp).toBeGreaterThanOrEqual(result.points[i - 1].timestamp);
  }
});
```

**Step 2: Verify RED**

Expected: FAIL because timestamps are absent.

**Step 3: Implement**

After building final `points`:

```js
function withMotionTimestamps(points, { startTimestamp = Date.now(), durationMs }) {
  if (!points.length) return points;
  const denom = Math.max(1, points.length - 1);
  return points.map((point, index) => ({
    ...point,
    timestamp: Math.round(startTimestamp + (durationMs * index) / denom),
  }));
}
```

In `planHumanMotion`:

```js
const finalPoints = useTimestamps ? withMotionTimestamps(points, { startTimestamp, durationMs: actualDuration }) : points;
return { points: finalPoints, durationMs: actualDuration, distance, overshot: shouldOvershoot, missed };
```

**Step 4: Verify**

```bash
npm test -- tests/unit/humanActions.test.js -t 'monotonic timestamps' --runInBand
```

Expected: PASS.

---

# Phase 5 — Better Scroll-To-Target Inspired by Ghost Cursor

### Task 5.1: Add pure scroll planner

**Objective:** Make wheel bursts and inverse corrections deterministic/testable.

**Files:**
- Modify: `tests/unit/humanActions.test.js`
- Modify: `lib/human-actions.js`

**Step 1: Write failing test**

```js
import { planHumanScroll } from '../../lib/human-actions.js';

test('planHumanScroll creates uneven wheel bursts with optional inverse correction', () => {
  const result = planHumanScroll({
    direction: 'down',
    amount: 900,
    rng: createSeededRandom(8),
    profile: 'fast',
    inverseCorrectionChance: 1,
  });

  const deltas = result.events.map((event) => event.dy);
  expect(new Set(deltas.map((dy) => Math.round(Math.abs(dy)))).size).toBeGreaterThan(1);
  expect(deltas.some((dy) => dy < 0)).toBe(true);
  expect(Math.abs(deltas.reduce((sum, dy) => sum + dy, 0))).toBeGreaterThan(0);
});
```

**Step 2: Verify RED**

Expected: FAIL because `planHumanScroll` is not exported.

**Step 3: Implement pure planner**

Add:

```js
export function planHumanScroll({ direction = 'down', amount = 600, rng = defaultRng, profile = 'fast', inverseCorrectionChance = 0.08 } = {}) {
  const prof = getHumanProfile(profile);
  const sign = direction === 'up' ? -1 : 1;
  const target = Math.max(1, Math.abs(Number(amount) || 600));
  const [minSteps, maxSteps] = prof.scroll.steps;
  const steps = randInt(rng, minSteps, maxSteps);
  const events = [];
  let remaining = target;
  for (let i = 0; i < steps; i += 1) {
    const base = remaining / Math.max(1, steps - i);
    const dy = sign * Math.max(1, Math.round(base * rand(rng, 0.65, 1.45)));
    events.push({ dx: 0, dy });
    remaining -= Math.abs(dy);
  }
  if (target >= 150 && rng() < inverseCorrectionChance) {
    events.push({ dx: 0, dy: -sign * randInt(rng, 12, Math.min(80, Math.round(target * 0.08))) });
  }
  return { events };
}
```

**Step 4: Wire `humanScroll` through planner**

Use `planHumanScroll(...)` for wheel deltas, preserving existing pauses.

**Step 5: Verify**

```bash
npm test -- tests/unit/humanActions.test.js -t 'planHumanScroll' --runInBand
npm test -- tests/unit/humanActions.test.js --runInBand
```

Expected: PASS.

---

# Phase 6 — Persona Defaults, But Fast by Default

### Task 6.1: Add ghost-like persona knobs

**Objective:** Store behavior probabilities in `lib/human-behavior-persona.js` so each managed profile has a stable behavioral fingerprint.

**Files:**
- Modify: `tests/unit/humanBehaviorPersona.test.js`
- Modify: `lib/human-behavior-persona.js`

**Step 1: Write failing test**

```js
test('human behavior persona exposes bounded ghost-like motion knobs', () => {
  const persona = buildHumanBehaviorPersona('leboncoin-ge');

  expect(persona.overshootChance).toBeGreaterThanOrEqual(0);
  expect(persona.overshootChance).toBeLessThanOrEqual(0.35);
  expect(persona.missChance).toBeGreaterThanOrEqual(0);
  expect(persona.missChance).toBeLessThanOrEqual(0.20);
  expect(persona.paddingPercentage).toBeGreaterThanOrEqual(10);
  expect(persona.paddingPercentage).toBeLessThanOrEqual(45);
});
```

**Step 2: Verify RED**

Expected: FAIL for missing fields.

**Step 3: Implement**

Add deterministic fields using the existing seeded RNG:

```js
overshootChance: Number((0.08 + rng() * 0.18).toFixed(3)),
missChance: Number((0.02 + rng() * 0.10).toFixed(3)),
paddingPercentage: Math.round(12 + rng() * 28),
inverseScrollCorrectionChance: Number((0.03 + rng() * 0.08).toFixed(3)),
```

**Step 4: Verify**

```bash
npm test -- tests/unit/humanBehaviorPersona.test.js --runInBand
```

Expected: PASS.

---

### Task 6.2: Wire persona knobs into click and scroll endpoints

**Objective:** Use per-profile persona values without changing the public endpoint API.

**Files:**
- Modify: `tests/unit/browserOnlyPolicy.test.js`
- Modify: `server.js`
- Possibly modify: `lib/human-actions.js`

**Step 1: Write policy/route test**

In `tests/unit/browserOnlyPolicy.test.js`, add static assertion that route call options include persona fields:

```js
test('click and scroll routes pass behavior persona motion knobs', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

  expect(source).toContain('overshootChance: behaviorPersona?.overshootChance');
  expect(source).toContain('missChance: behaviorPersona?.missChance');
  expect(source).toContain('paddingPercentage: behaviorPersona?.paddingPercentage');
  expect(source).toContain('inverseCorrectionChance: behaviorPersona?.inverseScrollCorrectionChance');
});
```

**Step 2: Verify RED**

Expected: FAIL until route wiring exists.

**Step 3: Implement route wiring**

Where `humanClick(...)` is called in `server.js`, pass:

```js
overshootChance: behaviorPersona?.overshootChance ?? 0,
missChance: behaviorPersona?.missChance ?? 0,
paddingPercentage: behaviorPersona?.paddingPercentage,
```

Where `humanScroll(...)` is called, pass:

```js
inverseCorrectionChance: behaviorPersona?.inverseScrollCorrectionChance,
```

Inside `humanClick`, pass `paddingPercentage` to `targetPoint(...)` / `chooseHumanTargetPoint(...)`.

**Step 4: Verify**

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js tests/unit/humanActions.test.js --runInBand
```

Expected: PASS.

---

# Phase 7 — Dependency Spike: Prove We Do Not Need Puppeteer

### Task 7.1: Add a short comparison doc

**Objective:** Document why implementation remains internal instead of adding `ghost-cursor` dependency directly.

**Files:**
- Create: `docs/ghost-cursor-evaluation.md`

**Step 1: Write doc**

Create `docs/ghost-cursor-evaluation.md`:

```md
# Ghost Cursor Evaluation

## Decision

Do not replace the managed browser with ghost-cursor and do not call Puppeteer GhostCursor directly from managed-browser routes.

## Why

- Managed browser uses Playwright/Camoufox, persistent profiles, refs, VNC, action locks, popup adoption, storage checkpoints, and security guards.
- ghost-cursor solves only motion/scroll/click realism for Puppeteer.
- Direct use would either require a Puppeteer compatibility layer or a second browser control surface.
- Internal planner gives us the useful behavior while preserving existing Camofox reliability and tests.

## Borrowed ideas

- Random intra-element target point.
- Distance/target-size-aware speed.
- Overshoot/miss/correction for long moves.
- Optional timestamped path planning for diagnostics.
- Uneven scroll bursts.

## Rejected ideas

- `GhostCursor(page).click(selector)` in routes.
- Adding Puppeteer as runtime dependency for managed-browser actions.
- Raw OS mouse/VNC control for agent actions.
```

**Step 2: Verify doc exists**

Run:

```bash
test -s docs/ghost-cursor-evaluation.md
```

Expected: exit 0.

---

# Phase 8 — Fingerprint Coherence Audit Inspired by DataDome

### Task 8.1: Add a DataDome/fingerprint evaluation doc

**Objective:** Document what the DataDome reference teaches us without implementing a bypass.

**Files:**
- Create: `docs/datadome-fingerprint-evaluation.md`

**Step 1: Write doc**

Create `docs/datadome-fingerprint-evaluation.md`:

```md
# DataDome Fingerprint Evaluation

## Decision

Do not implement DataDome cookie or payload forging. Use public bypass repos only as a checklist for browser-fingerprint coherence.

## What to learn

DataDome-style collection checks more than cursor movement:

- request headers: User-Agent, Accept-Language, Sec-CH-UA, Sec-Fetch
- JS identity: navigator.userAgent, languages, platform, webdriver
- viewport/screen: inner/outer width/height, screen/avail size, color depth, orientation
- hardware hints: hardwareConcurrency, deviceMemory, touch support
- browser capabilities: plugins, MIME types, PDF viewer, codecs, media APIs
- storage: cookies, localStorage, sessionStorage, IndexedDB
- graphics: canvas, WebGL vendor/renderer
- timezone and locale consistency

## Rejected ideas

- Posting forged payloads to `https://api-js.datadome.co/js/`.
- Hardcoding `ddv`, `ddk`, or challenge-specific payload fields.
- Logging raw challenge payloads/cookies/tokens.
- Adding browserforge as runtime dependency without a separate measured spike.

## Managed Browser direction

Managed Browser should look coherent because it is a real browser with stable profiles, not because it fakes one API call. Add diagnostics and tests that verify consistency between headers, JS-visible fields, viewport, locale, timezone, and profile persona.
```

**Step 2: Verify doc exists**

Run:

```bash
test -s docs/datadome-fingerprint-evaluation.md
```

Expected: exit 0.

---

### Task 8.2: Add a pure fingerprint coherence validator

**Objective:** Define a local validator that catches obvious persona inconsistencies before live browsing.

**Files:**
- Create: `lib/fingerprint-coherence.js`
- Create: `tests/unit/fingerprintCoherence.test.js`

**Step 1: Write failing tests**

Create `tests/unit/fingerprintCoherence.test.js`:

```js
import { validateFingerprintCoherence } from '../../lib/fingerprint-coherence.js';

describe('fingerprint coherence', () => {
  test('accepts a coherent desktop French profile', () => {
    const result = validateFingerprintCoherence({
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-mobile': '?0',
      },
      js: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        language: 'fr-FR',
        languages: ['fr-FR', 'fr', 'en'],
        platform: 'Win32',
        webdriver: false,
        hardwareConcurrency: 8,
        deviceMemory: 8,
      },
      viewport: {
        innerWidth: 1365,
        innerHeight: 768,
        outerWidth: 1365,
        outerHeight: 860,
        screenWidth: 1920,
        screenHeight: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
      },
      timezone: { name: 'Europe/Paris', offsetMinutes: -120 },
      webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11)' },
      storage: { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true },
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('flags mismatched user agent, language, platform, impossible viewport, and webdriver', () => {
    const result = validateFingerprintCoherence({
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123 Safari/537.36',
        'accept-language': 'fr-FR,fr;q=0.9',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-mobile': '?0',
      },
      js: {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0',
        language: 'en-US',
        languages: ['en-US'],
        platform: 'Linux x86_64',
        webdriver: true,
        hardwareConcurrency: 0,
      },
      viewport: {
        innerWidth: 2400,
        innerHeight: 1400,
        outerWidth: 1200,
        outerHeight: 900,
        screenWidth: 1920,
        screenHeight: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 12,
      },
      timezone: { name: 'Asia/Shanghai', offsetMinutes: -120 },
      storage: { cookies: false, localStorage: false, sessionStorage: true, indexedDB: true },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ua_mismatch' }),
      expect.objectContaining({ code: 'language_mismatch' }),
      expect.objectContaining({ code: 'platform_mismatch' }),
      expect.objectContaining({ code: 'webdriver_true' }),
      expect.objectContaining({ code: 'invalid_hardware_concurrency' }),
      expect.objectContaining({ code: 'viewport_exceeds_screen' }),
      expect.objectContaining({ code: 'storage_unavailable' }),
    ]));
  });
});
```

**Step 2: Verify RED**

Run:

```bash
npm test -- tests/unit/fingerprintCoherence.test.js --runInBand
```

Expected: FAIL because `lib/fingerprint-coherence.js` does not exist.

**Step 3: Implement minimal validator**

Create `lib/fingerprint-coherence.js`:

```js
function headerValue(headers = {}, name) {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry ? String(entry[1]) : '';
}

function osFromUA(ua = '') {
  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  return 'unknown';
}

function osFromPlatform(platform = '') {
  if (/Win/i.test(platform)) return 'windows';
  if (/Mac/i.test(platform)) return 'macos';
  if (/Linux|X11/i.test(platform)) return 'linux';
  if (/iPhone|iPad/i.test(platform)) return 'ios';
  return 'unknown';
}

function firstLanguage(value = '') {
  return String(value).split(',')[0].split(';')[0].trim().toLowerCase();
}

function addIssue(issues, code, message) {
  issues.push({ code, message });
}

export function validateFingerprintCoherence({ headers = {}, js = {}, viewport = {}, timezone = {}, storage = {} } = {}) {
  const issues = [];
  const headerUA = headerValue(headers, 'user-agent');
  const jsUA = String(js.userAgent || '');
  if (headerUA && jsUA && headerUA !== jsUA) addIssue(issues, 'ua_mismatch', 'header User-Agent differs from navigator.userAgent');

  const acceptLanguage = firstLanguage(headerValue(headers, 'accept-language'));
  const jsLanguage = String(js.language || '').toLowerCase();
  if (acceptLanguage && jsLanguage && acceptLanguage !== jsLanguage) addIssue(issues, 'language_mismatch', 'Accept-Language first language differs from navigator.language');

  const headerPlatform = headerValue(headers, 'sec-ch-ua-platform').replaceAll('"', '').toLowerCase();
  const jsOS = osFromPlatform(js.platform || jsUA);
  if (headerPlatform && jsOS !== 'unknown' && !headerPlatform.includes(jsOS === 'macos' ? 'mac' : jsOS)) {
    addIssue(issues, 'platform_mismatch', 'Sec-CH-UA-Platform differs from JS platform/UA');
  }

  if (js.webdriver === true) addIssue(issues, 'webdriver_true', 'navigator.webdriver is true');
  if (!Number.isFinite(js.hardwareConcurrency) || js.hardwareConcurrency < 1) addIssue(issues, 'invalid_hardware_concurrency', 'hardwareConcurrency must be >= 1');

  if (viewport.innerWidth > viewport.screenWidth || viewport.innerHeight > viewport.screenHeight) {
    addIssue(issues, 'viewport_exceeds_screen', 'inner viewport exceeds screen dimensions');
  }
  if (viewport.colorDepth && ![24, 30, 32].includes(Number(viewport.colorDepth))) {
    addIssue(issues, 'unusual_color_depth', 'colorDepth is unusual for desktop browser personas');
  }

  if (timezone.name === 'Europe/Paris' && ![-60, -120].includes(Number(timezone.offsetMinutes))) {
    addIssue(issues, 'timezone_offset_mismatch', 'Europe/Paris offset should be -60 or -120 minutes depending on DST');
  }

  if (storage.cookies === false || storage.localStorage === false || storage.indexedDB === false) {
    addIssue(issues, 'storage_unavailable', 'core browser storage is unavailable');
  }

  return { ok: issues.length === 0, issues };
}
```

**Step 4: Verify GREEN**

Run:

```bash
npm test -- tests/unit/fingerprintCoherence.test.js --runInBand
```

Expected: PASS.

---

### Task 8.3: Add a browser-side fingerprint collector

**Objective:** Collect a sanitized snapshot from the live page context for local diagnostics, without secrets/cookies.

**Files:**
- Create: `lib/fingerprint-collector.js`
- Create: `tests/unit/fingerprintCollector.test.js`

**Step 1: Write failing tests**

Create `tests/unit/fingerprintCollector.test.js`:

```js
import { collectFingerprintSnapshot } from '../../lib/fingerprint-collector.js';

test('collectFingerprintSnapshot returns sanitized page-evaluated fingerprint', async () => {
  const page = {
    evaluate: jest.fn(async (fn) => fn()),
  };

  const snapshot = await collectFingerprintSnapshot(page, {
    headers: { 'user-agent': 'ua', cookie: 'secret=1', authorization: 'Bearer nope' },
  });

  expect(page.evaluate).toHaveBeenCalled();
  expect(snapshot.headers).toEqual({ 'user-agent': 'ua' });
  expect(snapshot).toHaveProperty('js.userAgent');
  expect(snapshot).toHaveProperty('viewport.innerWidth');
  expect(snapshot).toHaveProperty('timezone.name');
  expect(JSON.stringify(snapshot)).not.toContain('secret=1');
  expect(JSON.stringify(snapshot)).not.toContain('Bearer nope');
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/fingerprintCollector.test.js --runInBand
```

Expected: FAIL because module does not exist.

**Step 3: Implement collector**

Create `lib/fingerprint-collector.js`:

```js
const REDACTED_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key']);

export function sanitizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !REDACTED_HEADERS.has(String(key).toLowerCase()))
  );
}

export async function collectFingerprintSnapshot(page, { headers = {} } = {}) {
  const js = await page.evaluate(() => {
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    const debugInfo = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      js: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: Array.from(navigator.languages || []),
        platform: navigator.platform,
        webdriver: navigator.webdriver,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints,
        pluginsLength: navigator.plugins ? navigator.plugins.length : 0,
        mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : 0,
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        orientation: screen.orientation?.type,
      },
      timezone: {
        name: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: new Date().getTimezoneOffset(),
      },
      storage: {
        cookies: navigator.cookieEnabled,
        localStorage: typeof localStorage !== 'undefined',
        sessionStorage: typeof sessionStorage !== 'undefined',
        indexedDB: typeof indexedDB !== 'undefined',
      },
      webgl: {
        vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : '',
        renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '',
      },
    };
  });
  return { headers: sanitizeHeaders(headers), ...js };
}
```

**Step 4: Verify GREEN**

```bash
npm test -- tests/unit/fingerprintCollector.test.js --runInBand
```

Expected: PASS.

---

### Task 8.4: Add a guarded local diagnostics endpoint or CLI command

**Objective:** Let operators inspect fingerprint coherence for a managed tab without exposing secrets or adding a bypass surface.

**Files:**
- Modify: `server.js` or `scripts/managed-browser.js`
- Modify: `tests/unit/browserOnlyPolicy.test.js` or create `tests/unit/fingerprintDiagnosticsRoute.test.js`

**Step 1: Prefer CLI if route surface is crowded**

Recommended command shape:

```bash
node scripts/managed-browser.js fingerprint --profile leboncoin-ju --site leboncoin --url https://www.leboncoin.fr
```

Output shape:

```json
{
  "ok": true,
  "issues": [],
  "snapshot": {
    "headers": { "user-agent": "...", "accept-language": "..." },
    "js": { "userAgent": "...", "language": "fr-FR", "webdriver": false },
    "viewport": { "innerWidth": 1365, "screenWidth": 1920 },
    "timezone": { "name": "Europe/Paris", "offsetMinutes": -120 }
  }
}
```

**Step 2: Write failing test**

If implemented as route, assert:

```js
test('fingerprint diagnostics response redacts sensitive headers', async () => {
  // Use existing route test helpers if available.
  // Expected: no cookie/authorization values in JSON response.
});
```

If implemented as CLI, assert static schema in the managed CLI tests and unit-test the formatter separately.

**Step 3: Implement minimal plumbing**

Call `collectFingerprintSnapshot(page, { headers })`, then `validateFingerprintCoherence(snapshot)`, and return both.

**Step 4: Verify**

Run the specific new test plus:

```bash
npm test -- tests/unit/fingerprintCoherence.test.js tests/unit/fingerprintCollector.test.js --runInBand
node --check server.js
```

Expected: PASS.

---

### Task 8.5: Add explicit challenge detection and human-required policy note

**Objective:** Make DataDome/challenge handling operator-safe: no fake solve, only detection and manual handoff.

**Files:**
- Create or modify: `docs/browser-control-policy.md`
- Test optional: `tests/unit/browserOnlyPolicy.test.js`

**Step 1: Add policy text**

Add this section to `docs/browser-control-policy.md`:

```md
## Challenge Pages / DataDome-like Protection

Managed Browser must not forge challenge-provider cookies or POST fake payloads to challenge APIs. When a DataDome-like challenge is detected, the correct behavior is:

1. Mark the action as `human_required`.
2. Expose the existing visible VNC/noVNC session to the operator.
3. Let the human solve or abandon the challenge.
4. Checkpoint managed browser storage after successful human resolution.
5. Resume normal browser-only actions from the real browser session.

Never log raw challenge payloads, cookies, tokens, OTPs, or typed secrets.
```

**Step 2: Optional static policy test**

Assert the policy doc contains `human_required`, `Checkpoint`, and `must not forge`.

**Step 3: Verify**

```bash
test -s docs/browser-control-policy.md
```

Expected: exit 0.

---


### Task 8.7: Add BotBrowser-inspired architecture review doc

**Objective:** Capture BotBrowser lessons as a local design checklist without switching browser engines.

**Files:**
- Create: `docs/fingerprint-architecture-review.md`
- Test: documentation/checklist review only

**Step 1: Create the review document**

```markdown
# Managed Browser Fingerprint Architecture Review

## Purpose

Use BotBrowser-style architecture claims as a checklist for improving the managed Camoufox browser. This is not a migration plan and not a bypass playbook.

## Current backend

- Primary backend: Camoufox/Playwright through managed browser tools.
- Profiles: persistent managed profiles with VNC/manual login and storage checkpointing.
- Actions: browser-only human actions through `lib/human-actions.js`.

## Review areas

### Identity bundle coherence

- User-Agent and Sec-CH-UA values agree.
- `navigator.platform`, mobile/touch flags, viewport, and screen metrics agree.
- Timezone, locale, and `Accept-Language` agree with proxy/IP geography.
- Fonts, WebGL/GPU, codecs, plugins, storage, permissions, and worker-visible values are stable and plausible.

### Network leakage

- WebRTC/STUN behavior is understood for each profile/proxy class.
- Proxy bypass rules do not leak real LAN/WAN identity except intentional localhost exemptions.
- QUIC/UDP behavior is documented.

### Automation artifacts

- Playwright/CDP globals and init-script traces are measured.
- Headless and headed behavior differences are documented.
- Extension/process artifacts are documented.

### Profile isolation

- Same profile: stable identity across restart.
- Different profiles: no accidental shared storage/fingerprint bundle.
- Manual login checkpointing never copies identity state across profiles.

### Validation

- Run CreepJS/Pixelscan/Iphey only as diagnostic observatories.
- Save redacted reports locally.
- Track regressions over time; do not optimize for a single detector.
```

**Step 2: Verify the document stays within policy**

Run:

```bash
grep -Ei 'bypass|solver|fake cookie|datadome payload|cloudflare bypass' docs/fingerprint-architecture-review.md || true
```

Expected: no operational bypass instructions; only high-level warning/policy language if any match appears.

---

### Task 8.8: Add fingerprint architecture checklist test fixture

**Objective:** Make the BotBrowser-inspired checklist testable as safe policy/config validation.

**Files:**
- Create or modify: `tests/unit/fingerprintArchitectureReview.test.js`
- Modify only if needed: `lib/browser-persona.js`

**Step 1: Write failing tests for safe diagnostic policy**

Test behaviors:

1. validation report redacts cookie/authorization-like fields;
2. validation report labels observatory results as diagnostics, not bypass pass/fail;
3. per-context multiplexing is disabled by default for managed profiles;
4. profile identity checks include worker-visible and network-leakage categories.

**Step 2: Run RED**

```bash
npm test -- tests/unit/fingerprintArchitectureReview.test.js --runInBand --forceExit
```

Expected: FAIL because the test/helper does not exist yet.

**Step 3: Implement minimal pure helper if needed**

Prefer a pure helper such as `buildFingerprintArchitectureChecklist(profileConfig)` returning categories and warnings. Do not launch a browser in this unit test.

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/fingerprintArchitectureReview.test.js --runInBand --forceExit
```

Expected: PASS.

---


### Task 8.9: Add challenge taxonomy model

**Objective:** Create a pure, testable model for classifying challenge providers without solving them.

**Files:**
- Create: `lib/challenge-detection.js`
- Test: `tests/unit/challengeDetection.test.js`

**Step 1: Write failing tests for provider taxonomy**

Create `tests/unit/challengeDetection.test.js`:

```js
import {
  detectChallengeProvider,
  classifyChallengeSignals,
} from '../../lib/challenge-detection.js';

describe('challenge detection taxonomy', () => {
  test('detects recaptcha iframe urls as human required', () => {
    const result = detectChallengeProvider({
      pageUrl: 'https://example.com/login',
      frameUrls: [
        'https://www.google.com/recaptcha/api2/anchor?k=site-key',
        'https://www.google.com/recaptcha/api2/bframe?hl=en',
      ],
    });

    expect(result).toMatchObject({
      detected: true,
      provider: 'recaptcha',
      humanRequired: true,
      suggestedAction: 'open_vnc',
    });
  });

  test('detects hcaptcha challenge urls as human required', () => {
    const result = detectChallengeProvider({
      frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'],
    });

    expect(result.provider).toBe('hcaptcha');
    expect(result.humanRequired).toBe(true);
  });

  test('detects cloudflare turnstile urls as human required', () => {
    const result = detectChallengeProvider({
      frameUrls: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0'],
    });

    expect(result.provider).toBe('turnstile');
    expect(result.humanRequired).toBe(true);
  });

  test('detects aws waf captcha urls as human required', () => {
    const result = detectChallengeProvider({
      pageUrl: 'https://example.com/awswaf/captcha?token=redacted',
    });

    expect(result.provider).toBe('aws_waf');
    expect(result.humanRequired).toBe(true);
  });

  test('returns no challenge for normal pages', () => {
    expect(detectChallengeProvider({ pageUrl: 'https://example.com/' })).toMatchObject({
      detected: false,
      provider: null,
      humanRequired: false,
    });
  });

  test('classifies captcha text and canvas hints without solving', () => {
    const result = classifyChallengeSignals({
      pageUrl: 'https://example.com/form',
      textSignals: ['Please solve the CAPTCHA below'],
      elementSignals: [{ tagName: 'canvas', ariaLabel: 'captcha challenge' }],
    });

    expect(result.detected).toBe(true);
    expect(result.type).toBe('text_or_canvas');
    expect(result.humanRequired).toBe(true);
  });
});
```

**Step 2: Run RED**

```bash
npm test -- tests/unit/challengeDetection.test.js --runInBand --forceExit
```

Expected: FAIL because `lib/challenge-detection.js` does not exist yet.

**Step 3: Implement minimal pure detection helper**

Create `lib/challenge-detection.js`:

```js
const PROVIDERS = [
  {
    provider: 'recaptcha',
    type: 'checkbox_or_challenge',
    patterns: [/google\.com\/recaptcha/i, /gstatic\.com\/recaptcha/i],
  },
  {
    provider: 'hcaptcha',
    type: 'checkbox_or_challenge',
    patterns: [/hcaptcha\.com/i, /hcaptcha\.html/i],
  },
  {
    provider: 'turnstile',
    type: 'managed_challenge',
    patterns: [/challenges\.cloudflare\.com/i, /turnstile/i],
  },
  {
    provider: 'arkose',
    type: 'funcaptcha',
    patterns: [/arkoselabs\.com/i, /funcaptcha/i],
  },
  {
    provider: 'aws_waf',
    type: 'managed_challenge',
    patterns: [/awswaf/i, /aws-waf/i],
  },
];

function urlsFrom(input = {}) {
  return [input.pageUrl, ...(input.frameUrls || [])].filter(Boolean).map(String);
}

function challengeResult({ provider = null, type = null, detected = false, frameUrl = null } = {}) {
  return {
    detected,
    provider,
    type,
    frameUrl,
    humanRequired: detected,
    suggestedAction: detected ? 'open_vnc' : null,
    policy: detected ? 'manual_handoff_only' : 'continue',
  };
}

export function detectChallengeProvider(input = {}) {
  for (const url of urlsFrom(input)) {
    for (const candidate of PROVIDERS) {
      if (candidate.patterns.some((pattern) => pattern.test(url))) {
        return challengeResult({
          detected: true,
          provider: candidate.provider,
          type: candidate.type,
          frameUrl: input.frameUrls?.includes(url) ? url : null,
        });
      }
    }
  }

  return challengeResult();
}

export function classifyChallengeSignals(input = {}) {
  const providerResult = detectChallengeProvider(input);
  if (providerResult.detected) return providerResult;

  const text = (input.textSignals || []).join(' ').toLowerCase();
  const elements = input.elementSignals || [];
  const hasCaptchaText = /captcha|verify you are human|security check/.test(text);
  const hasCanvasHint = elements.some((element) =>
    String(element.tagName || '').toLowerCase() === 'canvas' &&
    /captcha|challenge|verify/i.test(String(element.ariaLabel || element.title || ''))
  );

  if (hasCaptchaText || hasCanvasHint) {
    return challengeResult({ detected: true, provider: 'unknown', type: 'text_or_canvas' });
  }

  return challengeResult();
}
```

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/challengeDetection.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.10: Add snapshot challenge diagnostics without secrets

**Objective:** Expose challenge state in snapshots/outcome metadata while redacting sensitive payloads.

**Files:**
- Modify: `lib/snapshot.js`
- Modify: `server.js` only if snapshot assembly happens there
- Test: `tests/unit/snapshotChallengeDiagnostics.test.js`

**Step 1: Write failing tests for redacted diagnostics**

Create `tests/unit/snapshotChallengeDiagnostics.test.js`:

```js
import { buildChallengeDiagnostics } from '../../lib/challenge-detection.js';

describe('snapshot challenge diagnostics', () => {
  test('includes provider, type, frame count, and human handoff action', () => {
    const diagnostics = buildChallengeDiagnostics({
      pageUrl: 'https://example.com/login',
      frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=secret-site-key'],
      frameMetadata: [{ url: 'https://www.google.com/recaptcha/api2/anchor?k=secret-site-key', depth: 1, box: { x: 10, y: 20, width: 300, height: 80 }, devicePixelRatio: 2 }],
    });

    expect(diagnostics).toMatchObject({
      detected: true,
      provider: 'recaptcha',
      humanRequired: true,
      suggestedAction: 'open_vnc',
      frameCount: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('secret-site-key');
  });
});
```

**Step 2: Run RED**

```bash
npm test -- tests/unit/snapshotChallengeDiagnostics.test.js --runInBand --forceExit
```

Expected: FAIL because `buildChallengeDiagnostics` is missing.

**Step 3: Implement minimal diagnostics builder**

Add to `lib/challenge-detection.js`:

```js
function redactUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&][^=]+=)[^&]+/g, '$1[REDACTED]');
  }
}

export function buildChallengeDiagnostics(input = {}) {
  const result = classifyChallengeSignals(input);
  const frameMetadata = input.frameMetadata || [];

  return {
    ...result,
    pageUrl: redactUrl(input.pageUrl),
    frameCount: frameMetadata.length || (input.frameUrls || []).length,
    frames: frameMetadata.slice(0, 10).map((frame) => ({
      url: redactUrl(frame.url),
      depth: frame.depth ?? null,
      box: frame.box ?? null,
      devicePixelRatio: frame.devicePixelRatio ?? null,
    })),
  };
}
```

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/snapshotChallengeDiagnostics.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.11: Wire challenge diagnostics into outcome validation as a hard stop

**Objective:** Ensure replay/repair/actions stop on known CAPTCHA/challenge states instead of trying to click through them.

**Files:**
- Modify: `lib/outcome-validation.js`
- Modify: `lib/managed-llm-repair.js` only if repair can continue after failure
- Test: `tests/unit/challengeOutcomePolicy.test.js`

**Step 1: Write failing policy tests**

Create `tests/unit/challengeOutcomePolicy.test.js`:

```js
import { evaluateChallengeOutcomePolicy } from '../../lib/challenge-detection.js';

describe('challenge outcome policy', () => {
  test('turns detected challenges into human_required hard stops', () => {
    const decision = evaluateChallengeOutcomePolicy({
      challenge: { detected: true, provider: 'hcaptcha', humanRequired: true },
    });

    expect(decision).toEqual({
      ok: false,
      status: 'human_required',
      retryAllowed: false,
      repairAllowed: false,
      suggestedAction: 'open_vnc',
      checkpointAfterHuman: true,
    });
  });

  test('allows normal pages to continue', () => {
    expect(evaluateChallengeOutcomePolicy({ challenge: { detected: false } })).toMatchObject({
      ok: true,
      status: 'continue',
    });
  });
});
```

**Step 2: Run RED**

```bash
npm test -- tests/unit/challengeOutcomePolicy.test.js --runInBand --forceExit
```

Expected: FAIL because `evaluateChallengeOutcomePolicy` is missing.

**Step 3: Implement the pure policy helper**

Add to `lib/challenge-detection.js`:

```js
export function evaluateChallengeOutcomePolicy({ challenge } = {}) {
  if (challenge?.detected || challenge?.humanRequired) {
    return {
      ok: false,
      status: 'human_required',
      retryAllowed: false,
      repairAllowed: false,
      suggestedAction: 'open_vnc',
      checkpointAfterHuman: true,
    };
  }

  return {
    ok: true,
    status: 'continue',
    retryAllowed: true,
    repairAllowed: true,
    suggestedAction: null,
    checkpointAfterHuman: false,
  };
}
```

**Step 4: Wire into outcome validation**

Where outcome validation receives snapshot/page metadata, call `evaluateChallengeOutcomePolicy(...)` before LLM repair or retry. Preserve existing behavior for non-challenge pages.

**Step 5: Run GREEN and focused outcome tests**

```bash
npm test -- tests/unit/challengeOutcomePolicy.test.js tests/unit/outcomeValidation.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.12: Add explicit no-solver policy tests

**Objective:** Prevent accidental integration of NopeCHA/Buster/CapMonster/2Captcha-like solver paths.

**Files:**
- Create: `tests/unit/captchaSolverPolicy.test.js`
- No production code unless the test reveals a real violation

**Step 1: Write static policy tests**

Create `tests/unit/captchaSolverPolicy.test.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const filesToScan = [
  'package.json',
  'server.js',
  'lib/challenge-detection.js',
  'lib/managed-llm-repair.js',
  'lib/outcome-validation.js',
].map((file) => path.join(root, file)).filter(fs.existsSync);

describe('CAPTCHA solver policy', () => {
  test('does not add third-party CAPTCHA solver dependencies or endpoints', () => {
    const combined = filesToScan.map((file) => fs.readFileSync(file, 'utf8')).join('
');

    expect(combined).not.toMatch(/nopecha\.com|api\.nopecha|capmonster|2captcha|anticaptcha|anti-captcha/i);
  });

  test('policy uses manual handoff language for challenges', () => {
    const challengeFile = path.join(root, 'lib/challenge-detection.js');
    const content = fs.existsSync(challengeFile) ? fs.readFileSync(challengeFile, 'utf8') : '';

    expect(content).toMatch(/manual_handoff_only|human_required|open_vnc/);
  });
});
```

**Step 2: Run test**

```bash
npm test -- tests/unit/captchaSolverPolicy.test.js --runInBand --forceExit
```

Expected: PASS after challenge policy exists. If it fails because a solver dependency/API already exists, stop and ask Julien before removing anything.

---

### Task 8.13: Document CAPTCHA challenge policy

**Objective:** Make the operator policy explicit for future agents and prevent “helpful” solver integrations.

**Files:**
- Create: `docs/captcha-challenge-policy.md`
- Test: `tests/unit/captchaSolverPolicy.test.js`

**Step 1: Create documentation**

```markdown
# Managed Browser CAPTCHA Challenge Policy

## Policy

Managed Browser detects CAPTCHA/challenge pages but does not solve them automatically.

When a CAPTCHA/challenge is detected:

1. Stop the automated action/replay/repair path.
2. Return `human_required`.
3. Surface the managed VNC/noVNC session to the operator.
4. Let the human solve, abandon, or change approach.
5. After human resolution, checkpoint storage with reason `challenge_resolved_by_human`.
6. Resume only after a fresh snapshot confirms the page state changed.

## Providers to classify

- reCAPTCHA
- hCaptcha
- FunCAPTCHA / Arkose
- Cloudflare Turnstile
- AWS WAF CAPTCHA
- Text CAPTCHA
- Canvas/bounding-box challenges
- Drag-drop challenges
- Audio/video challenges

## Banned integrations

- NopeCHA extension or API as a default dependency
- Buster as an automatic solver extension
- CapMonster, 2Captcha, AntiCaptcha, or similar services
- Speech-to-text CAPTCHA solving
- Fake challenge payload/cookie generation
- Challenge reset loops intended to brute-force a pass

## Allowed diagnostics

- Provider name
- Redacted frame URL
- Frame hierarchy/depth
- Bounding box and devicePixelRatio
- Presence of site key as boolean only
- Suggested action: `open_vnc`

Never log raw cookies, challenge tokens, authorization headers, OTPs, typed secrets, screenshots of private account state, or full challenge payloads.
```

**Step 2: Extend policy test to require the doc**

Add an assertion that `docs/captcha-challenge-policy.md` exists and contains `human_required`, `open_vnc`, and `challenge_resolved_by_human`.

**Step 3: Run tests**

```bash
npm test -- tests/unit/captchaSolverPolicy.test.js --runInBand --forceExit
```

Expected: PASS.

---


### Task 8.14: Add configurable challenge resolution modes

**Objective:** Make CAPTCHA/challenge behavior explicit and operator-controlled: manual VNC by default, disabled mode for no-pause jobs, and a guarded future auto mode limited to controlled/allowlisted scopes.

**Files:**
- Modify: `lib/config.js` or the existing managed-browser config loader
- Modify: `camofox.config.json` only if this repo already stores managed-browser defaults there
- Create or modify: `tests/unit/challengeResolutionConfig.test.js`

**Step 1: Write failing config tests**

Create `tests/unit/challengeResolutionConfig.test.js`:

```js
import { normalizeChallengeResolutionConfig } from '../../lib/challenge-detection.js';

describe('challenge resolution config', () => {
  test('defaults to manual_vnc with redacted diagnostics', () => {
    expect(normalizeChallengeResolutionConfig()).toEqual({
      mode: 'manual_vnc',
      allowedAutoScopes: [],
      solverProvider: null,
      requireExplicitPerSiteOptIn: true,
      checkpointAfterHuman: true,
      redactDiagnostics: true,
    });
  });

  test('supports disabled mode without solver provider', () => {
    expect(normalizeChallengeResolutionConfig({ mode: 'disabled' })).toMatchObject({
      mode: 'disabled',
      solverProvider: null,
    });
  });

  test('rejects unknown modes', () => {
    expect(() => normalizeChallengeResolutionConfig({ mode: 'solve_everything' })).toThrow(/Unsupported challenge resolution mode/);
  });

  test('rejects auto mode without explicit controlled allowlist', () => {
    expect(() => normalizeChallengeResolutionConfig({ mode: 'auto_controlled_lab_only' })).toThrow(/allowlist/);
  });

  test('accepts auto_controlled_lab_only only with explicit allowlisted controlled scopes', () => {
    expect(normalizeChallengeResolutionConfig({
      mode: 'auto_controlled_lab_only',
      allowedAutoScopes: ['controlled-demo.local', 'owned-test-captcha-page'],
      solverProvider: 'internal_stub',
    })).toMatchObject({
      mode: 'auto_controlled_lab_only',
      allowedAutoScopes: ['controlled-demo.local', 'owned-test-captcha-page'],
      solverProvider: 'internal_stub',
    });
  });
});
```

**Step 2: Run RED**

```bash
npm test -- tests/unit/challengeResolutionConfig.test.js --runInBand --forceExit
```

Expected: FAIL because `normalizeChallengeResolutionConfig` is missing.

**Step 3: Implement minimal pure config normalizer**

Add to `lib/challenge-detection.js`:

```js
const CHALLENGE_RESOLUTION_MODES = new Set([
  'manual_vnc',
  'disabled',
  'auto_controlled_lab_only',
]);

export function normalizeChallengeResolutionConfig(config = {}) {
  const normalized = {
    mode: config.mode || 'manual_vnc',
    allowedAutoScopes: Array.isArray(config.allowedAutoScopes) ? config.allowedAutoScopes : [],
    solverProvider: config.solverProvider || null,
    requireExplicitPerSiteOptIn: config.requireExplicitPerSiteOptIn !== false,
    checkpointAfterHuman: config.checkpointAfterHuman !== false,
    redactDiagnostics: config.redactDiagnostics !== false,
  };

  if (!CHALLENGE_RESOLUTION_MODES.has(normalized.mode)) {
    throw new Error(`Unsupported challenge resolution mode: ${normalized.mode}`);
  }

  if (normalized.mode !== 'auto_controlled_lab_only') {
    normalized.solverProvider = null;
    normalized.allowedAutoScopes = [];
  }

  if (normalized.mode === 'auto_controlled_lab_only') {
    if (normalized.allowedAutoScopes.length === 0) {
      throw new Error('auto_controlled_lab_only requires an explicit controlled allowlist');
    }
    if (!normalized.requireExplicitPerSiteOptIn) {
      throw new Error('auto_controlled_lab_only requires explicit per-site opt-in');
    }
  }

  return normalized;
}
```

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/challengeResolutionConfig.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.15: Route challenge policy decisions through resolution mode

**Objective:** Ensure `manual_vnc`, `disabled`, and future guarded auto mode produce distinct, testable decisions without implementing a solver.

**Files:**
- Modify: `lib/challenge-detection.js`
- Modify: `lib/outcome-validation.js` when wiring into runtime
- Test: `tests/unit/challengeResolutionPolicy.test.js`

**Step 1: Write failing policy tests**

Create `tests/unit/challengeResolutionPolicy.test.js`:

```js
import { evaluateChallengeOutcomePolicy } from '../../lib/challenge-detection.js';

const challenge = { detected: true, provider: 'recaptcha', humanRequired: true };

describe('challenge resolution policy modes', () => {
  test('manual_vnc returns human_required with VNC handoff', () => {
    expect(evaluateChallengeOutcomePolicy({ challenge, resolution: { mode: 'manual_vnc' } })).toMatchObject({
      ok: false,
      status: 'human_required',
      suggestedAction: 'open_vnc',
      retryAllowed: false,
      repairAllowed: false,
      checkpointAfterHuman: true,
    });
  });

  test('disabled mode stops without VNC handoff', () => {
    expect(evaluateChallengeOutcomePolicy({ challenge, resolution: { mode: 'disabled' } })).toMatchObject({
      ok: false,
      status: 'challenge_blocked',
      suggestedAction: null,
      retryAllowed: false,
      repairAllowed: false,
    });
  });

  test('auto_controlled_lab_only returns auto_allowed only for allowlisted controlled scope', () => {
    expect(evaluateChallengeOutcomePolicy({
      challenge,
      site: 'controlled-demo.local',
      resolution: {
        mode: 'auto_controlled_lab_only',
        allowedAutoScopes: ['controlled-demo.local'],
        solverProvider: 'internal_stub',
      },
    })).toMatchObject({
      ok: false,
      status: 'auto_resolution_allowed_controlled_scope',
      suggestedAction: 'run_configured_controlled_solver',
      retryAllowed: false,
      repairAllowed: false,
    });
  });

  test('auto_controlled_lab_only falls back to human_required outside allowlist', () => {
    expect(evaluateChallengeOutcomePolicy({
      challenge,
      site: 'leboncoin',
      resolution: {
        mode: 'auto_controlled_lab_only',
        allowedAutoScopes: ['controlled-demo.local'],
        solverProvider: 'internal_stub',
      },
    })).toMatchObject({
      status: 'human_required',
      suggestedAction: 'open_vnc',
    });
  });
});
```

**Step 2: Run RED**

```bash
npm test -- tests/unit/challengeResolutionPolicy.test.js --runInBand --forceExit
```

Expected: FAIL until `evaluateChallengeOutcomePolicy` supports the `resolution` argument.

**Step 3: Implement policy branching only**

Update `evaluateChallengeOutcomePolicy` so it normalizes resolution config and returns decisions. Do not implement any CAPTCHA solver call in this task.

Pseudo-implementation:

```js
export function evaluateChallengeOutcomePolicy({ challenge, site, resolution } = {}) {
  if (!(challenge?.detected || challenge?.humanRequired)) {
    return {
      ok: true,
      status: 'continue',
      retryAllowed: true,
      repairAllowed: true,
      suggestedAction: null,
      checkpointAfterHuman: false,
    };
  }

  const config = normalizeChallengeResolutionConfig(resolution);

  if (config.mode === 'disabled') {
    return {
      ok: false,
      status: 'challenge_blocked',
      retryAllowed: false,
      repairAllowed: false,
      suggestedAction: null,
      checkpointAfterHuman: false,
    };
  }

  if (
    config.mode === 'auto_controlled_lab_only' &&
    site &&
    config.allowedAutoScopes.includes(site)
  ) {
    return {
      ok: false,
      status: 'auto_resolution_allowed_controlled_scope',
      retryAllowed: false,
      repairAllowed: false,
      suggestedAction: 'run_configured_controlled_solver',
      checkpointAfterHuman: false,
    };
  }

  return {
    ok: false,
    status: 'human_required',
    retryAllowed: false,
    repairAllowed: false,
    suggestedAction: 'open_vnc',
    checkpointAfterHuman: true,
  };
}
```

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/challengeResolutionPolicy.test.js tests/unit/challengeOutcomePolicy.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.16: Extend no-solver policy tests for real-account defaults

**Objective:** Prove that automatic CAPTCHA solving cannot be enabled accidentally for real managed accounts or globally.

**Files:**
- Modify: `tests/unit/captchaSolverPolicy.test.js`
- Modify: `docs/captcha-challenge-policy.md`

**Step 1: Add static policy assertions**

Extend `tests/unit/captchaSolverPolicy.test.js`:

```js
test('auto captcha mode is documented as controlled-lab-only and not global default', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/captcha-challenge-policy.md'), 'utf8');

  expect(doc).toMatch(/manual_vnc/);
  expect(doc).toMatch(/auto_controlled_lab_only/);
  expect(doc).toMatch(/controlled/i);
  expect(doc).toMatch(/allowlist/i);
  expect(doc).toMatch(/Never auto-solve on Leboncoin, France Travail, banking, email, admin, or real personal accounts/i);
});
```

**Step 2: Update documentation**

Add to `docs/captcha-challenge-policy.md`:

```markdown
## Resolution modes

- `manual_vnc` — default. Stop automation, return `human_required`, expose VNC/noVNC, checkpoint after human resolution.
- `disabled` — stop automation and return a blocked challenge status without requesting manual intervention.
- `auto_controlled_lab_only` — future/reserved. Only for owned controlled demos, synthetic tests, accessibility research, or explicitly authorized environments. Requires per-site/profile allowlist and must never be a global default.

Never auto-solve on Leboncoin, France Travail, banking, email, admin, or real personal accounts by default.
```

**Step 3: Run tests**

```bash
npm test -- tests/unit/captchaSolverPolicy.test.js tests/unit/challengeResolutionConfig.test.js tests/unit/challengeResolutionPolicy.test.js --runInBand --forceExit
```

Expected: PASS.

---

### Task 8.17: Rename controlled smoke task and verify both manual and disabled modes

**Objective:** Exercise the operational behavior without solving a CAPTCHA.

**Files:**
- No code changes unless smoke test reveals a bug

**Step 1: Controlled demo manual mode**

Use a controlled public/demo challenge page only. Configure `challengeResolution.mode = 'manual_vnc'`.

Expected:

```json
{
  "status": "human_required",
  "suggestedAction": "open_vnc",
  "checkpointAfterHuman": true
}
```

**Step 2: Controlled demo disabled mode**

Configure `challengeResolution.mode = 'disabled'`.

Expected:

```json
{
  "status": "challenge_blocked",
  "suggestedAction": null,
  "checkpointAfterHuman": false
}
```

**Step 3: Do not run auto mode on real accounts**

Only test `auto_controlled_lab_only` against unit tests or a local synthetic page. Do not invoke third-party solvers in smoke tests.

---

### Task 8.18: Real managed-browser challenge smoke test on controlled demo only

**Objective:** Verify detection/handoff behavior without touching real accounts or bypassing a production site.

**Files:**
- No code changes unless smoke test reveals a bug

**Step 1: Use a controlled public demo page only**

Use a demo page that intentionally displays a CAPTCHA/challenge widget, not a real account/login page. Do not solve the challenge automatically.

**Step 2: Navigate with managed browser**

Example flow:

1. `managed_browser_navigate(profile='ju', site='captcha-demo', url='<controlled-demo-url>')`
2. `managed_browser_snapshot(...)`
3. inspect returned challenge diagnostics

Expected:

```json
{
  "challenge": {
    "detected": true,
    "humanRequired": true,
    "suggestedAction": "open_vnc"
  }
}
```

**Step 3: Verify no automated solver activity**

Confirm logs do not contain outbound calls to NopeCHA/CapMonster/2Captcha-like services and no route attempts to click/solve the widget after `human_required`.

---

# Phase 9 — Real Camofox Verification

### Task 9.1: Run targeted unit and syntax suite

**Objective:** Prove the implementation does not regress policy or core action behavior.

**Files:**
- No code changes unless failures reveal a bug

**Step 1: Run focused tests**

```bash
cd /home/jul/tools/camofox-browser
npm test -- tests/unit/humanActions.test.js tests/unit/browserOnlyPolicy.test.js tests/unit/humanBehaviorPersona.test.js tests/unit/humanSessionState.test.js tests/unit/humanReading.test.js --runInBand
node --check server.js
```

Expected: PASS.

---

### Task 9.2: Run focused E2E click test

**Objective:** Catch Camofox/Xvfb movement hangs that unit fake pages cannot catch.

**Files:**
- No code changes unless failures reveal a bug

**Step 1: Run E2E**

```bash
npm test -- tests/e2e/formSubmission.test.js -t 'click button on page' --runInBand --forceExit
```

Expected: PASS.

If it hangs:

1. Inspect server logs/phase logs.
2. Confirm every Playwright mouse operation has a short guard.
3. Reduce default route probabilities for `missChance`/`overshootChance` before widening timeouts.

---

### Task 9.3: Smoke test via managed browser on a low-risk page

**Objective:** Validate real production path after restart.

**Files:**
- No code changes unless failures reveal a bug

**Step 1: Restart service if needed**

```bash
systemctl --user restart camofox-browser.service
systemctl --user status camofox-browser.service --no-pager
```

Expected: active/running.

**Step 2: Perform a real managed-browser click**

Use Hermes managed browser tools on a harmless page, for example:

1. `managed_browser_navigate(profile='ju', site='example', url='https://example.com')`
2. snapshot
3. click a visible link/ref with `human_profile='fast'`
4. snapshot again

Expected: click succeeds; no route timeout.

---

# Rollout / Defaults

- Keep `fast` as default profile.
- Start with conservative route defaults:
  - `overshootChance`: persona value capped at `0.25`, or `0` if no persona.
  - `missChance`: persona value capped at `0.12`, or `0` if no persona.
  - inverse scroll correction: capped at `0.10`.
- If Leboncoin or other sites become flaky, first disable `missChance` at route level before touching browser identity/fingerprinting.
- Do not add `ghost-cursor` to `dependencies` unless a later measured comparison shows our internal planner is worse and the adapter can remain Playwright-only.

# Final Verification Checklist

- [x] Planner tests pass and are deterministic.
- [x] All planned points are viewport-bounded.
- [x] Final cursor equals final click target.
- [x] Small targets create slower/more careful motion than large targets.
- [x] Overshoot/miss corrects before mouse down/up.
- [x] Scroll bursts are uneven but bounded.
- [x] Browser-only policy still bans synthetic DOM/X11 action paths.
- [x] DataDome reference is documented as fingerprint-coherence input only, not a bypass implementation.
- [x] Fingerprint coherence validator flags UA/language/platform/viewport/webdriver/storage mismatches.
- [x] Fingerprint diagnostics redact cookie/authorization-like headers.
- [x] Challenge policy says `human_required` + VNC/manual handoff + storage checkpoint; no fake cookie forging.
- [x] BotBrowser is documented as architecture/validation inspiration only; no default engine migration.
- [x] Fingerprint architecture review covers identity bundle, network leakage, automation artifacts, profile isolation, and diagnostic validation.
- [x] Per-context fingerprinting remains future-spike only, not default for real managed accounts.
- [x] Buster is documented as iframe/manual-handoff inspiration only; no GPL code copy and no audio CAPTCHA solving.
- [x] NopeCHA is documented as taxonomy/policy inspiration only; no solver extension/API dependency.
- [x] Challenge taxonomy detects reCAPTCHA, hCaptcha, Turnstile, Arkose/FunCAPTCHA, AWS WAF, text/canvas, drag-drop, and audio/video challenge classes.
- [x] Challenge outcomes return `human_required`, disable retries/LLM repair, expose VNC, and checkpoint only after human resolution in `manual_vnc` mode.
- [x] `disabled` mode detects and blocks challenges without opening/suggesting VNC.
- [x] `auto_controlled_lab_only` exists only as guarded future/controlled-scope policy, requires allowlist, and is blocked for real managed accounts by tests/docs.
- [x] Static policy tests ban NopeCHA/CapMonster/2Captcha-like integrations from managed-browser runtime paths unless a separate explicit controlled-scope plan is accepted.
- [x] `node --check server.js` passes.
- [x] Focused Camofox E2E click passes.
- [ ] One real managed-browser click smoke test passes. — BLOCKED: managed profile currently locked (HTTP 423 on visible-tab), so live smoke not run.
