# Browser Control Policy

For user-visible website sessions, automation must operate through the browser context and approved browser-control endpoints. The goal is to preserve browser-only behavior: Playwright browser primitives, no raw OS input tools, and no page-side JavaScript synthetic site actions.

## Allowed control paths

Use Camofox browser endpoints for the visible profile/tab:

- `GET /tabs?userId=...`
- `GET /tabs/<tabId>/snapshot?userId=...`
- `POST /tabs/<tabId>/click`
- `POST /tabs/<tabId>/type`
- `POST /tabs/<tabId>/press`
- `POST /tabs/<tabId>/scroll`
- `POST /tabs/<tabId>/navigate`

These endpoints should route visible actions through centralized human helpers in `lib/human-actions.js`:

- `humanPrepareTarget` before target-bound click/type actions.
- `humanClick` for normal clicks.
- `humanType` for keyboard text entry.
- `humanPress` for key presses and submit/enter actions.
- `humanScroll` for wheel scrolling.

The helper implementation must stay browser-only by using Playwright browser primitives such as `page.mouse.move/down/up/wheel`, `page.keyboard.type/press`, and locator visibility/focus/bounding-box operations.

## Forbidden for website interaction

Do not use these for user-visible site actions:

- Raw X11/macOS/desktop automation tools such as `xdotool`, `wmctrl`, `xprop`, `xwininfo`, `cliclick`, or `robotjs`.
- JavaScript DOM action simulation such as `dispatchEvent(...)`, `document.querySelector(...).click()`, or arbitrary `page.evaluate(...)` used to trigger clicks/key events/site actions.
- Direct calls to private site APIs or hidden endpoints to bypass the browser UI.
- Captcha or anti-bot bypass attempts.

`locator.click({ force: true })` is not a general-purpose click path. It is allowed only in the explicit Google SERP branch documented and guarded in `server.js`; normal click handling must use `humanPrepareTarget` plus `humanClick`.

## Required behavior

1. Prefer snapshot/vision context when selecting a target in a visible browser session.
2. Before clicking, confirm the target ref/selector belongs to the active tab for the correct `userId`/`tabId`.
3. If browser snapshot and visible screenshot disagree, stop website actions and reconcile active tab/window mapping before continuing.
4. If blocked by an interstitial or anti-bot challenge, report the browser-visible state and do not try forbidden control paths.
5. Keep the default human behavior profile `fast` so normal control remains responsive.
6. Keep sensitive field typing stable: intentional typos are disabled for password, email, telephone, one-time-code/code, URL, and number-like inputs.

## Policy tests

Run the browser-only policy test after changing action routes or human action helpers:

```bash
npm test -- tests/unit/browserOnlyPolicy.test.js --runInBand
```

Run the full targeted human-behavior verification before release:

```bash
npm test -- tests/unit/humanActions.test.js tests/unit/humanSessionState.test.js tests/unit/humanBehaviorPersona.test.js tests/unit/browserOnlyPolicy.test.js tests/unit/typeKeyboardMode.test.js tests/unit/browserPersona.test.js tests/unit/humanReading.test.js --runInBand
node --check server.js
```
