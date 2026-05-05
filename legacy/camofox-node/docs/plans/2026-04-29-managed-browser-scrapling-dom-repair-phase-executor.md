# Managed Browser Scrapling DOM Repair Phase Executor Plan

**Goal:** Add Scrapling-style local DOM-signature repair to Managed Browser replay so stale refs and DOM drift can be repaired without routine LLM calls.
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

- Source design: `docs/plans/2026-04-29-managed-browser-scrapling-dom-repair.md`.
- Existing self-healing modules:
  - `lib/action-context.js`
  - `lib/target-repair.js`
  - `lib/self-healing-replay.js`
  - `lib/agent-history-memory.js`
  - `lib/memory-replay-handlers.js`
- Existing relevant tests:
  - `tests/unit/actionContext.test.js`
  - `tests/unit/targetRepair.test.js`
  - `tests/unit/selfHealingReplay.test.js`
  - `tests/unit/agentHistoryMemory.test.js`
  - `tests/unit/domDriftReplay.test.js`
- Test runner: `npm test -- --runTestsByPath <tests...>`.
- Core logic must stay generic; no target-site hardcoding such as Leboncoin.
- Replay order must remain exact replay → local repair → validation → optional explicit LLM fallback.

---

## Phase 1 — DOM Signature Data Model
**Progress:** 100%

- [x] Add failing tests in `tests/unit/actionContext.test.js` for `buildDomSignature` capturing tag, normalized text, allowed attributes, parent, siblings, path, depth/index, and nearby text.
- [x] Implement and export `buildDomSignature` in `lib/action-context.js` using safe allowed attributes only.
- [x] Update `buildTargetContext` to include `dom_signature` when structural DOM data exists.
- [x] Add tests proving unsafe attributes/full HTML/typed values are not included in DOM signatures.
- [x] Run `npm test -- --runTestsByPath tests/unit/actionContext.test.js` and `node --check lib/action-context.js`.

### Phase Status
- [x] Phase 1 complete

---

## Phase 2 — Preserve DOM Signatures In AgentHistory
**Progress:** 100%

- [x] Add failing tests in `tests/unit/agentHistoryMemory.test.js` proving `target_summary.dom_signature` or direct `dom_signature` survives record/persist/load.
- [x] Update `lib/agent-history-memory.js` enrichment/persistence to preserve DOM signatures without duplicating or dropping safety fields.
- [x] Ensure parameterized messages and redacted secrets remain redacted while preserving non-sensitive structural metadata.
- [x] Add metadata/provenance compatibility tests if saved flows contain learned repair data.
- [x] Run `npm test -- --runTestsByPath tests/unit/agentHistoryMemory.test.js` and `node --check lib/agent-history-memory.js`.

### Phase Status
- [x] Phase 2 complete

---

## Phase 3 — DOM Signature Similarity Engine
**Progress:** 100%

- [x] Create `tests/unit/domSignatureRepair.test.js` with tests for robust scoring across id/class drift, best-candidate selection, and ambiguous candidate rejection.
- [x] Create `lib/dom-signature-repair.js` implementing deterministic local scoring for tag/text/attributes/parent/path/siblings/nearby/index.
- [x] Add and test `thresholdForStep(step)` with stricter thresholds for `type`, send/submit/buy/pay/delete/publish actions.
- [x] Add tests proving low-confidence and ambiguous matches return null/fail safe.
- [x] Run `npm test -- --runTestsByPath tests/unit/domSignatureRepair.test.js` and `node --check lib/dom-signature-repair.js`.

### Phase Status
- [x] Phase 3 complete

---

## Phase 4 — Wire DOM Repair Into Self-Healing Replay
**Progress:** 100%

- [x] Add failing test in `tests/unit/selfHealingReplay.test.js` proving replay tries exact ref, then existing `target_summary` repair, then DOM-signature repair with `llm_used: false`.
- [x] Update `lib/self-healing-replay.js` to call DOM-signature repair after target-summary repair fails or cannot validate.
- [x] Return structured diagnostics for DOM repair: `mode: dom_signature_repaired`, `original_ref`, `repaired_ref`, `score`, `candidate`, `llm_used: false`.
- [x] Update replay summary priority so any DOM-repaired step yields top-level `mode: dom_signature_repaired`.
- [x] Run `npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/domSignatureRepair.test.js` and `node --check lib/self-healing-replay.js`.

### Phase Status
- [x] Phase 4 complete

---

## Phase 5 — Live Candidate Metadata Plumbing
**Progress:** 100%

- [x] Inspect `lib/snapshot.js`, `lib/memory-replay-handlers.js`, and server ref-map wiring to locate where live candidates are built.
- [x] Add tests proving live candidate conversion includes DOM signatures from ref/node metadata.
- [x] Extend snapshot/ref metadata extraction to include safe structural fields: tag, allowed attributes, parent tag/text/attributes, sibling tag names, tag-only path, depth/index, nearby text.
- [x] Ensure candidate extraction does not include arbitrary HTML, event handlers, hidden values, secrets, or typed values.
- [x] Run targeted snapshot/action-context/memory-replay-handler tests and `node --check` touched modules.

### Phase Status
- [x] Phase 5 complete

---

## Phase 6 — Learn Successful DOM Repairs Safely
**Progress:** 100%

- [x] Add tests for `learnRepairs=true` invoking a `learnRepair` callback only after DOM repair succeeds and validation passes.
- [x] Update `lib/self-healing-replay.js` to pass learned repair payload with mode, old ref, new ref, score, candidate, original step, and repaired step.
- [x] Wire server/memory replay route persistence so successful learned DOM repairs update the relevant AgentHistory file with provenance.
- [x] Add tests proving validation failure, ambiguity, or risky low-confidence repair does not persist learned changes.
- [x] Run targeted self-healing replay, agent-history, and route wiring tests.

### Phase Status
- [x] Phase 6 complete

---

## Phase 7 — Safety Gates And Failure Modes
**Progress:** 100%

- [x] Add tests for structured failure modes: `dom_signature_ambiguous`, `dom_signature_below_threshold`, `dom_signature_validation_failed`, and planner fallback only when `allowLlmFallback=true`.
- [x] Enforce stricter thresholds for type/send/submit/buy/pay/delete/publish and fail safe when confidence is insufficient.
- [x] Verify exact replay and existing target-summary repair behavior remains unchanged for already-covered cases.
- [x] Add tests proving redacted type steps still return `requires_secret` and parameterized steps still return `requires_parameter` before any repair attempt types values.
- [x] Run `npm test -- --runTestsByPath tests/unit/selfHealingReplay.test.js tests/unit/domSignatureRepair.test.js tests/unit/targetRepair.test.js`.

### Phase Status
- [x] Phase 7 complete

---

## Phase 8 — Documentation And Final Validation
**Progress:** 100%

- [x] Add `docs/managed-browser-adaptive-repair.md` documenting exact replay, target-summary repair, DOM-signature repair, validation, learning, and safety gates.
- [x] Add examples of diagnostics modes without target-site hardcoding.
- [x] Run genericity scan over changed core files to ensure no target-site strings such as `leboncoin` were introduced.
- [x] Run final validation: `node --check server.js`, `node --check` all changed `lib/*.js`, targeted Jest suite, and `git diff --check`.
- [x] Update this execution board’s Global Status after all validations pass.

### Phase Status
- [x] Phase 8 complete

---

## Global Status
**Overall Progress:** 100%
- [x] Plan complete
