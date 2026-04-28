function explicitAllowLlmRepair(body = {}) {
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
