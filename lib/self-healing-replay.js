import { findBestDomSignatureCandidate } from './dom-signature-repair.js';
import { sideEffectPolicyCheck } from './managed-cli-schema.js';
import { findBestCandidate } from './target-repair.js';

function isSuccess(result) {
  return Boolean(result && result.ok !== false && !result.error);
}

function isRedactedTypeStep(step = {}) {
  return step.kind === 'type' && (step.text_redacted === true || step.text === '__REDACTED__');
}

function placeholderNamesFromValue(value) {
  if (typeof value !== 'string') return [];
  const names = [];
  const pattern = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;
  let match;
  while ((match = pattern.exec(value)) !== null) names.push(match[1]);
  return names;
}

function replaceRuntimePlaceholders(value, parameters = {}) {
  if (typeof value === 'string') {
    return value.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, name) => String(parameters[name]));
  }
  if (Array.isArray(value)) return value.map((item) => replaceRuntimePlaceholders(item, parameters));
  return value;
}

function collectPlaceholderNames(value, required) {
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholderNames(item, required);
    return;
  }
  for (const name of placeholderNamesFromValue(value)) required.add(name);
}

function resolveParameterizedStep(step = {}, parameters = {}) {
  const candidateFields = ['url', 'text', 'selector', 'value', 'expression', 'script', 'paths'];
  const required = new Set();
  for (const field of candidateFields) {
    collectPlaceholderNames(step[field], required);
  }
  if (step.text_parameterized) required.add(step.parameter_name || 'message');

  const missing = [...required].filter((name) => typeof parameters[name] !== 'string' || parameters[name].length === 0);
  if (missing.length > 0) return { ok: false, parameterNames: missing };
  if (required.size === 0) return { ok: true, step };

  const resolvedStep = { ...step, parameter_value_supplied: true };
  for (const field of candidateFields) {
    resolvedStep[field] = replaceRuntimePlaceholders(resolvedStep[field], parameters);
  }
  return { ok: true, step: resolvedStep };
}

async function validateStep(step, ctx) {
  const validate = ctx?.validate || (async () => ({ ok: true, skipped: true }));
  return validate(step.expected_outcome || {}, step);
}

function learnedRepairPayload(mode, originalStep, repairedStep, repaired) {
  return {
    mode,
    old_ref: originalStep?.ref,
    new_ref: repaired?.ref || repairedStep?.ref,
    original_ref: originalStep?.ref,
    repaired_ref: repaired?.ref || repairedStep?.ref,
    score: repaired?.score,
    candidate: repaired?.candidate,
    original_step: originalStep,
    repaired_step: repairedStep,
  };
}

async function maybeLearnRepair(ctx, payload) {
  if (ctx?.learnRepairs !== true || typeof ctx.learnRepair !== 'function') return false;
  await ctx.learnRepair(payload);
  return true;
}

async function runHandler(handler, step) {
  try {
    return await handler(step);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), thrown: true };
  }
}

async function handleInterruptIfPresent(ctx, step) {
  const interrupt = ctx.detectInterrupt ? await ctx.detectInterrupt() : null;
  const pacing = interrupt && ctx.adaptivePacing ? ctx.adaptivePacing(interrupt, step) : null;
  if (pacing?.delayMs > 0 && ctx.waitForPacing) {
    await ctx.waitForPacing(pacing.delayMs, pacing);
  }
  if (interrupt?.requires_human) {
    return { ok: false, mode: 'blocked', interrupt, pacing, requires_human: true };
  }
  if (interrupt && ctx.resolveInterrupt) {
    const resolution = await ctx.resolveInterrupt(interrupt, step);
    if (!isSuccess(resolution)) {
      return { ok: false, mode: 'interrupt_resolution_failed', interrupt, pacing, resolution };
    }
    return { ok: true, interrupt, pacing, resolution };
  }
  return { ok: true, interrupt, pacing };
}

function plannedStepFromFallback(planned) {
  if (!planned || typeof planned !== 'object' || planned.ok === false) return null;
  const candidate = planned.repaired_step || planned.step || planned.action;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate;
}

