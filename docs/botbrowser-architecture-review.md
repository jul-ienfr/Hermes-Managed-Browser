# BotBrowser-Inspired Architecture Review

BotBrowser is useful as a benchmark for fingerprint architecture, not as a replacement for the current managed browser.

## Keep as-is

- Camoufox/Playwright orchestration.
- Persistent named managed profiles.
- Accessibility refs and snapshots.
- VNC/noVNC manual login and challenge handoff.
- Action locks, popup adoption, storage checkpoints, and recovery metadata.

## Review areas borrowed conceptually

- Treat identity as a coherent bundle: UA, platform, screen, viewport, locale, timezone, WebGL/GPU, hardware, storage.
- Validate the actual runtime from inside the browser, not just launch options.
- Keep profile isolation strict for real accounts.
- Treat per-context fingerprinting as a future memory/process spike only; real managed accounts should keep separate persistent profiles by default.
- Use observatories such as CreepJS/Pixelscan/Iphey only for manual/local diagnostics, never as an automated bypass target.

## Rejected

- Replacing Camoufox with an opaque/proprietary browser core by default.
- Adding challenge bypass, forged cookies, or payload replay.
- Moving real-account profiles to shared contexts without a separate risk review.
