# CAPTCHA / Challenge Policy

Managed Browser must detect challenge pages and hand control to a human by default. It must not solve, bypass, or outsource challenges for real accounts.

## Providers/classes to classify

- reCAPTCHA
- hCaptcha
- Cloudflare Turnstile / managed challenges
- Arkose / FunCAPTCHA
- AWS WAF
- text/canvas challenges
- drag-drop / slider challenges
- audio/video challenge classes

## Resolution modes

### `manual_vnc` (default)

Return `human_required`, stop retries and LLM repair, expose VNC/noVNC for manual resolution, then checkpoint storage only after the human changes page state.

### `disabled`

Return a clean `challenge_blocked` result. Do not open or suggest VNC. Use this for unattended jobs that must never pause.

### `auto_controlled_lab_only`

Future guarded mode for owned demos, synthetic pages, accessibility research, or explicitly allowlisted controlled environments. It is off by default, requires an allowlist, and remains blocked for real managed accounts such as Leboncoin, France Travail, banking, email, admin, and personal accounts.

## Banned runtime integrations

No NopeCHA, CapMonster, 2Captcha, AntiCaptcha, DeathByCaptcha, Buster audio solving, speech-to-text CAPTCHA solving, challenge reset loops, forged cookies, or challenge payload replay in managed-browser runtime paths.

## Allowed diagnostics

Redacted frame URL, provider/category, frame name, bounding box, nesting-level hints, and `devicePixelRatio`. Never log cookies, auth headers, tokens, OTPs, typed secrets, screenshots containing private account state, full challenge payloads, or full page context to a solver service.
