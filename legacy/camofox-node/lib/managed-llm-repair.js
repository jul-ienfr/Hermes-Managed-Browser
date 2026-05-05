function explicitAllowLlmRepair(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'allowLlmFallback')) {
    return body.allowLlmFallback === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'allow_llm_fallback')) {
    return body.allow_llm_fallback === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'allowLlmRepair')) {
    return body.allowLlmRepair === true;
  }
  return body.allow_llm_repair === true;
}

async function unavailablePlannerFallback() {
  return {
    ok: false,
    mode: 'llm_unavailable',
    llm_used: false,
    error: 'No server-side LLM client is configured for memory replay repair.',
  };
}

function createManagedPlannerFallback() {
  return unavailablePlannerFallback;
}

export { explicitAllowLlmRepair, createManagedPlannerFallback, unavailablePlannerFallback };