async function runPlannerFallback(step, ctx, handler, originalExactResult) {
  if (!ctx.allowLlmFallback || !ctx.plannerFallback) return null;
  let planned;
  try {
    planned = await ctx.plannerFallback(step);
  } catch (err) {
    return {
      ok: false,
      mode: 'llm_fallback_failed',
      llm_used: false,
      error: err?.message || String(err),
      exact_result: originalExactResult,
    };
  }
  if (!planned || planned.ok === false) {
    return {
      ...planned,
      ok: false,
      mode: planned?.mode || 'llm_fallback_failed',
      llm_used: planned?.llm_used === true,
      exact_result: originalExactResult,
    };
  }
  const plannedStep = plannedStepFromFallback(planned);
  if (!plannedStep) {
    return {
      ok: false,
      mode: 'llm_fallback_invalid',
      llm_used: true,
      error: 'Planner fallback did not return a repaired step for local replay.',
      planner_result: planned,
      exact_result: originalExactResult,
    };
  }
  const repairedStep = { ...step, ...plannedStep };
  const plannedResult = await runHandler(handler, repairedStep);
  if (!isSuccess(plannedResult)) {
    return {
      ok: false,
      mode: 'llm_fallback_handler_failed',
      llm_used: true,
      result: plannedResult,
      repaired_step: repairedStep,
      planner_result: planned,
      exact_result: originalExactResult,
    };
  }
  const validation = await validateStep(repairedStep, ctx);
  if (!validation?.ok) {
    return {
      ok: false,
      mode: 'llm_fallback_validation_failed',
      llm_used: true,
      result: plannedResult,
      validation,
      repaired_step: repairedStep,
      planner_result: planned,
      exact_result: originalExactResult,
    };
  }
  return {
    ok: true,
    mode: 'llm_fallback',
    llm_used: true,
    result: plannedResult,
    validation,
    repaired_step: repairedStep,
    planner_result: planned,
    exact_result: originalExactResult,
  };
}

async function tryDomSignatureRepair(step, ctx, handler, candidates, exactResult) {
  const savedSignature = step.dom_signature || step.domSignature || step.target_summary?.dom_signature || step.target_summary?.domSignature;
  if (!savedSignature) return null;

  const repaired = findBestDomSignatureCandidate(savedSignature, candidates || [], { step, explainFailure: true });
  if (repaired?.ok === false) return repaired;
  if (!repaired?.ref || repaired.ref === step.ref) return null;

  const repairedStep = { ...step, ref: repaired.ref };
  const repairedResult = await runHandler(handler, repairedStep);
  if (!isSuccess(repairedResult)) {
    return {
      ok: false,
      mode: 'dom_signature_repair_failed',
      llm_used: false,
      result: repairedResult,
      repaired_step: repairedStep,
      original_ref: step.ref,
      repaired_ref: repaired.ref,
      score: repaired.score,
      candidate: repaired.candidate,
      exact_result: exactResult,
    };
  }

  const validation = await validateStep(repairedStep, ctx);
  if (!validation?.ok) {
    return {
      ok: false,
      mode: 'dom_signature_validation_failed',
      llm_used: false,
      result: repairedResult,
      validation,
      repaired_step: repairedStep,
      original_ref: step.ref,
      repaired_ref: repaired.ref,
      score: repaired.score,
      candidate: repaired.candidate,
      exact_result: exactResult,
    };
  }

  const payload = learnedRepairPayload('dom_signature_repaired', step, repairedStep, repaired);
  const learned = await maybeLearnRepair(ctx, payload);
  return {
    ok: true,
    mode: 'dom_signature_repaired',
    llm_used: false,
    result: repairedResult,
    validation,
    repaired_step: repairedStep,
    original_ref: step.ref,
    repaired_ref: repaired.ref,
    score: repaired.score,
    candidate: repaired.candidate,
    ...(learned ? { learned_repair: true } : {}),
  };
}

