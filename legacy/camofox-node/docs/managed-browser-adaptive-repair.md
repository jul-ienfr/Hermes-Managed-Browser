# Managed Browser Adaptive Repair

Managed Browser replay uses a deterministic adaptive repair pipeline to replay saved browser actions across ordinary DOM drift. The pipeline is intentionally generic: it operates on action refs, accessibility summaries, and safe DOM structure only. It must not contain target-site rules, domain names, marketplace-specific selectors, or site-specific text.

## Replay order

For each saved action, self-healing replay follows this order:

1. **Pre-flight gates**
   - Resolve runtime parameters such as `{{message}}` before interacting with the page.
   - Return `requires_parameter` when a required runtime value is missing.
   - Return `requires_secret` for redacted type actions instead of typing stored secrets.
   - Enforce side-effect policy gates before actions that may submit, publish, delete, pay, buy, or otherwise mutate state.
   - Handle human/interrupt gates before interaction when the page requires manual intervention.
2. **Exact replay**
   - Try the recorded action as-is, using its saved ref or selector.
   - Validate the expected outcome after the handler succeeds.
   - Return `mode: "exact"` when the action and validation pass.
3. **Target-summary repair**
   - Refresh live refs when possible.
   - Compare the saved `target_summary` with live candidates using generic role, accessible name, text, selected safe attributes, and index proximity.
   - Try the best candidate when it meets the target-summary confidence threshold.
   - Validate the repaired action before reporting success.
   - Return `mode: "repaired"` when target-summary repair succeeds.
4. **DOM-signature repair**
   - If exact replay fails and target-summary repair is unavailable or does not validate, compare the saved DOM signature with live candidate DOM signatures.
   - Use deterministic scoring over tag, normalized text, allowed attributes, parent, siblings, tag-only path, depth/index, and nearby text.
   - Apply stricter thresholds for typing and high-impact actions.
   - Reject low-confidence or ambiguous candidates rather than guessing.
   - Validate the repaired action before reporting success.
   - Return `mode: "dom_signature_repaired"` with `llm_used: false` when successful.
5. **Optional planner fallback**
   - A planner/LLM fallback is only attempted when explicitly enabled with `allowLlmFallback=true` and a planner callback is provided.
   - Local exact replay and local repairs never require routine LLM calls.

## Target-summary repair

Target-summary repair is the first local repair layer. It compares a saved summary like:

```json
{
  "ref": "e4",
  "role": "button",
  "name": "Continue",
  "text": "Continue",
  "attributes": {
    "data-testid": "continue-action"
  },
  "index": 6
}
```

against the current candidate set. Scoring is based on generic browser-facing metadata, not page-specific recipes. The successful repaired action records diagnostics such as:

```json
{
  "ok": true,
  "mode": "repaired",
  "original_ref": "e4",
  "repaired_ref": "e9",
  "candidate": {
    "ref": "e9",
    "role": "button",
    "name": "Continue"
  }
}
```

## DOM-signature repair

DOM signatures preserve safe structural context that tends to survive ref churn. A saved signature may include:

- element `tag`
- normalized visible text
- allowed attributes only: `id`, `class`, `name`, `type`, `placeholder`, `aria-label`, `title`, `href`, `data-testid`, `data-test`, `data-cy`
- parent tag/text/allowed attributes
- sibling tag/text/allowed attributes
- tag-only ancestor path
- depth and index
- nearby visible text snippets

DOM signatures must not include arbitrary HTML, event handlers, hidden values, typed text values, cookies, tokens, or secrets.

Generic example:

```json
{
  "tag": "button",
  "text": "Continue",
  "attributes": {
    "class": "primary action",
    "data-testid": "continue-action"
  },
  "parent": {
    "tag": "section",
    "text": "Step 2 Shipping"
  },
  "siblings": [
    { "tag": "button", "text": "Back" }
  ],
  "path": ["main", "form", "section", "button"],
  "depth": 4,
  "index": 6,
  "nearbyText": ["Shipping address", "Back"]
}
```

A successful DOM-signature repair returns structured diagnostics:

