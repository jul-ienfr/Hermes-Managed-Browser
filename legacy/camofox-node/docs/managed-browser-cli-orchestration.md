# Managed Browser CLI Orchestration

Managed Browser exposes a small profile-scoped HTTP surface for domain CLIs that need browser automation without owning a separate browser stack. A caller such as `emploi-cli` or `resell-cli` should treat a managed `profile` as the durable browser identity: cookies, storage, persona, tabs, and session state all belong to that profile.

The core service does not know about domain CLIs. CLI names, domains, action keys, and runtime parameters are request data and memory metadata supplied by callers.

## Invariants

- Every managed CLI request must include an explicit non-blank `profile`.
- Mutating operations must include a valid `lease_id` for that same `profile`.
- One writer lease may be active per profile at a time.
- Read-only snapshot/status calls may be allowed while locked depending on server policy, but writes fail closed without the current lease.
- Browser automation remains browser-only; do not add VNC, OCR, or raw-X11 fallbacks for CLI automation.
- LLM repair/fallback is opt-in only. Pass `allow_llm_fallback: true` and expect `llm_used` to report whether it was actually used.

## Endpoints used by CLI clients

| Step | Method/path | Purpose |
| --- | --- | --- |
| Discover profiles | `GET /managed/profiles` | List configured profile identities. |
| Check status | `GET /managed/profiles/:profile/status` | Inspect profile lifecycle and lease status. |
| Ensure profile | `POST /managed/profiles/ensure` | Validate profile identity and materialize profile metadata. |
| Acquire lease | `POST /managed/profiles/lease/acquire` | Obtain write ownership for a profile. |
| Renew lease | `POST /managed/profiles/lease/renew` | Extend a lease TTL during long flows. |
| Open | `POST /managed/cli/open` | Open a managed tab for a leased profile. |
| Snapshot | `POST /managed/cli/snapshot` | Read a tab snapshot and refs. |
| Act | `POST /managed/cli/act` | Perform supported browser actions with a lease. |
| Replay memory | `POST /managed/cli/memory/replay` | Replay a recorded AgentHistory flow with runtime parameters. |
| Record memory | `POST /managed/cli/memory/record` | Record a flow from the current tab state. |
| Checkpoint | `POST /managed/cli/checkpoint` | Persist/checkpoint profile storage. |
| Release lease | `POST /managed/profiles/lease/release` or `POST /managed/cli/release` | Release profile write ownership. |

## Minimal HTTP flow

This example shows the intended adapter sequence: acquire lease, replay, consume a structured result, and release lease. `jq` is used only by the shell example; a CLI adapter may keep the JSON in memory instead.

```bash
BASE_URL="${BASE_URL:-http://localhost:9377}"
PROFILE="example-demo"
OWNER_CLI="example-cli"

LEASE_JSON=$(curl -sS -X POST "$BASE_URL/managed/profiles/lease/acquire" \
  -H 'content-type: application/json' \
  -d '{"profile":"example-demo","owner_cli":"example-cli","ttl_ms":300000}')

LEASE_ID=$(printf '%s' "$LEASE_JSON" | jq -r '.lease_id')

REPLAY_JSON=$(curl -sS -X POST "$BASE_URL/managed/cli/memory/replay" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg profile "$PROFILE" \
    --arg lease_id "$LEASE_ID" \
    '{profile:$profile,lease_id:$lease_id,siteKey:"example",actionKey:"lookup",parameters:{query:"demo"},max_side_effect_level:"read_only",allow_llm_fallback:false}')")

printf '%s\n' "$REPLAY_JSON" | jq '{ok,operation,profile,lease_id,mode,llm_used,observable_state,requires_parameter,requires_secret,blocked,error,code}'

curl -sS -X POST "$BASE_URL/managed/profiles/lease/release" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg profile "$PROFILE" --arg lease_id "$LEASE_ID" '{profile:$profile,lease_id:$lease_id}')"
```

Equivalent request bodies:

```json
{
  "profile": "example-demo",
  "owner_cli": "example-cli",
  "ttl_ms": 300000
}
```

```json
{
  "profile": "example-demo",
  "lease_id": "lease-from-acquire-response",
  "siteKey": "example",
  "actionKey": "lookup",
  "parameters": {
    "query": "demo"
  },
  "max_side_effect_level": "read_only",
  "allow_llm_fallback": false
}
```

```json
{
  "profile": "example-demo",
  "lease_id": "lease-from-acquire-response"
}
```

## CLI/profile ownership patterns

### Single CLI, single profile