async function replayStepSelfHealing(step, ctx = {}) {
  const parameterized = resolveParameterizedStep(step, ctx.parameters || {});
  if (!parameterized.ok) {
    return {
      ok: false,
      mode: 'requires_parameter',
      requires_parameters: parameterized.parameterNames,
      llm_used: false,
    };
  }
  step = parameterized.step;

  const sideEffectPolicy = sideEffectPolicyCheck(step.side_effect_level || ctx.side_effect_level, ctx);
  if (!sideEffectPolicy.ok) return sideEffectPolicy;

  const preInterrupt = await handleInterruptIfPresent(ctx, step);
  if (!preInterrupt.ok) {
    return preInterrupt;
  }

  if (isRedactedTypeStep(step)) {
    return { ok: false, mode: 'requires_secret', requires_secret: true };
  }

  const handler = ctx.handlers?.[step.kind];
  if (!handler) {
    return { ok: false, error: `No handler for ${step.kind}` };
  }

  let exact = await runHandler(handler, step);
  if (isSuccess(exact)) {
    const validation = await validateStep(step, ctx);
    if (validation?.ok) {
      return { ok: true, mode: 'exact', result: exact, validation };
    }
    const fallback = await runPlannerFallback(step, ctx, handler, exact);
    if (fallback) {
      return { ...fallback, exact_validation: validation };
    }
    return { ok: false, mode: 'exact_validation_failed', result: exact, validation };
  }

  const plannerFallback = async () => runPlannerFallback(step, ctx, handler, exact);
  let candidates = null;

  if (step.target_summary) {
    if (ctx.refreshRefs) {
      await ctx.refreshRefs(step);
    }
    candidates = ctx.getCandidates ? await ctx.getCandidates(step) : [];
    const repaired = findBestCandidate(step.target_summary, candidates || []);
    if (repaired?.ref && repaired.ref !== step.ref) {
      const repairedStep = { ...step, ref: repaired.ref };
      const repairedResult = await runHandler(handler, repairedStep);
      if (isSuccess(repairedResult)) {
        const validation = await validateStep(repairedStep, ctx);
        if (validation?.ok) {
          return {
            ok: true,
            mode: 'repaired',
            result: repairedResult,
            validation,
            repaired_step: repairedStep,
            repaired_ref: repaired.ref,
            original_ref: step.ref,
            candidate: repaired,
          };
        }
        const domRepair = await tryDomSignatureRepair(step, ctx, handler, candidates, exact);
        if (domRepair?.ok) return { ...domRepair, repaired_validation: validation };
        const fallback = await plannerFallback();
        if (fallback) {
          return {
            ...fallback,
            repaired_validation: validation,
            repaired_ref: repaired.ref,
            original_ref: step.ref,
            candidate: repaired,
            dom_signature_repair: domRepair,
          };
        }
        return {
          ok: false,
          mode: 'repaired_validation_failed',
          result: repairedResult,
          validation,
          repaired_ref: repaired.ref,
          original_ref: step.ref,
          candidate: repaired,
          dom_signature_repair: domRepair,
        };
      }
      const domRepair = await tryDomSignatureRepair(step, ctx, handler, candidates, exact);
      if (domRepair?.ok) return { ...domRepair, repaired_result: repairedResult };
      const fallback = await plannerFallback();
      if (fallback) return { ...fallback, dom_signature_repair: domRepair };
      return {
        ok: false,
        mode: 'repair_failed',
        llm_used: false,
        result: repairedResult,
        repaired_ref: repaired.ref,
        original_ref: step.ref,
        candidate: repaired,
        exact_result: exact,
        dom_signature_repair: domRepair,
      };
    }
  }

  if (candidates === null && (step.dom_signature || step.domSignature || step.target_summary?.dom_signature || step.target_summary?.domSignature)) {
    if (ctx.refreshRefs) {
      await ctx.refreshRefs(step);
    }
    candidates = ctx.getCandidates ? await ctx.getCandidates(step) : [];
  }
  const domRepair = await tryDomSignatureRepair(step, ctx, handler, candidates || [], exact);
  if (domRepair?.ok) return domRepair;
  const domRepairFailed = domRepair?.ok === false;

  const fallback = await plannerFallback();
  if (fallback) {
    return domRepairFailed ? { ...fallback, dom_signature_repair: domRepair } : fallback;
  }
  if (domRepairFailed) return domRepair;
  return { ok: false, mode: 'repair_failed', llm_used: false, result: exact };
}

function summarizeReplayResults(results = []) {
  const modes = results.map((item) => item.mode).filter(Boolean);
  return {
    llm_used: results.some((item) => item.llm_used === true),
    mode: modes.includes('dom_signature_repaired')
      ? 'dom_signature_repaired'
      : modes.includes('repaired')
        ? 'repaired'
        : modes[0] || null,
    modes,
  };
}

async function replayStepsSelfHealing(steps, ctx = {}) {
  const results = [];
  for (const step of steps || []) {
    const result = await replayStepSelfHealing(step, ctx);
    results.push({ step, ...result });
    if (!result.ok) {
      return { ok: false, ...summarizeReplayResults(results), replayed_steps: results.length, results };
    }
  }
  return { ok: true, ...summarizeReplayResults(results), replayed_steps: results.length, results };
}

export { replaceRuntimePlaceholders, replayStepSelfHealing, replayStepsSelfHealing, resolveParameterizedStep };
