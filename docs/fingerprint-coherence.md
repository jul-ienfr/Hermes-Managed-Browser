# Managed Browser Fingerprint Coherence Audit

This is an audit/checklist layer, not a bypass layer. The goal is to keep a managed profile internally coherent so normal browser automation does not contradict its own declared persona.

## DataDome-inspired lesson

Challenge systems often correlate multiple weak signals. The useful takeaway for this project is coherence across the whole browser profile, not replaying challenge payloads, forging cookies, or bypassing protections.

## Coherence axes

- Locale and languages (`navigator.language`, `navigator.languages`, `Accept-Language`).
- Timezone and geolocation/proxy region.
- OS/platform/user-agent family.
- Screen, viewport, device scale factor, and visible VNC window size.
- Hardware hints (`hardwareConcurrency`, `deviceMemory`) matching the persona.
- WebGL/GPU family plausibility.
- WebRTC/STUN and network leakage review.
- Storage behavior: cookies and localStorage must be available for persistent profiles.
- Automation artifacts such as exposed `navigator.webdriver`.

## Diagnostics policy

Diagnostics must be local and redacted. Never log cookies, auth headers, tokens, OTPs, challenge payloads, raw screenshots of private account state, or typed secrets.

## Validation helpers

- `lib/fingerprint-coherence.js#collectBrowserFingerprintSnapshot(page)` gathers browser-side fields.
- `lib/fingerprint-coherence.js#validateFingerprintCoherence(...)` flags mismatches.
- `lib/fingerprint-coherence.js#redactFingerprintDiagnostics(...)` redacts sensitive fields before logs/reports.
