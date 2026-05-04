# Managed Browser + CLI Orchestration Global Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Managed Browser into a shared, multi-profile browser automation service that domain CLIs can use safely and efficiently without re-planning known workflows through an LLM.

**Architecture:** Managed Browser owns browser state, profiles, tabs, leases, AgentHistory memory, local replay, DOM repair, and safety gates. Domain CLIs own business intent and call Managed Browser through a stable profile-scoped API. Replay is local-first; LLM fallback is explicit and last-resort only.

**Tech Stack:** Node.js ESM, Camofox/Playwright, existing `/home/jul/tools/camofox-browser`, AgentHistory files under `~/.hermes/browser_memory`, Jest tests, local HTTP/API clients for CLIs.

---

## 1. Core Product Rule

```text
CLI asks domain intent on explicit profile
→ Managed Browser acquires profile lease
→ exact local replay if known
→ target_summary repair if ref changed
→ DOM-signature repair if structure changed
→ validate outcome
→ learn repaired flow if safe
→ return structured result
→ LLM fallback only if explicitly allowed
```

Routine replay must not call the LLM.

---

## 2. Responsibility Split

### Managed Browser owns browser execution

Managed Browser is responsible for:

- browser profiles,
- Camofox contexts,
- cookies/storage sessions,
- fingerprint/persona,
- tabs/windows,
- snapshots and refs,
- human-like browser actions,
- AgentHistory capture,
- memory replay,
- local repair,
- outcome validation,
- leases/locks,
- checkpoints,
- safety gates.

### CLIs own domain intent

Domain CLIs are responsible for:

- deciding what task to perform,
- preparing business parameters,
- interpreting structured results,
- applying domain rules,
- deciding whether an action is read-only, transactional, or requires approval.

Examples:

```text
emploi-cli
  decides: search jobs near Bogève, parse offers, rank offers
  browser: France Travail login/search handled by Managed Browser

resell-cli / reell-cli
  decides: check inbox, evaluate offer, apply resale rules
  browser: Leboncoin profile/messages handled by Managed Browser
```

---

## 3. Profile Model

### Rule

```text
1 profile = 1 browser identity = 1 managed browser profile
```

A profile includes:

- cookies,
- localStorage/sessionStorage,
- browser fingerprint/persona,
- tabs,
- cursor/session state,
- AgentHistory timeline,
- learned repairs,
- checkpoints.

### Requirements

- Every mutating CLI call must include an explicit `profile`.
- Managed Browser must never silently fall back to another profile.
- If a requested profile does not exist, is locked, unhealthy, or unavailable, return a structured error.
- A CLI may operate several profiles concurrently, but each profile has its own lease.

Example:

```text
emploi-cli
  profile: emploi-julien
  profile: emploi-test
  profile: emploi-alt

resell-cli
  profile: lbc-ju
  profile: lbc-ge
```

---

## 4. Lease / Lock Model

### Rule

```text
1 profile → 1 writer at a time
```

Because tabs in the same profile share session/cookies/storage, lock scope defaults to the whole profile, not only one tab.

### Lease metadata

Each lease should include:

```json
{
  "lease_id": "...",
  "profile": "emploi-julien",
  "owner_cli": "emploi-cli",
  "mode": "write",
  "ttl_seconds": 300,
  "created_at": "...",
  "expires_at": "..."
}
```

### Behavior

- Write actions require a valid lease.
- Read-only snapshots may optionally be allowed without write lease depending on policy.
- Expired leases are automatically reclaimable.
- Multi-profile orchestration uses multiple independent leases.
- A lease cannot span different profiles.

---

## 5. API Contract For CLIs

Minimum stable primitives:

```text
profiles.list()
profiles.ensure(profile, owner_cli?, policy?)
profiles.status(profile)

lease.acquire(profile, owner_cli, ttl_seconds, mode="write")
lease.renew(profile, lease_id, ttl_seconds)
lease.release(profile, lease_id)

open(profile, url, site_key?, lease_id)
snapshot(profile, tab_id, lease_id?)
act(profile, tab_id, action, ref|selector|semantic_hint, parameters?, lease_id)

memory.record(profile, tab_id, site_key, action_key, lease_id)
memory.replay(profile, site_key, action_key, parameters?, lease_id, allow_llm_fallback=false, learn_repairs=true)

checkpoint(profile, lease_id)
release(profile, lease_id)
```

### Important API rule

Every result should be machine-readable:

