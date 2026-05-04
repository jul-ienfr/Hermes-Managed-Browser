# Managed Browser CLI Orchestration Phase Executor Plan

**Goal:** Make Managed Browser a shared, multi-profile browser automation service usable by domain CLIs such as `emploi-cli` and `resell-cli` without each CLI owning its own browser automation stack.
**Repo:** `/home/jul/tools/camofox-browser`
**Owner:** Julien / Hermes
**Execution Skill:** `phase-plan-executor`
**Execution Date:** 2026-04-29

---

## Execution Settings

- **Concurrency:** 2
- **Parallel Mode:** safe
- **Validation Mode:** standard
- **Max Retries Per Task:** 1
- **Resume:** true
- **Commit Mode:** none
- **Phase Filter:** all

---

## Verified Context

- Source design: `docs/plans/2026-04-29-managed-browser-cli-orchestration-global-plan.md`.
- Repo is already dirty; workers must not stage/commit unrelated files.
- Managed Browser is under `/home/jul/tools/camofox-browser`.
- Existing relevant modules include `lib/managed-browser-policy.js`, `lib/managed-lifecycle.js`, `lib/agent-history-memory.js`, `lib/self-healing-replay.js`, `lib/memory-replay-handlers.js`, `server.js`.
- Test runner: `npm test -- --runTestsByPath <tests...>`.
- Browser automation must remain browser-only: no VNC/OCR/raw-X11 fallback for agent/CLI automation.

---

## Phase 1 — Profile Identity Contract
**Progress:** 100%

- [x] Inspect current managed-browser profile handling in `server.js`, `lib/managed-lifecycle.js`, `lib/managed-browser-policy.js`, and existing managed-browser tests; record the live profile/tab data shape in this plan under a short “Implementation Notes” subsection.
- [x] Add unit tests proving mutating managed-browser operations reject missing/blank `profile` instead of silently using a default profile.
- [x] Add or update profile normalization helpers so a profile is treated as one browser identity with cookies/storage/persona/tabs/session state.
- [x] Add `profiles.list`, `profiles.status`, and `profiles.ensure` endpoint or handler coverage, using existing route style where possible.
- [x] Run targeted profile-policy tests and `node --check` on touched modules.

### Phase Status
- [x] Phase 1 complete

---

## Phase 2 — Profile-Level Lease Manager
**Progress:** 100%

- [x] Create a lease manager module such as `lib/profile-lease-manager.js` with acquire, renew, release, status, and TTL expiry behavior.
- [x] Add unit tests for one writer per profile, independent leases across different profiles, expired lease reclaim, and structured `profile_locked` errors.
- [x] Wire write/mutating managed-browser endpoints to require a valid `lease_id` scoped to the requested `profile`.
- [x] Keep read-only snapshot/status behavior policy-controlled and test both allowed and rejected cases.
- [x] Run targeted lease tests plus existing managed-lifecycle/managed-policy tests.

### Phase Status
- [x] Phase 2 complete

---

## Phase 3 — Profile-Scoped API Surface For CLIs
**Progress:** 100%

- [x] Define the stable CLI-facing request/response schema for `open`, `snapshot`, `act`, `memory.record`, `memory.replay`, `checkpoint`, and `release`, always including `profile` and, for write operations, `lease_id`.
- [x] Add tests proving structured results include `ok`, `profile`, `lease_id` where relevant, `mode`, `llm_used`, `requires_*` fields, and final observable state when available.
- [x] Implement route/handler changes without breaking existing managed-browser tool wrappers.
- [x] Add backwards-compatibility behavior only where safe; unsafe missing-profile calls must fail closed.
- [x] Run targeted API/managed-browser tests.

### Phase Status
- [x] Phase 3 complete

---

## Phase 4 — Profile-Aware Browser Memory Lookup
**Progress:** 100%