```json
{
  "ok": true,
  "mode": "dom_signature_repaired",
  "llm_used": false,
  "original_ref": "e4",
  "repaired_ref": "e12",
  "score": 91,
  "candidate": {
    "ref": "e12",
    "role": "button",
    "name": "Continue"
  },
  "validation": { "ok": true }
}
```

## Validation

Repair is not considered successful until the action handler succeeds and the expected outcome validates. Validation may be skipped only by an explicit validator result that marks the check as skipped. If validation fails, the replay reports a failure mode instead of silently accepting the repaired ref.

Typical validation inputs include generic expected-outcome checks such as URL changes, visible text, tab state, or a caller-provided assertion. The repair layer does not embed target-site assumptions.

## Learning successful repairs

When `learnRepairs=true` and a `learnRepair` callback is provided, Managed Browser can persist a successful DOM-signature repair after validation passes. The learned payload includes provenance:

```json
{
  "mode": "dom_signature_repaired",
  "old_ref": "e4",
  "new_ref": "e12",
  "original_ref": "e4",
  "repaired_ref": "e12",
  "score": 91,
  "candidate": { "ref": "e12", "name": "Continue" },
  "original_step": { "kind": "click", "ref": "e4" },
  "repaired_step": { "kind": "click", "ref": "e12" }
}
```

Learning is blocked when repair is ambiguous, below threshold, validation fails, a side-effect gate blocks the action, a required parameter is missing, or a secret would be required.

## Safety gates

Adaptive repair favors fail-safe behavior:

- **No site hardcoding:** logic and docs use generic roles, names, attributes, and structural context.
- **No secret replay:** redacted type steps return `requires_secret` before any repair attempt types values.
- **Runtime parameter enforcement:** parameterized steps return `requires_parameter` until caller-provided parameters are present.
- **Higher thresholds for risky actions:** `type` requires a stricter DOM-signature score; `send`, `submit`, `buy`, `pay`, `delete`, and `publish` require the strictest score.
- **Ambiguity rejection:** candidates with insufficient score margin return `dom_signature_ambiguous`.
- **Validation required before learning:** learned repairs are persisted only after successful handler execution and validation.
- **LLM opt-in:** planner fallback is disabled unless the caller explicitly enables it.

## Diagnostics modes

The replay result mode explains the path taken. Examples below are generic and avoid site-specific strings.

### `exact`

```json
{
  "ok": true,
  "mode": "exact",
  "llm_used": false,
  "validation": { "ok": true }
}
```

### `repaired`

```json
{
  "ok": true,
  "mode": "repaired",
  "original_ref": "e2",
  "repaired_ref": "e8",
  "candidate": { "ref": "e8", "role": "link", "name": "Details" }
}
```

### `dom_signature_repaired`

```json
{
  "ok": true,
  "mode": "dom_signature_repaired",
  "llm_used": false,
  "original_ref": "e2",
  "repaired_ref": "e11",
  "score": 88,
  "candidate": { "ref": "e11", "role": "link", "name": "Details" }
}
```

### `dom_signature_below_threshold`

```json
{
  "ok": false,
  "mode": "dom_signature_below_threshold",
  "llm_used": false,
  "score": 63,
  "threshold": 85,
  "margin": 63
}
```

### `dom_signature_ambiguous`

```json
{
  "ok": false,
  "mode": "dom_signature_ambiguous",
  "llm_used": false,
  "score": 90,
  "runner_up_score": 88,
  "threshold": 85,
  "margin": 2
}
```

### `dom_signature_validation_failed`

```json
{
  "ok": false,
  "mode": "dom_signature_validation_failed",
  "llm_used": false,
  "original_ref": "e2",
  "repaired_ref": "e11",
  "score": 88,
  "validation": { "ok": false, "reason": "expected outcome was not observed" }
}
```

### `requires_parameter`

```json
{
  "ok": false,
  "mode": "requires_parameter",
  "llm_used": false,
  "requires_parameters": ["message"]
}
```

### `requires_secret`

```json
{
  "ok": false,
  "mode": "requires_secret",
  "requires_secret": true
}
```

### `llm_fallback`

```json
{
  "ok": true,
  "mode": "llm_fallback",
  "llm_used": true,
  "validation": { "ok": true }
}
```

`llm_fallback` is only possible when enabled by the caller. Local adaptive repair modes report `llm_used: false`.