```json
{
  "ok": true,
  "profile": "emploi-julien",
  "lease_id": "...",
  "mode": "exact|repaired|dom_signature_repaired|blocked|requires_parameter|requires_secret|llm_fallback",
  "llm_used": false,
  "replayed_steps": 4,
  "final_url": "...",
  "observed_text": "...",
  "artifacts": []
}
```

CLIs should never parse human-readable browser logs as their integration layer.

---

## 6. Memory Architecture

### Shared templates

Generic, safe-to-share flows live at:

```text
~/.hermes/browser_memory/<site>/<action>.AgentHistory.json
```

Example:

```text
~/.hermes/browser_memory/francetravail.fr/search_jobs.AgentHistory.json
```

### Profile-scoped variants

Profile-specific learned flows live at:

```text
~/.hermes/browser_memory/profiles/<profile>/<site>/<action>.AgentHistory.json
```

Examples:

```text
~/.hermes/browser_memory/profiles/emploi-julien/francetravail.fr/search_jobs.AgentHistory.json
~/.hermes/browser_memory/profiles/lbc-ju/leboncoin.fr/open_messages.AgentHistory.json
```

### Lookup order

```text
1. profile-specific flow
2. shared site/action template if safe_to_share=true
3. no memory found → local fallback / learn / explicit LLM fallback if allowed
```

### Metadata

Each flow should carry metadata such as:

```json
{
  "profile": "emploi-julien",
  "owner_cli": "emploi-cli",
  "domain": "job_search",
  "side_effect_level": "read_only",
  "parameters": ["query", "location"],
  "safe_to_share": false,
  "created_by": "managed-browser"
}
```

---

## 7. Parameter Model

Saved flows should not bake in live values when the value is task-specific.

Use placeholders:

```text
{{query}}
{{location}}
{{message}}
```

Example CLI call:

```json
{
  "profile": "emploi-julien",
  "site_key": "francetravail.fr",
  "action_key": "search_jobs",
  "parameters": {
    "query": "chauffeur poids lourd",
    "location": "Bogève"
  }
}
```

Managed Browser must:

- refuse missing parameters,
- never type `{{placeholder}}` literally,
- never store secrets or free-form messages in clear text,
- keep message/reply flows parameterized.

---

## 8. Replay And Repair Pipeline

### Layer 1 — Exact replay

Use recorded refs/selectors/actions directly.

Result:

```json
{ "mode": "exact", "llm_used": false }
```

### Layer 2 — Target summary repair

If the ref is stale, rescan current refs and score candidates from accessibility context:

- role,
- name,
- text,
- label,
- placeholder,
- safe attributes,
- index.

Result:

```json
{ "mode": "repaired", "llm_used": false }
```

### Layer 3 — DOM signature repair

If accessibility repair is insufficient, use Scrapling-style local similarity:

- tag,
- text,
- allowed attributes,
- parent tag/text/attributes,
- siblings,
- tag-only path,
- index/depth,
- nearby text.

Result:

```json
{ "mode": "dom_signature_repaired", "llm_used": false }
```

### Layer 4 — Outcome validation

After any replay/repair, validate observable outcomes:

- URL contains/equals,
- title contains,
- page text appears,
- selector/ref exists,
- expected state is reached.

### Layer 5 — Learn repaired flow

If repair succeeds and validation passes, persist improved flow with provenance:

```json
{
  "learned_from": {
    "mode": "dom_signature_repaired",
    "old_ref": "e12",
    "new_ref": "e39",
    "score": 87,
    "timestamp": "..."
  }
}
```

### Layer 6 — Explicit LLM fallback

Only if caller set:

```json
{ "allow_llm_fallback": true }
```

Return clearly:

```json
{ "llm_used": true, "mode": "llm_fallback" }
```

---

## 9. Safety Policy

### Read-only actions

Can usually run automatically:

- open page,
- search,
- scrape visible data,
- navigate,
- sort/filter,
- inspect inbox without sending.

### Sensitive actions

Need stricter thresholds and possibly approval:

- send message,
- apply to job,
- publish listing,
- buy,
- pay,
- delete,
- confirm,
- modify account settings.

### Repair thresholds

Suggested defaults:

```text
read/navigation/search: medium threshold
click continue/login/search: medium-high threshold
type: high threshold
send/submit/buy/delete/publish/pay: very high threshold + policy gate
```

Ambiguous candidate matches must fail safe.