Use one profile for one CLI identity. This is the simplest deployment when one CLI owns a single account or persona.

1. `emploi-cli` acquires a lease for `leboncoin-cim`.
2. It opens/replays/checkpoints with that same `lease_id`.
3. It releases the lease in a `finally`/cleanup path.

Keep one long-lived lease only while the CLI is actively mutating browser state. Release promptly so status checks and other operators do not see stale contention.

### Single CLI, multiple profiles

A single CLI may operate several independent profiles by acquiring separate leases per profile. Never reuse a `lease_id` across profiles.

- `emploi-cli` may acquire `leboncoin-cim` for account A and `leboncoin-ge` for account B.
- The CLI should keep an in-memory map keyed by profile: `{ profile -> lease_id }`.
- AgentHistory lookup is profile-aware; profile-specific flows are preferred and shared templates are used only when metadata marks them safe to share.

### Multiple CLIs, separate profiles

Different CLIs should use separate profiles when they represent separate accounts, domains, or risk boundaries.

- `emploi-cli` can use an employment-focused profile.
- `resell-cli` can use a resale-focused profile.
- Each profile has separate cookies/storage/persona/tabs/session state, so leases do not contend unless both CLIs target the same profile.

### Profile contention

If two CLIs need the same profile, only one can hold the writer lease. The second acquire/write receives `profile_locked` with the active owner/lease metadata when available.

Recommended behavior:

1. Inspect `code === "profile_locked"` and `reason`.
2. If the owner is another CLI, back off with jitter or surface a useful message to the operator.
3. If the owner is the same CLI after a crash, wait for TTL expiry or release using the current valid lease if it is still known.
4. Do not force a second browser profile directory for the same logical identity; that risks cookie/storage divergence.

## Structured result fields

Successful CLI endpoint responses are normalized to include stable fields where relevant.

| Field | Meaning |
| --- | --- |
| `ok` | Boolean success flag. `false` or an HTTP error response means the CLI should not assume the action completed. |
| `operation` | Stable operation name such as `open`, `snapshot`, `act`, `memory.replay`, `checkpoint`, or `release`. |
| `profile` | Managed profile identity used by the request. |
| `lease_id` | Lease used for write operations or supplied by the caller. |
| `mode` | Execution mode, usually `browser`; replay may report a more specific mode such as `memory.replay`. |
| `llm_used` | Whether an LLM fallback/repair path actually ran. It should remain `false` unless explicitly allowed and used. |
| `observable_state` | Final visible state when available, for example tab id, URL, title, refs count, checkpoint state, or release state. |
| `requires_parameter` | Missing runtime parameter names needed to safely replay a parameterized flow. |
| `requires_secret` | Missing secret names needed to continue; callers should supply through their secret handling, not logs. |
| `requires_confirmation` | The requested side effect exceeds policy and needs operator confirmation or a higher explicit max side-effect level. |
| `blocked` | The request was intentionally blocked by policy. |
| `side_effect_level` | Flow side-effect classification: `read_only`, `message_send`, `submit_apply`, `buy_pay`, `delete`, `publish`, or `account_setting`. |

Example successful replay result:

```json
{
  "ok": true,
  "operation": "memory.replay",
  "profile": "example-demo",
  "lease_id": "018ef2b6-0000-4000-9000-000000000000",
  "mode": "memory.replay",
  "llm_used": false,
  "siteKey": "example",
  "actionKey": "lookup",
  "steps": 4,
  "observable_state": {
    "currentTabId": "tab_123",
    "url": "https://example.com/"
  }
}
```

## Error shapes

Errors use HTTP status codes plus structured fields. Existing route errors may also include `error` without `ok`; adapters should branch on HTTP status and `code`/`requires_*` fields, not string matching alone.

### `profile_locked`

Returned when a profile has a different active writer lease, a write request omits `lease_id`, a `lease_id` mismatches, or locked reads are disallowed by policy.

```json
{
  "error": "Managed browser profile \"leboncoin-cim\" is locked by another writer.",
  "code": "profile_locked",
  "profile": "leboncoin-cim",
  "lease_id": "active-lease-id",
  "owner": "emploi-cli",
  "expires_at": 1770000000000,
  "reason": "lease_mismatch",
  "required_lease_id": true
}
```

### `profile_unavailable`

Use this adapter category when a configured profile cannot be ensured, opened, or reached due to lifecycle/browser availability. The server may report the lower-level message in `error`; CLIs should normalize it for their user interface.