- [x] Extend AgentHistory memory storage to support profile-scoped variants under `~/.hermes/browser_memory/profiles/<profile>/<site>/<action>.AgentHistory.json`.
- [x] Add tests for lookup order: profile-specific flow first, then shared site/action template only if metadata marks it safe to share.
- [x] Add metadata preservation for `profile`, `owner_cli`, `domain`, `side_effect_level`, `safe_to_share`, `created_by`, and `parameters`.
- [x] Ensure Managed Browser never leaks profile-specific learned flows across profiles silently.
- [x] Run targeted `agentHistoryMemory` and replay-handler tests.

### Phase Status
- [x] Phase 4 complete

---

## Phase 5 — Runtime Parameters And Safety Boundaries
**Progress:** 100%

- [x] Add or tighten tests proving replay refuses missing runtime parameters such as `{{query}}`, `{{location}}`, and `{{message}}`.
- [x] Ensure message/reply/comment typed values remain parameterized and secrets/OTP/password/card/token-like fields remain redacted.
- [x] Add side-effect-level metadata and policy checks for read-only, message/send, submit/apply, buy/pay, delete, publish, and account-setting actions.
- [x] Ensure CLI-triggered LLM fallback is never implicit; it must require `allow_llm_fallback=true` and report `llm_used: true`.
- [x] Run targeted self-healing replay and memory tests.

### Phase Status
- [x] Phase 5 complete

---

## Phase 6 — CLI Client Adapter And Documentation
**Progress:** 100%

- [x] Add a small documented CLI-client adapter or HTTP examples showing acquire lease → replay → structured result → release lease.
- [x] Document single CLI/single profile, single CLI/multiple profiles, multiple CLIs/separate profiles, and profile contention patterns.
- [x] Add docs for structured result fields and error shapes such as `profile_locked`, `profile_unavailable`, `requires_parameter`, `requires_secret`, `blocked`.
- [x] Add example requests for `emploi-cli` and `resell-cli` without hardcoding either domain into core logic.
- [x] Run docs sanity checks and targeted tests for any adapter code.

### Phase Status
- [x] Phase 6 complete

---

## Phase 7 — End-To-End Smoke Coverage
**Progress:** 100%

- [x] Add low-risk E2E or integration tests for one CLI owner using one profile through lease/replay/release.
- [x] Add integration test for one CLI owner using two profiles concurrently without cross-profile memory/state leakage.
- [x] Add integration test for two owners contending for the same profile and receiving structured `profile_locked` behavior.
- [x] Add integration test proving known memory replay completes with `llm_used: false`.
- [x] Run final validation: `node --check server.js`, `node --check` touched `lib/*.js`, targeted Jest suite, and `git diff --check`.

### Phase Status
- [x] Phase 7 complete

---

## Implementation Notes

### Phase 1 — Profile Identity Contract

- Live managed profile policy shape is `{ profile, siteKey, userId, sessionKey, defaultStartUrl, profileDir, browserPersonaKey, humanPersonaKey, defaultHumanProfile, displayPolicy, lifecyclePolicy, securityPolicy, identity }`.
- The normalized `identity` ties one profile to all browser state scopes: `cookies`/`storage` use `userId`, `browserPersona` uses `browserPersonaKey`, `humanPersona` uses `humanPersonaKey`, and `tabs`/`sessionState` use `sessionKey`.
- Live server session shape is keyed by normalized `userId` in `sessions` and contains `{ context, tabGroups: Map<sessionKey, Map<tabId, tabState>>, profileDir, launchPersona, lastAccess, proxySessionId, browserProxySessionId }`.
- Live tab state shape includes `{ page, refs, visitedUrls, downloads, toolCalls, humanSession, agentHistorySteps, recoveryMeta, consoleMessages, jsErrors, diagnosticsTotals }`; `recoveryMeta` carries `userId`, `sessionKey`, `tabId`, `profileDir`, `siteKey`, persona keys, and persona/profile data.
- Added profile contract handlers/endpoints: `GET /managed/profiles` (`profiles.list`), `GET /managed/profiles/:profile/status` (`profiles.status`), and `POST /managed/profiles/ensure` (`profiles.ensure`). Mutating managed routes now fail closed on missing/blank `profile` through `requireManagedBrowserProfileIdentity`.

---

## Global Status
**Overall Progress:** 100%
- [x] Plan complete