---

## 10. CLI Harmony Patterns

### Pattern A — Single CLI, single profile

```text
emploi-cli
  acquire lease emploi-julien
  replay francetravail/search_jobs
  parse result
  release lease
```

### Pattern B — Single CLI, multiple profiles

```text
emploi-cli
  acquire lease emploi-julien
  acquire lease emploi-test
  run separate browser workflows
  merge domain results
  release both leases
```

### Pattern C — Multiple CLIs, separate profiles

```text
emploi-cli → profile emploi-julien
resell-cli → profile lbc-ju
```

Both can run at same time because profiles are isolated.

### Pattern D — Multiple CLIs want same profile

```text
emploi-cli requests emploi-julien
another-cli requests emploi-julien
```

Second request receives:

```json
{
  "ok": false,
  "error": "profile_locked",
  "profile": "emploi-julien",
  "locked_by": "emploi-cli",
  "retry_after_seconds": 120
}
```

---

## 11. Implementation Phases

### Phase 1 — Profile-scoped API contract

- Add or formalize profile parameter in all managed-browser endpoints.
- Reject mutating calls without profile.
- Add `profiles.list`, `profiles.status`, `profiles.ensure`.
- Add tests proving no silent default profile fallback.

### Phase 2 — Lease manager

- Create profile-level lease registry.
- Implement acquire/renew/release.
- Enforce write lock on mutating endpoints.
- Add TTL cleanup.
- Add tests for concurrent CLIs and expired locks.

### Phase 3 — Profile-aware memory lookup

- Add profile-specific memory path.
- Keep shared template path.
- Implement lookup order: profile → shared safe template.
- Add metadata fields: profile, owner_cli, domain, side_effect_level, safe_to_share.
- Add tests for profile isolation.

### Phase 4 — Parameterized replay contract

- Ensure placeholders are required at runtime.
- Refuse missing parameters.
- Redact secrets.
- Parameterize message/reply/comment fields.
- Add tests for `{{message}}`, `{{query}}`, `{{location}}`.

### Phase 5 — Local replay and repair

- Keep exact replay.
- Keep target_summary repair.
- Add DOM signature capture and repair.
- Add action-specific thresholds.
- Add validation after repair.
- Add learned repair provenance.

### Phase 6 — CLI client adapter

- Provide a small client library or documented HTTP examples for CLIs.
- Make it easy for `emploi-cli` or `resell-cli` to call:
  - acquire lease,
  - replay action,
  - fetch structured result,
  - release lease.

### Phase 7 — End-to-end smoke tests

- Use low-risk sites/actions first.
- Test one CLI with one profile.
- Test one CLI with two profiles.
- Test two CLIs contending for the same profile.
- Test profile memory isolation.
- Test replay without LLM.
- Test explicit LLM fallback returns `llm_used: true`.

---

## 12. Acceptance Criteria

1. Every mutating browser action requires explicit `profile`.
2. One profile maps to one browser identity.
3. A CLI can operate multiple profiles concurrently with independent leases.
4. Two CLIs cannot write to the same profile concurrently.
5. Memory lookup is profile-aware and never leaks account-specific flows across profiles unless explicitly marked safe to share.
6. Known flows replay without LLM.
7. Broken refs repair locally without LLM when confidence is sufficient.
8. DOM drift repairs locally using DOM signatures.
9. Ambiguous or risky repairs fail safe.
10. Structured results are stable enough for CLIs to consume.
11. LLM fallback is explicit and detectable.
12. No VNC/OCR/raw-X11 fallback is used by CLI automation.
13. No site-specific hardcoding is required for the core.

---

## 13. Non-Goals

- Do not make each CLI launch its own Playwright/Camofox browser.
- Do not let CLIs bypass Managed Browser memory/lease policy.
- Do not share profile-specific memory across accounts silently.
- Do not call the LLM for every repeated browser action.
- Do not persist secrets or literal free-form messages.
- Do not allow destructive/public actions through low-confidence repairs.

---

## Final Target State

Managed Browser becomes the local browser operating system for automation:

```text
CLI = domain brain
Managed Browser = profile/browser/memory/replay/repair/safety executor
```

Practical result:

```text
emploi-cli can drive several job-search profiles.
resell-cli can drive several resale profiles.
Both can run safely in parallel if profiles differ.
Known browser work is replayed locally.
DOM drift is repaired locally.
LLM is only the emergency planner, not the default executor.
```