```json
{
  "ok": false,
  "code": "profile_unavailable",
  "profile": "example-demo",
  "operation": "open",
  "error": "No active managed browser session is available for the profile."
}
```

### `requires_parameter`

Returned when a replay contains placeholders such as `{{query}}`, `{{location}}`, or `{{message}}` and the caller did not provide safe runtime values.

```json
{
  "ok": false,
  "operation": "memory.replay",
  "profile": "leboncoin-cim",
  "lease_id": "lease-id",
  "mode": "memory.replay",
  "llm_used": false,
  "requires_parameter": ["query", "location"],
  "error": "Replay requires runtime parameters."
}
```

### `requires_secret`

Returned when a flow needs a secret, token, password, OTP, card, or similarly sensitive value. Secrets must remain parameterized/redacted in stored memory and logs.

```json
{
  "ok": false,
  "operation": "memory.replay",
  "profile": "leboncoin-cim",
  "lease_id": "lease-id",
  "mode": "memory.replay",
  "llm_used": false,
  "requires_secret": ["account_password"],
  "error": "Replay requires one or more secrets."
}
```

### `blocked`

Returned when policy blocks a requested flow, commonly because the recorded side-effect level is higher than the caller's `max_side_effect_level`.

```json
{
  "ok": false,
  "operation": "memory.replay",
  "profile": "leboncoin-cim",
  "lease_id": "lease-id",
  "mode": "blocked",
  "llm_used": false,
  "blocked": true,
  "side_effect_level": "submit_apply",
  "max_side_effect_level": "read_only",
  "requires_confirmation": true,
  "reason": "side_effect_level_exceeds_policy"
}
```

## Domain CLI examples

These examples intentionally keep domain details in request data. Core Managed Browser logic should not branch on `emploi-cli` or `resell-cli`.

### `emploi-cli` read-only search replay

```json
{
  "profile": "leboncoin-cim",
  "owner_cli": "emploi-cli",
  "ttl_ms": 300000
}
```

```json
{
  "profile": "leboncoin-cim",
  "lease_id": "lease-from-acquire-response",
  "siteKey": "leboncoin",
  "actionKey": "emploi.search",
  "owner_cli": "emploi-cli",
  "parameters": {
    "query": "alternance développeur",
    "location": "Lyon"
  },
  "max_side_effect_level": "read_only",
  "allow_llm_fallback": false
}
```

### `emploi-cli` message/send replay

```json
{
  "profile": "leboncoin-cim",
  "lease_id": "lease-from-acquire-response",
  "siteKey": "leboncoin",
  "actionKey": "emploi.contact",
  "owner_cli": "emploi-cli",
  "parameters": {
    "message": "Bonjour, je suis intéressé par votre annonce."
  },
  "max_side_effect_level": "message_send",
  "allow_llm_fallback": false
}
```

### `resell-cli` listing lookup replay

```json
{
  "profile": "leboncoin-ge",
  "owner_cli": "resell-cli",
  "ttl_ms": 300000
}
```

```json
{
  "profile": "leboncoin-ge",
  "lease_id": "lease-from-acquire-response",
  "siteKey": "leboncoin",
  "actionKey": "resell.lookup_listing",
  "owner_cli": "resell-cli",
  "parameters": {
    "query": "console occasion",
    "location": "Grenoble"
  },
  "max_side_effect_level": "read_only",
  "allow_llm_fallback": false
}
```

### `resell-cli` publish/listing replay

```json
{
  "profile": "leboncoin-ge",
  "lease_id": "lease-from-acquire-response",
  "siteKey": "leboncoin",
  "actionKey": "resell.publish_listing",
  "owner_cli": "resell-cli",
  "parameters": {
    "title": "Console occasion très bon état",
    "price": "120",
    "description": "Remise en main propre possible."
  },
  "max_side_effect_level": "publish",
  "allow_llm_fallback": false
}
```

## Adapter checklist

A small CLI adapter should implement the following control flow:

1. Validate `profile`, `siteKey`, `actionKey`, `parameters`, and maximum side-effect policy before any write.
2. Acquire a lease with `owner_cli` and a bounded TTL.
3. Run `open` if the flow requires a tab and no current tab is known.
4. Run `memory.replay` or lower-level `act` requests with the acquired `lease_id`.
5. Interpret structured fields: handle `requires_parameter`, `requires_secret`, `blocked`, and `profile_locked` explicitly.
6. Checkpoint when profile storage should be persisted after meaningful state changes.
7. Release the lease in a `finally` block, even when replay fails.
8. Never log raw secrets or expanded sensitive typed values.
