import { findBestCandidate } from './target-repair.js';

function isSuccess(result) {
  return Boolean(result && result.ok !== false && !result.error);
}

function isRedactedTypeStep(step = {}) {
  return step.kind === 'type' && (step.text_redacted === true || step.text === '__REDACTED__');
}

function resolveParameterizedStep(step = {}, parameters = {}) {
  if (!step.text_parameterized) return { ok: true, step };
  const parameterName = step.parameter_name || 'message';
  const value = parameters[parameterName];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, parameterName };
  }
  return {
    ok: true,
    step: {
      ...step,
      text: value,
      parameter_value_supplied: true,
    },
  };
}

async function validateStep(step, ctx) {
  const validate = ctx?.validate || (async () => ({ ok: true, skipped: true }));
  return validate(step.expected_outcome || {}, step);
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

async function replayStepSelfHealing(step, ctx = {}) {
  const parameterized = resolveParameterizedStep(step, ctx.parameters || {});
  if (!parameterized.ok) {
    return {
      ok: false,
      mode: 'requires_parameter',
      requires_parameters: [parameterized.parameterName],
      llm_used: false,
    };
  }
  step = parameterized.step;

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

  if (step.target_summary) {
    if (ctx.refreshRefs) {
      await ctx.refreshRefs(step);
    }
    const candidates = ctx.getCandidates ? await ctx.getCandidates(step) : [];
    const repaired = findBestCandidate(step.target_summary, candidates || []);
    if (repaired?.ref && repaired.ref !== step.ref) {
      const repairedStep = { ...step, ref: repaired.ref };
      const repairedResult = await handler(repairedStep);
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
        const fallback = await plannerFallback();
        if (fallback) {
          return {
            ...fallback,
            repaired_validation: validation,
            repaired_ref: repaired.ref,
            original_ref: step.ref,
            candidate: repaired,
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
        };
      }
      const fallback = await plannerFallback();
      if (fallback) return fallback;
      return {
        ok: false,
        mode: 'repair_failed',
        llm_used: false,
        result: repairedResult,
        repaired_ref: repaired.ref,
        original_ref: step.ref,
        candidate: repaired,
        exact_result: exact,
      };
    }
  }

  const fallback = await plannerFallback();
  if (fallback) return fallback;
  return { ok: false, mode: 'repair_failed', llm_used: false, result: exact };
}

function summarizeReplayResults(results = []) {
  const modes = results.map((item) => item.mode).filter(Boolean);
  return {
    llm_used: results.some((item) => item.llm_used === true),
    mode: modes.includes('repaired') ? 'repaired' : modes[0] || null,
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

export { replayStepSelfHealing, replayStepsSelfHealing };
