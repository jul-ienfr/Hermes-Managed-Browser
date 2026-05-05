# Optional Human Session Recorder

This document defines a **local-only, privacy-safe** schema for recording real manual browser sessions for later human-behavior calibration. It is a schema and helper contract only; it does not enable network upload, remote telemetry, raw X11 automation, or page-side JavaScript action simulation.

## Scope and policy

- Recording files must stay on the local machine and should be excluded from commits.
- Use browser/VNC-observed input events only. Do not use raw X11 automation for site actions.
- Do not replay these files as private browsing scripts. The intended output is derived timing distributions for behavior tuning.
- Do not record URLs, selectors, element text, form values, cookies, headers, storage, screenshots, or accessibility snapshots in recorder events.
- Do not store secrets or account identifiers.

## File format

Recorder files are newline-delimited JSON (`.jsonl`). Each line is one sanitized event with a relative timestamp in milliseconds from the start of the local recording session.

Example:

```jsonl
{"t":0,"type":"mouse.move","x":120,"y":300}
{"t":153,"type":"mouse.down","button":"left"}
{"t":187,"type":"mouse.up","button":"left"}
{"t":430,"type":"wheel","dx":0,"dy":380}
{"t":920,"type":"key.type","class":"letter","delay":43}
```

## Event schema

Common fields:

- `t` — non-negative integer milliseconds since recorder start.
- `type` — one of the event types below.

Supported event types:

| Type | Required fields | Notes |
| --- | --- | --- |
| `mouse.move` | `x`, `y` | Viewport-relative coordinates only. No target metadata. |
| `mouse.down` | `button` | `button` is `left`, `middle`, or `right`. |
| `mouse.up` | `button` | `button` is `left`, `middle`, or `right`. |
| `wheel` | `dx`, `dy` | Wheel deltas only. |
| `key.type` | `class`, `delay` | Character class and elapsed key delay only. |
| `key.press` | `class`, `delay` | Control-key class only; no raw key names required. |

## Typing privacy rules

Never store raw typed text by default. For `key.type`, store only `class`:

- `letter`
- `digit`
- `space`
- `punctuation`
- `control`

Password, email, phone, OTP/code, URL, and number fields are sensitive. Full values must never be recorded. If a local collector can identify field kind, it may mark an event with `sensitive: true`, but it must still store only character class and timing.

Forbidden fields include but are not limited to:

- `text`, `value`, `raw`, `keySequence`
- `url`, `selector`, `xpath`
- `targetText`, `label`, `placeholder`, `ariaLabel`
- cookies, tokens, headers, local/session storage

## Derived summaries for calibration

Calibration should consume summaries, not raw replay content. A summary may include distributions such as:

```json
{
  "version": 1,
  "eventCounts": { "mouse.move": 120, "key.type": 42 },
  "keyClassCounts": { "letter": 30, "digit": 4, "space": 6, "punctuation": 2 },
  "keyDelayMs": { "count": 42, "min": 18, "max": 140, "mean": 54 },
  "interEventDelayMs": { "count": 180, "min": 4, "max": 900, "mean": 83 }
}
```

These summaries are suitable for future behavior persona tuning because they preserve timing tendencies without preserving private content.

## Current implementation status

`lib/human-session-recording.js` contains small privacy helpers for event sanitization, typed-character classification, and local summary generation. There is no recorder endpoint and no automatic collection. Calibration import is intentionally deferred until 2–3 real manual local session summaries exist.
