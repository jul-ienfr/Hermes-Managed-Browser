# Human Behavior Controls

Camofox human behavior V2 makes browser actions behave like a coherent visible session while preserving browser-only automation. The public endpoints remain compatible and default to the fast profile.

## Default profile: `fast`

The default `humanProfile` is `fast` for click, type, press, and scroll endpoints. It is intentionally responsive for agent workflows:

- Click pauses are short: small delay before mouse down, brief hold, brief after-click pause.
- Typing uses short per-key delays and modest word/correction pauses.
- Scrolling uses a small number of wheel bursts.
- Reading pauses are bounded for fast profile page-load/navigation contexts.

Other profiles such as `medium` and `slow` exist for slower interaction signatures, but integrations should not switch away from `fast` unless a task explicitly needs slower behavior.

## Per-profile behavior signatures

Each browser profile/user receives a deterministic human behavior persona from `buildHumanBehaviorPersona(profileKey)`. The persona keeps sessions consistent for the same profile while varying across profiles.

Persona fields include:

- `seed`: deterministic numeric seed used by human session state.
- `profile`: timing profile, defaulting to `fast`.
- `motionJitter`: profile-specific movement variation.
- `overshootChance`: probability used by advanced mouse aiming when enabled.
- `hesitationChance`: reserved/persona-level hesitation knob.
- `readingSpeed`: multiplier for target/page reading pauses.
- `typoRateText`: persona default for free-text typo behavior when explicitly enabled.

The defaults keep operation fast. Tuning should happen by changing these knobs or passing explicit endpoint/helper options, not by adding OS-level or page-side synthetic actions.

## Cursor state

Every tab has a `humanSession` with persistent cursor state. Click actions start from `getHumanCursor(tabState.humanSession)` and update state with `updateHumanCursor(...)` after the human click result.

This prevents each action from starting at a fake corner position and makes consecutive actions look like a continuous session. The initial cursor is deterministic and viewport-relative from the session seed.

## Target preparation

Target-bound click/type routes call `humanPrepareTarget` before the actual action. Preparation can:

- Read the element bounding box.
- Scroll the element toward a comfortable viewport band.
- Add a small reading/intent pause affected by `readingSpeed`.

Normal clicking then uses `humanClick`, which moves through a human-like mouse path, optionally overshoots during movement, settles around the target when enabled, and performs Playwright mouse down/up.

## Scrolling model

`humanScroll` uses Playwright `page.mouse.wheel` with bursty, uneven wheel deltas. For larger scrolls, a small inverse correction can occur to mimic a real wheel/trackpad adjustment. The `fast` profile keeps burst counts and pauses short.

## Sensitive field typing policy

Intentional typos are disabled by default in endpoints (`mistakesRate: 0`). Even if a mistake rate is requested, `effectiveMistakesRate` suppresses typos for sensitive or structured kinds:

- `password`
- `email`
- `tel`
- `otp`
- `code`
- `url`
- `number`

Free-text typo behavior should remain opt-in. Do not enable mistakes for login, contact, payment, order-code, or other structured fields.

## Forbidden implementation paths

Human behavior must remain browser-only. Do not add:

- Raw X11/desktop tools: `xdotool`, `wmctrl`, `cliclick`, `robotjs`, etc.
- Page-side synthetic site actions: `dispatchEvent`, injected `document.querySelector(...).click()`, or `page.evaluate` that triggers UI actions.
- Blanket `force: true` click behavior. The only tolerated force click is the explicit Google SERP branch in `server.js`.

## Verification commands

Policy-only check:

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js --runInBand
```

Targeted human-behavior verification:

```bash
npm test -- tests/unit/humanActions.test.js tests/unit/humanSessionState.test.js tests/unit/humanBehaviorPersona.test.js tests/unit/browserOnlyPolicy.test.js tests/unit/typeKeyboardMode.test.js tests/unit/browserPersona.test.js tests/unit/humanReading.test.js --runInBand
node --check server.js
```

Optional live VNC smoke testing should use only a safe local fixture or blank test page. Do not interact with sensitive accounts during smoke tests.
